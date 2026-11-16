import type { SomaApi } from './types';

/**
 * How the user interface reaches the main process: on the desktop Electron's IPC (preload.ts), in the web version a
 * WebSocket to the server (web/). Channels are `group:method` (src/main/commands.ts). `invoke` expects an answer, `send`
 * does not, `on` receives messages from the main process.
 */
export interface Transport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each method of SomaApi gives the type of its answer
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as with invoke
  on(channel: string, cb: (...args: any[]) => void): void;
  /** Where dropped files are for the main process: their place on disk (desktop), uploaded first (web). */
  filePaths(files: File[]): string[] | Promise<string[]>;
}

/** `testMode`: SOMA_TEST=1. `startsHome`: the app begins on the start page (outside the tests always). */
export interface ApiEnv { testMode: boolean; startsHome: boolean }

/** Schmale, feste Schnittstelle zwischen Renderer und Hauptprozess. Der Renderer hat keinen Node-Zugriff. */
export function createSomaApi(t: Transport, env: ApiEnv): SomaApi {
  return {
    testMode: env.testMode,
    startsHome: env.startsHome,
    project: {
      current: () => t.invoke('project:current'),
      create: (kind) => t.invoke('project:create', kind),
      list: () => t.invoke('project:list'),
      open: (id) => t.invoke('project:open', id),
      onChanged: (cb) => { t.on('project:changed', (p) => cb(p)); },
      saveState: () => t.invoke('project:saveState'),
      save: (saveAs) => t.invoke('project:save', saveAs),
      openZip: () => t.invoke('project:openZip'),
      openFolder: () => t.invoke('project:openFolder'),
      exportZip: () => t.invoke('project:exportZip'),
      createFromCadQuery: () => t.invoke('project:createFromCadQuery'),
      onStep: (cb) => { t.on('project:step', (s) => cb(s)); },
      exportCadQuery: () => t.invoke('project:exportCadQuery'),
      onSaveState: (cb) => { t.on('save:state', (st) => cb(st)); },
      reveal: () => t.invoke('project:reveal'),
      copyPath: () => t.invoke('project:copyPath'),
      setThumb: (dataUrl) => t.invoke('project:setThumb', dataUrl),
      thumb: (id) => t.invoke('project:thumb', id),
      remove: (id) => t.invoke('project:remove', id),
      viewFile: (rel) => t.invoke('project:viewFile', rel),
    },
    versions: {
      log: () => t.invoke('versions:log'),
      preview: (hash) => t.invoke('versions:preview', hash),
      restore: (hash) => t.invoke('versions:restore', hash),
      onChanged: (cb) => { t.on('versions:changed', () => cb()); },
    },
    build: {
      run: () => t.invoke('build:run'),
      cancel: () => t.invoke('build:cancel'),
      setAuto: (on) => t.invoke('build:setAuto', on),
      status: () => t.invoke('build:status'),
      onStatus: (cb) => { t.on('build:status', (s) => cb(s)); },
      export: (format, part, mesh) => t.invoke('build:export', format, part, mesh ?? null),
      exportAssembly: () => t.invoke('build:exportAssembly'),
    },
    fs: {
      list: () => t.invoke('fs:list'),
      readText: (rel) => t.invoke('fs:readText', rel),
      readBinary: (rel) => t.invoke('fs:readBinary', rel),
      onChanged: (cb) => { t.on('fs:changed', () => cb()); },
      // Der Renderer kennt keine Dateipfade. Nur die Pfade gezogener Dateien gehen an den Hauptprozess, der prüft und kopiert.
      // Paths known at once (desktop): ask at once, so the import keeps its place before later requests (another model opened)
      importFiles: (files) => {
        const paths = t.filePaths(files);
        return Array.isArray(paths) ? t.invoke('fs:import', paths.filter(Boolean)) : paths.then((p) => t.invoke('fs:import', p.filter(Boolean)));
      },
      importPick: () => t.invoke('fs:importPick'),
      create: (parent, name, dir) => t.invoke('fs:create', parent, name, dir),
      rename: (rel, name) => t.invoke('fs:rename', rel, name),
      trash: (rel) => t.invoke('fs:trash', rel),
      reveal: (rel) => t.invoke('fs:reveal', rel),
      openExternal: (rel) => t.invoke('fs:openExternal', rel),
      saveFeedback: (png) => t.invoke('fs:saveFeedback', png),
      writeText: (id, rel, text, base, force) => t.invoke('fs:writeText', id, rel, text, base, force),
      backupText: (id, rel, text) => t.invoke('fs:backupText', id, rel, text),
      onEditorRequest: (cb) => {
        t.on('editor:req', async (id: number, action: 'status' | 'save' | 'discard') => t.send('editor:res', id, await cb(action).catch(() => null)));
      },
    },
    dxf: { view: (rel, known) => t.invoke('dxf:view', rel, known ?? null) },
    term: {
      create: (opts) => t.invoke('term:create', opts),
      write: (id, data) => t.send('term:write', id, data),
      resize: (id, cols, rows) => t.send('term:resize', id, cols, rows),
      kill: (id) => t.send('term:kill', id),
      onData: (cb) => { t.on('term:data', (id, data) => cb(id, data)); },
      onExit: (cb) => { t.on('term:exit', (id, code) => cb(id, code)); },
    },
    agents: { detect: () => t.invoke('agents:detect') },
    ai: {
      status: () => t.invoke('ai:status'),
      start: () => t.invoke('ai:start'),
      command: (cmd) => t.invoke('ai:command', cmd),
      respond: (res) => t.send('ai:respond', res),
      stop: () => t.invoke('ai:stop'),
      onEvent: (cb) => { t.on('ai:event', (ev) => cb(ev)); },
      onExit: (cb) => { t.on('ai:exit', (ev) => cb(ev)); },
      accounts: () => t.invoke('ai:accounts'),
      saveKey: (provider, key) => t.invoke('ai:saveKey', provider, key),
      signIn: () => t.invoke('ai:signIn'),
      cancelSignIn: () => t.invoke('ai:cancelSignIn'),
      signOut: (provider) => t.invoke('ai:signOut', provider),
      onSignInUrl: (cb) => { t.on('ai:signInUrl', (url) => cb(url)); },
      models: () => t.invoke('ai:models'),
      defaultModel: () => t.invoke('ai:defaultModel'),
      setDefaultModel: (provider, id) => t.invoke('ai:setDefaultModel', provider, id),
      sessions: () => t.invoke('ai:sessions'),
      switchSession: (id) => t.invoke('ai:switchSession', id),
    },
    measure: {
      query: (source, req) => t.invoke('measure:query', source, req),
      start: () => t.invoke('measure:start'),
      prepare: (source, build) => t.invoke('measure:prepare', source, build),
    },
    params: {
      state: () => t.invoke('params:state'),
      set: (values) => t.invoke('params:set', values),
      resetAll: () => t.invoke('params:resetAll'),
    },
    help: {
      read: () => t.invoke('help:read'),
      image: (name) => t.invoke('help:image', name),
    },
    skills: {
      list: () => t.invoke('skills:list'),
      set: (id, mode) => t.invoke('skills:set', id, mode),
      configure: (id, values) => t.invoke('skills:configure', id, values),
      setDefault: (id, mode) => t.invoke('skills:setDefault', id, mode),
    },
    library: {
      list: () => t.invoke('library:list'),
      read: (id) => t.invoke('library:read', id),
      check: (text) => t.invoke('library:check', text),
      save: (id, text, base) => t.invoke('library:save', id, text, base),
      create: (title, from) => t.invoke('library:create', title, from),
      remove: (id) => t.invoke('library:remove', id),
      import: () => t.invoke('library:import'),
      setDefault: (id, mode) => t.invoke('library:setDefault', id, mode),
      reveal: (id) => t.invoke('library:reveal', id),
    },
    settings: {
      get: () => t.invoke('settings:get'),
      set: (patch) => t.invoke('settings:set', patch),
    },
    storage: {
      stats: () => t.invoke('storage:stats'),
      open: (area) => t.invoke('storage:open', area),
      clearPreviews: () => t.invoke('storage:clearPreviews'),
    },
    gpu: {
      webglFailed: () => t.invoke('gpu:webglFailed'),
    },
    about: {
      info: () => t.invoke('about:info'),
      copy: () => t.invoke('about:copy'),
    },
    updates: {
      check: () => t.invoke('updates:check'),
    },
    anim: {
      list: () => t.invoke('anim:list'),
      build: (file) => t.invoke('anim:build', file ?? null),
      onChanged: (cb) => { t.on('anim:changed', () => cb()); },
    },
    drawings: {
      list: () => t.invoke('drawings:list'),
      build: (file) => t.invoke('drawings:build', file ?? null),
      export: (what, sheet) => t.invoke('drawings:export', what, sheet ?? null),
      onChanged: (cb) => { t.on('drawings:changed', () => cb()); },
    },
    results: {
      list: () => t.invoke('results:list'),
      rerun: (id) => t.invoke('results:rerun', id),
    },
    render: {
      video: (animId) => t.invoke('render:video', animId),
      onProgress: (cb) => { t.on('render:progress', (f) => cb(f)); },
      onNotice: (cb) => { t.on('render:notice', (n) => cb(n)); },
    },
    dialog: {
      choose: (o) => t.invoke('dialog:choose', o),
      // Erst ab hier zeigt der Hauptprozess Rückfragen in der App, vorher (oder ohne Antwort) als Dialog des Systems
      onShow: (cb) => {
        t.on('dialog:show', async (id: number, o) => t.send('dialog:res', id, await cb(o).catch(() => null)));
        t.send('dialog:ready');
      },
    },
    openUrl: (url) => t.invoke('app:openUrl', url),
    copyText: (text) => t.invoke('app:copyText', text),
    // Nur im Testmodus: vorbereitete Antworten für native Dialoge
    test: env.testMode
      ? {
        answers: (a) => t.invoke('test:answers', a), screenshot: (f, rect) => t.invoke('test:screenshot', f, rect), bridge: () => t.invoke('test:bridge'),
        close: () => t.invoke('test:close'), clipboard: () => t.invoke('test:clipboard'),
      }
      : undefined,
  };
}
