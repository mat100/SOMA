import fs from 'node:fs';
import path from 'node:path';
import { aboutInfo, aboutText } from './about';
import { detectAgents } from './agents';
import { bridgeEnv } from './bridge';
import { choose, chooseInputFiles, chooseSkillFiles, setTestAnswers, trashItem } from './dialogs';
import { viewDxf } from './dxf';
import { backupText, createEntry, entryPath, importInputs, listFiles, renameEntry, resolveInside, saveFeedbackImage, trashEntry, writeProjectText } from './files';
import { readHelp, readHelpImage } from './help';
import { log } from './log';
import { editBackupsDir, helpDir, libraryBackupsDir, skillDirs, skillsDir, thumbnailsDir, userSkillsDir } from './paths';
import { platform } from './platform';
import type { ProjectController } from './projects';
import { readSettings, writeSettings } from './settings';
import { checkLibraryText, createLibrarySkill, importLibrarySkills, libraryState, ownFile, readLibrarySkill, removeLibrarySkill, saveLibrarySkill } from './skilllibrary';
import { isSkillId, isSkillMode, librarySkill } from './skills';
import { piEntry } from './somaai';
import { aiAccounts, cancelSignIn, defaultModel, listModels, listSessions, saveApiKey, setDefaultModel, signInChatGPT, signOut } from './somaaiauth';
import { areaDir, clearPreviews, isStorageArea, storageStats } from './storage';
import { terminalEnv } from './terminals';
import { checkUpdate } from './updates';
import { getSkillBases, getSkillDefaults, isProjectId, setSkillBase, setSkillDefault } from './workspace';
import { fileOpBlockReason } from '../shared/editable';
import type { AiResult, AiStatus, FileOpResult, LibraryResult, StorageClear } from '../shared/types';

/*
 * Everything the user interface can ask of the main process, as a table of channels (`group:method`, see preload.ts and
 * src/shared/api.ts). The host registers it on its transport: Electron on ipcMain (main.ts), the web version on its
 * WebSocket (web/). `handle` answers, `on` only receives. What only one host can do (restarting Electron, screenshots of
 * the window) the host registers itself.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the arguments come from the renderer and are checked in each handler
export type Handler = (...args: any[]) => unknown;
export type Handle = (channel: string, fn: Handler) => void;
export type On = (channel: string, fn: Handler) => void;

/** In test mode copied text lands here instead of in the user's real clipboard. */
let testClipboard = '';
/** Copies text; the answer for the renderer, with the error when the clipboard refused. */
async function copy(text: string, path?: string): Promise<FileOpResult> {
  if (process.env.SOMA_TEST === '1') { testClipboard = text; return { ok: true, ...(path ? { path } : {}) }; }
  try { await platform().writeClipboard(text); } catch (e) { return { ok: false, error: `Could not copy: ${e instanceof Error ? e.message : String(e)}` }; }
  return { ok: true, ...(path ? { path } : {}) };
}

/**
 * Logs requests answered with `{ ok: false, error }` (log.ts), canceled questions not. Otherwise only the user would see the
 * message and the log would miss it. Exceptions are logged by the host.
 */
export function logFailures(channel: string, fn: Handler): Handler {
  return async (...args) => {
    const r: unknown = await fn(...args);
    const o = r as { ok?: unknown; error?: unknown; canceled?: unknown } | null;
    if (o && typeof o === 'object' && o.ok === false && o.error && !o.canceled) log('WARN', `[${channel}] ${String(o.error)}`);
    return r;
  };
}

