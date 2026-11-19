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
- **Results reach the user's computer through a synced folder, not through SOMA.** With `SOMA_MIRROR_DIR` the server
  keeps the results of the open model as plain files in a folder of its own, one folder per model (`server/mirror.ts`);
  a sync tool brings that folder to the user's computer. In a Coder workspace that is the file sync of Coder Desktop
  (Mutagen): no cloud storage, no network share, nothing to sign in to. The folder is written in one direction only and
  holds no part of the model the app reads back. Chosen over Google Drive (needs a Google account or service account, and
  syncing the working folder itself breaks Git and floods the drive with the project environment) and over Samba in the
  container (port 445 per user, an open share on a machine that runs agents).

## Synced folder (`SOMA_MIRROR_DIR`)

```
<SOMA_MIRROR_DIR>/<model name>/
  model.step, drawings.pdf, drawings/…   output/ of the model, after each build or new drawing
  renders/…                              renders/ of the model (soma render)
  <model name>.soma                      the model file, after each save
  versions/<date> <message>/…            the results as they were at each save (off with SOMA_MIRROR_VERSIONS=0)
  .soma-mirror.json                      which model this is and what SOMA wrote
```

- A file the user changed there (on their computer, the sync brings the change back) is never overwritten: the new one
  goes next to it as `<name> (from SOMA).<ext>` and the page says so once. A file the user deleted comes back with the
  next new result. Nothing in the folder is ever deleted, `versions/` included: it grows with each save.
- Files are written through a temporary file and renamed, so the sync never picks up half a file.
- The folder is named after the model. A folder of that name that belongs to another model or to the user is left alone:
  then the name gets the start of the model's ID (`<name> (2)`, … when the folder is the models' home, see below). A
  folder with a `.soma-mirror.json` SOMA cannot read is never taken.
