const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, Notification, shell, screen, dialog, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const isDev = process.env.ELECTRON_ENV === 'development';

// Module-level paths (needed by both main window and launcher windows)
const distIndexPath = path.resolve(__dirname, '..', 'dist', 'dockwarden', 'browser', 'index.html');

// In-memory items cache — populated on every vault:get-items / vault:sync so
// launcher windows can get items instantly without re-running `bw list items`
let itemsCache = [];

// ─── Simple JSON store ────────────────────────────────────────────────────────
class Store {
  constructor() {
    this._file = null;
    this._data = {};
  }
  _init() {
    if (this._file) return;
    this._file = path.join(app.getPath('userData'), 'dockwarden-store.json');
    try {
      this._data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
    } catch {
      this._data = {};
    }
  }
  get(key, defaultValue) {
    this._init();
    if (Store._isUnsafeKey(key)) return defaultValue;
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue;
  }
  set(key, value) {
    this._init();
    // Reject prototype-polluting keys (e.g. from a compromised renderer passing
    // an arbitrary settings key through the generic store bridge).
    if (Store._isUnsafeKey(key)) {
      console.warn('[security] blocked store write to unsafe key:', key);
      return;
    }
    this._data[key] = value;
    try { fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2)); } catch {}
  }
  static _isUnsafeKey(key) {
    return typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype';
  }
}

const store = new Store();

// ─── In-memory session (never persisted to disk) ──────────────────────────────
let bwSession = null;
let pending2FA = null;      // { email, serverUrl, env }
let pending2FAProcess = null; // Live spawn process holding the auth session open

// ─── Offline Edit Queue ───────────────────────────────────────────────────────
// Entries are encrypted with safeStorage (OS keychain) before being written
// to the store so passwords are never at rest in plaintext.
//
// Entry shape:
//   { id, operation: 'create'|'edit', itemId?, item, patch?,
//     revisionDate?, timestamp, name, itemType }

let isOfflineMode = false;
let offlineQueue   = [];          // in-memory; persisted encrypted to store

const OFFLINE_QUEUE_STORE_KEY = 'offlineQueue_enc';

function isNetworkError(msg = '') {
  const m = msg.toLowerCase();
  return (
    m.includes('econnrefused') || m.includes('enotfound') ||
    m.includes('etimedout')    || m.includes('econnreset') ||
    m.includes('network error') || m.includes('unable to connect') ||
    m.includes('failed to fetch') || m.includes('err_network') ||
    m.includes('getaddrinfo')  || m.includes('socket hang up') ||
    m.includes('connect econnrefused')
  );
}

function loadOfflineQueue() {
  try {
    const enc = store.get(OFFLINE_QUEUE_STORE_KEY, null);
    if (!enc) { offlineQueue = []; return; }
    if (safeStorage.isEncryptionAvailable()) {
      const json = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      offlineQueue = JSON.parse(json) || [];
    } else {
      // Fallback: store was plaintext (safeStorage unavailable at time of writing)
      offlineQueue = JSON.parse(Buffer.from(enc, 'base64').toString('utf8')) || [];
    }
  } catch {
    offlineQueue = [];
  }
}

function saveOfflineQueue() {
  try {
    const json = JSON.stringify(offlineQueue);
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json).toString('base64');
      store.set(OFFLINE_QUEUE_STORE_KEY, enc);
    } else {
      // Degrade gracefully — warn but persist as base64 plaintext
      console.warn('[offline-queue] safeStorage unavailable — queue stored as base64 plaintext');
      store.set(OFFLINE_QUEUE_STORE_KEY, Buffer.from(json).toString('base64'));
    }
  } catch (e) {
    console.error('[offline-queue] failed to persist queue:', e.message);
  }
}

function addToOfflineQueue(entry) {
  const { randomUUID } = require('crypto');
  // Collapse multiple edits to the same item into one queue entry
  if (entry.operation === 'edit' && entry.itemId) {
    const existing = offlineQueue.findIndex(e => e.operation === 'edit' && e.itemId === entry.itemId);
    if (existing >= 0) {
      // Merge patch: later values overwrite earlier ones
      offlineQueue[existing].patch = { ...offlineQueue[existing].patch, ...entry.patch };
      offlineQueue[existing].timestamp = entry.timestamp;
      saveOfflineQueue();
      return offlineQueue[existing];
    }
  }
  const queued = { id: randomUUID(), ...entry };
  offlineQueue.push(queued);
  saveOfflineQueue();
  return queued;
}

function removeFromOfflineQueue(entryId) {
  offlineQueue = offlineQueue.filter(e => e.id !== entryId);
  saveOfflineQueue();
}

function setOfflineMode(value) {
  if (isOfflineMode === value) return;
  isOfflineMode = value;
  mainWindow?.webContents.send('offline:status-changed', {
    offline: value,
    queueLength: offlineQueue.length,
  });
  // Update tray tooltip
  if (tray) {
    tray.setToolTip(value
      ? `DockWarden — Offline (${offlineQueue.length} pending)`
      : 'DockWarden');
  }
}

// Strip sensitive credential data from queue entries before sending to renderer
function sanitiseQueueEntry(entry) {
  return {
    id: entry.id,
    operation: entry.operation,
    itemId: entry.itemId,
    name: entry.name,
    itemType: entry.itemType,
    timestamp: entry.timestamp,
    // Only send field names changed, not values — renderer uses these for display only
    changedFields: entry.patch ? Object.keys(entry.patch) : [],
    revisionDate: entry.revisionDate || null,
  };
}

// Apply a patch object (from an offline edit entry) to a fetched bw item in-place
function applyPatchToItem(item, patch) {
  if (!patch) return;
  if (patch.name !== undefined) item.name = patch.name;
  if (patch.notes !== undefined) item.notes = patch.notes || null;
  if (patch.folderId !== undefined) item.folderId = patch.folderId || null;
  if (item.type === 1) {
    item.login = item.login || {};
    if (patch.username !== undefined) item.login.username = patch.username || null;
    if (patch.password !== undefined) item.login.password = patch.password || null;
    if (patch.website !== undefined) {
      item.login.uris = patch.website ? [{ match: null, uri: patch.website }] : [];
    }
  }
  if (patch.tags !== undefined) {
    item.fields = item.fields || [];
    const idx = item.fields.findIndex(f => f.name === '_dw_tags');
    const tagValue = patch.tags.join(',');
    if (idx >= 0) item.fields[idx].value = tagValue;
    else item.fields.push({ name: '_dw_tags', value: tagValue, type: 0 });
  }
  if (patch.expiresAt !== undefined) {
    item.fields = item.fields || [];
    const idx = item.fields.findIndex(f => f.name === '_dw_expires');
    if (idx >= 0) item.fields[idx].value = patch.expiresAt ?? '';
    else if (patch.expiresAt) item.fields.push({ name: '_dw_expires', value: patch.expiresAt, type: 0 });
  }
}

// Flush all queued operations. Returns { applied, conflicts, errors }
// Conflicts are sent to the renderer for user resolution.
async function flushOfflineQueue() {
  if (offlineQueue.length === 0) return { applied: 0, conflicts: [], errors: [] };

  const applied = [];
  const conflicts = [];
  const errors = [];

  // Process creates first (they have no conflict risk)
  const creates = offlineQueue.filter(e => e.operation === 'create');
  for (const entry of creates) {
    try {
      const encoded = Buffer.from(JSON.stringify(entry.item)).toString('base64');
      const result = await runBw(['create', 'item', encoded, '--session', bwSession]);
      const created = JSON.parse(result);
      const realItem = mapBwItem(created);
      // Replace the temp item in cache with the real one
      itemsCache = itemsCache.map(i => i.id === entry.itemId ? realItem : i);
      removeFromOfflineQueue(entry.id);
      applied.push({ entryId: entry.id, operation: 'create', name: entry.name });
    } catch (err) {
      errors.push({ entryId: entry.id, name: entry.name, error: err.message });
    }
  }

  // Process edits — detect conflicts by comparing revisionDate
  const edits = offlineQueue.filter(e => e.operation === 'edit');
  for (const entry of edits) {
    try {
      const current = await runBwJson(['get', 'item', entry.itemId, '--session', bwSession]);
      const currentRevision = current.revisionDate || current.lastModifiedDate || null;

      // Conflict: remote was modified after we queued the edit
      if (entry.revisionDate && currentRevision && currentRevision !== entry.revisionDate) {
        conflicts.push({
          entryId: entry.id,
          itemId: entry.itemId,
          name: entry.name,
          itemType: entry.itemType,
          changedFields: Object.keys(entry.patch || {}),
          queuedAt: entry.timestamp,
          remoteModifiedAt: currentRevision,
        });
        continue; // Leave in queue; user must resolve
      }

      // No conflict — apply
      applyPatchToItem(current, entry.patch);
      const encoded = Buffer.from(JSON.stringify(current)).toString('base64');
      await runBw(['edit', 'item', entry.itemId, encoded, '--session', bwSession]);
      removeFromOfflineQueue(entry.id);
      applied.push({ entryId: entry.id, operation: 'edit', name: entry.name });
    } catch (err) {
      errors.push({ entryId: entry.id, name: entry.name, error: err.message });
    }
  }

  // Notify renderer of updated queue and any conflicts
  mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
  if (conflicts.length > 0) {
    mainWindow?.webContents.send('offline:conflicts-detected', { conflicts });
  }

  return { applied: applied.length, conflicts, errors };
}

// ─── bwCliPath — stored encrypted via safeStorage ────────────────────────────
// safeStorage ties the encrypted blob to the OS credential manager
// (DPAPI/Keychain/libsecret).  An attacker editing dockwarden-store.json
// cannot produce a valid encrypted value without running code in the same OS
// session, so externally substituting a malicious binary path fails silently
// and the app falls back to the safe default "bw".

const SAFE_BW_BASENAME = /^bw(\.exe|\.cmd)?$/i;
const UNSAFE_DIRS = ['/tmp', '/var/tmp', os.tmpdir()].map(d => path.resolve(d));

// ─── PATH augmentation ────────────────────────────────────────────────────────
// Electron does not start a login shell, so it often inherits a stripped PATH
// (e.g. /usr/bin:/bin on macOS/Linux or the bare Windows system PATH).
// We prepend every well-known directory where the Bitwarden CLI could live so
// that "bw" resolves without the user having to set a full path.
function getAugmentedPath() {
  const home = os.homedir();
  let extra;

  if (process.platform === 'win32') {
    extra = [
      path.join(process.env.APPDATA  || '', 'npm'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
    ];
  } else {
    extra = [
      '/usr/local/bin',
      '/usr/bin',
      '/opt/homebrew/bin',          // Apple Silicon Homebrew
      '/opt/homebrew/sbin',
      '/opt/local/bin',             // MacPorts
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'),
      '/snap/bin',                  // Linux Snap
    ];
  }

  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Prepend extras (deduped) so they take priority over any system fallback
  const merged = [...new Set([...extra, ...current])];
  return merged.join(path.delimiter);
}

// Candidate absolute paths for auto-detection (no shell required)
function getBwCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(process.env.APPDATA || '', 'npm', 'bw.cmd'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'bw.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'bw.exe'),
      'C:\\Program Files\\nodejs\\bw.exe',
    ];
  }
  return [
    '/usr/local/bin/bw',
    '/opt/homebrew/bin/bw',
    '/opt/local/bin/bw',
    path.join(home, '.npm-global', 'bin', 'bw'),
    path.join(home, '.local', 'bin', 'bw'),
    '/snap/bin/bw',
    '/usr/bin/bw',
  ];
}

