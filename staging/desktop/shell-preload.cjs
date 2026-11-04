'use strict';
// This bridge is deliberately absent from the hosted Ludy renderer and PDFs.
if (location.protocol === 'ludy-client:' && location.hostname === 'shell' && location.pathname === '/status' && !location.search && !location.hash) {
  const {contextBridge,ipcRenderer} = require('electron');
  contextBridge.exposeInMainWorld('ludyClient',Object.freeze({
    state:()=>ipcRenderer.invoke('ludy-client:state'),
    retry:()=>ipcRenderer.invoke('ludy-client:retry'),
    browser:()=>ipcRenderer.invoke('ludy-client:browser')
  }));
}
