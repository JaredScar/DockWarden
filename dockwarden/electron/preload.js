const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  vault: {
    getItems: () => ipcRenderer.invoke('vault:get-items'),
    getCachedItems: () => ipcRenderer.invoke('vault:get-cached-items'),
    getFolders: () => ipcRenderer.invoke('vault:get-folders'),
    getTotp: (itemId) => ipcRenderer.invoke('vault:get-totp', { itemId }),
    sync: () => ipcRenderer.invoke('vault:sync'),
    editItem: (id, patch) => ipcRenderer.invoke('vault:edit-item', { id, patch }),
    createItem: (item) => ipcRenderer.invoke('vault:create-item', { item }),
    status: () => ipcRenderer.invoke('vault:status'),
    login: (email, password, serverUrl) => ipcRenderer.invoke('vault:login', { email, password, serverUrl }),
    login2fa: (code, method) => ipcRenderer.invoke('vault:login-2fa', { code, method }),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', { password }),
    lock: () => ipcRenderer.invoke('vault:lock'),
    logout: () => ipcRenderer.invoke('vault:logout'),
    getExpiryPolicies: () => ipcRenderer.invoke('vault:get-expiry-policies'),
    setExpiryPolicies: (policies) => ipcRenderer.invoke('vault:set-expiry-policies', { policies }),
    getSetting: (key, defaultValue) => ipcRenderer.invoke('vault:get-setting', { key, defaultValue }),
    setSetting: (key, value) => ipcRenderer.invoke('vault:set-setting', { key, value }),
  },
  autotype: {
    send: (username, password, pressEnter) => ipcRenderer.invoke('autotype:send', { username, password, pressEnter }),
  },
  launcher: {
    close: () => ipcRenderer.send('launcher:close'),
    navigateToItem: (itemId) => ipcRenderer.send('launcher:navigate-to-item', itemId),
    openSearch: () => ipcRenderer.invoke('launcher:open-search'),
    openAutotype: () => ipcRenderer.invoke('launcher:open-autotype'),
  },
  bw: {
    getConfig: () => ipcRenderer.invoke('bw:get-config'),
    setCliPath: (cliPath) => ipcRenderer.invoke('bw:set-cli-path', { cliPath }),
    checkCli: () => ipcRenderer.invoke('bw:check-cli'),
    autoDetect: () => ipcRenderer.invoke('bw:auto-detect'),
  },
  backup: {
    runNow: () => ipcRenderer.invoke('backup:run-now'),
    getHistory: () => ipcRenderer.invoke('backup:get-history'),
    getDir: () => ipcRenderer.invoke('backup:get-dir'),
    setDir: (dir) => ipcRenderer.invoke('backup:set-dir', { dir }),
  },
  account: {
    getProfiles: () => ipcRenderer.invoke('account:get-profiles'),
    addProfile: (profile) => ipcRenderer.invoke('account:add-profile', { profile }),
    updateProfile: (id, patch) => ipcRenderer.invoke('account:update-profile', { id, patch }),
    removeProfile: (id) => ipcRenderer.invoke('account:remove-profile', { id }),
    getActive: () => ipcRenderer.invoke('account:get-active'),
    setActive: (id) => ipcRenderer.invoke('account:set-active', { id }),
    switch: (id) => ipcRenderer.invoke('account:switch', { id }),
  },
  snapshot: {
    getAll: () => ipcRenderer.invoke('snapshot:get-all'),
    saveManual: (label) => ipcRenderer.invoke('snapshot:save-manual', { label }),
    delete: (id) => ipcRenderer.invoke('snapshot:delete', { id }),
    diff: (idA, idB) => ipcRenderer.invoke('snapshot:diff', { idA, idB }),
  },
  icon: {
    getAll: () => ipcRenderer.invoke('icon:get-all'),
    set: (itemId, icon) => ipcRenderer.invoke('icon:set', { itemId, icon }),
    remove: (itemId) => ipcRenderer.invoke('icon:remove', { itemId }),
    getSetting: (key, defaultValue) => ipcRenderer.invoke('vault:get-setting', { key, defaultValue }),
    setSetting: (key, value) => ipcRenderer.invoke('vault:set-setting', { key, value }),
  },
  folder: {
    create: (name) => ipcRenderer.invoke('folder:create', { name }),
    rename: (id, name) => ipcRenderer.invoke('folder:rename', { id, name }),
    delete: (id) => ipcRenderer.invoke('folder:delete', { id }),
    move: (folders, oldPath, newPath) => ipcRenderer.invoke('folder:move', { folders, oldPath, newPath }),
  },
  template: {
    getAll: () => ipcRenderer.invoke('template:get-all'),
    save: (template) => ipcRenderer.invoke('template:save', { template }),
    delete: (id) => ipcRenderer.invoke('template:delete', { id }),
  },
  watchtower: {
    startScan: (items, settings) => ipcRenderer.invoke('watchtower:start-scan', items, settings),
    onScanProgress: (callback) =>
      ipcRenderer.on('watchtower:scan-progress', (_, progress) => callback(progress)),
    onScanResults: (callback) =>
      ipcRenderer.on('watchtower:scan-results', (_, results) => callback(results)),
    cancelScan: () => ipcRenderer.send('watchtower:cancel-scan'),
    updateBadge: (total, critical) => ipcRenderer.send('watchtower:update-badge', { total, critical }),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('watchtower:scan-progress');
      ipcRenderer.removeAllListeners('watchtower:scan-results');
    },
  },
  generator: {
    generate: (opts) => ipcRenderer.invoke('vault:generate', opts),
    getSettings: () => ipcRenderer.invoke('generator:get-settings'),
    setSettings: (settings) => ipcRenderer.invoke('generator:set-settings', settings),
    getActiveWindow: () => ipcRenderer.invoke('vault:get-active-window'),
    open: () => ipcRenderer.invoke('generator:open'),
    onSiteHint: (callback) => ipcRenderer.on('generator:site-hint', (_, hint) => callback(hint)),
    removeListeners: () => ipcRenderer.removeAllListeners('generator:site-hint'),
  },
  offline: {
    getStatus: () => ipcRenderer.invoke('offline:get-status'),
    setMode: (offline) => ipcRenderer.invoke('offline:set-mode', { offline }),
    flushQueue: () => ipcRenderer.invoke('offline:flush-queue'),
    discardEntry: (entryId) => ipcRenderer.invoke('offline:discard-entry', { entryId }),
    resolveConflicts: (resolutions) => ipcRenderer.invoke('offline:resolve-conflicts', { resolutions }),
    onStatusChanged: (cb) => ipcRenderer.on('offline:status-changed', (_, data) => cb(data)),
    onQueueUpdated: (cb) => ipcRenderer.on('offline:queue-updated', (_, data) => cb(data)),
    onConflictsDetected: (cb) => ipcRenderer.on('offline:conflicts-detected', (_, data) => cb(data)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('offline:status-changed');
      ipcRenderer.removeAllListeners('offline:queue-updated');
      ipcRenderer.removeAllListeners('offline:conflicts-detected');
    },
  },
  primary: {
    getAll: () => ipcRenderer.invoke('primary:get-all'),
    setAll: (items) => ipcRenderer.invoke('primary:set-all', { items }),
  },
  usage: {
    increment: (itemId) => ipcRenderer.invoke('usage:increment', { itemId }),
    getAll: () => ipcRenderer.invoke('usage:get-all'),
  },
  app: {
    getStore: (key) => ipcRenderer.invoke('app:get-store', key),
    setStore: (key, value) => ipcRenderer.invoke('app:set-store', { key, value }),
    notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    getVersion: () => ipcRenderer.invoke('app:get-version'),
  },
  on: (channel, callback) => {
    const validChannels = [
      'vault:sync-requested',
      'vault:lock-requested',
      'navigate',
      'navigate-to-item',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => callback(...args));
    }
  },
  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
});
