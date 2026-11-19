// The synced folder (server/mirror.ts) on temporary folders: what is copied, what is kept, version folders.
// Run with `npm run test:unit` (Node strips the types).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Mirror, copyName, folderName, type MirrorStatus } from '../server/mirror.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-mirror-'));
  const dir = path.join(base, 'model');
  const root = path.join(base, 'synced');
  const put = (rel: string, text: string) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    // Another mtime for each write, also within the same millisecond
    const t = new Date(Date.now() + Math.random() * 1e6);
    fs.utimesSync(f, t, t);
  };
  const statuses: MirrorStatus[] = [];
  const mirror = new Mirror(root, { versions: true, onStatus: (s) => statuses.push(s) });
  const read = (rel: string) => fs.readFileSync(path.join(root, 'Bracket', rel), 'utf8');
  const has = (rel: string) => fs.existsSync(path.join(root, 'Bracket', rel));
  return { base, dir, root, put, mirror, statuses, read, has, model: { id: ID, name: 'Bracket', dir } };
}

test('copies output/ to the top and renders/ as renders/, leaves out the rest of the model', async () => {
  const s = setup();
  s.put('output/model.step', 'step 1');
  s.put('output/drawings.pdf', 'pdf');
  s.put('output/drawings/Body.dxf', 'dxf');
  s.put('renders/front.png', 'png');
  s.put('model.py', 'code');
  s.put('.soma/model.glb', 'glb');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'step 1');
  assert.equal(s.read('drawings.pdf'), 'pdf');
  assert.equal(s.read('drawings/Body.dxf'), 'dxf');
  assert.equal(s.read('renders/front.png'), 'png');
  assert.equal(s.has('model.py'), false);
  assert.equal(s.has('model.glb'), false);
  assert.equal(s.statuses.at(-1)?.state, 'ok');
  assert.deepEqual(s.statuses.at(-1)?.kept, []);
  // No temporary files left for the sync tool
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'Bracket')).filter((n) => n.startsWith('.soma-mirror-tmp')), []);
});

test('a new result replaces the one SOMA wrote', async () => {
  const s = setup();
  s.put('output/model.step', 'step 1');
  await s.mirror.sync(s.model);
  s.put('output/model.step', 'step 2');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'step 2');
});

test('a file the user changed stays, the new one goes next to it, and the status says so', async () => {
  const s = setup();
  s.put('output/model.step', 'step 1');
  await s.mirror.sync(s.model);
  fs.writeFileSync(path.join(s.root, 'Bracket', 'model.step'), 'edited by the user');
  s.put('output/model.step', 'step 2');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'edited by the user');
  assert.equal(s.read('model (from SOMA).step'), 'step 2');
  assert.deepEqual(s.statuses.at(-1)?.kept, [{ file: 'model.step', copy: 'model (from SOMA).step', updated: true }]);
  // The next result updates the copy, the user's file still stays
  s.put('output/model.step', 'step 3');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'edited by the user');
  assert.equal(s.read('model (from SOMA).step'), 'step 3');
  // A copy the user changed as well is not touched either
  fs.writeFileSync(path.join(s.root, 'Bracket', 'model (from SOMA).step'), 'copy edited');
  s.put('output/model.step', 'step 4');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model (from SOMA).step'), 'copy edited');
  assert.deepEqual(s.statuses.at(-1)?.kept, [{ file: 'model.step', copy: 'model (from SOMA).step', updated: false }]);
  // The user removes their file: the next result goes to its place again, the note is gone
  fs.rmSync(path.join(s.root, 'Bracket', 'model.step'));
  s.put('output/model.step', 'step 5');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'step 5');
  assert.deepEqual(s.statuses.at(-1)?.kept, []);
});

test('a file the user deleted comes back only with a new result, nothing in the folder is ever deleted', async () => {
  const s = setup();
  s.put('output/model.step', 'step 1');
  s.put('renders/a.png', 'a');
  await s.mirror.sync(s.model);
  fs.rmSync(path.join(s.root, 'Bracket', 'model.step'));
  await s.mirror.sync(s.model);
  assert.equal(s.has('model.step'), false);
  s.put('output/model.step', 'step 2');
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'step 2');
  // Gone from the model: stays in the folder
  fs.rmSync(path.join(s.dir, 'renders', 'a.png'));
  await s.mirror.sync(s.model);
  assert.equal(s.read('renders/a.png'), 'a');
});

