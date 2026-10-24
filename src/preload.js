const { contextBridge, ipcRenderer: ipc } = require('electron');
const inv = (c, ...a) => ipc.invoke(c, ...a);
contextBridge.exposeInMainWorld('nexus', {
  config: () => inv('config'),
  restore: () => inv('auth:restore'), login: () => inv('auth:login'), elyLogin: d => inv('auth:ely', d), offlineList: () => inv('auth:offline:list'), offlineRegister: d => inv('auth:offline:register', d), offlineLogin: d => inv('auth:offline:login', d), logout: () => inv('auth:logout'),
  status: () => inv('server:status'),
  play: () => inv('game:play'), repair: () => inv('game:repair'),
  diag: () => inv('diag:run'),
  settingsGet: () => inv('settings:get'), settingsSet: p => inv('settings:set', p), javaInfo: () => inv('java:info'),
  manifestInfo: () => inv('manifest:info'), modsList: () => inv('mods:list'),
  modsUpdate: () => inv('mods:update'), modsReport: () => inv('mods:report'),
  setRam: v => inv('settings:ram', v),
  open: w => inv('open', w), copy: t => inv('copy', t),
  win: a => ipc.send('win', a), log: m => ipc.send('rlog', m),
  on: (ch, fn) => ipc.on(ch, (_, d) => fn(d))
});
