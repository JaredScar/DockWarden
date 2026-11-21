'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const power = require('./power-lib');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isItemId(id) {
  return typeof id === 'string' && /^[0-9a-f-]{32,40}$/i.test(id);
}

function loopback(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokensEqual(expected, given) {
  if (typeof given !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function friendlyImportError(err) {
  const msg = String(err && err.message || err || 'Import failed');
  if (/argon2|NotImplemented/i.test(msg)) {
    return 'This database uses Argon2 in a form DockWarden could not run. In KeePass choose File → Export → KeePass XML (2.x) and import that file. The XML keeps expiry, auto-type, history, and attachments.';
  }
  if (/invalid key|InvalidKey|credential/i.test(msg)) return 'That database password did not unlock the file.';
  return msg.slice(0, 400);
}

function createPowerFeatures(deps) {
  const {
    ipcMain, app, BrowserWindow, dialog, Notification, screen,
    store, getSession, getItems, setItems, runBw, runBwJson, applyPatchToItem,
    getActiveWindowTitle, openLauncherWindow, isLauncherOpen, closeLauncher,
    getMainWindow, distIndexPath, isDev,
  } = deps;

  let token = crypto.randomBytes(32).toString('hex');
  let server = null;
  let port = 0;
  const hits = [];
  let largePayload = null;
  let largeWindow = null;
  let autotypeContext = { title: '', matches: [] };
  const pickedFiles = new Set();
  const localMarks = {};

  function tokenFile() {
    return path.join(app.getPath('userData'), 'dw-run.json');
  }

  function syncSession() {
    const file = tokenFile();
    if (!getSession() || !port) {
      token = crypto.randomBytes(32).toString('hex');
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
      return;
    }
    try {
      fs.writeFileSync(file, JSON.stringify({ port, token }), { mode: 0o600 });
    } catch { /* the CLI will report that DockWarden is unavailable */ }
  }

  function allowRequest() {
    const now = Date.now();
    while (hits.length && now - hits[0] > 60000) hits.shift();
    if (hits.length >= 30) return false;
    hits.push(now);
    return true;
  }

  function startServer() {
    if (server) return;
    server = http.createServer(async (req, res) => {
      const send = (status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (!loopback(req)) { send(403, { error: 'Forbidden' }); return; }
      if (req.method !== 'POST' || req.url !== '/resolve') { send(404, { error: 'Not found' }); return; }
      if (!allowRequest()) { send(429, { error: 'Too many requests' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { send(400, { error: 'Invalid request' }); return; }
      if (!getSession() || !tokensEqual(token, body.token)) {
        send(401, { error: 'DockWarden is locked or not running. Unlock the vault and try again.' });
        return;
      }
      const refs = Array.isArray(body.refs) ? body.refs.slice(0, 32) : [];
      if (!refs.length || refs.some(ref => typeof ref !== 'string' || ref.length > 300)) {
        send(400, { error: 'Provide up to 32 dw:// references' });
        return;
      }
      const values = {};
      for (const ref of refs) {
        const result = power.resolveRef(getItems(), ref);
        if (result.error) { send(404, { error: result.error }); return; }
        values[ref] = result.value;
      }
      try {
        new Notification({
          title: 'Secret run',
          body: `Supplied ${refs.length} secret${refs.length === 1 ? '' : 's'} to a local command.`,
        }).show();
      } catch { /* notifications are optional */ }
      send(200, { values });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = address && address.port ? address.port : 0;
      syncSession();
    });
  }

  function stop() {
    syncSession();
    if (server) server.close();
    server = null;
    clearLarge();
  }

  function cliExample() {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'dw-run.js')
      : path.join(__dirname, 'dw-run.js');
    const sample = 'run --env API_TOKEN=dw://Item/password -- npm start';
    if (!app.isPackaged) return `node "${script}" ${sample}`;
    if (process.platform === 'win32') {
      return `$env:ELECTRON_RUN_AS_NODE=1; & "${process.execPath}" "${script}" ${sample}`;
    }
    return `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${script}" ${sample}`;
  }

  function notifyItemsChanged() {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('vault:items-changed');
  }

  function markLocal(id) {
    if (!id) return;
    const now = Date.now();
    localMarks[id] = now;
    const marks = store.get('localEditMarks', {});
    marks[id] = now;
    store.set('localEditMarks', marks);
  }

  function recordSync(items) {
    const prev = store.get('vaultFingerprint', []);
    const marks = { ...store.get('localEditMarks', {}), ...localMarks };
    const next = (items || []).map(power.snapshotItem);
    const result = power.inboxFromFingerprints(prev, next, marks);
    store.set('vaultFingerprint', next);
    store.set('localEditMarks', result.marks);
    for (const key of Object.keys(localMarks)) delete localMarks[key];
    if (result.records.length) {
      const inbox = store.get('changeInbox', []);
      store.set('changeInbox', [...result.records, ...inbox].slice(0, 200));
      const remote = result.records.filter(row => row.origin === 'remote');
      if (remote.length === 1) {
        new Notification({ title: 'Vault changed', body: `${remote[0].itemName} changed outside DockWarden.` }).show();
      } else if (remote.length > 1) {
        new Notification({ title: 'Vault changed', body: `${remote.length} items changed outside DockWarden.` }).show();
      }
    }
    return result.records;
  }

  async function propagateLinks(sourceId, patch) {
    const updated = [];
    const session = getSession();
    if (!session) return updated;
    const wantUser = patch && patch.username !== undefined;
    const wantPass = patch && patch.password !== undefined;
    if (!wantUser && !wantPass) return updated;
    for (const item of getItems()) {
      if (!item || item.id === sourceId) continue;
      const linkUser = wantUser && item.links && item.links.username === sourceId;
      const linkPass = wantPass && item.links && item.links.password === sourceId;
      if (!linkUser && !linkPass) continue;
      try {
        const raw = await runBwJson(['get', 'item', item.id, '--session', session]);
        raw.login = raw.login || {};
        if (linkUser) raw.login.username = patch.username || null;
        if (linkPass) raw.login.password = patch.password || null;
        const encoded = Buffer.from(JSON.stringify(raw)).toString('base64');
        await runBw(['edit', 'item', item.id, encoded, '--session', session]);
        markLocal(item.id);
        if (linkUser) item.username = patch.username || null;
        if (linkPass) item.password = patch.password || null;
        updated.push({ id: item.id, username: item.username, password: item.password });
      } catch (err) {
        updated.push({ id: item.id, error: err.message });
      }
    }
    return updated;
  }

  function loadRoute(win, route) {
    if (fs.existsSync(distIndexPath) && !isDev) win.loadFile(distIndexPath, { hash: route });
    else win.loadURL(`http://localhost:4200/#${route}`);
  }

  async function typeWindows(steps) {
    const esc = (value) => String(value || '').replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`);
    const safeSteps = steps.map(step => step.kind === 'text' ? { kind: 'text', value: esc(step.value) } : step);
    const scriptFile = path.join(app.getPath('temp'), `dw-at-${Date.now()}.ps1`);
    const scriptFileEsc = scriptFile.replace(/\\/g, '\\\\');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      'Start-Sleep -Milliseconds 400',
      'foreach ($step in @($d.steps)) {',
      '  if ($step.kind -eq "delay") { Start-Sleep -Milliseconds ([int]$step.ms); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "TAB") { [System.Windows.Forms.SendKeys]::SendWait("{TAB}"); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "ENTER") { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "SPACE") { [System.Windows.Forms.SendKeys]::SendWait(" "); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "UP") { [System.Windows.Forms.SendKeys]::SendWait("{UP}"); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "DOWN") { [System.Windows.Forms.SendKeys]::SendWait("{DOWN}"); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "LEFT") { [System.Windows.Forms.SendKeys]::SendWait("{LEFT}"); continue }',
      '  if ($step.kind -eq "key" -and $step.value -eq "RIGHT") { [System.Windows.Forms.SendKeys]::SendWait("{RIGHT}"); continue }',
      '  if ($step.kind -eq "text" -and $step.value) { [System.Windows.Forms.SendKeys]::SendWait([string]$step.value) }',
      '}',
      `Remove-Item '${scriptFileEsc}' -ErrorAction SilentlyContinue`,
    ].join('\n');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const proc = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', scriptFile,
    ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    proc.stdin.write(JSON.stringify({ steps: safeSteps }));
    proc.stdin.end();
    proc.unref();
  }

  async function typeMac(steps) {
    const pbcopy = (text) => new Promise((resolve, reject) => {
      const proc = spawn('pbcopy');
      proc.on('error', reject);
      proc.on('close', resolve);
      proc.stdin.write(text ?? '', 'utf8');
      proc.stdin.end();
    });
    const osa = (script) => new Promise((resolve, reject) => {
      const proc = spawn('osascript', ['-e', script], { shell: false });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`)));
    });
    const keys = { TAB: '48', ENTER: '36', SPACE: '49', UP: '126', DOWN: '125', LEFT: '123', RIGHT: '124' };
    let typedSecret = false;
    for (const step of steps) {
      if (step.kind === 'delay') { await wait(step.ms); continue; }
      if (step.kind === 'key') {
        const code = keys[step.value];
        if (code) await osa(`tell application "System Events" to key code ${code}`);
        continue;
      }
      if (step.kind === 'text' && step.value) {
        await pbcopy(step.value);
        await osa('tell application "System Events" to keystroke "v" using command down');
        typedSecret = true;
      }
    }
    if (typedSecret) setTimeout(() => { pbcopy('').catch(() => {}); }, 2000);
  }

  async function sendAutotype(payload, sender) {
    const fields = { username: payload.username || '', password: payload.password || '' };
    const steps = payload.sequence
      ? power.sequenceToSteps(payload.sequence, fields)
      : power.legacySteps(fields.username, fields.password, !!payload.pressEnter);
    if (!steps.length) return { success: false, error: 'Nothing to type' };
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return { success: false, error: 'Auto-Type is supported on Windows and macOS only.' };
    }
    try {
      if (sender) {
        const win = BrowserWindow.fromWebContents(sender);
        const main = getMainWindow();
        if (win && win !== main && !win.isDestroyed()) win.hide();
      }
      const main = getMainWindow();
      if (main && !main.isDestroyed() && main.isVisible()) main.minimize();
      await wait(450);
      if (process.platform === 'win32') await typeWindows(steps);
      else await typeMac(steps);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function onAutotypeHotkey() {
    if (isLauncherOpen()) { closeLauncher(); return; }
    const title = await getActiveWindowTitle();
    const matches = power.matchRules(getItems(), title);
    autotypeContext = { title: title || '', matches };
    if (matches.length === 1) {
      const item = getItems().find(entry => entry.id === matches[0].itemId);
      if (item) {
        await sendAutotype({
          username: item.username || '',
          password: item.password || '',
          sequence: matches[0].sequence,
        });
        return;
      }
    }
    openLauncherWindow('autotype');
  }

  function clearLarge() {
    largePayload = null;
    if (largeWindow && !largeWindow.isDestroyed()) largeWindow.close();
    largeWindow = null;
  }

  async function showLargeType(payload) {
    const secret = payload && typeof payload.secret === 'string' ? payload.secret : '';
    if (!secret || secret.length > 2000) return { success: false, error: 'Nothing to show' };
    let qr = null;
    let wifiQr = null;
    try {
      const QRCode = require('qrcode');
      if (secret.length <= 700) qr = await QRCode.toDataURL(secret, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
      const ssid = typeof payload.ssid === 'string' ? payload.ssid.trim().slice(0, 64) : '';
      if (ssid && secret.length <= 180) {
        const wifi = `WIFI:T:WPA;S:${power.escapeWifi(ssid)};P:${power.escapeWifi(secret)};;`;
        wifiQr = await QRCode.toDataURL(wifi, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
      }
    } catch { /* large type still works without a code */ }
    largePayload = {
      title: String(payload.title || 'Password').slice(0, 120),
      secret,
      qr,
      wifiQr,
    };
    openLargeWindow();
    return { success: true };
  }

  function openLargeWindow() {
    if (largeWindow && !largeWindow.isDestroyed()) {
      largeWindow.focus();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const area = display.workArea;
    const width = 760;
    const height = 520;
    largeWindow = new BrowserWindow({
      width,
      height,
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round(area.height * 0.12),
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    loadRoute(largeWindow, '/large-type');
    let armed = false;
    largeWindow.once('ready-to-show', () => {
      largeWindow?.show();
      largeWindow?.focus();
      setTimeout(() => { armed = true; }, 400);
    });
    largeWindow.on('blur', () => { if (armed) clearLarge(); });
    largeWindow.on('closed', () => { largeWindow = null; largePayload = null; });
    setTimeout(() => { if (largeWindow && !largeWindow.isDestroyed()) clearLarge(); }, 60000);
  }

  async function loadImportEntries(filePath, password) {
    if (!pickedFiles.has(filePath)) throw new Error('Choose the file from the import dialog.');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xml') return power.parseKeepassXml(fs.readFileSync(filePath, 'utf8'));
    if (ext === '.kdbx') return power.loadKdbxBuffer(fs.readFileSync(filePath), password || '');
    throw new Error('Choose a .kdbx database or a KeePass XML (2.x) export.');
  }

  async function ensureFolder(name, cache) {
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    const session = getSession();
    if (cache.size === 0) {
      const folders = await runBwJson(['list', 'folders', '--session', session]);
      for (const folder of folders) cache.set(folder.name, folder.id);
    }
    let acc = '';
    let id = null;
    for (const part of name.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      if (!cache.has(acc)) {
        const encoded = Buffer.from(JSON.stringify({ name: acc })).toString('base64');
        const created = JSON.parse(await runBw(['create', 'folder', encoded, '--session', session]));
        cache.set(acc, created.id);
      }
      id = cache.get(acc);
    }
    return id;
  }

  async function createBwItem(entry, folderId) {
    const session = getSession();
    const build = () => power.toBitwardenItem(entry, folderId);
    const write = async (item) => {
      const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
      return JSON.parse(await runBw(['create', 'item', encoded, '--session', session]));
    };
    const item = build();
    try {
      return await write(item);
    } catch (err) {
      if (!item.passwordHistory) throw err;
      delete item.passwordHistory;
      const created = await write(item);
      created._historyDropped = err.message;
      return created;
    }
  }

  function validHost(host) {
    return typeof host === 'string' && host.length > 0 && host.length <= 253 && /^[A-Za-z0-9._-]+$/.test(host);
  }

  function validUser(user) {
    return user == null || user === '' || (typeof user === 'string' && user.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(user));
  }

  function registerIpc() {
    ipcMain.handle('power:run-status', () => ({
      listening: Boolean(server && port && getSession()),
      example: cliExample(),
    }));

    ipcMain.handle('power:get-changes', () => store.get('changeInbox', []));

    ipcMain.handle('power:unseen-count', () => {
      return store.get('changeInbox', []).filter(row => !row.seen && row.origin === 'remote').length;
    });

    ipcMain.handle('power:mark-seen', (_, { ids } = {}) => {
      const inbox = store.get('changeInbox', []);
      const chosen = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
      for (const row of inbox) {
        if (!chosen.size || chosen.has(row.id)) row.seen = true;
      }
      store.set('changeInbox', inbox);
      return inbox.filter(row => !row.seen && row.origin === 'remote').length;
    });

    ipcMain.handle('power:rotate-url', (_, { website, rotateUrl }) => {
      return power.rotateUrlFor({ website: typeof website === 'string' ? website : '', rotateUrl: typeof rotateUrl === 'string' ? rotateUrl : null });
    });

    ipcMain.handle('autotype:get-context', () => autotypeContext);

    ipcMain.handle('autotype:send', (event, payload) => sendAutotype(payload || {}, event.sender));

    ipcMain.handle('power:save-autotype-rule', async (_, { itemId, rule }) => {
      if (!isItemId(itemId)) return { success: false, error: 'Invalid item' };
      const session = getSession();
      if (!session) return { success: false, error: 'Unlock the vault first' };
      const value = String(rule?.value || '').trim().slice(0, 120);
      const sequence = String(rule?.sequence || '{USERNAME}{TAB}{PASSWORD}{ENTER}').slice(0, 300);
      if (!value) return { success: false, error: 'A window title is required' };
      try {
        const cached = getItems().find(item => item.id === itemId);
        const rules = [...(cached?.autotypeRules || []), {
          id: crypto.randomUUID(),
          match: rule?.match === 'regex' ? 'regex' : 'contains',
          value,
          sequence,
        }];
        const raw = await runBwJson(['get', 'item', itemId, '--session', session]);
        power.applyExtra(raw, { autotypeRules: rules, defaultSequence: cached?.defaultSequence || null });
        const encoded = Buffer.from(JSON.stringify(raw)).toString('base64');
        await runBw(['edit', 'item', itemId, encoded, '--session', session]);
        if (cached) cached.autotypeRules = rules;
        markLocal(itemId);
        notifyItemsChanged();
        return { success: true, rules };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('power:show-large-type', (_, payload) => showLargeType(payload || {}));
    ipcMain.handle('power:get-large-type', () => largePayload);
    ipcMain.handle('power:close-large-type', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
      largePayload = null;
    });

    ipcMain.handle('launch:ssh', (_, { user, host, port }) => {
      if (!validHost(host) || !validUser(user)) return { success: false, error: 'That host cannot be launched' };
      const numericPort = port == null || port === '' ? null : Number(port);
      if (numericPort != null && (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)) {
        return { success: false, error: 'Invalid port' };
      }
      const args = [];
      if (numericPort) args.push('-p', String(numericPort));
      args.push(user ? `${user}@${host}` : host);
      try {
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/d', '/c', 'start', '""', 'ssh', ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        } else {
          spawn('ssh', args, { detached: true, stdio: 'ignore' }).unref();
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('launch:rdp', (_, { host, port }) => {
      if (process.platform !== 'win32') return { success: false, error: 'Remote Desktop launch is available on Windows.' };
      if (!validHost(host)) return { success: false, error: 'That host cannot be launched' };
      const numericPort = port == null || port === '' ? null : Number(port);
      if (numericPort != null && (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)) {
        return { success: false, error: 'Invalid port' };
      }
      const target = numericPort ? `${host}:${numericPort}` : host;
      try {
        spawn('mstsc', [`/v:${target}`], { detached: true, stdio: 'ignore' }).unref();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('keepass:pick', async () => {
      const result = await dialog.showOpenDialog(getMainWindow() || undefined, {
        title: 'Import a KeePass database',
        filters: [{ name: 'KeePass', extensions: ['kdbx', 'xml'] }],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      const filePath = result.filePaths[0];
      pickedFiles.add(filePath);
      return { canceled: false, path: filePath };
    });

    ipcMain.handle('keepass:preview', async (_, { filePath, password } = {}) => {
      try {
        const entries = await loadImportEntries(filePath, password);
        return { success: true, entries: entries.map(power.previewEntry) };
      } catch (err) {
        return { success: false, error: friendlyImportError(err) };
      }
    });

    ipcMain.handle('keepass:import', async (event, { filePath, password, indexes } = {}) => {
      if (!getSession()) return { success: false, error: 'Unlock the vault first' };
      let entries;
      try { entries = await loadImportEntries(filePath, password); }
      catch (err) { return { success: false, error: friendlyImportError(err) }; }
      const chosen = Array.isArray(indexes) && indexes.length
        ? indexes.map(index => entries[index]).filter(Boolean)
        : entries;
      const folderCache = new Map();
      let imported = 0;
      const failed = [];
      for (let i = 0; i < chosen.length; i++) {
        const entry = chosen[i];
        try {
          const folderId = await ensureFolder(entry.folder, folderCache);
          const created = await createBwItem(entry, folderId);
          if (created._historyDropped) {
            failed.push({ title: entry.title, error: 'Imported without password history. Bitwarden rejected the history field.' });
          }
          for (const file of entry.attachments || []) {
            if (!file.data || file.data.length > 5 * 1024 * 1024) continue;
            const safeName = path.basename(String(file.name || 'attachment')).replace(/[<>:"/\\|?*\u0000]/g, '_').slice(0, 80);
            const tmp = path.join(app.getPath('temp'), `dw-att-${Date.now()}-${safeName || 'file'}`);
            fs.writeFileSync(tmp, file.data);
            try {
              await runBw(['create', 'attachment', '--file', tmp, '--itemid', created.id, '--session', getSession()]);
            } catch (err) {
              failed.push({ title: entry.title, error: `Saved the item, but attachment ${safeName} was not uploaded.` });
            } finally {
              try { fs.rmSync(tmp, { force: true }); } catch { /* temp cleanup is best-effort */ }
            }
          }
          imported++;
        } catch (err) {
          failed.push({ title: entry.title || 'Untitled', error: friendlyImportError(err) });
        }
        event.sender.send('keepass:progress', { current: i + 1, total: chosen.length, title: entry.title || '' });
      }
      notifyItemsChanged();
      return { success: true, imported, failed };
    });

    ipcMain.handle('vault:delete-item', async (_, { id }) => {
      if (!isItemId(id)) return { success: false, error: 'Invalid item' };
      const session = getSession();
      if (!session) return { success: false, error: 'Unlock the vault first' };
      try {
        await runBw(['delete', 'item', id, '--session', session]);
        setItems(getItems().filter(item => item.id !== id));
        markLocal(id);
        notifyItemsChanged();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('vault:merge-items', async (_, { keeperId, loserId, patch }) => {
      if (!isItemId(keeperId) || !isItemId(loserId) || keeperId === loserId) {
        return { success: false, error: 'Choose two different items' };
      }
      const session = getSession();
      if (!session) return { success: false, error: 'Unlock the vault first' };
      try {
        const item = await runBwJson(['get', 'item', keeperId, '--session', session]);
        applyPatchToItem(item, patch || {});
        if (patch && typeof patch.extraWebsite === 'string' && patch.extraWebsite && item.type === 1) {
          item.login = item.login || {};
          item.login.uris = item.login.uris || [];
          if (!item.login.uris.some(uri => uri && uri.uri === patch.extraWebsite)) {
            item.login.uris.push({ match: null, uri: patch.extraWebsite });
          }
        }
        const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
        await runBw(['edit', 'item', keeperId, encoded, '--session', session]);
        await runBw(['delete', 'item', loserId, '--session', session]);
        markLocal(keeperId);
        markLocal(loserId);
        setItems(getItems().filter(entry => entry.id !== loserId));
        notifyItemsChanged();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  return {
    startServer,
    stop,
    syncSession,
    markLocal,
    recordSync,
    propagateLinks,
    onAutotypeHotkey,
    registerIpc,
    snapshotItem: power.snapshotItem,
    publicSnap: power.publicSnap,
    fieldDiff: power.fieldDiff,
  };
}

module.exports = { createPowerFeatures };