- A renamed model starts a new folder, the old one stays (as the models' home it moves along, see below).
- A model opened as a folder ("Open folder") has no saves: only its results are copied.
- Known limits: two saves within about a second make one version folder; a file changed on the computer in the very
  moment SOMA replaces it can be lost (the sync tool reports such conflicts itself); names differing only in case
  collide on Windows and macOS.

### The models' home (`SOMA_MIRROR_DIR` below `SOMA_WEB_FILES`)

When the dialogs show the synced folder too (in a Coder workspace both variables are the same folder), the folder of a
model is where the model lives for the user, not only a copy of its results. The working copy stays in the app data
(`<app data>/workspaces/`, with its Git history) as before.

- **New model** asks for the name first (Enter takes it) and makes `<name>/` at once. The name is cleaned like a folder
  name. When a folder of that name belongs to another model or to the user, the next free name (`<name> (2)`) is offered.
  The tutorial and a model from a CadQuery script keep their names, their folder gets a number when the name is taken.
- **Save** (Ctrl+S) of a model without a model file saves `<name>/<name>.soma` without a dialog. The file is noted in
  `.soma-mirror.json` as SOMA's and never copied onto itself. A model opened from a `.soma` elsewhere under the folder
  (copied in on the computer, the sync brings it) is saved back to that file, as on the desktop, and not copied a second
  time into its model folder. A folder of the user's that holds the opened file becomes the model's folder (nothing of
  the user's is replaced in it). A `<name>.soma` of the user's in the folder is replaced only after asking.
- **Save as** starts with the model name: the same name saves in its folder, a new name moves the model to the folder of
  that name. The folder is renamed when everything in it is SOMA's (the files it wrote and nobody changed, `versions/`,
  `.soma-mirror.json`) and it still has the name SOMA gave it; the old model file in it becomes `<new name>.soma` and is
  saved over. Otherwise the old folder stays as it is, the model gets a new one and the page says so once. Save elsewhere on the server and Download are the other buttons.
- **Download …** in the model menu: the model file to the computer, saved first when there are changes. Saving itself does
  not download any more.
- **Open** starts in the folder browser, in the synced folder, with Upload from this computer as a button.
- The folder browser of the dialogs has **New folder** (only below `SOMA_WEB_FILES`, plain names, no links followed).

Without `SOMA_MIRROR_DIR`, or with it outside `SOMA_WEB_FILES`, new models are "New model" and saving asks as before.

### In a Coder workspace

The template sets the variable on the persistent home volume and makes the folder:

```hcl
resource "coder_agent" "main" {
  # …
  env = {
    SOMA_MIRROR_DIR = "/home/coder/SOMA-files"
    # The same folder for the dialogs: the models live there (see "The models' home")
    SOMA_WEB_FILES  = "/home/coder/SOMA-files"
  }
  startup_script = <<-EOT
    mkdir -p /home/coder/SOMA-files
    # … start the SOMA web server as before
  EOT
}
```

Each user, once per workspace: install Coder Desktop, turn on Coder Connect, and under File Sync add a pair of a new
local folder (e.g. `C:\SOMA`) and `/home/coder/SOMA-files` of the workspace. The sync runs while the workspace runs;
results made meanwhile arrive on the computer at its next start.

## Commands

```
cd web
npm install
npm start                  # builds and starts the server, prints the address with the token
npm run build              # only builds (dist/)
npm run typecheck
npm run test:unit
npm test                   # builds, then unit, server and browser tests (Chromium from Playwright's cache)
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

## Which code runs

`npm run build` writes the commit, its branch and whether `app/`, `web/` or `python/` had uncommitted changes into
`dist/build.json`. The server prints it when it starts, the start page shows it next to the version (`deploy 83b46cf`,
a `+` for uncommitted changes), and `GET /health` answers without the token:

```
{"ok":true,"version":"0.11.0","commit":"83b46cf3a1c2","branch":"deploy","dirty":false,"built":"2026-11-19T16:00:00.000Z"}
```

So a check after a deployment can tell whether a change is in it. The code is public (GPL), its commit is no secret.

## Container

`web/Dockerfile` builds an image with the server, Python 3.12 with CadQuery and `soma` (pinned as
`python/requirements-base.txt`) and CalculiX, from the root of the repository:

```
docker build -f web/Dockerfile -t soma-web .
docker run -p 5173:5173 -v soma-data:/home/node soma-web     # the log names the address with the token
```

Everything of the user is in `/home/node` (models, settings, sign-ins of agents): keep it on a volume. Agents such as
Claude Code are not part of the image; install them in the container (`npm install -g …` in a terminal of SOMA goes to
`/home/node/.npm-global`, on the volume) or build an image of your own on top. The image listens on all addresses and
asks for the token: `SOMA_WEB_AUTH=proxy` is only for a proxy in the same container or network namespace, with
`SOMA_WEB_HOST=127.0.0.1` and `SOMA_WEB_ORIGINS` set.

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
| `SOMA_MIRROR_DIR` | off | Synced folder: results of the open model as files for a sync tool (see above) |
| `SOMA_MIRROR_VERSIONS` | `1` | `0`: no `versions/` folder at each save |
| `SOMA_COMMIT`, `SOMA_BRANCH` | from Git | Only for `npm run build`: which code is built, when there is no `.git` (the image) |

## Structure

- `server/main.ts`: start, HTTP (`http.ts`: token, cookie, origin check, static files), WebSocket, the command table.
- `server/tabs.ts`: the connected tab, reconnecting the same page, taking over by another tab.
- `server/platform.ts`: the host for `app/src/main` (dialogs, clipboard, links, recycle bin, render page).
- `server/mirror.ts`: the synced folder (`SOMA_MIRROR_DIR`), driven by the messages of the main process to the page
  (build finished, drawings, changed files, save state) in `server/main.ts`.
- `server/files.ts`: uploads (`<app data>/uploads/`), the download area (`<app data>/downloads/`: what a request
  writes there goes to the browser, again after each change), download links as copies, the folders for the dialogs.
- `client/files.ts`: the file dialogs in the page: upload or a file on the server, download or a place on the server.
- `client/main.ts`: `window.soma` on the WebSocket, then the renderer of the desktop app. `client/webui.ts`: what only
  the web version shows (connection lost, session taken over). `client/home.ts`: the models' home (name of a new model,
  Download in the model menu).
- `shared/codec.ts`: messages as binary frames, keeps what Electron's IPC keeps (ArrayBuffer, typed arrays, `undefined`).
- `shared/protocol.ts`: the messages. `shared/files.ts`: the answers of the file dialogs, checked on the server.
- `bin/soma-web.cjs`: starts `dist/server.js` with the packages of `app/`.
- `test/`: unit tests (`unit.test.mts`, `mirror.test.mts`), the built server over HTTP and WebSocket (`server.test.mts`), the page in
  Chromium (`browser.test.mts`: file dialogs, dropped files, lost connection, second tab, Alt shortcuts, closing, synced folder, the models' home on a second server), and
  `harness-web.mjs`: the suites of the desktop app against the web, `SOMA_TEST_TARGET=web node test/run-all.mjs` in `app/`.
- `Dockerfile`: the image (one container per user).