test('the model file after a save, a version folder for each later save', async () => {
  const s = setup();
  execFileSync('git', ['init', '-q', s.dir]);
  const commit = (msg: string) => {
    execFileSync('git', ['-C', s.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg]);
    return execFileSync('git', ['-C', s.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const zip = path.join(s.base, 'Bracket.soma');
  s.put('output/model.step', 'step 1');
  fs.writeFileSync(zip, 'zip 1');
  // First sync of a model saved before: the file, but no version (its results are not known any more)
  await s.mirror.sync(s.model, { head: commit('First'), zipPath: zip });
  assert.equal(s.read('Bracket.soma'), 'zip 1');
  assert.equal(s.has('versions'), false);
  s.put('output/model.step', 'step 2');
  fs.writeFileSync(zip, 'zip 2');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(zip, t, t);
  await s.mirror.sync(s.model, { head: commit('Thicker rib: 3 mm'), zipPath: zip });
  assert.equal(s.read('Bracket.soma'), 'zip 2');
  const versions = fs.readdirSync(path.join(s.root, 'Bracket', 'versions'));
  assert.equal(versions.length, 1);
  assert.match(versions[0], /^\d{4}-\d\d-\d\d \d{4} Thicker rib_ 3 mm$/);
  assert.equal(s.read(`versions/${versions[0]}/model.step`), 'step 2');
  // The same save again (save:state comes often): no second folder
  await s.mirror.sync(s.model, { head: execFileSync('git', ['-C', s.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), zipPath: zip });
  assert.equal(fs.readdirSync(path.join(s.root, 'Bracket', 'versions')).length, 1);
});

test('a folder of another model or of the user is not taken: the name with the start of the ID', async () => {
  const s = setup();
  s.put('output/model.step', 'mine');
  fs.mkdirSync(path.join(s.root, 'Bracket'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'Bracket', 'notes.txt'), 'the user');
  await s.mirror.sync(s.model);
  assert.equal(fs.readFileSync(path.join(s.root, `Bracket (${ID.slice(0, 8)})`, 'model.step'), 'utf8'), 'mine');
  // The other model of the same name gets the plain name only when it is free; here both are taken by now
  await s.mirror.sync({ id: OTHER, name: 'Bracket', dir: s.dir });
  assert.equal(fs.readFileSync(path.join(s.root, `Bracket (${OTHER.slice(0, 8)})`, 'model.step'), 'utf8'), 'mine');
  // And the first model finds its folder again
  s.put('output/model.step', 'mine 2');
  await s.mirror.sync(s.model);
  assert.equal(fs.readFileSync(path.join(s.root, `Bracket (${ID.slice(0, 8)})`, 'model.step'), 'utf8'), 'mine 2');
  assert.equal(fs.readFileSync(path.join(s.root, 'Bracket', 'notes.txt'), 'utf8'), 'the user');
});

test('errors end up in the status, nothing throws', async () => {
  const s = setup();
  s.put('output/model.step', 'x');
  fs.writeFileSync(s.root, 'a file where the folder should be');
  await s.mirror.sync(s.model);
  assert.equal(s.statuses.at(-1)?.state, 'error');
  assert.ok(s.statuses.at(-1)?.error);
});

test('names for any system', () => {
  assert.equal(folderName('Držák: v2/final?'), 'Držák_ v2_final_');
  assert.equal(folderName('CON'), 'model');
  assert.equal(folderName('con.txt'), 'model');
  assert.equal(folderName('...'), 'model');
  assert.equal(folderName('name. '), 'name');
  assert.equal(copyName('drawings/Body.dxf'), 'drawings/Body (from SOMA).dxf');
  assert.equal(copyName('README'), 'README (from SOMA)');
});

test('links are never followed: not in the model, not in the folder', async () => {
  const s = setup();
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  // renders/ of the model is a link out, output/ holds a link to a file outside
  fs.mkdirSync(s.dir, { recursive: true });
  fs.symlinkSync(outside, path.join(s.dir, 'renders'));
  s.put('output/model.step', 'step');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(s.dir, 'output', 'secret.txt'));
  await s.mirror.sync(s.model);
  assert.equal(s.read('model.step'), 'step');
  assert.equal(s.has('secret.txt'), false);
  assert.equal(s.has('renders'), false);
  assert.equal(s.statuses.at(-1)?.state, 'error', 'the left out renders/ is reported');
  assert.match(s.statuses.at(-1)?.error ?? '', /renders is not a folder/);
  // In the folder: drawings/ as a link out (the sync may bring one) is not written through
  fs.symlinkSync(outside, path.join(s.root, 'Bracket', 'drawings'));
  s.put('output/drawings/Body.pdf', 'pdf');
  await s.mirror.sync(s.model);
  assert.equal(fs.existsSync(path.join(outside, 'Body.pdf')), false);
  assert.match(s.statuses.at(-1)?.error ?? '', /not a folder/);
  // A manifest that is a link is not read or written through
  fs.rmSync(path.join(s.root, 'Bracket', 'drawings'));
  const target = path.join(outside, 'm.json');
  fs.writeFileSync(target, JSON.stringify({ id: ID, files: {} }));
  fs.rmSync(path.join(s.root, 'Bracket', '.soma-mirror.json'));
  fs.symlinkSync(target, path.join(s.root, 'Bracket', '.soma-mirror.json'));
  await s.mirror.sync(s.model);
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ id: ID, files: {} }));
});

