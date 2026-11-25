// The bridge between the sandboxed renderer and main: exposes `window.desktop` and nothing else.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { CHANNELS, type DesktopApi, type StreamEvent } from "../shared/ipc.ts";

let nextStream = 0;

const api: DesktopApi = {
  call: (name, ...args) => ipcRenderer.invoke(CHANNELS.call, name, args),
  connection: () => ipcRenderer.invoke(CHANNELS.connection),
  subscribe(botId, since, onEvent) {
    nextStream += 1;
    const id = `s${nextStream}`;
    const listener = (_event: IpcRendererEvent, streamId: unknown, event: StreamEvent) => {
      if (streamId === id) onEvent(event);
    };
    ipcRenderer.on(CHANNELS.streamEvent, listener);
    ipcRenderer.send(CHANNELS.streamOpen, { id, botId, since });
    return () => {
      ipcRenderer.removeListener(CHANNELS.streamEvent, listener);
      ipcRenderer.send(CHANNELS.streamClose, id);
    };
  },
  ready: (botCount) => ipcRenderer.send(CHANNELS.ready, botCount),
};

contextBridge.exposeInMainWorld("desktop", api);