export function registerCommands(ctl: ProjectController, handle: Handle, on: On): void {
  const dir = () => ctl.need().dir;

  handle('project:current', () => ctl.info());
  // Nur der feste Name fürs Tutorial (E94), kein freier Text aus dem Renderer
  handle('project:create', (kind?: unknown) => ctl.create(kind === 'tutorial' ? 'Tutorial' : undefined));
  handle('project:list', async () => (await import('./workspace')).listProjects());
  handle('project:open', (id: string) => ctl.open(id));
  handle('project:saveState', () => ctl.saveState());
  handle('project:save', (saveAs?: boolean) => ctl.save(!!saveAs));
  handle('project:openZip', () => ctl.openZip());
  handle('project:openFolder', () => ctl.openFolder());
  handle('project:exportZip', () => ctl.exportZip());
  handle('project:createFromCadQuery', () => ctl.createFromCadQuery());
  handle('project:exportCadQuery', () => ctl.exportCadQuery());
  handle('project:reveal', () => ctl.reveal());
  // Agenten-Apps (Claude Desktop, Codex-App) öffnen den Arbeitsordner selbst. `soma` finden sie über .soma/env (AGENTS.md)
  handle('project:copyPath', (): FileOpResult | Promise<FileOpResult> => {
    const dir = ctl.session?.dir;
    if (!dir) return { ok: false, error: 'No model is open.' };
    return copy(dir, dir);
  });
  handle('project:setThumb', (dataUrl: string) => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m || m[1].length > 2_000_000 || !ctl.session) return;
    fs.mkdirSync(thumbnailsDir(), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsDir(), `${ctl.session.id}.jpg`), Buffer.from(m[1], 'base64'));
  });
  handle('project:remove', (id: string) => ctl.remove(String(id)));
  handle('project:viewFile', (rel: unknown) => ctl.viewFile(rel));
  handle('project:thumb', (id: string) => {
    if (!isProjectId(String(id))) return null;
    try { return `data:image/jpeg;base64,${fs.readFileSync(path.join(thumbnailsDir(), `${id}.jpg`)).toString('base64')}`; } catch { return null; }
  });

  handle('versions:log', () => ctl.gitLog());
  handle('versions:preview', (hash: string) => ctl.preview(hash));
  handle('versions:restore', (hash: string) => ctl.restore(hash));

  handle('build:run', () => ctl.need().builds.start('manual'));
  handle('build:cancel', () => ctl.need().builds.cancel());
  handle('build:setAuto', (on: boolean) => ctl.need().builds.setAuto(!!on));
  handle('build:status', () => ctl.need().builds.status);
  handle('build:export', (format: string, part: string | null, mesh: unknown) => ctl.exportModel(String(format), part ? String(part) : null, mesh));
  handle('build:exportAssembly', () => ctl.exportModel('step', null, undefined, true));

  handle('fs:list', () => listFiles(dir()));
  handle('fs:import', (paths: string[]) => importInputs(dir(), Array.isArray(paths) ? paths.map(String) : []));
  handle('fs:importPick', async () => {
    const root = dir();
    const files = await chooseInputFiles();
    return files.length ? importInputs(root, files) : null;
  });
  handle('fs:create', (parent: string, name: string, isDir: boolean) => createEntry(dir(), String(parent ?? ''), String(name ?? ''), !!isDir));
  handle('fs:rename', (rel: string, name: string) => renameEntry(dir(), String(rel ?? ''), String(name ?? '')));
  handle('fs:trash', async (rel: string): Promise<FileOpResult> => {
    const root = dir();
    const r = entryPath(root, String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    // Gesperrtes gar nicht erst zur Rückfrage bringen (trashEntry prüft danach noch einmal mit bereinigtem Pfad)
    const block = fileOpBlockReason(String(rel), 'delete');
    if (block) return { ok: false, error: `${rel} cannot be deleted. ${block}` };
    const isDir = fs.statSync(r.abs).isDirectory();
    // Die Rückfrage stellt der Hauptprozess: So beantworten Tests sie wie alle anderen Dialoge (dialogs.ts)
    const c = await choose({
      title: 'Delete',
      message: isDir ? `Move the folder “${path.basename(r.abs)}” and everything in it to the Recycle Bin?` : `Move “${path.basename(r.abs)}” to the Recycle Bin?`,
      detail: 'It can be restored from the Recycle Bin. Saved versions in the history are kept anyway.',
      buttons: ['Move to Recycle Bin', 'Cancel'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    return trashEntry(root, String(rel), (abs) => trashItem(abs));
  });
  handle('fs:reveal', (rel: string): FileOpResult => {
    const r = entryPath(dir(), String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST !== '1') platform().showItemInFolder(r.abs);
    return { ok: true, path: String(rel ?? '') };
  });
  handle('fs:openExternal', async (rel: string): Promise<FileOpResult> => {
    const r = entryPath(dir(), String(rel ?? ''), true);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: String(rel ?? '') };
    const err = await platform().openPath(r.abs);
    return err ? { ok: false, error: err } : { ok: true, path: String(rel ?? '') };
  });
  // Links aus Markdown-Dateien (E51). Nur Web und Mail: file:, Programme und eigene Protokolle könnten etwas ausführen.
  // „Send to agent“ legt den Text auch in die Zwischenablage, für Agenten-Apps außerhalb der App (Claude Desktop, Codex-App)
  handle('app:copyText', (text: unknown): FileOpResult | Promise<FileOpResult> => {
    if (typeof text !== 'string' || text.length > 1_000_000) return { ok: false, error: 'Nothing to copy.' };
    return copy(text);
  });
  handle('app:openUrl', async (url: unknown): Promise<FileOpResult> => {
    const u = String(url ?? '');
    if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: `Only web and mail addresses can be opened: ${u.slice(0, 100)}` };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: u };
    try { await platform().openExternal(u); return { ok: true, path: u }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  handle('fs:saveFeedback', (png: unknown) => saveFeedbackImage(dir(), png));
  handle('fs:writeText', (id: string, rel: string, text: string, base: string | null, force?: boolean) => {
    const s = ctl.session;
    // Späte Eingabe aus einem schon gewechselten Modell: nicht ins falsche Projekt schreiben, aber auch nicht verlieren
    if (!s || s.id !== id) {
      if (!isProjectId(String(id))) return { ok: false, error: 'Unknown model.' };
      return { ok: false, error: `The model has been switched in the meantime. The change is kept as a backup in ${backupText(editBackupsDir(id), String(rel), String(text))}` };
    }
    return writeProjectText(s.dir, String(rel), String(text), base == null ? null : String(base), !!force, editBackupsDir(s.id));
  });
  handle('fs:backupText', (id: string, rel: string, text: string) => {
    if (!isProjectId(String(id))) throw new Error('Unknown model.');
    return backupText(editBackupsDir(String(id)), String(rel), String(text));
  });
  handle('fs:readText', (rel: string) => fs.readFileSync(resolveInside(dir(), rel), 'utf8'));
  handle('fs:readBinary', (rel: string) => {
    const b = fs.readFileSync(resolveInside(dir(), rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  handle('dxf:view', (rel: unknown, known: unknown) => viewDxf(dir(), String(rel), known == null ? null : String(known)));

  handle('term:create', (opts?: { command?: string }) => ctl.need().terminals.create(opts));
  on('term:write', (id: number, data: string) => ctl.session?.terminals.write(id, data));
  on('term:resize', (id: number, cols: number, rows: number) => ctl.session?.terminals.resize(id, cols, rows));
  on('term:kill', (id: number) => ctl.session?.terminals.kill(id));

  const agents = () => detectAgents(ctl.session ? terminalEnv(dir()) : process.env);
  handle('agents:detect', () => agents());
  // SOMA AI (somaai.ts): one pi process per open model, only reachable through the commands SomaAI allows
  const noModel: AiResult = { ok: false, error: 'No model is open.' };
  handle('ai:status', (): AiStatus => ctl.session?.ai.status() ?? { available: !!piEntry(), running: false });
  handle('ai:start', () => ctl.session?.ai.start() ?? noModel);
  handle('ai:command', (cmd: unknown) => ctl.session?.ai.command(cmd) ?? noModel);
  on('ai:respond', (res: unknown) => ctl.session?.ai.respond(res));
  handle('ai:stop', () => ctl.session?.ai.stopAndWait());
  // Sign-in (somaaiauth.ts) holds for the whole app. A running pi of the open model ends, the next message starts it
  // again with the new sign-in and model (the conversation continues)
  const restartAi = <T extends { ok: boolean }>(r: T): T => { if (r.ok) ctl.session?.ai.restart(); return r; };
  handle('ai:accounts', () => aiAccounts());
  handle('ai:saveKey', (provider: unknown, key: unknown) => restartAi(saveApiKey(provider, key)));
  handle('ai:signIn', async () => restartAi(await signInChatGPT((url) => {
    platform().send('ai:signInUrl', url);
    if (process.env.SOMA_TEST !== '1') void platform().openExternal(url);
  })));
  handle('ai:cancelSignIn', () => cancelSignIn());
  handle('ai:signOut', (provider: unknown) => restartAi(signOut(provider)));
  // Earlier conversations of the open model: the window gets ids, never files. Switching looks the file up again
  handle('ai:sessions', async () => {
    const s = ctl.session;
    if (!s) return noModel;
    const r = await listSessions(s.dir);
    return r.ok ? { ok: true, sessions: (r.sessions ?? []).map(({ id, title, modified, messages }) => ({ id, title, modified, messages })) } : r;
  });
  handle('ai:switchSession', async (id: unknown) => {
    const s = ctl.session;
    if (!s) return noModel;
    if (typeof id !== 'string') return { ok: false, error: 'Unknown conversation.' };
    const r = await listSessions(s.dir);
    if (ctl.session !== s) return { ok: false, error: 'Another model was opened meanwhile.' };
    const hit = r.sessions?.find((x) => x.id === id);
    if (!hit) return { ok: false, error: r.error ?? 'This conversation is no longer there.' };
    return s.ai.switchSession(hit.path);
  });
  handle('ai:models', () => listModels());
  handle('ai:defaultModel', () => defaultModel());
  handle('ai:setDefaultModel', (provider: unknown, id: unknown) => setDefaultModel(provider, id));
  handle('measure:query', (source: unknown, req: unknown) => ctl.measure(source, req));
  handle('measure:start', () => ctl.measureStart());
  handle('measure:prepare', (source: unknown, build: unknown) => ctl.measurePrepare(source, build));
  handle('params:state', () => ctl.paramState());
  handle('params:set', (values: unknown) => ctl.setParams(values));
  handle('params:resetAll', () => ctl.resetAllParams());
  // Anleitung (E83): Text aus dem mitgelieferten Skill, Bilder aus resources/help/
  handle('help:read', () => readHelp(skillsDir()));
  handle('help:image', (name: unknown) => readHelpImage(helpDir(), name));
  handle('skills:list', () => ctl.skills());
  handle('skills:set', (id: unknown, mode: unknown) => ctl.setSkill(id, mode));
  handle('skills:configure', (id: unknown, values: unknown) => ctl.configureSkill(id, values));
  handle('skills:setDefault', (id: unknown, mode: unknown) => ctl.setSkillDefault(id, mode));

  // Bibliothek der Skills in den Einstellungen (E78): unabhängig vom offenen Modell, also auch auf der Startseite
  const lib = () => libraryState(skillDirs(), getSkillDefaults(), getSkillBases());
  const libDo = async (f: () => Omit<LibraryResult, 'ok' | 'library'> | Promise<Omit<LibraryResult, 'ok' | 'library'>>): Promise<LibraryResult> => {
    try { return { ok: true, ...(await f()), library: lib() }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), library: lib() }; }
  };
  handle('library:list', () => lib());
  handle('library:read', (id: unknown) => readLibrarySkill(skillDirs(), String(id)));
  handle('library:check', (text: unknown) => checkLibraryText(text));
  handle('library:save', (id: unknown, text: unknown, base: unknown) => libDo(() => {
    if (typeof text !== 'string') throw new Error('No text.');
    const r = saveLibrarySkill(skillDirs(), String(id), text, typeof base === 'string' ? base : null, libraryBackupsDir());
    if (r.base !== undefined) setSkillBase(String(id), r.base);
    return { id: String(id), backup: r.backup, warnings: r.warnings };
  }));
  handle('library:create', (title: unknown, from: unknown) =>
    libDo(() => ({ id: createLibrarySkill(skillDirs(), String(title ?? ''), typeof from === 'string' ? from : undefined) })));
  handle('library:remove', (id: unknown) => libDo(() => {
    const backup = removeLibrarySkill(skillDirs(), String(id), libraryBackupsDir());
    setSkillBase(String(id), null);
    return { id: String(id), backup };
  }));
  handle('library:import', () => libDo(async () => {
    const files = await chooseSkillFiles();
    if (!files.length) return { canceled: true };
    const r = await importLibrarySkills(skillDirs(), files, libraryBackupsDir(), async (c) => {
      const detail = c.source === 'own'
        ? `${c.file} has the same file name as one of your skills. Replace: your current version goes into the backup. Import as a copy: the file gets its own name.`
        : `${c.file} has the same file name as a built-in skill. Replace: the file takes the place of the built-in skill${c.source === 'edited' ? ', your edited version goes into the backup' : ''}, “Reset” brings the original back. Import as a copy: the file gets its own name.`;
      const i = await choose({ title: 'Import skills', message: `“${c.title}” (${c.id}.md) already exists.`, detail, buttons: ['Replace', 'Import as a copy', 'Skip'] });
      return i === 0 ? 'replace' : i === 1 ? 'copy' : 'skip';
    });
    for (const [id, h] of Object.entries(r.bases)) setSkillBase(id, h);
    return { id: r.ids[0], imported: r.ids, warnings: r.warnings, backup: r.backups[0] ?? null };
  }));
  handle('library:setDefault', (id: unknown, mode: unknown) => libDo(() => {
    const s = isSkillId(id) ? librarySkill(skillDirs(), id) : undefined;
    if (!s) throw new Error('This skill does not exist (any more).');
    if (!isSkillMode(mode)) throw new Error(`Unknown level “${String(mode)}”.`);
    setSkillDefault(s.id, mode, s.defaultMode);
    return { id: s.id };
  }));
  handle('library:reveal', async (id: unknown) => {
    const file = typeof id === 'string' ? ownFile(skillDirs(), id) : null;
    if (process.env.SOMA_TEST === '1') return;
    if (file) { platform().showItemInFolder(file); return; }
    fs.mkdirSync(userSkillsDir(), { recursive: true });
    await platform().openPath(userSkillsDir());
  });

  // Einstellungen der App (E81)
  handle('settings:get', () => readSettings());
  handle('settings:set', (patch: unknown) => {
    try { return writeSettings(patch); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), ...readSettings() }; }
  });
  handle('storage:stats', () => storageStats());
  handle('storage:open', async (area: unknown): Promise<FileOpResult> => {
    if (!isStorageArea(area)) return { ok: false, error: 'Unknown folder.' };
    const p = areaDir(area);
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (process.env.SOMA_TEST === '1') return { ok: true, path: p };
    const err = await platform().openPath(p);
    return err ? { ok: false, error: err } : { ok: true, path: p };
  });
  handle('storage:clearPreviews', async (): Promise<StorageClear> => {
    const keep = ctl.session?.id ?? null;
    const c = await choose({
      title: 'Clear preview cache',
      message: 'Clear the preview cache?',
      detail: `Previews of older versions are created again when you open them in the history. ${keep ? 'Those of the open model stay. ' : ''}Your models and their history are not affected.`,
      buttons: ['Clear', 'Cancel'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    try {
      const r = await clearPreviews(keep);
      return { ok: !r.failed, freed: r.freed, kept: r.kept, stats: await storageStats(), ...(r.failed ? { error: `${r.failed} folder${r.failed === 1 ? '' : 's'} could not be removed (still in use).` } : {}) };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  handle('about:info', () => aboutInfo(agents));
  // Nur wenn die Einstellung es erlaubt: Ausgeschaltet geht keine Anfrage ins Netz
  handle('updates:check', () => checkUpdate(readSettings().settings.start.updateCheck));
  handle('about:copy', async (): Promise<FileOpResult> => {
    return copy(aboutText(await aboutInfo(agents)));
  });

  handle('anim:list', () => ctl.animList());
  handle('anim:build', (file: unknown) => ctl.animBuild(file));
  handle('drawings:list', () => ctl.drawingList());
  handle('drawings:build', (file: unknown) => ctl.drawingBuild(file));
  handle('drawings:export', (what: unknown, sheet: unknown) => ctl.drawingExport(what, sheet));
  handle('results:list', () => ctl.results());
  handle('results:rerun', (id: unknown) => ctl.rerunResult(id));
  handle('render:video', (id: unknown) => ctl.renderVideo(id));
  // Rückfragen aus dem Renderer (etwa ungespeicherte Eingaben im Editor) laufen über dieselben Dialoge wie im Hauptprozess
  handle('dialog:choose', (o: { title?: unknown; message?: unknown; detail?: unknown; buttons?: unknown }) => {
    const buttons = Array.isArray(o?.buttons) ? o.buttons.slice(0, 4).map(String) : [];
    if (!buttons.length) return -1;
    return choose({ title: String(o.title ?? 'SOMA'), message: String(o.message ?? ''), detail: o.detail == null ? undefined : String(o.detail), buttons });
  });

  // Nur im Testmodus: vorbereitete Antworten für Dialoge (siehe dialogs.ts)
  if (process.env.SOMA_TEST === '1') {
    handle('test:answers', (a: unknown[]) => setTestAnswers(a));
    // Adresse und Schlüssel für soma render, damit Tests es auch außerhalb eines Terminals aufrufen können
    handle('test:bridge', () => bridgeEnv());
    handle('test:clipboard', () => testClipboard);
  }
}
