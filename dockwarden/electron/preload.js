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
  },
  backup: {
    runNow: () => ipcRenderer.invoke('backup:run-now'),
    getHistory: () => ipcRenderer.invoke('backup:get-history'),
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
  app: {
    getStore: (key) => ipcRenderer.invoke('app:get-store', key),
    setStore: (key, value) => ipcRenderer.invoke('app:set-store', { key, value }),
    notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
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
