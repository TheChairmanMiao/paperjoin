const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  openFiles: () => ipcRenderer.invoke('paperjoin:open'),
  compressPdf: async (bytes, preset) => {
    try { return await ipcRenderer.invoke('paperjoin:compress', bytes, preset); }
    catch (error) { throw new Error(String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
  },
  savePdf: (bytes, filename) => ipcRenderer.invoke('paperjoin:save', bytes, filename),
  setWorkspaceHasFiles: (value) => ipcRenderer.send('paperjoin:workspace', value === true),
  onMenuAction: (callback) => {
    const listener = (_event, action) => { if (['open', 'export', 'undo'].includes(action)) callback(action); };
    ipcRenderer.on('paperjoin:menu', listener);
    return () => ipcRenderer.removeListener('paperjoin:menu', listener);
  },
});
