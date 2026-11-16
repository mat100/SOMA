import { startBridge, stopBridge } from './bridge';
import { stopWarm, warmUp } from './build';
import { adoptLoginShellPath, skillDirs } from './paths';
import type { ProjectController } from './projects';
import { renameOldSkillFiles } from './skilllibrary';
import { sweepDiscarded } from './workspace';

/**
 * Start and end of the main process, the same for every host (platform.ts): Electron on the desktop (main.ts), the server
 * of the web version (web/). The host sets the platform first. `controller`: the project of the window (or browser tab)
 * for requests from the terminals (bridge.ts), null while there is none.
 */
export async function startCore(controller: () => ProjectController | null): Promise<void> {
  adoptLoginShellPath(); // macOS und Linux: PATH wie im Terminal, sonst fehlen die Agenten
  // Python schon jetzt vorwärmen: Bis das Fenster steht und das letzte Modell offen ist, ist cadquery geladen (build.ts)
  warmUp();
  sweepDiscarded(); // Reste verworfener Modelle (E69) vom letzten Mal
  renameOldSkillFiles(skillDirs()); // eigene Fassungen unter den Kennungen bis 0.5.0 (E87)
  // Erst die Verbindung für `soma render` (E58), dann das Fenster: Die Terminals bekommen Adresse und Schlüssel beim Anlegen
  await startBridge(async (route, body) => {
    const ctl = controller();
    if (!ctl) return { status: 503, body: { ok: false, error: 'The app has no window right now.' } };
    if (route === 'render') return ctl.renderForAgent(body);
    return { status: 404, body: { ok: false, error: `Unknown request: ${route}` } };
  });
}

export function stopCore(): void {
  stopBridge();
  stopWarm();
}