/**
 * Validate that a path looks like a legitimate Bitwarden CLI binary.
 * Returns an error string if invalid, or null if OK.
 */
function validateBwCliPath(p) {
  if (!p || typeof p !== 'string') return 'Path must be a non-empty string';
  // Allow bare "bw" / "bw.exe" / "bw.cmd" names (resolved via PATH at runtime)
  if (/^bw(\.exe|\.cmd)?$/i.test(p)) return null;
  const resolved = path.resolve(p);
  const base = path.basename(resolved);
  if (!SAFE_BW_BASENAME.test(base)) {
    return `Filename must be "bw", "bw.exe", or "bw.cmd" — got "${base}"`;
  }
  // Reject world-writable directories (e.g. /tmp) as install locations
  const dir = path.dirname(resolved);
  if (UNSAFE_DIRS.some(u => dir === u || dir.startsWith(u + path.sep))) {
    return `"${dir}" is not a trusted location for the Bitwarden CLI`;
  }
  return null;
}

function encryptBwPath(p) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(p).toString('base64');
}

function decryptBwPath(enc) {
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null; // tampered or from a different OS account
  }
}

/**
 * Returns the validated bwCliPath.
 * Priority: safeStorage-encrypted value → plaintext legacy value → 'bw'.
 * Silently falls back to 'bw' if the stored value is tampered or invalid.
 */
function getBwPath() {
  // 1. Try the encrypted value (new format)
  const enc = store.get('bwCliPathEnc', null);
  if (enc) {
    const decrypted = decryptBwPath(enc);
    if (decrypted && !validateBwCliPath(decrypted)) return decrypted;
    // Decryption failed or invalid — tampered config; fall through to default
    console.warn('[security] bwCliPathEnc failed integrity check — using default "bw"');
    return 'bw';
  }

  // 2. Migrate unencrypted legacy value on first run after update
  const plain = store.get('bwCliPath', null);
  if (plain && !validateBwCliPath(plain)) {
    const encrypted = encryptBwPath(plain);
    if (encrypted) {
      store.set('bwCliPathEnc', encrypted);
      store.set('bwCliPath', undefined); // remove plaintext
    }
    return plain;
  }

  return 'bw';
}

// ─── Shared spawn configuration ───────────────────────────────────────────────
// Returns the bw binary path, shell flag, and fully-augmented environment for
// every spawn site.  Centralised so PATH augmentation, shell-mode detection,
// and ENOENT messaging are consistent across runBw and the inline login spawns.
//
// Shell-mode rules:
//  • macOS / Linux  – shell: false (most secure; bw is a real ELF/Mach-O binary)
//  • Windows        – shell: true  (required because npm installs bw as a .cmd
//                     wrapper that cmd.exe must interpret).  Args are still passed
//                     as an array so no injection is possible through them.
function getBwSpawnConfig(extraEnv = {}) {
  const bwPath = getBwPath();
  const useShell = process.platform === 'win32' || bwPath.toLowerCase().endsWith('.cmd');
  const env = { ...process.env, ...extraEnv, PATH: getAugmentedPath() };
  return { bwPath, useShell, env };
}

function makeBwEnoentError() {
  return new Error(
    'CLI_NOT_FOUND: Bitwarden CLI not found. ' +
    'Install it with "npm install -g @bitwarden/cli" and open Settings → ' +
    'Bitwarden Connection to set the path.'
  );
}

// Run a bw CLI command and return stdout as a string.
async function runBw(args, extraEnv = {}) {
  const { bwPath, useShell, env } = getBwSpawnConfig(extraEnv);

  return new Promise((resolve, reject) => {
    const proc = spawn(bwPath, args, {
      env,
      shell: useShell,
      windowsHide: true,
    });

    const chunks = [];
    let stderr = '';

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      reject(err.code === 'ENOENT' ? makeBwEnoentError() : err);
    });
    proc.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      } else {
        reject(new Error(stderr.trim() || `bw exited with code ${code}`));
      }
    });
  });
}

async function runBwJson(args, env = {}) {
  const output = await runBw(args, env);
  return JSON.parse(output);
}

// ─── External URL safety ──────────────────────────────────────────────────────
// Only allow opening web/email links externally. Blocks file:, smb:, javascript:,
// and OS-handler protocols that could be abused to launch local programs.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function openExternalSafely(url) {
  if (!isSafeExternalUrl(url)) {
    console.warn('[security] blocked openExternal for disallowed URL:', String(url).slice(0, 120));
    return false;
  }
  shell.openExternal(url);
  return true;
}

// Store keys the renderer must NOT be able to read or write through the generic
// app:get-store / app:set-store / vault:get-setting / vault:set-setting bridges.
// The CLI path has a dedicated, validated + encrypted setter (bw:set-cli-path)
// and is surfaced (decrypted) only via bw:get-config — so the raw encrypted blob
// should never flow through the unrestricted generic store API.
const PROTECTED_STORE_KEYS = new Set(['bwCliPath', 'bwCliPathEnc', 'backupDir']);

// ─── Backup directory safety ──────────────────────────────────────────────────
// backupDir decides where the (encrypted) vault export is written. It must only
// be changeable through the dedicated, validated setter below — never via the
// generic store bridge — so a compromised renderer can't silently redirect
// backups to an attacker-chosen or system-sensitive location.
function validateBackupDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) {
    return 'Backup folder path is invalid';
  }
  if (dir.includes('\u0000')) return 'Backup folder path is invalid';
  if (!path.isAbsolute(dir)) return 'Backup folder must be an absolute path';
  return null;
}

// Returns a validated backup directory, falling back to the default if the
// stored value is missing or was tampered with externally.
function getSafeBackupDir() {
  const fallback = path.join(app.getPath('documents'), 'DockWarden-Backups');
  const stored = store.get('backupDir', null);
  if (stored && !validateBackupDir(stored)) return stored;
  return fallback;
}

// ─── Bitwarden server URL safety ──────────────────────────────────────────────
// The server URL is handed to `bw config server`, which determines where the
// master password is submitted at login/unlock. An attacker-supplied or
// malformed value (file:, javascript:, http: in prod, an internal host, etc.)
// could redirect credentials to a hostile endpoint, so validate strictly.
function validateServerUrl(url) {
  // Empty means "use the default Bitwarden cloud" — allowed.
  if (url === undefined || url === null || url === '') return null;
  if (typeof url !== 'string' || url.length > 2048) return 'Server URL is invalid';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Server URL is not a valid URL';
  }
  // Only http(s); block file:, javascript:, data:, etc.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Server URL must use http or https';
  }
  // Permit http only for loopback (self-hosted dev); require https otherwise.
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !isLoopback) {
    return 'Server URL must use https (http is only allowed for localhost)';
  }
  return null;
}

// Map a Bitwarden CLI item to our VaultItem model
function mapBwItem(bwItem) {
  const item = {
    id: bwItem.id,
    name: bwItem.name || 'Unnamed',
    type: mapItemType(bwItem.type),
    tags: [], // BW CLI doesn't have native tags; we store them in custom fields
    favorite: bwItem.favorite || false,
    folderId: bwItem.folderId || null,
    lastModified: bwItem.revisionDate || new Date().toISOString(),
    createdAt: bwItem.creationDate || new Date().toISOString(),
    username: null,
    password: null,
    website: null,
    totp: null,
    expiresAt: null,
    notes: bwItem.notes || null,
    cardNumber: null,
    passwordStrength: null,
  };

  if (bwItem.type === 1 && bwItem.login) {
    item.username = bwItem.login.username || null;
    item.password = bwItem.login.password || null;
    item.totp = bwItem.login.totp || null;
    if (bwItem.login.uris && bwItem.login.uris.length > 0) {
      item.website = bwItem.login.uris[0].uri || null;
    }
    // Estimate password strength by length + character variety
    if (item.password) {
      item.passwordStrength = estimatePasswordStrength(item.password);
    }
  }

  if (bwItem.type === 3 && bwItem.card) {
    item.cardNumber = bwItem.card.number ? maskCardNumber(bwItem.card.number) : null;
    // Build an expiry date from card expiration year/month
    if (bwItem.card.expYear && bwItem.card.expMonth) {
      item.expiresAt = `${bwItem.card.expYear}-${String(bwItem.card.expMonth).padStart(2, '0')}-01`;
    }
  }

  // Parse custom fields for tags and expiry
  if (bwItem.fields) {
    const tagsField = bwItem.fields.find(f => f.name === '_dw_tags');
    if (tagsField && tagsField.value) {
      item.tags = tagsField.value.split(',').map(t => t.trim()).filter(Boolean);
    }
    const expiryField = bwItem.fields.find(f => f.name === '_dw_expires');
    if (expiryField && expiryField.value) {
      item.expiresAt = expiryField.value;
    }
  }

  return item;
}

function mapItemType(bwType) {
  switch (bwType) {
    case 1: return 'login';
    case 2: return 'note';
    case 3: return 'card';
    case 4: return 'identity';
    default: return 'login';
  }
}

function maskCardNumber(num) {
  if (!num) return null;
  const clean = num.replace(/\s/g, '');
  return `${clean.substring(0, 4)} **** **** ${clean.slice(-4)}`;
}

function estimatePasswordStrength(password) {
  let score = 0;
  if (password.length >= 8) score += 20;
  if (password.length >= 12) score += 20;
  if (password.length >= 16) score += 10;
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/[0-9]/.test(password)) score += 10;
  if (/[^a-zA-Z0-9]/.test(password)) score += 20;
  return Math.min(score, 100);
}

