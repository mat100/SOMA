import { navLegend, type NavPreset } from '../shared/settings';

// Übersicht der Tasten und Mausgesten für den Reiter „Shortcuts“ der Einstellungen. Die Tasten selbst sind dort verdrahtet, wo
// sie wirken (main.ts, markup.ts, videoview.ts …). Wer dort eine ändert oder hinzufügt, trägt sie hier nach.

export interface Shortcut { keys: string[]; what: string }
export interface ShortcutGroup { title: string; items: Shortcut[] }

/**
 * In the browser (web version) Ctrl+N opens a new window and Ctrl+1 to 3 switch tabs; the browser does not give them to
 * the page. There these commands are on Alt instead. Keys of the list and labels in the window follow (webKeys).
 */
export const WEB_ALT_KEYS = ['n', '1', '2', '3'];

/** In the browser: Ctrl of the keys above becomes Alt, in labels like "Ctrl N" and "(Ctrl 1)" too. */
export function webKeys(root: ParentNode): void {
  const swap = (s: string) => s.replace(/\bCtrl([ +])([N123])\b/g, 'Alt$1$2');
  for (const e of root.querySelectorAll<HTMLElement>('.kbd, .k')) if (/^Ctrl [N123]$/.test(e.textContent ?? '')) e.textContent = swap(e.textContent!);
  for (const e of root.querySelectorAll<HTMLElement>('[title*="Ctrl"]')) e.title = swap(e.title);
}

/** Alle Gruppen. Die Navigation im Viewer hängt von der Mausbelegung in den Einstellungen ab (E81). */
export function shortcutGroups(nav: NavPreset, web = false): ShortcutGroup[] {
  const mod = (k: string) => (web && WEB_ALT_KEYS.includes(k.toLowerCase()) ? 'Alt' : 'Ctrl');
  return [
    {
      title: 'Select and show parts',
      items: [
        { keys: ['Click'], what: 'Select a part, in the model or in the structure tree' },
        { keys: ['Ctrl', 'Click'], what: 'Add a part to the selection or remove it' },
        { keys: ['Shift', 'Click'], what: 'Add to the selection. In the tree: select all parts from the last click to here' },
        { keys: ['Alt', 'Drag'], what: 'Box select in the model. Left to right: parts fully inside. Right to left: parts touching the box. With Shift or Ctrl: add' },
        { keys: ['Right-click'], what: 'Menu for the part or the selection: isolate, hide, transparent, zoom, code, agent' },
        { keys: ['H'], what: 'Hide the selected parts' },
        { keys: ['Shift', 'H'], what: 'Show all parts again' },
        { keys: ['I'], what: 'Isolate: show only the selected parts' },
        { keys: ['T'], what: 'Make the selected parts transparent, or opaque again' },
        { keys: ['Esc'], what: 'Clear the selection' },
        { keys: ['Drag across the eyes'], what: 'In the tree: hide or show several parts in one go (same for the half circles: transparent)' },
        { keys: ['F3'], what: 'Expand or collapse the structure tree' },
      ],
    },
    {
      title: 'View',
      items: [
        ...navLegend(nav).map((n) => ({ keys: [n.how], what: n.label })),
        { keys: ['Double-click'], what: 'Set the pivot to the spot under the mouse' },
      ],
    },
    {
      title: 'Model and window',
      items: [
        { keys: ['Ctrl', 'S'], what: 'Save the model (in the code: save the file and build)' },
        { keys: ['Ctrl', 'Shift', 'S'], what: 'Save as' },
        { keys: ['Ctrl', 'O'], what: 'Open a model' },
        { keys: [mod('N'), 'N'], what: 'New model' },
        { keys: ['Ctrl', 'B'], what: 'Build now' },
        { keys: [mod('1'), '1'], what: 'Show or hide the sidebar' },
        { keys: [mod('2'), '2'], what: 'Show or hide the code' },
        { keys: [mod('3'), '3'], what: 'Expand or collapse the agent' },
        { keys: ['F1'], what: 'Help: how the app works' },
      ],
    },
    {
      title: 'Animation and video',
      items: [
        { keys: ['Space'], what: 'Play or pause' },
        { keys: ['←', '→'], what: 'Video: one frame back or forward' },
        { keys: ['Esc'], what: 'Close the video' },
      ],
    },
    {
      title: 'Tools',
      items: [
        { keys: ['Esc'], what: 'Stop measuring, cancel a preparation' },
        { keys: ['↑', '↓'], what: 'Section: move the plane by 1 mm (Shift: 10 mm, Alt: 0.1 mm)' },
        { keys: ['+', '−', '0'], what: 'PDF and DXF: zoom in, zoom out, fit' },
        { keys: ['F2'], what: 'Files: rename' },
        { keys: ['Del'], what: 'Files: move to the Recycle Bin' },
      ],
    },
    {
      title: 'Markup',
      items: [
        { keys: ['Ctrl', 'Z'], what: 'Undo' },
        { keys: ['Ctrl', 'Y'], what: 'Redo (also Ctrl Shift Z)' },
        { keys: ['Del'], what: 'Delete the selected shape' },
        { keys: ['Shift'], what: 'While drawing: square, circle, 15° steps. While scaling: keep the aspect ratio' },
        { keys: ['Alt'], what: 'While dragging: ignore the grid' },
        { keys: ['Esc'], what: 'Deselect the shape, then discard the markup (press twice)' },
      ],
    },
  ];
}
