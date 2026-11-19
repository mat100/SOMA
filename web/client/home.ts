import type { SomaApi } from '../../app/src/shared/types';
import type { ProjectInfo } from '../../app/src/shared/types';
import { toast } from '../../app/src/renderer/ui';
import { askModelName } from './files';
import type { WsTransport } from './transport';

/*
 * The synced folder as the models' home (web/server/main.ts, modelHome): "New model" asks for the name first, as the
 * model gets a folder of that name at once; saving needs no dialog (the server saves into that folder), so downloading the
 * model file is an entry of its own in the model menu.
 */

/** Buttons of the app that create a model (index.html; tests and shortcuts need them, so their ids are fixed). */
const NEW_BUTTONS = '#btn-new, #start-new, #start-new-tpl, #start-empty-new';

const hidden = (id: string) => document.getElementById(id)?.hidden ?? true;

export function modelHome(t: WsTransport, api: SomaApi): void {
  /** The name asked for before the app started creating (it shows its loading screen first, see below). */
  let pending: string | null = null;
  const ask = () => askModelName(t, { title: 'New model', message: 'Name of the new model. Its folder in the synced folder gets the same name.', value: 'New model', ok: 'Create' });

  const create = api.project.create;
  api.project.create = async (kind) => {
    if (kind) return create(kind); // the tutorial: its own name
    // Called without the buttons (tests through the API): asked here, above the loading screen
    const name = pending ?? (await ask());
    pending = null;
    if (name === null) throw new Error('No name given, no model created.');
    return t.invoke('web:createModel', name) as Promise<ProjectInfo>;
  };

  // The app shows its loading screen before it creates the model; the name is asked before that, so canceling leaves the
  // window as it was. The click or key goes to the app again once there is a name.
  let again = false;
  const busy = () => !hidden('app-busy') || !hidden('settings') || !hidden('help') || !!document.querySelector('.ask-scrim');
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.(NEW_BUTTONS) as HTMLElement | null;
    if (again || !b || busy()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void ask().then((name) => {
      if (name === null) return;
      pending = name;
      again = true;
      try { b.click(); } finally { again = false; }
    });
  }, true);
  window.addEventListener('keydown', (e) => {
    // Alt+N in the browser (shortcuts.ts WEB_ALT_KEYS), Ctrl+N where the browser leaves it to the page
    const n = e.key.toLowerCase() === 'n' && !e.shiftKey && ((e.altKey && !e.ctrlKey && !e.metaKey) || (e.ctrlKey && !e.altKey));
    if (again || !n || busy() || (e.target as Element | null)?.closest?.('#terminals')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const init: KeyboardEventInit = { key: e.key, code: e.code, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true };
    void ask().then((name) => {
      if (name === null) return;
      pending = name;
      again = true;
      try { window.dispatchEvent(new KeyboardEvent('keydown', init)); } finally { again = false; }
    });
  }, true);

  // Download: after Save as in the model menu
  const saveAs = document.getElementById('btn-saveas');
  if (saveAs) {
    const b = document.createElement('button');
    b.id = 'btn-web-download';
    b.className = 'mi';
    b.setAttribute('role', 'menuitem');
    b.title = 'The model file to this computer, saved first when there are changes';
    const ico = document.createElement('span');
    ico.className = 'noico';
    const label = document.createElement('span');
    label.textContent = 'Download …';
    b.append(ico, label);
    b.addEventListener('click', () => {
      void (t.invoke('web:downloadModel') as Promise<{ ok: boolean; error?: string; name?: string }>)
        .then((r) => { if (r.error) toast(r.error, 'error'); })
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'));
    });
    saveAs.after(b);
  }
}
