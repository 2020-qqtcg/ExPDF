const { contextBridge, ipcRenderer } = require('electron')
const closeCallbacks = new Set()
function subscribe(channel, callback) {
  const handler = (_event, value) => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
ipcRenderer.on('desktop:prepare-close', async (_event, nonce) => {
  try { await Promise.all([...closeCallbacks].map(callback => callback())) }
  catch (error) { console.error('保存阅读会话失败', error) }
  finally { await ipcRenderer.invoke('desktop:did-flush', nonce) }
})
contextBridge.exposeInMainWorld('folioDesktop', Object.freeze({
  platform: process.platform,
  openPdf: () => ipcRenderer.invoke('desktop:open-pdf'),
  openPdfs: () => ipcRenderer.invoke('desktop:open-pdfs'),
  openAgentFile: options => ipcRenderer.invoke('desktop:open-agent-file', options),
  savePdf: options => ipcRenderer.invoke('desktop:save-pdf', options),
  onOpenPdf: callback => subscribe('desktop:open-pdf-data', callback),
  onCommand: callback => subscribe('desktop:command', callback),
  onBeforeClose: callback => { closeCallbacks.add(callback); return () => closeCallbacks.delete(callback) },
  ready: () => ipcRenderer.invoke('desktop:ready'),
  setDocument: document => ipcRenderer.send('desktop:set-document', document),
}))
