'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = async (channel, data) => {
  const result = await ipcRenderer.invoke(channel, data);
  if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
  return result.value;
};
contextBridge.exposeInMainWorld('systemus', {
  agentSettings:()=>call('agents:settings'),
  providerStatus:agent=>call('agents:status',{agent}),
  providerDocs:provider=>call('agents:docs',{provider}),
  updateAgentSettings:data=>call('agents:update',data),
  onAgentSettings:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('agents:updated',listener);return()=>ipcRenderer.removeListener('agents:updated',listener);},
  copyFiles: (paths, cut=false) => call('explorer:clipboard-copy',{paths,cut}),
  clipboardFiles: () => call('explorer:clipboard-files'),
  pasteFiles: destination => call('explorer:clipboard-paste',{destination}),
  droppedPaths: files => Array.from(files).slice(0,501).map(file=>webUtils.getPathForFile(file)),
  watchFolders: paths => call('explorer:watch',{paths}),
  onFolderChanged: callback => { const listener=(_event,update)=>callback(update);ipcRenderer.on('explorer:folder-changed',listener);return()=>ipcRenderer.removeListener('explorer:folder-changed',listener); },
  boot: () => call('explorer:boot'),
  list: options => call('explorer:list', options),
  cancelList: id => call('explorer:cancel-list', { id }),
  properties: path => call('explorer:properties', { path }),
  preview: path => call('explorer:preview', { path }),
  mutate: options => call('explorer:mutate', options),
  prepareTrash: paths => call('explorer:prepare-trash', { paths }),
  trash: () => call('explorer:trash'),
  saveSettings: data => call('explorer:settings', data),
  search: options => call('explorer:search', options),
  cancelSearch: id => call('explorer:cancel-search', { id }),
  openExternal: (path, reveal = false) => call('explorer:external', { path, reveal }),
  onSearch: callback => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('explorer:search-update', listener);
    return () => ipcRenderer.removeListener('explorer:search-update', listener);
  },
  onListProgress: callback => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('explorer:list-progress', listener);
    return () => ipcRenderer.removeListener('explorer:list-progress', listener);
  },
  onOperationProgress: callback => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('explorer:operation-progress', listener);
    return () => ipcRenderer.removeListener('explorer:operation-progress', listener);
  },
  fileIcons: {
    boot: () => call('file-icons:boot'),
    resolve: keys => call('file-icons:resolve',{keys}),
    onUpdate: callback => {const listener=(_event,update)=>callback(update);ipcRenderer.on('file-icons:update',listener);return()=>ipcRenderer.removeListener('file-icons:update',listener);}
  },
  librarian: {
    boot: () => call('librarian:boot'),
    send: data => call('librarian:send', data),
    approve: data => call('librarian:approve', data),
    cancel: id => call('librarian:cancel', { id }),
    clear: () => call('librarian:clear'),
    setScope: path => call('librarian:scope', { path }),
    onUpdate: callback => {
      const listener = (_event, update) => callback(update);
      ipcRenderer.on('librarian:update', listener);
      return () => ipcRenderer.removeListener('librarian:update', listener);
    }
  }
});
