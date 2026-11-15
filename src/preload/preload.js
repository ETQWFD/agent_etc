'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('etc', {
  info: () => ipcRenderer.invoke('app:info'),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    patch: (patch) => ipcRenderer.invoke('config:patch', patch),
  },
  providers: {
    save: (p) => ipcRenderer.invoke('provider:save', p),
    remove: (id) => ipcRenderer.invoke('provider:delete', id),
    activate: (id) => ipcRenderer.invoke('provider:activate', id),
    test: (p) => ipcRenderer.invoke('provider:test', p),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    save: (text, importance) => ipcRenderer.invoke('memory:save', { text, importance }),
    search: (query, limit) => ipcRenderer.invoke('memory:search', { query, limit }),
    forget: (id) => ipcRenderer.invoke('memory:forget', id),
  },
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    create: (title) => ipcRenderer.invoke('session:create', title),
    remove: (id) => ipcRenderer.invoke('session:delete', id),
    rename: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    stop: () => ipcRenderer.invoke('chat:stop'),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugin:list'),
    toggle: (id, enabled) => ipcRenderer.invoke('plugin:toggle', { id, enabled }),
    install: () => ipcRenderer.invoke('plugin:install'),
    uninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
    addMcp: (server) => ipcRenderer.invoke('plugin:add-mcp', server),
    marketSearch: (source, query) => ipcRenderer.invoke('plugin:market-search', { source, query }),
    marketInstall: (entry) => ipcRenderer.invoke('plugin:market-install', entry),
  },
  skills: {
    list: () => ipcRenderer.invoke('skill:list'),
    toggle: (id, enabled) => ipcRenderer.invoke('skill:toggle', { id, enabled }),
    open: (id) => ipcRenderer.invoke('skill:open', id),
    importFile: () => ipcRenderer.invoke('skill:import-file'),
    importFolder: () => ipcRenderer.invoke('skill:import-folder'),
    importHarness: () => ipcRenderer.invoke('skill:import-harness'),
    remove: (id) => ipcRenderer.invoke('skill:remove', id),
  },
  browser: {
    status: () => ipcRenderer.invoke('browser:status'),
    launch: () => ipcRenderer.invoke('browser:launch'),
    stop: () => ipcRenderer.invoke('browser:stop'),
  },
  qq: {
    status: () => ipcRenderer.invoke('qq:status'),
    test: () => ipcRenderer.invoke('qq:test'),
    start: () => ipcRenderer.invoke('qq:start'),
    stop: () => ipcRenderer.invoke('qq:stop'),
    onStatus: on('qq:status'),
  },
  localmodel: {
    status: () => ipcRenderer.invoke('localmodel:status'),
    start: () => ipcRenderer.invoke('localmodel:start'),
    stop: () => ipcRenderer.invoke('localmodel:stop'),
    pickRuntime: () => ipcRenderer.invoke('localmodel:pick-runtime'),
    pickModel: () => ipcRenderer.invoke('localmodel:pick-model'),
    installEngine: () => ipcRenderer.invoke('localmodel:install-engine'),
    inspect: () => ipcRenderer.invoke('localmodel:inspect'),
  },
  mobile: {
    status: () => ipcRenderer.invoke('mobile:status'),
    start: () => ipcRenderer.invoke('mobile:start'),
    stop: () => ipcRenderer.invoke('mobile:stop'),
    save: (patch) => ipcRenderer.invoke('mobile:save', patch),
  },
  updates: {
    check: () => ipcRenderer.invoke('app:check-update'),
  },
  dialog: {
    pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  },
  approval: {
    respond: (id, approved) => ipcRenderer.invoke('approval:respond', { id, approved }),
  },
  choice: {
    respond: (id, answer) => ipcRenderer.invoke('choice:respond', { id, answer }),
  },
  onAgentEvent: on('agent:event'),
  onApproval: on('agent:approval'),
  onChoice: on('agent:choice'),
});
