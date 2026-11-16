import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createSomaApi } from '../shared/api';

/** Desktop: the interface (src/shared/api.ts) on Electron's IPC. */
const api = createSomaApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => { ipcRenderer.on(channel, (_e, ...args) => cb(...args)); },
  filePaths: (files) => files.map((f) => webUtils.getPathForFile(f)),
}, {
  platform: 'desktop',
  testMode: process.env.SOMA_TEST === '1',
  startsHome: process.env.SOMA_TEST !== '1' || process.env.SOMA_TEST_START === 'home',
});

contextBridge.exposeInMainWorld('soma', api);