test('after a failure, what was written still counts as SOMA\'s own', async () => {
  const s = setup();
  s.put('output/model.step', 'step 1');
  s.put('output/drawings/Body.pdf', 'pdf 1');
  await s.mirror.sync(s.model);
  // drawings/ blocked by a file of the user: model.step is written, the run reports the error
  fs.rmSync(path.join(s.root, 'Bracket', 'drawings'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'Bracket', 'drawings'), 'in the way');
  s.put('output/model.step', 'step 2');
  s.put('output/drawings/Body.pdf', 'pdf 2');
  await s.mirror.sync(s.model);
  assert.equal(s.statuses.at(-1)?.state, 'error');
  assert.equal(s.read('model.step'), 'step 2');
  // Out of the way: the next result replaces model.step, it is not taken for a file of the user
  fs.rmSync(path.join(s.root, 'Bracket', 'drawings'));
  s.put('output/model.step', 'step 3');
  await s.mirror.sync(s.model);
  assert.equal(s.statuses.at(-1)?.state, 'ok');
  assert.equal(s.read('model.step'), 'step 3');
  assert.equal(s.read('drawings/Body.pdf'), 'pdf 2');
  assert.equal(s.has('model (from SOMA).step'), false);
});

test('requests during a run are not lost: a save waiting stays, other models get their turn', async () => {
  const s = setup();
  execFileSync('git', ['init', '-q', s.dir]);
  const commit = (msg: string) => {
    execFileSync('git', ['-C', s.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg]);
    return execFileSync('git', ['-C', s.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const zip = path.join(s.base, 'Bracket.soma');
  fs.writeFileSync(zip, 'zip');
  s.put('output/model.step', 'step');
  await s.mirror.sync(s.model, { head: commit('First'), zipPath: zip });
  const other = path.join(s.base, 'other');
  fs.mkdirSync(path.join(other, 'output'), { recursive: true });
  fs.writeFileSync(path.join(other, 'output', 'model.step'), 'other');
  // While the first runs: a save, then a build of the same model (no save), and another model
  const runs = [
    s.mirror.sync(s.model),
    s.mirror.sync(s.model, { head: commit('Second'), zipPath: zip }),
    s.mirror.sync(s.model),
    s.mirror.sync({ id: OTHER, name: 'Other', dir: other }),
  ];
  await Promise.all(runs);
  assert.equal(fs.readdirSync(path.join(s.root, 'Bracket', 'versions')).length, 1);
  assert.equal(fs.readFileSync(path.join(s.root, 'Other', 'model.step'), 'utf8'), 'other');
});

test('too many files: the first ones are copied, the rest is reported', async () => {
  const s = setup();
  for (let i = 0; i < 2005; i++) fs.mkdirSync(path.join(s.dir, 'renders'), { recursive: true }), fs.writeFileSync(path.join(s.dir, 'renders', `r${i}.png`), 'x');
  await s.mirror.sync(s.model);
  assert.equal(fs.readdirSync(path.join(s.root, 'Bracket', 'renders')).length, 2000);
  assert.match(s.statuses.at(-1)?.error ?? '', /More than 2000 files in renders/);
});