let mainWindow = null;
let tray = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
    icon: path.join(__dirname, '../public/favicon.ico'),
    show: false,
  });

  const distIndex = path.resolve(__dirname, '..', 'dist', 'dockwarden', 'browser', 'index.html');
  const distExists = fs.existsSync(distIndex);

  console.log('[DockWarden] __dirname:', __dirname);
  console.log('[DockWarden] distIndex:', distIndex);
  console.log('[DockWarden] distExists:', distExists);
  console.log('[DockWarden] isDev:', isDev);

  if (!distExists || isDev) {
    console.log('[DockWarden] Loading dev server at http://localhost:4200');
    mainWindow.loadURL('http://localhost:4200');
  } else {
    console.log('[DockWarden] Loading file:', distIndex);
    mainWindow.loadFile(distIndex).catch(err => {
      console.error('[DockWarden] loadFile failed:', err);
    });
  }

  // Catch page load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[DockWarden] did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) console.error('[Renderer]', message);
  });

  // Only open DevTools during development — never in a packaged build.
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 3000);

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../public/favicon.ico'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open DockWarden', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Sync Now', click: () => mainWindow?.webContents.send('vault:sync-requested') },
    { label: 'Quick Lock', accelerator: 'CmdOrCtrl+L', click: () => mainWindow?.webContents.send('vault:lock-requested') },
    { type: 'separator' },
    { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.webContents.send('navigate', '/settings'); } },
    { type: 'separator' },
    { label: 'Quit DockWarden', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('DockWarden — Bitwarden Companion');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── Launcher / Auto-Type floating windows ────────────────────────────────────

let activeLauncherWindow = null;

function openLauncherWindow(mode) {
  // Only one launcher window at a time
  if (activeLauncherWindow && !activeLauncherWindow.isDestroyed()) {
    activeLauncherWindow.close();
    return;
  }

  // Position on the display where the cursor currently is
  const cursorPt  = screen.getCursorScreenPoint();
  const display   = screen.getDisplayNearestPoint(cursorPt);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  const WIN_W = 620;
  const WIN_H = mode === 'autotype' ? 500 : 440;
  const winX  = dx + Math.round((dw - WIN_W) / 2);
  const winY  = dy + Math.round(dh * 0.12);          // ~12% from top

  const distExists = fs.existsSync(distIndexPath);

  activeLauncherWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: winX,
    y: winY,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  const hash = mode === 'autotype' ? '/autotype' : '/launcher';
  if (!distExists || isDev) {
    activeLauncherWindow.loadURL(`http://localhost:4200/#${hash}`);
  } else {
    activeLauncherWindow.loadFile(distIndexPath, { hash });
  }

  activeLauncherWindow.once('ready-to-show', () => {
    activeLauncherWindow?.show();
    activeLauncherWindow?.focus();
  });

  // Close when the user clicks away
  activeLauncherWindow.on('blur', () => {
    activeLauncherWindow?.close();
  });

  activeLauncherWindow.on('closed', () => {
    activeLauncherWindow = null;
  });
}

// ─── Password generator ───────────────────────────────────────────────────────
// Fully local — no bw CLI required. Uses Node crypto for CSPRNG entropy.
const CHARSET = {
  upper:   'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower:   'abcdefghijklmnopqrstuvwxyz',
  numbers: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?',
};

function generatePassword(opts = {}) {
  const {
    length   = 20,
    upper    = true,
    lower    = true,
    numbers  = true,
    symbols  = true,
    ambiguous = false, // exclude 0/O/I/l when false
  } = opts;

  const { randomInt } = require('crypto');

  let pool = '';
  if (upper)   pool += CHARSET.upper;
  if (lower)   pool += CHARSET.lower;
  if (numbers) pool += CHARSET.numbers;
  if (symbols) pool += CHARSET.symbols;
  if (!pool)   pool = CHARSET.lower + CHARSET.numbers;   // sane fallback

  // Strip visually ambiguous characters when the user prefers readability
  if (!ambiguous) pool = pool.replace(/[0OIl]/g, '');

  // Build password, ensuring at least one char from each enabled class
  const required = [];
  if (upper   && pool.match(/[A-Z]/)) required.push(pool.match(/[A-Z]/g)[randomInt(pool.match(/[A-Z]/g).length)]);
  if (lower   && pool.match(/[a-z]/)) required.push(pool.match(/[a-z]/g)[randomInt(pool.match(/[a-z]/g).length)]);
  if (numbers && pool.match(/[0-9]/)) required.push(pool.match(/[0-9]/g)[randomInt(pool.match(/[0-9]/g).length)]);
  if (symbols && pool.match(/[^A-Za-z0-9]/)) {
    const sym = pool.match(/[^A-Za-z0-9]/g);
    required.push(sym[randomInt(sym.length)]);
  }

  const rest = Math.max(0, length - required.length);
  const chars = required.concat(
    Array.from({ length: rest }, () => pool[randomInt(pool.length)])
  );
  // Fisher-Yates shuffle for uniformly random order
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ─── Active-window title detection ───────────────────────────────────────────
// Best-effort: captures the focused app/browser title BEFORE the generator
// window opens, so the site-name field can be pre-filled.
async function getActiveWindowTitle() {
  try {
    if (process.platform === 'win32') {
      const { randomInt } = require('crypto');
      const script = `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class WinFW {
  [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
}
"@
$h=[WinFW]::GetForegroundWindow();$s=New-Object System.Text.StringBuilder 512;[WinFW]::GetWindowText($h,$s,512)|Out-Null;$s.ToString()`.trim();
      return await new Promise((resolve) => {
        const proc = spawn('powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { env: { ...process.env, PATH: getAugmentedPath() }, shell: false, windowsHide: true }
        );
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('close', () => resolve(out.trim()));
        proc.on('error', () => resolve(''));
      });
    } else if (process.platform === 'darwin') {
      return await new Promise((resolve) => {
        const proc = spawn('osascript',
          ['-e', 'tell application "System Events" to get title of front window of (first application process whose frontmost is true)'],
          { env: { ...process.env, PATH: getAugmentedPath() }, shell: false }
        );
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('close', () => resolve(out.trim()));
        proc.on('error', () => resolve(''));
      });
    }
  } catch { /* non-fatal */ }
  return '';
}

// Extract a tidy site name / hostname from a window title like:
//   "GitHub · Build software together — Mozilla Firefox"
//   "Dashboard - Netlify - Google Chrome"
function parseSiteFromTitle(title) {
  if (!title) return { name: '', url: '' };

  // Strip common browser suffixes
  const stripped = title
    .replace(/\s[–—-]\s*(Google Chrome|Firefox|Microsoft Edge|Safari|Brave|Opera|Arc)\s*$/i, '')
    .replace(/\s[–—-]\s*(Mozilla Firefox)\s*$/i, '')
    .trim();

  // Try to detect a URL in the title (rare but possible)
  const urlMatch = stripped.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    try {
      const parsed = new URL(urlMatch[0]);
      return { name: parsed.hostname.replace(/^www\./, ''), url: parsed.href };
    } catch {}
  }

  // Use the last " - " or " – " separated segment as the site name
  const parts = stripped.split(/\s[–—-]\s/);
  const name = (parts[parts.length - 1] || stripped).trim();
  return { name, url: '' };
}

// ─── Quick Generator window ───────────────────────────────────────────────────
let activeGeneratorWindow = null;

async function openGeneratorWindow() {
  if (activeGeneratorWindow && !activeGeneratorWindow.isDestroyed()) {
    activeGeneratorWindow.focus();
    return;
  }

  // Capture the active window title BEFORE we steal focus
  const rawTitle = await getActiveWindowTitle();
  const siteHint = parseSiteFromTitle(rawTitle);

  const cursorPt = screen.getCursorScreenPoint();
  const display  = screen.getDisplayNearestPoint(cursorPt);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  const WIN_W = 480;
  const WIN_H = 580;
  const winX  = dx + Math.round((dw - WIN_W) / 2);
  const winY  = dy + Math.round(dh * 0.10);

  activeGeneratorWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: winX,
    y: winY,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#161b22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  const hash = '/generate';
  if (fs.existsSync(distIndexPath) && !isDev) {
    activeGeneratorWindow.loadFile(distIndexPath, { hash });
  } else {
    activeGeneratorWindow.loadURL(`http://localhost:4200/#${hash}`);
  }

  activeGeneratorWindow.once('ready-to-show', () => {
    activeGeneratorWindow?.show();
    activeGeneratorWindow?.focus();
    // Send the site hint as soon as the renderer is ready
    activeGeneratorWindow?.webContents.send('generator:site-hint', siteHint);
  });

  // Send the hint again after a short delay in case the renderer wasn't ready
  setTimeout(() => {
    if (activeGeneratorWindow && !activeGeneratorWindow.isDestroyed()) {
      activeGeneratorWindow.webContents.send('generator:site-hint', siteHint);
    }
  }, 800);

  activeGeneratorWindow.on('blur', () => { activeGeneratorWindow?.close(); });
  activeGeneratorWindow.on('closed', () => { activeGeneratorWindow = null; });
}

// Cached items — available instantly to launcher windows
ipcMain.handle('vault:get-cached-items', () => itemsCache);

ipcMain.handle('vault:get-totp', async (_, { itemId }) => {
  if (!bwSession) return { success: false, error: 'Vault is locked' };
  try {
    const code = await runBw(['get', 'totp', itemId], { BW_SESSION: bwSession });
    return { success: true, code: code.trim() };
  } catch (err) {
    return { success: false, error: extractBwError(String(err.message)) };
  }
});

// Launcher window asks to be closed
ipcMain.on('launcher:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// Main window can ask to open the launcher (e.g. sidebar button click)
ipcMain.handle('launcher:open-search', () => openLauncherWindow('search'));
ipcMain.handle('launcher:open-autotype', () => openLauncherWindow('autotype'));

// Launcher window selected an item → show main window at /items?select=<id>
ipcMain.on('launcher:navigate-to-item', (event, itemId) => {
  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.webContents.send('navigate-to-item', itemId);
  BrowserWindow.fromWebContents(event.sender)?.close();
});

function registerGlobalShortcuts() {
  globalShortcut.register('CmdOrCtrl+Alt+\\', () => {
    openLauncherWindow('search');
  });

  globalShortcut.register('CmdOrCtrl+Alt+A', () => {
    openLauncherWindow('autotype');
  });

  // Quick Generate — opens the generator floating window
  globalShortcut.register('CmdOrCtrl+Alt+G', () => {
    openGeneratorWindow();
  });

  globalShortcut.register('CmdOrCtrl+L', () => {
    mainWindow?.webContents.send('vault:lock-requested');
  });

  // Sync vault — also handled in-app but register globally so it works
  // even when the app is in the background
  globalShortcut.register('CmdOrCtrl+S', () => {
    mainWindow?.webContents.send('vault:sync-requested');
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function setupIpcHandlers() {
  // ─── Auth ──────────────────────────────────────────────────────────────────

  ipcMain.handle('vault:status', async () => {
    try {
      // Pass session if we have one so bw reports the correct unlocked state
      const args = bwSession ? ['status', '--session', bwSession] : ['status'];
      const output = await runBw(args);
      const status = JSON.parse(output);
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: { status: 'unauthenticated' } };
    }
  });

  ipcMain.handle('vault:login', async (_, { email, password, serverUrl }) => {
    // Kill any stale pending process from a previous attempt
    if (pending2FAProcess) {
      try { pending2FAProcess.kill(); } catch {}
      pending2FAProcess = null;
    }
    pending2FA = null;

    // Reject hostile/malformed server URLs before the master password is ever
    // submitted to that endpoint (anti credential-phishing).
    const serverErr = validateServerUrl(serverUrl);
    if (serverErr) return { success: false, error: serverErr };

    const env = { BW_PASSWORD: password };
    try { if (serverUrl) await runBw(['config', 'server', serverUrl]); } catch { /* non-fatal */ }

    return new Promise((resolve) => {
      const { bwPath, useShell, env: spawnEnv } = getBwSpawnConfig(env);
      // No --nointeraction: bw stays alive waiting on stdin for the 2FA code,
      // so we can pipe it later without triggering a second email.
      const proc = spawn(bwPath,
        ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw'],
        { env: spawnEnv, shell: useShell, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let settled = false;

      function settle(result) {
        if (!settled) { settled = true; resolve(result); }
      }

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        stderr += d.toString();
        // bw writes the 2FA prompt to stderr — detect it to freeze here
        if (!settled && isTwoFactorRequired(stderr)) {
          console.log('[DockWarden] 2FA prompt detected:', stderr.slice(-120).trim());
          pending2FAProcess = proc;
          pending2FA = { email, serverUrl, env };
          settle({ success: false, requiresTwoFactor: true });
        }
        // "Already logged in" — just unlock instead of erroring
        if (!settled && isAlreadyLoggedIn(stderr)) {
          handleAlreadyLoggedIn(email, serverUrl, env, settle);
        }
      });

      // Safety timeout: if bw has not exited OR shown a prompt after 10 s,
      // assume it is waiting for stdin (email code)
      const timeout = setTimeout(() => {
        if (!settled) {
          console.log('[DockWarden] Login timeout — assuming 2FA waiting on stdin');
          pending2FAProcess = proc;
          pending2FA = { email, serverUrl, env };
          settle({ success: false, requiresTwoFactor: true });
        }
      }, 10000);

      proc.on('close', exitCode => {
        clearTimeout(timeout);
        if (settled) return; // already handled via prompt detection
        if (exitCode === 0) {
          bwSession = stdout.trim();
          store.set('bwEmail', email);
          if (serverUrl) store.set('bwServerUrl', serverUrl);
          pending2FA = null;
          // Auto-save account profile on first login
          saveAccountProfile(email, serverUrl || 'https://bitwarden.com');
          settle({ success: true });
        } else {
          const msg = stderr + stdout;
          if (isAlreadyLoggedIn(msg)) {
            handleAlreadyLoggedIn(email, serverUrl, env, settle);
          } else if (isTwoFactorRequired(msg)) {
            // Some bw versions exit with the error instead of waiting on stdin
            pending2FA = { email, serverUrl, env };
            settle({ success: false, requiresTwoFactor: true });
          } else {
            settle({ success: false, error: extractBwError(msg) });
          }
        }
      });

      proc.on('error', err => {
        clearTimeout(timeout);
        const friendly = err.code === 'ENOENT' ? makeBwEnoentError() : err;
        settle({ success: false, error: friendly.message });
      });
    });
  });

  ipcMain.handle('vault:login-2fa', async (_, { code, method = 1 }) => {
    if (!pending2FA) {
      return { success: false, error: 'Session expired. Please sign in again.' };
    }
    const { email, serverUrl, env } = pending2FA;

    // ── Path A: live process is still waiting on stdin (preferred) ────────────
    if (pending2FAProcess && !pending2FAProcess.killed) {
      return new Promise((resolve) => {
        let newStdout = '';
        let newStderr = '';

        pending2FAProcess.stdout.on('data', d => { newStdout += d.toString(); });
        pending2FAProcess.stderr.on('data', d => { newStderr += d.toString(); });

        pending2FAProcess.once('close', exitCode => {
          pending2FAProcess = null;
          if (exitCode === 0) {
            const session = newStdout.trim();
            if (session) {
              bwSession = session;
              store.set('bwEmail', email);
              if (serverUrl) store.set('bwServerUrl', serverUrl);
              pending2FA = null;
              resolve({ success: true });
            } else {
              // Session key wasn't captured in this listener — fall back to unlock
              runBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], env)
                .then(out => {
                  bwSession = out.trim();
                  store.set('bwEmail', email);
                  if (serverUrl) store.set('bwServerUrl', serverUrl);
                  pending2FA = null;
                  resolve({ success: true });
                })
                .catch(unlockErr => {
                  resolve({ success: false, error: extractBwError(String(unlockErr.message)) });
                });
            }
          } else {
            resolve({ success: false, error: extractBwError(newStderr + newStdout) });
          }
        });

        // Pipe the code directly into bw's waiting stdin
        try {
          pending2FAProcess.stdin.write(code + '\n');
          pending2FAProcess.stdin.end();
        } catch (e) {
          resolve({ success: false, error: 'Failed to pipe verification code: ' + e.message });
        }
      });
    }

    // ── Path B: process already exited — spawn fresh and pipe code quickly ────
    return new Promise((resolve) => {
      const { bwPath, useShell, env: spawnEnv } = getBwSpawnConfig(env);
      const proc = spawn(bwPath,
        ['login', email, '--passwordenv', 'BW_PASSWORD', '--method', String(method), '--raw'],
        { env: spawnEnv, shell: useShell, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let codeWritten = false;

      function writeCode() {
        if (!codeWritten) {
          codeWritten = true;
          try { proc.stdin.write(code + '\n'); proc.stdin.end(); } catch {}
        }
      }

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        stderr += d.toString();
        if (isTwoFactorRequired(stderr)) writeCode(); // write as soon as prompt appears
      });

      // Fallback: write after 4 s regardless
      const fallback = setTimeout(writeCode, 4000);

      proc.on('close', exitCode => {
        clearTimeout(fallback);
        if (exitCode === 0) {
          bwSession = stdout.trim();
          store.set('bwEmail', email);
          if (serverUrl) store.set('bwServerUrl', serverUrl);
          pending2FA = null;
          resolve({ success: true });
        } else {
          resolve({ success: false, error: extractBwError(stderr + stdout) });
        }
      });

      proc.on('error', err => {
        clearTimeout(fallback);
        const friendly = err.code === 'ENOENT' ? makeBwEnoentError() : err;
        resolve({ success: false, error: friendly.message });
      });
    });
  });

  ipcMain.handle('vault:unlock', async (_, { password }) => {
    try {
      const env = { ...process.env, BW_PASSWORD: password };
      const output = await runBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], env);
      bwSession = output.trim();
      // Ensure the current email/server is persisted as a profile so the switcher shows it
      const email = store.get('bwEmail', '');
      const serverUrl = store.get('bwServerUrl', 'https://bitwarden.com');
      if (email) saveAccountProfile(email, serverUrl);
      return { success: true };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
  });

  ipcMain.handle('vault:lock', async () => {
    try {
      await runBw(['lock']);
      bwSession = null;
      return { success: true };
    } catch (err) {
      bwSession = null;
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vault:logout', async () => {
    try {
      await runBw(['logout']);
      bwSession = null;
      store.set('bwEmail', null);
      return { success: true };
    } catch (err) {
      bwSession = null;
      return { success: false, error: err.message };
    }
  });

  // ─── Vault Items ───────────────────────────────────────────────────────────

  ipcMain.handle('vault:get-items', async () => {
    if (!bwSession) {
      return [];
    }
    try {
      const items = await runBwJson(['list', 'items', '--session', bwSession]);
      itemsCache = items.map(mapBwItem);
      return itemsCache;
    } catch (err) {
      console.error('vault:get-items error:', err.message);
      return [];
    }
  });

  ipcMain.handle('vault:sync', async () => {
    if (!bwSession) {
      return { success: false, error: 'Not unlocked' };
    }
    try {
      await runBw(['sync', '--session', bwSession]);
      const items = await runBwJson(['list', 'items', '--session', bwSession]);
      itemsCache = items.map(mapBwItem);

      // Auto-save a lightweight metadata snapshot so users can diff vault changes over time
      const snaps = store.get('vaultSnapshots', []);
      const newSnap = {
        id: `snap-${Date.now()}`,
        label: 'Auto (sync)',
        timestamp: new Date().toISOString(),
        itemCount: itemsCache.length,
        items: itemsCache.map(i => ({
          id: i.id, name: i.name, type: i.type,
          lastModified: i.lastModified, folderId: i.folderId || null,
        })),
      };
      store.set('vaultSnapshots', [newSnap, ...snaps].slice(0, 50));

      // Sync succeeded — clear offline mode and attempt queue flush
      if (isOfflineMode) setOfflineMode(false);
      let flushResult = null;
      if (offlineQueue.length > 0) {
        flushResult = await flushOfflineQueue();
      }

      return {
        success: true,
        itemCount: items.length,
        syncedAt: new Date().toISOString(),
        flushResult,
      };
    } catch (err) {
      // Network error → activate offline mode
      if (isNetworkError(err.message)) {
        setOfflineMode(true);
        return { success: false, error: err.message, offline: true };
      }
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vault:edit-item', async (_, { id, patch }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };

    // ── Offline mode: queue the edit ─────────────────────────────────────────
    if (isOfflineMode) {
      const cached = itemsCache.find(i => i.id === id);
      const queued = addToOfflineQueue({
        operation: 'edit',
        itemId: id,
        patch,
        revisionDate: cached?.lastModified || null,
        timestamp: new Date().toISOString(),
        name: cached?.name || id,
        itemType: cached?.type || 'login',
      });
      mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
      return { success: true, queued: true, queueEntryId: queued.id };
    }

    try {
      const item = await runBwJson(['get', 'item', id, '--session', bwSession]);

      // ── Core fields ──────────────────────────────────────────────────────────
      if (patch.name !== undefined) item.name = patch.name;
      if (patch.notes !== undefined) item.notes = patch.notes || null;
      if (patch.folderId !== undefined) item.folderId = patch.folderId || null;

      // ── Login-specific fields ────────────────────────────────────────────────
      if (item.type === 1) {
        item.login = item.login || {};
        if (patch.username !== undefined) item.login.username = patch.username || null;
        if (patch.password !== undefined) item.login.password = patch.password || null;
        if (patch.website !== undefined) {
          item.login.uris = patch.website
            ? [{ match: null, uri: patch.website }]
            : [];
        }
      }

      // ── DockWarden custom fields (tags, expiry) ──────────────────────────────
      if (patch.tags !== undefined) {
        item.fields = item.fields || [];
        const idx = item.fields.findIndex(f => f.name === '_dw_tags');
        const tagValue = patch.tags.join(',');
        if (idx >= 0) item.fields[idx].value = tagValue;
        else item.fields.push({ name: '_dw_tags', value: tagValue, type: 0 });
      }
      if (patch.expiresAt !== undefined) {
        item.fields = item.fields || [];
        const idx = item.fields.findIndex(f => f.name === '_dw_expires');
        if (idx >= 0) {
          item.fields[idx].value = patch.expiresAt ?? '';
        } else if (patch.expiresAt) {
          item.fields.push({ name: '_dw_expires', value: patch.expiresAt, type: 0 });
        }
      }

      const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
      await runBw(['edit', 'item', id, encoded, '--session', bwSession]);
      return { success: true, id };
    } catch (err) {
      // Auto-switch to offline mode on network error and queue the edit
      if (isNetworkError(err.message)) {
        setOfflineMode(true);
        const cached = itemsCache.find(i => i.id === id);
        const queued = addToOfflineQueue({
          operation: 'edit',
          itemId: id,
          patch,
          revisionDate: cached?.lastModified || null,
          timestamp: new Date().toISOString(),
          name: cached?.name || id,
          itemType: cached?.type || 'login',
        });
        mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
        return { success: true, queued: true, queueEntryId: queued.id };
      }
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vault:get-folders', async () => {
    if (!bwSession) return [];
    try {
      const folders = await runBwJson(['list', 'folders', '--session', bwSession]);
      return folders.map(f => ({ id: f.id, name: f.name }));
    } catch (err) {
      console.error('vault:get-folders error:', err.message);
      return [];
    }
  });

  // ─── Create Item ───────────────────────────────────────────────────────────

  ipcMain.handle('vault:create-item', async (_, { item }) => {
    if (!bwSession) return { success: false, error: 'Vault is locked. Please unlock first.' };

    // ── Offline mode: queue the create ──────────────────────────────────────
    if (isOfflineMode) {
      const { randomUUID } = require('crypto');
      const tempId = `dw-offline-${randomUUID()}`;
      const queued = addToOfflineQueue({
        operation: 'create',
        itemId: tempId,
        item,
        timestamp: new Date().toISOString(),
        name: item.name || 'Untitled',
        itemType: item.type === 1 ? 'login' : 'note',
      });
      // Return a fake mapped item so the UI shows it immediately
      const fakeItem = {
        id: tempId,
        name: item.name || 'Untitled',
        type: item.type === 1 ? 'login' : 'secure-note',
        username: item.login?.username || null,
        password: item.login?.password || null,
        website: item.login?.uris?.[0]?.uri || null,
        notes: item.notes || null,
        folderId: item.folderId || null,
        tags: [],
        totp: null,
        favorite: false,
        lastModified: new Date().toISOString(),
        _offlineQueued: true,
      };
      itemsCache = [fakeItem, ...itemsCache];
      mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
      return { success: true, queued: true, item: fakeItem, queueEntryId: queued.id };
    }

    try {
      // bw create item expects base64-encoded JSON (same as what `bw encode` produces)
      const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
      const result = await runBw(['create', 'item', encoded, '--session', bwSession]);
      const created = JSON.parse(result);
      return { success: true, item: mapBwItem(created) };
    } catch (err) {
      // Auto-switch to offline mode on network error and queue the create
      if (isNetworkError(extractBwError(err.message) || err.message)) {
        setOfflineMode(true);
        const { randomUUID } = require('crypto');
        const tempId = `dw-offline-${randomUUID()}`;
        const queued = addToOfflineQueue({
          operation: 'create',
          itemId: tempId,
          item,
          timestamp: new Date().toISOString(),
          name: item.name || 'Untitled',
          itemType: item.type === 1 ? 'login' : 'note',
        });
        const fakeItem = {
          id: tempId,
          name: item.name || 'Untitled',
          type: item.type === 1 ? 'login' : 'secure-note',
          username: item.login?.username || null,
          password: item.login?.password || null,
          website: item.login?.uris?.[0]?.uri || null,
          notes: item.notes || null,
          folderId: item.folderId || null,
          tags: [],
          totp: null,
          favorite: false,
          lastModified: new Date().toISOString(),
          _offlineQueued: true,
        };
        itemsCache = [fakeItem, ...itemsCache];
        mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
        return { success: true, queued: true, item: fakeItem, queueEntryId: queued.id };
      }
      return { success: false, error: extractBwError(err.message) };
    }
  });

  // ─── Folder CRUD ───────────────────────────────────────────────────────────

  ipcMain.handle('folder:create', async (_, { name }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };
    try {
      const encoded = Buffer.from(JSON.stringify({ name })).toString('base64');
      const result = await runBw(['create', 'folder', encoded, '--session', bwSession]);
      const created = JSON.parse(result);
      return { success: true, folder: { id: created.id, name: created.name } };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
  });

  ipcMain.handle('folder:rename', async (_, { id, name }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };
    try {
      const encoded = Buffer.from(JSON.stringify({ name })).toString('base64');
      await runBw(['edit', 'folder', id, encoded, '--session', bwSession]);
      return { success: true };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
  });

  ipcMain.handle('folder:delete', async (_, { id }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };
    try {
      await runBw(['delete', 'folder', id, '--session', bwSession]);
      return { success: true };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
  });

  // Move a folder (and all its descendants) to a new parent path.
  // oldPath = current full BW folder name (e.g. "Work")
  // newPath = desired full BW folder name (e.g. "Personal/Work")
  ipcMain.handle('folder:move', async (_, { folders, oldPath, newPath }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };
    try {
      // Rename the folder itself and every descendant whose name starts with oldPath/
      const toRename = folders.filter(f =>
        f.name === oldPath || f.name.startsWith(oldPath + '/')
      );
      for (const f of toRename) {
        const updatedName = f.name === oldPath
          ? newPath
          : newPath + f.name.slice(oldPath.length);
        const encoded = Buffer.from(JSON.stringify({ name: updatedName })).toString('base64');
        await runBw(['edit', 'folder', f.id, encoded, '--session', bwSession]);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
  });

  // ─── Templates ─────────────────────────────────────────────────────────────

  ipcMain.handle('template:get-all', () => {
    return store.get('templates', []);
  });

  ipcMain.handle('template:save', (_, { template }) => {
    const templates = store.get('templates', []);
    const idx = templates.findIndex(t => t.id === template.id);
    if (idx >= 0) templates[idx] = template;
    else templates.push(template);
    store.set('templates', templates);
    return true;
  });

  ipcMain.handle('template:delete', (_, { id }) => {
    const templates = store.get('templates', []).filter(t => t.id !== id);
    store.set('templates', templates);
    return true;
  });

  // ─── Auto-Type (Windows only) ──────────────────────────────────────────────

  ipcMain.handle('autotype:send', async (_, { username, password, pressEnter }) => {
    const platform = process.platform;
    if (platform !== 'win32' && platform !== 'darwin') {
      return { success: false, error: 'Auto-Type is supported on Windows and macOS only.' };
    }

    try {
      mainWindow?.minimize();

      if (platform === 'win32') {
        // ── Windows: PowerShell SendKeys ──────────────────────────────────────
        function escSK(str) {
          return (str || '').replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`);
        }

        // Credentials are passed to PowerShell over stdin and never written to
        // disk. The script file itself contains no secrets — only the logic to
        // read the piped JSON — so a world-readable temp dir can't leak the
        // password the way a plaintext data file would.
        const scriptFile = path.join(app.getPath('temp'), `dw-at-${Date.now()}.ps1`);
        const scriptFileEsc = scriptFile.replace(/\\/g, '\\\\');

        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d = [Console]::In.ReadToEnd() | ConvertFrom-Json',
          'Start-Sleep -Milliseconds 900',
          'if ($d.username) { [System.Windows.Forms.SendKeys]::SendWait($d.username) }',
          'if ($d.username -and $d.password) { [System.Windows.Forms.SendKeys]::SendWait("{TAB}") }',
          'if ($d.password) { [System.Windows.Forms.SendKeys]::SendWait($d.password) }',
          'if ($d.pressEnter) { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }',
          `Remove-Item '${scriptFileEsc}' -ErrorAction SilentlyContinue`,
        ].join('\n');

        fs.writeFileSync(scriptFile, script, 'utf8');

        const proc = spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-File', scriptFile,
        ], { stdio: ['pipe', 'ignore', 'ignore'] });

        // Pipe the (SendKeys-escaped) credentials over stdin, then close it.
        proc.stdin.write(JSON.stringify({
          username: escSK(username || ''),
          password: escSK(password || ''),
          pressEnter: !!pressEnter,
        }));
        proc.stdin.end();
        proc.unref();

      } else {
        // ── macOS: pbcopy + osascript (handles all Unicode / special chars) ───
        // Uses clipboard as an intermediary so no AppleScript string escaping
        // is needed — works with any password including quotes, backslashes, etc.
        const pbcopy = (text) => new Promise((resolve, reject) => {
          const proc = spawn('pbcopy');
          proc.on('error', reject);
          proc.on('close', resolve);
          proc.stdin.write(text ?? '', 'utf8');
          proc.stdin.end();
        });

        // spawn osascript with shell:false so the AppleScript is passed as a
        // direct argument, not interpolated into a shell command string.
        const oса = (script) => new Promise((res, rej) => {
          const p = spawn('osascript', ['-e', script], { shell: false });
          p.on('error', rej);
          p.on('close', code => code === 0 ? res() : rej(new Error(`osascript exited ${code}`)));
        });

        // Short delay so DockWarden finishes minimising before we steal focus
        await new Promise(r => setTimeout(r, 900));

        if (username) {
          await pbcopy(username);
          await oса('tell application "System Events" to keystroke "v" using command down');
        }
        if (username && password) {
          await oса('tell application "System Events" to key code 48'); // Tab
        }
        if (password) {
          await pbcopy(password);
          await oса('tell application "System Events" to keystroke "v" using command down');
        }
        if (pressEnter) {
          await oса('tell application "System Events" to key code 36'); // Return
        }

        // Clear clipboard after 2 s so the password is not left behind
        setTimeout(() => pbcopy(''), 2000);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Backup ────────────────────────────────────────────────────────────────

  ipcMain.handle('backup:run-now', async () => {
    if (!bwSession) {
      return { success: false, error: 'Vault must be unlocked to create a backup' };
    }
    try {
      // Export the vault as an encrypted JSON file. The directory is re-validated
      // here so an externally tampered store can't redirect the export.
      const backupDir = getSafeBackupDir();
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outFile = path.join(backupDir, `dockwarden-backup-${timestamp}.json`);
      await runBw(['export', '--output', outFile, '--format', 'encrypted_json', '--session', bwSession]);

      const stats = fs.statSync(outFile);
      const sizeKb = Math.round(stats.size / 1024);
      const sizeStr = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;

      const history = store.get('backupHistory', []);
      const entry = { id: Date.now().toString(), timestamp: new Date().toISOString(), destination: 'Local', size: sizeStr, status: 'success', path: outFile };
      store.set('backupHistory', [entry, ...history].slice(0, 50));

      return { success: true, timestamp: new Date().toISOString(), size: sizeStr };
    } catch (err) {
      const history = store.get('backupHistory', []);
      const entry = { id: Date.now().toString(), timestamp: new Date().toISOString(), destination: 'Local', size: '—', status: 'failed' };
      store.set('backupHistory', [entry, ...history].slice(0, 50));
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backup:get-history', async () => {
    return store.get('backupHistory', []);
  });

  ipcMain.handle('backup:get-dir', async () => {
    return getSafeBackupDir();
  });

  // Dedicated, validated setter for the backup directory (the only sanctioned
  // way to change it — the key is blocked on the generic store bridge).
  ipcMain.handle('backup:set-dir', async (_, { dir }) => {
    const err = validateBackupDir(dir);
    if (err) return { success: false, error: err };
    store.set('backupDir', dir);
    return { success: true, dir };
  });

  // ─── App ───────────────────────────────────────────────────────────────────

  ipcMain.handle('app:get-store', async (_, key) => {
    if (PROTECTED_STORE_KEYS.has(key)) {
      console.warn('[security] blocked generic store read of protected key:', key);
      return null;
    }
    return store.get(key);
  });

  ipcMain.handle('app:set-store', async (_, { key, value }) => {
    if (PROTECTED_STORE_KEYS.has(key)) {
      console.warn('[security] blocked generic store write to protected key:', key);
      return false;
    }
    store.set(key, value);
    return true;
  });

  ipcMain.handle('app:notify', async (_, { title, body }) => {
    new Notification({ title, body }).show();
    return true;
  });

  ipcMain.handle('app:open-external', async (_, url) => {
    return { success: openExternalSafely(url) };
  });

  ipcMain.handle('app:get-version', () => app.getVersion());

  // ─── Primary account per site ─────────────────────────────────────────────

  ipcMain.handle('primary:get-all', () => store.get('primaryItems', []));

  ipcMain.handle('primary:set-all', (_, { items }) => {
    if (!Array.isArray(items)) return false;
    store.set('primaryItems', items.filter(id => typeof id === 'string'));
    return true;
  });

  // ─── Usage tracking (frequency-of-use sort) ────────────────────────────────

  const USAGE_STORE_KEY = 'usageCounts';

  ipcMain.handle('usage:increment', (_, { itemId }) => {
    if (!itemId || typeof itemId !== 'string') return 0;
    const counts = store.get(USAGE_STORE_KEY, {});
    counts[itemId] = (counts[itemId] || 0) + 1;
    store.set(USAGE_STORE_KEY, counts);
    return counts[itemId];
  });

  ipcMain.handle('usage:get-all', () => {
    return store.get(USAGE_STORE_KEY, {});
  });

  // ─── Settings helpers ──────────────────────────────────────────────────────

  ipcMain.handle('bw:get-config', async () => {
    return {
      bwEmail: store.get('bwEmail', ''),
      bwServerUrl: store.get('bwServerUrl', 'https://bitwarden.com'),
      bwCliPath: getBwPath(), // always returns the validated, decrypted value
      isSessionActive: !!bwSession,
    };
  });

  ipcMain.handle('bw:set-cli-path', async (_, { cliPath }) => {
    const err = validateBwCliPath(cliPath);
    if (err) return { success: false, error: err };

    const encrypted = encryptBwPath(cliPath);
    if (encrypted) {
      store.set('bwCliPathEnc', encrypted);
      store.set('bwCliPath', undefined); // remove any legacy plaintext
    } else {
      // safeStorage unavailable (rare); store plaintext but log a warning
      console.warn('[security] safeStorage unavailable — storing bwCliPath as plaintext');
      store.set('bwCliPath', cliPath);
    }
    return { success: true };
  });

  ipcMain.handle('bw:check-cli', async () => {
    try {
      const version = await runBw(['--version']);
      return { success: true, version: version.trim() };
    } catch {
      return { success: false, version: null };
    }
  });

  ipcMain.handle('bw:auto-detect', async () => {
    for (const candidate of getBwCandidates()) {
      try {
        if (fs.existsSync(candidate)) {
          const err = validateBwCliPath(candidate);
          if (!err) return { found: true, path: candidate };
        }
      } catch { /* skip */ }
    }
    return { found: false, path: null };
  });

  // ─── Offline Queue IPC ─────────────────────────────────────────────────────

  ipcMain.handle('offline:get-status', () => ({
    offline: isOfflineMode,
    queue: offlineQueue.map(sanitiseQueueEntry),
  }));

  ipcMain.handle('offline:set-mode', (_, { offline }) => {
    setOfflineMode(!!offline);
    return { offline: isOfflineMode };
  });

  ipcMain.handle('offline:discard-entry', (_, { entryId }) => {
    // If it was a queued create with a temp ID, remove the fake item from cache
    const entry = offlineQueue.find(e => e.id === entryId);
    if (entry?.operation === 'create' && entry.itemId?.startsWith('dw-offline-')) {
      itemsCache = itemsCache.filter(i => i.id !== entry.itemId);
    }
    removeFromOfflineQueue(entryId);
    mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
    return { success: true };
  });

  ipcMain.handle('offline:flush-queue', async () => {
    if (!bwSession) return { success: false, error: 'Vault is locked.' };
    return await flushOfflineQueue();
  });

  ipcMain.handle('offline:resolve-conflicts', async (_, { resolutions }) => {
    // resolutions: [{ entryId, action: 'apply'|'discard' }]
    if (!bwSession) return { success: false, error: 'Vault is locked.' };
    const results = [];
    for (const { entryId, action } of resolutions) {
      const entry = offlineQueue.find(e => e.id === entryId);
      if (!entry) continue;
      if (action === 'discard') {
        removeFromOfflineQueue(entryId);
        results.push({ entryId, applied: false });
        continue;
      }
      // Apply: re-run the edit with the queued patch
      try {
        const item = await runBwJson(['get', 'item', entry.itemId, '--session', bwSession]);
        applyPatchToItem(item, entry.patch);
        const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
        await runBw(['edit', 'item', entry.itemId, encoded, '--session', bwSession]);
        removeFromOfflineQueue(entryId);
        results.push({ entryId, applied: true });
      } catch (err) {
        results.push({ entryId, applied: false, error: err.message });
      }
    }
    mainWindow?.webContents.send('offline:queue-updated', { queue: offlineQueue.map(sanitiseQueueEntry) });
    return { success: true, results };
  });

  // ─── Password Generator IPC ────────────────────────────────────────────────

  ipcMain.handle('vault:generate', (_, opts = {}) => {
    // Sanitise options from renderer (untrusted input)
    const length  = Math.min(128, Math.max(8, Number(opts.length)  || 20));
    const upper   = opts.upper   !== false;
    const lower   = opts.lower   !== false;
    const numbers = opts.numbers !== false;
    const symbols = !!opts.symbols;
    const ambiguous = !!opts.ambiguous;
    return generatePassword({ length, upper, lower, numbers, symbols, ambiguous });
  });

  ipcMain.handle('vault:get-active-window', async () => {
    const rawTitle = await getActiveWindowTitle();
    return parseSiteFromTitle(rawTitle);
  });

  ipcMain.handle('generator:get-settings', () => {
    return store.get('generatorSettings', {
      defaultUsername: '',
      length: 20,
      upper: true,
      lower: true,
      numbers: true,
      symbols: true,
      ambiguous: false,
    });
  });

  ipcMain.handle('generator:set-settings', (_, settings) => {
    if (!settings || typeof settings !== 'object') return false;
    store.set('generatorSettings', settings);
    return true;
  });

  ipcMain.handle('generator:open', () => {
    openGeneratorWindow();
  });

  // ─── Auto-updater IPC ──────────────────────────────────────────────────────

  ipcMain.handle('updater:check', () => {
    if (!isDev) autoUpdater.checkForUpdates();
    return { checking: !isDev };
  });

  ipcMain.handle('updater:install-and-relaunch', () => {
    autoUpdater.quitAndInstall();
  });

  // ─── Expiry Policies ──────────────────────────────────────────────────────────

  const DEFAULT_EXPIRY_POLICIES = [
    {
      id: 'policy-90day',
      name: '90-Day Rotation',
      description: 'Flag login passwords not changed in 90 days',
      type: 'password-age',
      thresholdDays: 90,
      itemTypes: ['login'],
      enabled: true,
      notifyDaysBefore: 14,
    },
    {
      id: 'policy-1year',
      name: 'Annual Review',
      description: 'Flag all credentials not updated in 365 days',
      type: 'password-age',
      thresholdDays: 365,
      itemTypes: ['login', 'card'],
      enabled: false,
      notifyDaysBefore: 30,
    },
  ];

  ipcMain.handle('vault:get-expiry-policies', async () => {
    return store.get('expiryPolicies', DEFAULT_EXPIRY_POLICIES);
  });

  ipcMain.handle('vault:set-expiry-policies', async (_, { policies }) => {
    store.set('expiryPolicies', policies);
    return true;
  });

  // ─── Account Profiles ─────────────────────────────────────────────────────────

  const ACCOUNT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#f97316'];

  ipcMain.handle('account:get-profiles', async () => {
    return store.get('accountProfiles', []);
  });

  ipcMain.handle('account:add-profile', async (_, { profile }) => {
    const serverErr = validateServerUrl(profile?.serverUrl);
    if (serverErr) return { success: false, error: serverErr };
    const profiles = store.get('accountProfiles', []);
    const id = `acct-${Date.now()}`;
    const color = ACCOUNT_COLORS[profiles.length % ACCOUNT_COLORS.length];
    const newProfile = { ...profile, id, color };
    // Avoid duplicates by email + server
    const filtered = profiles.filter(p => !(p.email === newProfile.email && p.serverUrl === newProfile.serverUrl));
    store.set('accountProfiles', [...filtered, newProfile]);
    return newProfile;
  });

  ipcMain.handle('account:update-profile', async (_, { id, patch }) => {
    if (patch && 'serverUrl' in patch) {
      const serverErr = validateServerUrl(patch.serverUrl);
      if (serverErr) return { success: false, error: serverErr };
    }
    const profiles = store.get('accountProfiles', []);
    store.set('accountProfiles', profiles.map(p => p.id === id ? { ...p, ...patch } : p));
    return true;
  });

  ipcMain.handle('account:remove-profile', async (_, { id }) => {
    const profiles = store.get('accountProfiles', []);
    store.set('accountProfiles', profiles.filter(p => p.id !== id));
    if (store.get('activeAccountId') === id) store.set('activeAccountId', null);
    return true;
  });

  ipcMain.handle('account:get-active', async () => {
    return store.get('activeAccountId', null);
  });

  ipcMain.handle('account:set-active', async (_, { id }) => {
    store.set('activeAccountId', id);
    return true;
  });

  ipcMain.handle('account:switch', async (_, { id }) => {
    const profiles = store.get('accountProfiles', []);
    const profile = profiles.find(p => p.id === id);
    if (!profile) return { success: false, error: 'Profile not found' };
    // Lock vault, set new email/server, redirect to unlock so the stored config is picked up
    bwSession = null;
    store.set('bwEmail', profile.email);
    if (profile.serverUrl) store.set('bwServerUrl', profile.serverUrl);
    store.set('activeAccountId', id);
    mainWindow?.webContents.send('navigate', '/unlock');
    return { success: true };
  });

  // ─── Generic Settings ─────────────────────────────────────────────────────────

  ipcMain.handle('vault:get-setting', async (_, { key, defaultValue }) => {
    if (PROTECTED_STORE_KEYS.has(key)) {
      console.warn('[security] blocked generic setting read of protected key:', key);
      return defaultValue ?? null;
    }
    return store.get(key, defaultValue ?? null);
  });

  ipcMain.handle('vault:set-setting', async (_, { key, value }) => {
    if (PROTECTED_STORE_KEYS.has(key)) {
      console.warn('[security] blocked generic setting write to protected key:', key);
      return false;
    }
    store.set(key, value);
    return true;
  });

  // ─── Vault Snapshots ──────────────────────────────────────────────────────────

  ipcMain.handle('snapshot:get-all', async () => {
    const snaps = store.get('vaultSnapshots', []);
    // Return metadata only (no items array) for the list view
    return snaps.map(s => ({ id: s.id, label: s.label, timestamp: s.timestamp, itemCount: s.itemCount }));
  });

  ipcMain.handle('snapshot:save-manual', async (_, { label }) => {
    if (!bwSession || itemsCache.length === 0) return { success: false, error: 'Vault is locked or empty' };
    const snaps = store.get('vaultSnapshots', []);
    const newSnap = {
      id: `snap-${Date.now()}`,
      label: label || 'Manual snapshot',
      timestamp: new Date().toISOString(),
      itemCount: itemsCache.length,
      items: itemsCache.map(i => ({
        id: i.id, name: i.name, type: i.type,
        lastModified: i.lastModified, folderId: i.folderId || null,
      })),
    };
    store.set('vaultSnapshots', [newSnap, ...snaps].slice(0, 50));
    return { success: true, snapshot: { id: newSnap.id, label: newSnap.label, timestamp: newSnap.timestamp, itemCount: newSnap.itemCount } };
  });

  ipcMain.handle('snapshot:delete', async (_, { id }) => {
    const snaps = store.get('vaultSnapshots', []);
    store.set('vaultSnapshots', snaps.filter(s => s.id !== id));
    return true;
  });

  ipcMain.handle('snapshot:diff', async (_, { idA, idB }) => {
    const snaps = store.get('vaultSnapshots', []);
    const snapA = snaps.find(s => s.id === idA);
    const snapB = snaps.find(s => s.id === idB);
    if (!snapA || !snapB) return { success: false, error: 'Snapshot not found' };

    const aMap = new Map(snapA.items.map(i => [i.id, i]));
    const bMap = new Map(snapB.items.map(i => [i.id, i]));

    const added = [];
    const deleted = [];
    const modified = [];
    let unchanged = 0;

    for (const [id, item] of bMap) {
      if (!aMap.has(id)) added.push(item);
    }
    for (const [id, item] of aMap) {
      if (!bMap.has(id)) deleted.push(item);
    }
    for (const [id, aItem] of aMap) {
      const bItem = bMap.get(id);
      if (bItem) {
        if (aItem.lastModified !== bItem.lastModified || aItem.name !== bItem.name) {
          modified.push({ before: aItem, after: bItem });
        } else {
          unchanged++;
        }
      }
    }

    return { success: true, diff: { added, deleted, modified, unchanged, snapA: { label: snapA.label, timestamp: snapA.timestamp }, snapB: { label: snapB.label, timestamp: snapB.timestamp } } };
  });

  // ─── Custom Icons ─────────────────────────────────────────────────────────────

  ipcMain.handle('icon:get-all', async () => {
    return store.get('customIcons', {});
  });

  ipcMain.handle('icon:set', async (_, { itemId, icon }) => {
    if (typeof itemId !== 'string' || itemId === '__proto__' || itemId === 'constructor' || itemId === 'prototype') {
      return false;
    }
    const icons = store.get('customIcons', {});
    icons[itemId] = icon;
    store.set('customIcons', icons);
    return true;
  });

  ipcMain.handle('icon:remove', async (_, { itemId }) => {
    if (typeof itemId !== 'string') return false;
    const icons = store.get('customIcons', {});
    delete icons[itemId];
    store.set('customIcons', icons);
    return true;
  });

  // ─── Watchtower ────────────────────────────────────────────────────────────

  let watchtowerActive = false;

  ipcMain.handle('watchtower:start-scan', async (_event, serializedItems, settings) => {
    // Validate input shape — a malformed call must not leave the scan flag stuck
    // (which would permanently block future scans) or crash mid-iteration.
    if (!Array.isArray(serializedItems)) {
      return { success: false, error: 'Invalid scan payload' };
    }

    const crypto = require('crypto');
    let zxcvbn;
    try { zxcvbn = require('zxcvbn'); } catch { zxcvbn = null; }

    // Default all checks to enabled if settings not provided
    const checks = settings?.enabledChecks ?? {};
    const enabled = {
      breachedPasswords: checks.breachedPasswords !== false,
      weakPasswords:     checks.weakPasswords     !== false,
      reusedPasswords:   checks.reusedPasswords   !== false,
      insecureUris:      checks.insecureUris       !== false,
      missingTotp:       checks.missingTotp        !== false,
      duplicateItems:    checks.duplicateItems     !== false,
    };

    watchtowerActive = true;
    const startTime = Date.now();
    const allFindings = [];

    const sendProgress = (phase, processed, total) => {
      if (!watchtowerActive) return;
      mainWindow?.webContents.send('watchtower:scan-progress', {
        phase, totalItems: total, processedItems: processed, startedAt: startTime,
      });
    };

    // ── Helper: k-Anonymity HIBP range lookup ────────────────────────────────
    async function hibpCheck(password) {
      const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = sha1.substring(0, 5);
      const suffix = sha1.substring(5);
      try {
        const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
          headers: { 'User-Agent': 'DockWarden-Watchtower/1.0', 'Add-Padding': 'true' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return 0;
        const text = await res.text();
        for (const line of text.split('\r\n')) {
          const [s, c] = line.split(':');
          if (s === suffix) return parseInt(c, 10) || 0;
        }
      } catch { /* network error — skip */ }
      return 0;
    }

    // ── Helper: delay for rate limiting ──────────────────────────────────────
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // ── PHASE 1: Breached passwords (HIBP) ───────────────────────────────────
    sendProgress('checking_breaches', 0, serializedItems.length);
    if (enabled.breachedPasswords) {
      const pwToIds = new Map();
      for (const item of serializedItems) {
        if (!item.password) continue;
        const ids = pwToIds.get(item.password) ?? [];
        ids.push(item.id);
        pwToIds.set(item.password, ids);
      }

      let breachProcessed = 0;
      const breachCounts = new Map();

      for (const [password, ids] of pwToIds) {
        if (!watchtowerActive) break;
        const count = await hibpCheck(password);
        for (const id of ids) breachCounts.set(id, count);
        breachProcessed += ids.length;
        sendProgress('checking_breaches', breachProcessed, serializedItems.length);
        await delay(120); // ~8 req/sec, safely under HIBP's 10/sec free-tier limit
      }

      for (const [itemId, count] of breachCounts) {
        if (count === 0) continue;
        const item = serializedItems.find(i => i.id === itemId);
        if (!item) continue;
        allFindings.push({
          id: crypto.randomUUID(),
          category: 'breached_password',
          severity: 'critical',
          vaultItemId: itemId,
          vaultItemName: item.name,
          vaultItemUri: item.uris?.[0] ?? null,
          message: `Password found in ${count.toLocaleString()} data breach${count !== 1 ? 'es' : ''}`,
          detail: 'Change this password immediately — it has been publicly exposed',
          actionLabel: 'Change Password',
          dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
        });
      }
    }

    // ── PHASE 2: Password strength (zxcvbn) ──────────────────────────────────
    if (!watchtowerActive) goto_complete();
    sendProgress('checking_strength', 0, serializedItems.length);
    if (enabled.weakPasswords) {
      for (const item of serializedItems) {
        if (!item.password) continue;
        let score = 2, crackTime = 'unknown', feedback = [];
        if (zxcvbn) {
          const r = zxcvbn(item.password, item.username ? [item.username] : []);
          score = r.score;
          crackTime = r.crack_times_display?.offline_slow_hashing_1e4_per_second ?? 'unknown';
          feedback = [
            ...(r.feedback?.warning ? [r.feedback.warning] : []),
            ...(r.feedback?.suggestions ?? []),
          ];
        } else {
          const pw = item.password;
          score = pw.length < 8 ? 0 : pw.length < 10 ? 1 : 2;
          crackTime = score === 0 ? 'instantly' : 'minutes';
        }
        if (score <= 1) {
          allFindings.push({
            id: crypto.randomUUID(),
            category: 'weak_password',
            severity: 'high',
            vaultItemId: item.id,
            vaultItemName: item.name,
            vaultItemUri: item.uris?.[0] ?? null,
            message: `Weak password — estimated crack time: ${crackTime}`,
            detail: feedback.length > 0 ? feedback.slice(0, 2).join('. ') : null,
            actionLabel: 'Generate Stronger',
            dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
          });
        }
      }
    }
    sendProgress('checking_strength', serializedItems.length, serializedItems.length);

    // ── PHASE 3: Reused passwords ─────────────────────────────────────────────
    if (!watchtowerActive) goto_complete();
    sendProgress('checking_reuse', 0, serializedItems.length);
    if (enabled.reusedPasswords) {
      const pwGroups = new Map();
      for (const item of serializedItems) {
        if (!item.password) continue;
        const g = pwGroups.get(item.password) ?? [];
        g.push(item);
        pwGroups.set(item.password, g);
      }
      for (const group of pwGroups.values()) {
        if (group.length < 2) continue;
        for (const item of group) {
          const others = group.filter(g => g.id !== item.id).map(g => g.name).slice(0, 3).join(', ');
          allFindings.push({
            id: crypto.randomUUID(),
            category: 'reused_password',
            severity: 'medium',
            vaultItemId: item.id,
            vaultItemName: item.name,
            vaultItemUri: item.uris?.[0] ?? null,
            message: `Password reused across ${group.length} accounts`,
            detail: `Also used by: ${others}`,
            actionLabel: 'Change Password',
            dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
          });
        }
      }
    }

    // ── PHASE 4: Insecure URIs ────────────────────────────────────────────────
    if (!watchtowerActive) goto_complete();
    sendProgress('checking_uris', 0, serializedItems.length);
    if (enabled.insecureUris) {
      for (const item of serializedItems) {
        for (const uri of (item.uris ?? [])) {
          if (!uri.startsWith('http://')) continue;
          try {
            const u = new URL(uri);
            if (['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.hostname.endsWith('.local')) continue;
          } catch { continue; }
          allFindings.push({
            id: crypto.randomUUID(),
            category: 'insecure_uri',
            severity: 'medium',
            vaultItemId: item.id,
            vaultItemName: item.name,
            vaultItemUri: uri,
            message: 'Login page uses unencrypted HTTP',
            detail: `${uri} — credentials are sent in plain text`,
            actionLabel: 'Open Item',
            dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
          });
          break;
        }
      }
    }

    // ── PHASE 5: Missing TOTP ─────────────────────────────────────────────────
    if (!watchtowerActive) goto_complete();
    sendProgress('checking_totp', 0, serializedItems.length);
    if (enabled.missingTotp) {
      const totpDomains = new Set([
        'google.com', 'github.com', 'gitlab.com', 'bitbucket.org',
        'amazon.com', 'aws.amazon.com', 'microsoft.com', 'live.com',
        'outlook.com', 'apple.com', 'facebook.com', 'twitter.com',
        'x.com', 'instagram.com', 'linkedin.com', 'reddit.com',
        'discord.com', 'slack.com', 'dropbox.com', 'paypal.com',
        'stripe.com', 'twitch.tv', 'steam.com', 'epicgames.com',
        'cloudflare.com', 'digitalocean.com', 'heroku.com',
        'namecheap.com', 'godaddy.com', 'bitwarden.com',
        'proton.me', 'protonmail.com', 'coinbase.com', 'binance.com',
        'npmjs.com', 'hub.docker.com', 'shopify.com', 'figma.com',
        'notion.so', 'atlassian.com', 'vercel.com', 'netlify.com',
        'railway.app', 'render.com',
      ]);
      for (const item of serializedItems) {
        if (item.totpUri) continue;
        const matchedDomain = (item.uris ?? [])
          .map(uri => { try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { return null; } })
          .find(host => host && totpDomains.has(host));
        if (matchedDomain) {
          allFindings.push({
            id: crypto.randomUUID(),
            category: 'missing_totp',
            severity: 'low',
            vaultItemId: item.id,
            vaultItemName: item.name,
            vaultItemUri: item.uris?.[0] ?? null,
            message: `${matchedDomain} supports 2FA but none is configured`,
            detail: 'Adding TOTP significantly improves account security',
            actionLabel: 'Set Up 2FA',
            dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
          });
        }
      }
    }

    // ── PHASE 6: Duplicate items ──────────────────────────────────────────────
    if (!watchtowerActive) goto_complete();
    sendProgress('checking_duplicates', 0, serializedItems.length);
    if (enabled.duplicateItems) {
      const seen = new Map();
      for (const item of serializedItems) {
        if (!item.username || !item.uris?.length) continue;
        let host;
        try { host = new URL(item.uris[0]).hostname.replace(/^www\./, ''); } catch { continue; }
        const key = `${host}|${item.username.toLowerCase()}`;
        if (seen.has(key)) {
          const original = seen.get(key);
          allFindings.push({
            id: crypto.randomUUID(),
            category: 'duplicate_item',
            severity: 'info',
            vaultItemId: item.id,
            vaultItemName: item.name,
            vaultItemUri: item.uris[0],
            message: `Possible duplicate of "${original.name}"`,
            detail: `Both use ${item.username} on ${host}`,
            actionLabel: 'Review',
            dismissedAt: null, snoozedUntil: null, detectedAt: Date.now(),
          });
        } else {
          seen.set(key, item);
        }
      }
    }

    // ── Health score ──────────────────────────────────────────────────────────
    function goto_complete() {}

    const n = serializedItems.length || 1;
    const count = (cat) => allFindings.filter(f => f.category === cat).length;

    const breachFree     = Math.max(0, Math.round(((n - count('breached_password')) / n) * 100));
    const strengthScore  = Math.max(0, Math.round(((n - count('weak_password'))     / n) * 100));
    const uniquenessScore= Math.max(0, Math.round(((n - count('reused_password'))   / n) * 100));
    const httpsScore     = Math.max(0, Math.round(((n - count('insecure_uri'))      / n) * 100));
    const mfaCoverage    = Math.max(0, Math.round(((n - count('missing_totp'))      / n) * 100));
    const overall        = Math.round(
      breachFree * 0.30 + strengthScore * 0.25 + uniquenessScore * 0.20 +
      httpsScore * 0.10 + mfaCoverage * 0.15
    );

    const results = {
      findings: allFindings,
      scannedAt: Date.now(),
      scannedItemCount: serializedItems.length,
      scanDurationMs: Date.now() - startTime,
      scores: { overall, breachFree, strengthScore, uniquenessScore, httpsScore, mfaCoverage },
    };

    watchtowerActive = false;

    // Update tray tooltip with issue count
    const totalIssues = allFindings.length;
    const criticalIssues = allFindings.filter(f => f.severity === 'critical').length;
    if (tray) {
      if (totalIssues === 0) {
        tray.setToolTip('DockWarden — Vault Healthy ✓');
      } else {
        const critLabel = criticalIssues > 0 ? ` · ${criticalIssues} critical` : '';
        tray.setToolTip(`DockWarden — ${totalIssues} security issue${totalIssues !== 1 ? 's' : ''}${critLabel}`);
      }
    }

    mainWindow?.webContents.send('watchtower:scan-results', results);
    return results;
  });

  ipcMain.on('watchtower:cancel-scan', () => {
    watchtowerActive = false;
  });

  // Update tray badge from renderer (e.g. after dismiss/snooze changes active count)
  ipcMain.on('watchtower:update-badge', (_event, { total, critical }) => {
    if (!tray) return;
    if (total === 0) {
      tray.setToolTip('DockWarden — Vault Healthy ✓');
    } else {
      const critLabel = critical > 0 ? ` · ${critical} critical` : '';
      tray.setToolTip(`DockWarden — ${total} security issue${total !== 1 ? 's' : ''}${critLabel}`);
    }
  });
}

function extractBwError(msg) {
  if (!msg) return 'Unknown error';
  // Strip the leaked command line (e.g. 'Command failed: "bw" "login" ...')
  const stripped = msg.replace(/Command failed:[^\n]*/i, '').trim();
  const source = stripped || msg;
  const match = source.match(/Error:\s*(.+)/i);
  if (match) return match[1].trim();
  // Return the first meaningful non-empty line
  const firstLine = source.split('\n').map(l => l.trim()).find(l => l.length > 0);
  return firstLine || source.substring(0, 200);
}

function isTwoFactorRequired(msg) {
  const lower = (msg || '').toLowerCase();
  return (
    lower.includes('code is required') ||
    lower.includes('two-step') ||
    lower.includes('two factor') ||
    lower.includes('twofactor') ||
    lower.includes('2fa') ||
    lower.includes('two_factor') ||
    lower.includes('mfa') ||
    lower.includes('verification code') ||
    lower.includes('otp') ||
    (lower.includes('token') && lower.includes('required')) ||
    (lower.includes('invalid') && lower.includes('login') && lower.includes('code'))
  );
}

function isAlreadyLoggedIn(msg) {
  const lower = (msg || '').toLowerCase();
  return lower.includes('already logged in');
}

// When bw says the user is already logged in, just unlock the vault with their password.
function handleAlreadyLoggedIn(email, serverUrl, env, settle) {
  console.log('[DockWarden] Already logged in — attempting unlock');
  runBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], env)
    .then(out => {
      bwSession = out.trim();
      store.set('bwEmail', email);
      if (serverUrl) store.set('bwServerUrl', serverUrl);
      // Ensure the account profile is saved even for the "already logged in" path
      saveAccountProfile(email, serverUrl || 'https://bitwarden.com');
      settle({ success: true });
    })
    .catch(err => {
      settle({ success: false, error: extractBwError(String(err.message)) });
    });
}

/**
 * Upsert an account profile in the local store and mark it as active.
 * Safe to call multiple times — avoids duplicates by email + serverUrl.
 */
function saveAccountProfile(email, serverUrl) {
  const profiles = store.get('accountProfiles', []);
  const srv = serverUrl || 'https://bitwarden.com';
  const existing = profiles.find(p => p.email === email && p.serverUrl === srv);
  if (existing) {
    store.set('activeAccountId', existing.id);
    return;
  }
  const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#f97316'];
  const id = `acct-${Date.now()}`;
  const color = COLORS[profiles.length % COLORS.length];
  const prof = { id, name: email.split('@')[0] || email, email, serverUrl: srv, color };
  store.set('accountProfiles', [...profiles, prof]);
  store.set('activeAccountId', id);
}


// ─── Renderer hardening: navigation, window.open, and CSP ─────────────────────

// The only origins the renderer is ever allowed to live at.
const ALLOWED_RENDERER_ORIGINS = new Set([
  'http://localhost:4200', // dev server
  'file://',               // packaged build
]);

function isAllowedRendererTarget(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol === 'file:') return true; // packaged app assets
    return ALLOWED_RENDERER_ORIGINS.has(u.origin);
  } catch {
    return false;
  }
}

function setupWebContentsSecurity() {
  app.on('web-contents-created', (_event, contents) => {
    // Block in-place navigation to anything other than our own app origin.
    // External http(s) links are diverted to the system browser instead of
    // hijacking a window that holds the privileged electronAPI bridge.
    const navigationGuard = (event, navigationUrl) => {
      if (!isAllowedRendererTarget(navigationUrl)) {
        event.preventDefault();
        openExternalSafely(navigationUrl);
      }
    };
    contents.on('will-navigate', navigationGuard);
    // Also catch server/meta redirects, which fire will-redirect (not will-navigate).
    contents.on('will-redirect', navigationGuard);

    // Never let the renderer spawn new Electron windows. Safe external links
    // are opened in the system browser; everything else is denied.
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url);
      return { action: 'deny' };
    });

    // Defense-in-depth: forbid attaching <webview> with custom preferences.
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function setupContentSecurityPolicy() {
  const prodCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Angular + custom-CSS feature inject <style>
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

  // Dev needs the ng live-reload websocket and eval-based HMR tooling.
  const devCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http://localhost:4200 ws://localhost:4200",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');

  const csp = isDev ? devCsp : prodCsp;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // Deny all renderer permission requests (camera, geolocation, etc.) — the app
  // needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
}

app.whenReady().then(() => {
  setupContentSecurityPolicy();
  setupWebContentsSecurity();
  createMainWindow();
  createTray();
  registerGlobalShortcuts();
  loadOfflineQueue();   // Restore any queued edits from the previous session
  setupIpcHandlers();

  // ─── Auto-updater ──────────────────────────────────────────────────────────
  // Skip update checks in dev mode (no published release to compare against)
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      mainWindow?.webContents.send('updater:status', { status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('updater:status', { status: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('updater:status', { status: 'up-to-date' });
    });

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('updater:status', {
        status: 'downloading',
        percent: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('updater:status', { status: 'downloaded', version: info.version });
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update ready',
        message: `DockWarden ${info.version} is ready to install.`,
        detail: 'The update will be applied the next time you quit and reopen the app, or you can restart now.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });

    autoUpdater.on('error', (err) => {
      mainWindow?.webContents.send('updater:status', { status: 'error', error: err.message });
    });

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  else mainWindow?.show();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
