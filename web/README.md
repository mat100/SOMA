# SOMA in the browser

The web version of SOMA. The browser tab is the window, a Node server is the main process. Both run the code of the
desktop app in `app/` unchanged: the renderer (`app/src/renderer`), the main process (`app/src/main`) and the Python
library `soma`. Only what Electron did is replaced. Projects are the same `.soma` models.

## Decisions

- **One user per server.** Each user gets their own server, typically their own container (as a Coder workspace). The
  server runs Python code of models, terminals and agents with the rights of its user, like the desktop app does on the
  user's computer. Isolation between users is the container's job, not the server's.
- **Ports instead of Electron.** `app/src/main/platform.ts` is the interface to the host. Electron implements it in
  `app/src/main/electron-platform.ts`, this server in `web/server/platform.ts`. The commands of the user interface are one
  table (`app/src/main/commands.ts`), registered on Electron's IPC (`main.ts`) or on the WebSocket here. The renderer gets
  `window.soma` from `createSomaApi` (`app/src/shared/api.ts`) on top of a transport: IPC in `preload.ts`, a WebSocket in
  `web/client/transport.ts`. A new command in the desktop app therefore works here without changes in `web/`.
- **In `web/` of the same repository**, so the web version follows the desktop app with every change.
- **Node without a framework:** `node:http` and `ws`, built with the esbuild of `app/` (`app/esbuild.config.mjs`).
- **Projects live on the server.** The browser uploads files into it and downloads models and exports.
- **One tab at a time.** The tab that connects last has the session, the other one shows that SOMA is open elsewhere.
  The open model, running builds and terminals stay on the server when the tab closes or reloads.
- **Images and videos (`soma render`) are rendered in the user's tab**, with its GPU, not on the server: a hidden frame
  with the render page of the desktop app. Without an open tab `soma render` says so. A tab in the background may be
  slowed down by the browser; a long video is best made with the tab in front. Videos are H.264 where the browser can
  encode it, otherwise VP9 (as on the desktop).

## Commands

```
cd web
npm install
npm start                  # builds and starts the server, prints the address with the token
npm run build              # only builds (dist/)
npm run typecheck
npm run test:unit
```

`app/` needs `npm install` too, the server uses its packages (`node-pty`, `dugite`, the renderer's libraries).

## Files

The models live on the server. What the desktop does with a dialog of the system, the page does with its own:

- **Open** (a model, a CadQuery script, files to import, skills): upload from this computer, or choose a file on the
  server. A model opened from an upload saves back as a download: each Ctrl+S downloads the model again.
- **Save** (Save as, exports): download to this computer, or a place on the server (with a question before replacing).
  Exports of all parts download as one ZIP.
- **Open folder** (a folder as the model, E103): a folder on the server.
- **Show in folder / open with another program**: the file is downloaded.
- Dropping files from the computer into the window uploads them (folders: as a ZIP or through Import).

## Container

`web/Dockerfile` builds an image with the server, Python 3.12 with CadQuery and `soma` (pinned as
`python/requirements-base.txt`) and CalculiX, from the root of the repository:

```
docker build -f web/Dockerfile -t soma-web .
docker run -p 5173:5173 -v soma-data:/home/soma soma-web     # the log names the address with the token
```

Everything of the user is in `/home/soma` (models, settings, sign-ins of agents): keep it on a volume. Agents such as
Claude Code are not part of the image; install them in the container (`npm install -g …` in a terminal of SOMA) or build
an image of your own on top. Behind an authenticating proxy use `SOMA_WEB_AUTH=proxy` and `SOMA_WEB_ORIGINS`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SOMA_WEB_HOST` | `127.0.0.1` | Address to listen on |
| `SOMA_WEB_PORT` | `5173` | Port |
| `SOMA_WEB_TOKEN` | random, kept in `<app data>/web-token` | Token for the first visit: `http://host:port/?token=…`. The server exchanges it for a cookie |
| `SOMA_WEB_AUTH` | `token` | `proxy`: a proxy in front authenticates (only with `SOMA_WEB_HOST` on localhost) |
| `SOMA_WEB_BASE` | `/` | Path prefix a proxy keeps in front of every request (Coder's path-based apps); not needed when the proxy removes it |
| `SOMA_WEB_ORIGINS` | | Further origins allowed for the WebSocket, comma separated |
| `SOMA_WEB_FILES` | home folder | Folder on the server the file dialogs show (open, save, open folder); nothing outside it, links included |
| `SOMA_USER_DATA` | `~/.soma-web` | App data: models, settings, logs |
| `SOMA_PYTHON` | `python3` in `PATH` | Python with `soma` and CadQuery (as for the desktop app) |

## Structure

- `server/main.ts`: start, HTTP (`http.ts`: token, cookie, origin check, static files), WebSocket, the command table.
- `server/tabs.ts`: the connected tab, reconnecting the same page, taking over by another tab.
- `server/platform.ts`: the host for `app/src/main` (dialogs, clipboard, links, recycle bin, render page).
- `server/files.ts`: uploads (`<app data>/uploads/`), the download area (`<app data>/downloads/`: what a request
  writes there goes to the browser, again after each change), download links as copies, the folders for the dialogs.
- `client/files.ts`: the file dialogs in the page: upload or a file on the server, download or a place on the server.
- `client/main.ts`: `window.soma` on the WebSocket, then the renderer of the desktop app. `client/webui.ts`: what only
  the web version shows (connection lost, session taken over).
- `shared/codec.ts`: messages as binary frames, keeps what Electron's IPC keeps (ArrayBuffer, typed arrays, `undefined`).
- `shared/protocol.ts`: the messages. `shared/files.ts`: the answers of the file dialogs, checked on the server.
- `bin/soma-web.cjs`: starts `dist/server.js` with the packages of `app/`.
- `test/`: unit tests (`unit.test.mts`), the built server over HTTP and WebSocket (`server.test.mts`), and
  `harness-web.mjs`: the suites of the desktop app against the web, `SOMA_TEST_TARGET=web node test/run-all.mjs` in `app/`.
- `Dockerfile`: the image (one container per user).
