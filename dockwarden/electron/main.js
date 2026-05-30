const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, Notification, shell, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { autoUpdater } = require('electron-updater');

const execAsync = promisify(exec);

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
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue;
  }
  set(key, value) {
    this._init();
    this._data[key] = value;
    try { fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2)); } catch {}
  }
}

const store = new Store();

// ─── In-memory session (never persisted to disk) ──────────────────────────────
let bwSession = null;
let pending2FA = null;      // { email, serverUrl, env }
let pending2FAProcess = null; // Live spawn process holding the auth session open

function getBwPath() {
  return store.get('bwCliPath', 'bw');
}

// Run a bw CLI command and return parsed JSON output
async function runBw(args, env = {}) {
  const bwPath = getBwPath();
  const mergedEnv = { ...process.env, ...env };
  // Quote args to handle spaces; use shell so PATH is resolved on all platforms
  const quotedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const cmd = `"${bwPath}" ${quotedArgs}`;
  const { stdout } = await execAsync(cmd, {
    env: mergedEnv,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trim();
}

async function runBwJson(args, env = {}) {
  const output = await runBw(args, env);
  return JSON.parse(output);
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
      sandbox: false,
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

  mainWindow.webContents.openDevTools();

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
      sandbox: false,
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

    const env = { BW_PASSWORD: password };
    try { if (serverUrl) await runBw(['config', 'server', serverUrl]); } catch { /* non-fatal */ }

    return new Promise((resolve) => {
      const bwPath = getBwPath();
      // No --nointeraction: bw stays alive waiting on stdin for the 2FA code,
      // so we can pipe it later without triggering a second email.
      const proc = spawn(bwPath,
        ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw'],
        { env: { ...process.env, ...env }, shell: true, windowsHide: true,
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
        settle({ success: false, error: err.message });
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
      const bwPath = getBwPath();
      const proc = spawn(bwPath,
        ['login', email, '--passwordenv', 'BW_PASSWORD', '--method', String(method), '--raw'],
        { env: { ...process.env, ...env }, shell: true, windowsHide: true,
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
        resolve({ success: false, error: err.message });
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

      return {
        success: true,
        itemCount: items.length,
        syncedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vault:edit-item', async (_, { id, patch }) => {
    if (!bwSession) return { success: false, error: 'Not unlocked' };
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
    try {
      // bw create item expects base64-encoded JSON (same as what `bw encode` produces)
      const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
      const result = await runBw(['create', 'item', encoded, '--session', bwSession]);
      const created = JSON.parse(result);
      return { success: true, item: mapBwItem(created) };
    } catch (err) {
      return { success: false, error: extractBwError(err.message) };
    }
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
        const ts         = Date.now();
        const dataFile   = path.join(app.getPath('temp'), `dw-at-data-${ts}.json`);
        const scriptFile = path.join(app.getPath('temp'), `dw-at-${ts}.ps1`);

        fs.writeFileSync(dataFile, JSON.stringify({
          username: escSK(username || ''),
          password: escSK(password || ''),
          pressEnter: !!pressEnter,
        }), 'utf8');

        const dataFileEsc   = dataFile.replace(/\\/g, '\\\\');
        const scriptFileEsc = scriptFile.replace(/\\/g, '\\\\');

        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          `$d = Get-Content '${dataFileEsc}' | ConvertFrom-Json`,
          'Start-Sleep -Milliseconds 900',
          'if ($d.username) { [System.Windows.Forms.SendKeys]::SendWait($d.username) }',
          'if ($d.username -and $d.password) { [System.Windows.Forms.SendKeys]::SendWait("{TAB}") }',
          'if ($d.password) { [System.Windows.Forms.SendKeys]::SendWait($d.password) }',
          'if ($d.pressEnter) { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }',
          `Remove-Item '${dataFileEsc}' -ErrorAction SilentlyContinue`,
          `Remove-Item '${scriptFileEsc}' -ErrorAction SilentlyContinue`,
        ].join('\n');

        fs.writeFileSync(scriptFile, script, 'utf8');

        const proc = spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-File', scriptFile,
        ], { detached: true, stdio: 'ignore' });
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

        const oса = (script) => execAsync(`osascript -e '${script}'`);

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
      // Export the vault as an encrypted JSON file
      const backupDir = store.get('backupDir', path.join(app.getPath('documents'), 'DockWarden-Backups'));
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

  // ─── App ───────────────────────────────────────────────────────────────────

  ipcMain.handle('app:get-store', async (_, key) => {
    return store.get(key);
  });

  ipcMain.handle('app:set-store', async (_, { key, value }) => {
    store.set(key, value);
    return true;
  });

  ipcMain.handle('app:notify', async (_, { title, body }) => {
    new Notification({ title, body }).show();
    return true;
  });

  ipcMain.handle('app:open-external', async (_, url) => {
    shell.openExternal(url);
  });

  // ─── Settings helpers ──────────────────────────────────────────────────────

  ipcMain.handle('bw:get-config', async () => {
    return {
      bwEmail: store.get('bwEmail', ''),
      bwServerUrl: store.get('bwServerUrl', 'https://bitwarden.com'),
      bwCliPath: store.get('bwCliPath', 'bw'),
      isSessionActive: !!bwSession,
    };
  });

  ipcMain.handle('bw:set-cli-path', async (_, { cliPath }) => {
    store.set('bwCliPath', cliPath);
    return true;
  });

  ipcMain.handle('bw:check-cli', async () => {
    try {
      const version = await runBw(['--version']);
      return { success: true, version: version.trim() };
    } catch {
      return { success: false, version: null };
    }
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
    return store.get(key, defaultValue ?? null);
  });

  ipcMain.handle('vault:set-setting', async (_, { key, value }) => {
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
    const icons = store.get('customIcons', {});
    icons[itemId] = icon;
    store.set('customIcons', icons);
    return true;
  });

  ipcMain.handle('icon:remove', async (_, { itemId }) => {
    const icons = store.get('customIcons', {});
    delete icons[itemId];
    store.set('customIcons', icons);
    return true;
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


app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerGlobalShortcuts();
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
