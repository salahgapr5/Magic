const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const call = (n) => (...a) => ipcRenderer.invoke(n, ...a);
contextBridge.exposeInMainWorld('pipeline', {
  state: call('state'), project: call('project'), pickInput: call('pick-input'), saveSettings: call('settings'),
  run: call('run'), cancel: call('cancel'), regenerate: call('regenerate'), replace: call('replace'), remove: call('delete'), setOverlay: call('overlay'), setOverlayAll: call('overlay-all'), exportVideo: call('export'),
  getKey: call('get-key'), setKey: call('set-key'), reveal: call('reveal'), defaultModel: call('default-model'),
  fileUrl: (dir, rel) => pathToFileURL(dir + '/' + rel).href,
  onProgress: (cb) => { const h = (_, p) => cb(p); ipcRenderer.on('progress', h); return () => ipcRenderer.removeListener('progress', h); },
});
