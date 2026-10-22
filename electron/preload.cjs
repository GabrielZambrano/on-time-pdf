const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('onTime', {
  open: (file) => ipcRenderer.invoke('doc:open', file),
  initialFile: () => ipcRenderer.invoke('app:initial'),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (callback) => {
    const handler = (_e, payload) => callback(payload)
    ipcRenderer.on('update', handler)
    return () => ipcRenderer.removeListener('update', handler)
  },
  bytes: () => ipcRenderer.invoke('doc:bytes'),
  state: () => ipcRenderer.invoke('doc:state'),
  op: (cmd, args) => ipcRenderer.invoke('doc:op', cmd, args),
  merge: (files) => ipcRenderer.invoke('doc:merge', files),
  query: (cmd, args) => ipcRenderer.invoke('doc:query', cmd, args),
  undo: () => ipcRenderer.invoke('doc:undo'),
  redo: () => ipcRenderer.invoke('doc:redo'),
  saveAs: () => ipcRenderer.invoke('doc:saveAs'),
  exportTo: (cmd, args) => ipcRenderer.invoke('doc:export', cmd, args),
  split: (ranges) => ipcRenderer.invoke('doc:split', ranges),
  pickFiles: (kind, multi) => ipcRenderer.invoke('pick:files', kind, multi),
  pathForFile: (file) => webUtils.getPathForFile(file),
})
