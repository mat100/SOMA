// Bundelt Hauptprozess, Preload und Renderer nach dist/. Kein Framework, nur TypeScript.
// Run directly for the desktop app. The web version (web/build.mjs) imports the exported parts; paths are relative to app/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// esbuild of app/ also for web/build.mjs: one version for everything
export { build };

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(APP_DIR, ...p);
const { version, dependencies = {} } = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));

// Versionsnummer von SOMA (E68) aus package.json, für alle Teile gleich (src/shared/version.ts)
export const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022', absWorkingDir: APP_DIR, define: { __SOMA_VERSION__: JSON.stringify(version) } };

/** Worker von pdf.js als klassisches Skript: Module aus file:// lädt Chromium nicht (E54). */
export function buildPdfWorker(outDir) {
  return build({ ...common, sourcemap: false, entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'], outfile: path.resolve(APP_DIR, outDir, 'pdf.worker.js'), platform: 'browser', format: 'iife' });
}

/**
 * Komponenten für „About“ in den Einstellungen (E81): Name, Version und Lizenz der npm-Pakete, die die App mitbringt,
 * gelesen aus ihren package.json. Electron selbst nennt die App zur Laufzeit.
 */
export function writeComponents(file) {
  const components = Object.keys(dependencies).sort().map((name) => {
    try {
      const p = JSON.parse(fs.readFileSync(at('node_modules', name, 'package.json'), 'utf8'));
      return { name, version: p.version ?? '', license: typeof p.license === 'string' ? p.license : p.license?.type ?? '' };
    } catch { return { name, version: '', license: '' }; }
  });
  fs.mkdirSync(path.dirname(path.resolve(APP_DIR, file)), { recursive: true });
  fs.writeFileSync(path.resolve(APP_DIR, file), `${JSON.stringify(components, null, 2)}\n`);
}

/**
 * Lizenztexte der npm-Pakete nach dist/licenses/<paket>/ (THIRD_PARTY_NOTICES.md). esbuild übernimmt beim Bündeln nur
 * Kommentare mit @license, MIT und Co. verlangen aber den Text bei jeder Weitergabe. Gesammelt werden alle Laufzeit-
 * Abhängigkeiten samt ihren eigenen, aufgelöst wie Node (erst verschachtelt, dann flach). Optionale, die npm auf diesem
 * System nicht installiert hat, fehlen eben. Lieber ein Paket zu viel als eins zu wenig.
 */
export function writeLicenses(outDir) {
  const dest = path.resolve(APP_DIR, outDir);
  fs.rmSync(dest, { recursive: true, force: true });
  const licensed = new Set();
  const collect = (name, from) => {
    let dir = from;
    while (!fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) {
      if (dir === APP_DIR) return;
      dir = path.dirname(dir);
    }
    const pkgDir = path.join(dir, 'node_modules', name);
    if (licensed.has(pkgDir)) return;
    licensed.add(pkgDir);
    const p = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const out = path.join(dest, `${name.replace('/', '__')}@${p.version}`);
    for (const f of fs.readdirSync(pkgDir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))) {
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(path.join(pkgDir, f), path.join(out, f));
    }
    for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) collect(dep, pkgDir);
  };
  for (const name of Object.keys(dependencies)) collect(name, APP_DIR);
  // winpty liegt in node-pty unter deps/, das die Paketierung weglässt (electron-builder.config.cjs)
  const winpty = at('node_modules', 'node-pty', 'deps', 'winpty', 'LICENSE');
  if (fs.existsSync(winpty)) {
    fs.mkdirSync(path.join(dest, 'node-pty__winpty'), { recursive: true });
    fs.copyFileSync(winpty, path.join(dest, 'node-pty__winpty', 'LICENSE'));
  }
}

/** Pages, styles, fonts and the data of pdf.js, next to the bundles of the renderer. */
export function copyRendererAssets(outDir) {
  const dest = path.resolve(APP_DIR, outDir);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(at('src/renderer/index.html'), path.join(dest, 'index.html'));
  fs.copyFileSync(at('src/renderer/render.html'), path.join(dest, 'render.html'));
  fs.copyFileSync(at('src/renderer/style.css'), path.join(dest, 'style.css'));
  // App-Icon für den Ladebildschirm (index.html), der zeigt sich, bevor icons.ts geladen ist
  fs.copyFileSync(at('resources/icon.svg'), path.join(dest, 'logo.svg'));
  fs.copyFileSync(at('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(dest, 'xterm.css'));

  // Daten von pdf.js (Apache 2.0): Zeichentabellen für asiatische Schriften, Ersatz für nicht eingebettete Standardschriften,
  // Decoder für JPEG 2000 und JBIG2. Ohne sie zeigt pdf.js manche Dateien nur unvollständig.
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    fs.cpSync(at('node_modules', 'pdfjs-dist', dir), path.join(dest, 'pdfjs', dir), { recursive: true });
  }
  fs.copyFileSync(at('node_modules', 'pdfjs-dist', 'LICENSE'), path.join(dest, 'pdfjs', 'LICENSE'));

  // Schriften liegen lokal bei (die Content-Security-Policy erlaubt nur eigene Dateien, offline muss es auch gehen).
  // IBM Plex steht unter der SIL Open Font License.
  fs.mkdirSync(path.join(dest, 'fonts'), { recursive: true });
  for (const [pkg, weights] of [['ibm-plex-sans', [400, 500, 600]], ['ibm-plex-mono', [400, 500, 700]]]) {
    for (const w of weights) {
      for (const subset of ['latin', 'latin-ext']) {
        const file = `${pkg}-${subset}-${w}-normal.woff2`;
        fs.copyFileSync(at('node_modules', '@fontsource', pkg, 'files', file), path.join(dest, 'fonts', file));
      }
    }
  }
}

async function buildDesktop() {
  await Promise.all([
    build({ ...common, entryPoints: ['src/main/main.ts'], outfile: at('dist/main/main.js'), platform: 'node', format: 'cjs',
            external: ['electron', 'node-pty', 'dugite'] }),
    build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: at('dist/preload/preload.js'), platform: 'node', format: 'cjs',
            external: ['electron'] }),
    // Unsichtbares Render-Fenster für soma render (E58): eigener Preload und eigene Seite, derselbe Viewer
    build({ ...common, entryPoints: ['src/preload/render-preload.ts'], outfile: at('dist/preload/render-preload.js'), platform: 'node', format: 'cjs',
            external: ['electron'] }),
    build({ ...common, entryPoints: ['src/renderer/render.ts'], outfile: at('dist/renderer/render.js'), platform: 'browser', format: 'iife' }),
    build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: at('dist/renderer/main.js'), platform: 'browser', format: 'iife' }),
    buildPdfWorker('dist/renderer'),
  ]);
  writeComponents('dist/main/components.json');
  writeLicenses('dist/licenses');
  copyRendererAssets('dist/renderer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildDesktop();
