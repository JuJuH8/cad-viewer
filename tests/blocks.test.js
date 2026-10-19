// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des blocs : moteur des blocs dynamiques (paramètres, actions, visibilité), poignées, éditeur de blocs,
// insertion, enregistrement DXF (représentations pour AutoCAD, définitions relues).
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands, explode } from '../src/editor/commands.js';
import {
  evaluate, normalize, valueOf, dynGrips, valueFromPoint, withValue, blockForInsert, cleanDyn, ensureKeys,
} from '../src/blocks/dynamic.js';
import { BlockEditorSession, syncInsertAttribs } from '../src/blocks/block-editor.js';
import { registerBlockCommands } from '../src/blocks/commands.js';
import { blockFromDrawing } from '../src/blocks/insert-dialog.js';
import { setGeometry } from '../src/ui/panels.js';

const pl = (pts, k) => ({ type: 'LWPOLYLINE', layer: '0', color: 0, pts, bulges: pts.map(() => 0), closed: true, z: 0, width: 0, k });

// Bureau : plateau (1), écran (2), bord (3), étiquette (4) ; longueur (étirement du côté droit), visibilité.
function desk() {
  return {
    name: 'BUREAU', base: [0, 0, 0], flags: 0, xref: false,
    entities: [
      pl([[0, 0], [1200, 0], [1200, 600], [0, 600]], 1),
      { type: 'CIRCLE', layer: '0', color: 0, c: [900, 300, 0], r: 150, k: 2 },
      { type: 'LINE', layer: '0', color: 0, p1: [0, 500, 0], p2: [1200, 500, 0], k: 3 },
      { type: 'ATTDEF', layer: '0', color: 0, p: [1100, 100, 0], h: 50, rot: 0, text: 'B?', tag: 'NUM', prompt: 'Numéro', align: 'left', valign: 'baseline', wf: 1, k: 4 },
    ],
    dyn: {
      params: [
        { id: 'P1', type: 'linear', name: 'Longueur', p1: [0, -100], p2: [1200, -100], min: 800, max: 2400, step: 200 },
        { id: 'P2', type: 'visibility', name: 'Visibilité', p: [-200, 300], states: ['Avec écran', 'Sans écran'], hidden: { 'Sans écran': [2] } },
      ],
      actions: [{ id: 'A1', type: 'stretch', param: 'P1', frame: [[1000, -200], [1300, -200], [1300, 700], [1000, 700]], keys: [1, 3, 4] }],
    },
  };
}

test('blocs dynamiques : valeurs admises (bornes, pas, liste), étirement, visibilité', () => {
  const b = desk();
  const p = b.dyn.params[0];
  assert.equal(normalize(p, 1290), 1200, 'pas de 200 depuis le minimum');
  assert.equal(normalize(p, 5000), 2400, 'maximum');
  assert.equal(normalize(p, 100), 800, 'minimum');
  assert.equal(normalize({ ...p, list: [600, 900, 1500] }, 1100), 900, 'valeur la plus proche de la liste');
  assert.equal(valueOf(p, {}), 1200, 'défaut : longueur dessinée');
  const e = evaluate(b, { P1: 1800 });
  assert.deepEqual(e[0].pts.map((q) => q[0]), [0, 1800, 1800, 0], 'côté droit étiré');
  assert.point(e[2].p2, [1800, 500, 0]);
  assert.point(e[3].p, [1700, 100, 0], 1e-6, 'étiquette déplacée avec le côté');
  assert.point(e[1].c, [900, 300, 0], 1e-6, 'écran hors du cadre : inchangé');
  assert.equal(evaluate(b, { P2: 'Sans écran' }).length, 3, 'écran caché');
  assert.equal(evaluate(b, { P2: 'Inconnu' }).length, 4, 'état inconnu : premier état');
});

test('blocs dynamiques : déplacer, échelle, rotation, inversion, point', () => {
  const base = { name: 'X', base: [0, 0, 0], entities: [{ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [100, 0, 0], k: 1 }] };
  const mk = (param, action) => ({ ...base, dyn: { params: [param], actions: [{ id: 'A', param: param.id, keys: [1], ...action }] } });
  const lin = { id: 'L', type: 'linear', name: 'D', p1: [0, 0], p2: [100, 0] };
  assert.point(evaluate(mk(lin, { type: 'move' }), { L: 150 })[0].p1, [50, 0, 0], 1e-6, 'déplacer de la différence');
  assert.point(evaluate(mk(lin, { type: 'scale' }), { L: 200 })[0].p2, [200, 0, 0], 1e-6, 'échelle depuis l’origine');
  const rot = { id: 'R', type: 'rotation', name: 'A', c: [0, 0], r: 50, a0: 0 };
  assert.point(evaluate(mk(rot, { type: 'rotate' }), { R: Math.PI / 2 })[0].p2, [0, 100, 0]);
  const flip = { id: 'F', type: 'flip', name: 'I', p1: [0, 0], p2: [0, 10] };
  assert.point(evaluate(mk(flip, { type: 'flip' }), { F: 1 })[0].p2, [-100, 0, 0], 1e-6, 'symétrie par l’axe vertical');
  assert.point(evaluate(mk(flip, { type: 'flip' }), { F: 0 })[0].p2, [100, 0, 0]);
  const pt = { id: 'T', type: 'point', name: 'P', p: [100, 0] };
  assert.point(evaluate(mk(pt, { type: 'move' }), { T: [10, 20] })[0].p1, [10, 20, 0]);
  // Nettoyage : action dont le paramètre a disparu, clés disparues.
  const c = cleanDyn({ params: [lin], actions: [{ id: 'A', param: 'L', keys: [1, 9] }, { id: 'B', param: 'Z', keys: [1] }] }, [{ k: 1 }]);
  assert.deepEqual(c.actions, [{ id: 'A', param: 'L', keys: [1] }]);
  assert.deepEqual(ensureKeys([{ k: 4 }, {}, { k: 2 }]).map((x) => x.k), [4, 5, 2]);
});

test('blocs dynamiques : insertion (géométrie évaluée, poignées, valeur depuis une poignée, attributs, Propriétés)', () => {
  const doc = new Document();
  doc.blocks.set('BUREAU', desk());
  let id;
  doc.transaction('i', () => {
    id = doc.add({
      type: 'INSERT', name: 'BUREAU', layer: '0', p: [1000, 1000, 0], sx: 1, sy: 1, sz: 1, rot: Math.PI / 2,
      attribs: [{ type: 'TEXT', layer: '0', tag: 'NUM', text: 'B12', p: [900, 2100, 0], h: 50, rot: Math.PI / 2 }],
    }).id;
  });
  const ins = doc.get(id);
  assert.equal(blockForInsert(doc, ins).entities.length, 4);
  const grips = dynGrips(doc, ins);
  assert.equal(grips.length, 2);
  assert.point(grips[0].p, [1100, 2200], 1e-6, 'poignée de longueur (bloc tourné de 90°)');
  assert.equal(grips[1].shape, 'menu');
  // Poignée tirée de 650 le long du paramètre : 1850 → pas de 200 → 1800.
  const v = valueFromPoint(doc, ins, 'P1', [1100, 2850]);
  assert.equal(v, 1800);
  const moved = withValue(doc, ins, 'P1', v);
  assert.equal(moved.dyn.P1, 1800);
  assert.point(moved.attribs[0].p, [900, 2700, 0], 1e-6, 'attribut déplacé avec son étiquette');
  assert.equal(moved.attribs[0].text, 'B12', 'valeur gardée');
  assert.equal(blockForInsert(doc, moved).entities[0].pts[1][0], 1800, 'définition évaluée');
  // Décomposer : objets évalués.
  const parts = explode(doc, moved);
  assert.ok(parts.some((x) => x.type === 'LWPOLYLINE' && Math.abs(G.dist(x.pts[0], x.pts[1]) - 1800) < 1e-6));
  // Propriétés : visibilité et longueur.
  const e = structuredClone(ins);
  assert.ok(setGeometry(e, 'dyn:P2', 'Sans écran', doc));
  assert.ok(setGeometry(e, 'dyn:P1', '2000', doc));
  assert.deepEqual(e.dyn, { P2: 'Sans écran', P1: 2000 });
  assert.equal(blockForInsert(doc, e).entities.length, 3);
  // Synchronisation des attributs (ATTSYNC) : étiquette ajoutée à la définition.
  const b2 = structuredClone(desk());
  b2.entities.push({ type: 'ATTDEF', layer: '0', p: [0, 650, 0], h: 40, rot: 0, text: 'Service', tag: 'SERVICE', prompt: 'Service', align: 'left', valign: 'baseline', wf: 1, k: 5 });
  const synced = syncInsertAttribs(doc, ins, b2);
  assert.deepEqual(synced.attribs.map((a) => [a.tag, a.text]), [['NUM', 'B12'], ['SERVICE', 'Service']]);
});

// Éditeur et commandes, comme un utilisateur.
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const log = [];
const editor = new Editor(renderer, { print: (m) => log.push(m) });
registerCommands(editor);
const session = new BlockEditorSession({
  editor, renderer, getDoc: () => editor.doc,
  setDoc: (d) => { renderer.setDocument(d); editor.setDocument(d); },
});
registerBlockCommands(editor, session);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function type(...xs) { for (const x of xs) { editor.submit(x); await tick(); } }
async function run(cmd, ...xs) { editor.run(cmd); await tick(); await type(...xs); await tick(); }

test('éditeur de blocs : paramètre linéaire avec étirement, états de visibilité, enregistrement, annulation', async () => {
  const doc = new Document();
  doc.header.insunits = 4;
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -500, minY: -500, maxX: 3000, maxY: 2000 });
  editor.settings.osnap = false;
  await run('REC', '0,0', '1200,600');
  await run('C', '900,300', '150');
  editor.setSelection([...doc.entities.keys()]);
  await run('BLOC', 'TABLE', '0,0');
  const insId = [...doc.entities.values()].find((e) => e.type === 'INSERT').id;
  editor.setSelection([insId]);
  await run('EDITBLOC');
  assert.ok(session.editing && editor.doc !== doc, 'dessin de travail');
  const tmp = editor.doc;
  assert.deepEqual([...tmp.entities.keys()], [1, 2], 'objets repérés par leur clé');
  // Paramètre linéaire, étirement du côté droit (cadre 1000…1300) sur le plateau.
  editor.run('PARAMLIN');
  await tick();
  await type('0,-100', '1200,-100', 'Longueur', 'E', '1000,-200', '1300,700');
  editor.setSelection([1]);
  await type('');
  // Visibilité : deuxième état sans le cercle.
  await run('VISIBILITE', '-200,300');
  await run('BVNOUVEAU', 'Simple');
  editor.setSelection([2]);
  await run('BVCACHER');
  assert.deepEqual(renderer.hiddenIds ? [...renderer.hiddenIds] : [], [2], 'objet caché dans l’état courant');
  const dyn = tmp.header.blockDyn;
  assert.deepEqual(dyn.params.map((p) => p.type), ['linear', 'visibility']);
  assert.deepEqual(dyn.actions[0].keys, [1]);
  // Une annulation dans l'éditeur retire le dernier réglage.
  tmp.undo();
  assert.deepEqual(tmp.header.blockDyn.params[1].hidden?.Simple || [], []);
  tmp.redo();
  // Enregistrer puis fermer : définition remplacée, insertion dynamique.
  await run('BFERMER', 'Oui');
  assert.ok(!session.editing && editor.doc === doc, 'dessin rétabli');
  const block = doc.blocks.get('TABLE');
  assert.equal(block.dyn.params.length, 2);
  const ins = doc.get(insId);
  assert.equal(dynGrips(doc, ins).length, 2, 'poignées dynamiques sur l’insertion');
  doc.transaction('v', () => doc.update(withValue(doc, ins, block.dyn.params[0].id, 2000)));
  assert.equal(renderer.cache.get(insId).box.maxX, 2000, 'insertion étirée');
  doc.undo();
  doc.undo();
  assert.ok(!doc.blocks.get('TABLE').dyn, 'une annulation rétablit l’ancienne définition');
  editor.settings.osnap = true;
});

test('éditeur de blocs : poignée glissée, menu de visibilité, pose répétée et décomposée, bloc depuis un dessin', async () => {
  const doc = new Document();
  doc.blocks.set('BUREAU', desk());
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -500, minY: -500, maxX: 3000, maxY: 2000 });
  editor.settings.osnap = false;
  let id;
  doc.transaction('i', () => { id = doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] }).id; });
  editor.setSelection([id]);
  const el = renderer.canvas, rect = el.getBoundingClientRect();
  const ev = (type, p) => {
    const [sx, sy] = renderer.toScreen(p[0], p[1]);
    el.dispatchEvent(new PointerEvent(type, { clientX: rect.left + sx, clientY: rect.top + sy, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true }));
  };
  ev('pointerdown', [1200, -100]);
  ev('pointermove', [1650, -100]);
  ev('pointerup', [1650, -100]);
  await tick();
  assert.equal(doc.get(id).dyn?.P1, 1600, 'poignée de longueur glissée (pas de 200)');
  // Poignée de visibilité : le menu des états est demandé à l'interface.
  const asked = [];
  editor.ui.onDynMenu = (eid, param) => asked.push([eid, param]);
  editor.setSelection([id]);
  ev('pointerdown', [-200, 300]);
  ev('pointerup', [-200, 300]);
  await tick();
  assert.deepEqual(asked, [[id, 'P2']]);
  delete editor.ui.onDynMenu;
  // Pose depuis la boîte d'insertion : répétée (Échap pour finir), puis décomposée.
  editor.insertState = { name: 'BUREAU', scale: 2, rot: 0, rotOnScreen: false, repeat: true };
  editor.run('POSERBLOC');
  await tick();
  await type('3000,0', 'B1', '6000,0', 'B2');
  editor.cancel();
  await tick();
  const placed = [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.id !== id);
  assert.deepEqual(placed.map((e) => [e.sx, e.attribs[0]?.text]), [[2, 'B1'], [2, 'B2']]);
  editor.insertState = { name: 'BUREAU', scale: 1, rot: 0, rotOnScreen: false, explode: true };
  const before = doc.entities.size;
  await run('POSERBLOC', '0,3000', 'B3');
  assert.equal(doc.entities.size, before + 5, 'décomposé : plateau, écran, bord, définition d’attribut et sa valeur en texte');
  assert.ok(![...doc.entities.values()].some((e) => e.type === 'INSERT' && Math.abs(e.p[1] - 3000) < 1e-9), 'aucune insertion');
  // Bloc depuis un autre dessin.
  const x = new Document();
  x.transaction('a', () => { x.addLayer('MOBILIER', { color: 3 }); x.add({ type: 'LINE', layer: 'MOBILIER', p1: [0, 0, 0], p2: [10, 0, 0] }); });
  const name = blockFromDrawing(doc, x, 'Chaise');
  assert.equal(name, 'Chaise');
  assert.ok(doc.layers.has('MOBILIER') && doc.blocks.get('Chaise').entities.length === 1);
  assert.equal(blockFromDrawing(doc, x, 'Chaise'), 'Chaise_2', 'nom libre');
  editor.settings.osnap = true;
});

test('blocs dynamiques : DXF (représentation figée pour AutoCAD, définition et valeurs relues)', async () => {
  const doc = new Document();
  doc.blocks.set('BUREAU', desk());
  doc.transaction('i', () => {
    doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, dyn: { P1: 2000 }, attribs: [] });
    doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, -1000, 0], sx: 1, sy: 1, sz: 1, rot: 0, dyn: { P2: 'Sans écran' }, attribs: [] });
    doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, -2000, 0], sx: 1, sy: 1, sz: 1, rot: 0, dyn: { P1: 2000 }, attribs: [] });
  });
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  await fetch('/__out/blocs-dynamiques.dxf', { method: 'POST', body: text });
  assert.ok(text.includes('BUREAU_DYN1') && text.includes('BUREAU_DYN2') && !text.includes('BUREAU_DYN3'), 'une représentation par jeu de valeurs');
  assert.ok(text.includes('CV_BLOCS_DYNAMIQUES'), 'dictionnaire des définitions');
  const db = await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf');
  const raw = db.tables.BLOCK_RECORD.entries.find((b) => b.name === 'BUREAU_DYN1');
  assert.ok(JSON.stringify(raw.entities.find((e) => e.type === 'LWPOLYLINE')).includes('2000'), 'représentation étirée lisible sans l’appli');
  const back = importDatabase(db).doc;
  assert.deepEqual([...back.blocks.keys()], ['BUREAU'], 'représentations retirées à la relecture');
  assert.equal(back.blocks.get('BUREAU').dyn.actions[0].keys.join(), '1,3,4');
  assert.deepEqual([...back.entities.values()].map((e) => e.dyn), [{ P1: 2000 }, { P2: 'Sans écran' }, { P1: 2000 }]);
});

test('visibilité avancée : plusieurs paramètres, table de consultation, attributs cachés avec leur état', async () => {
  const { matchingRow, hiddenKeys, syncAttribs, CUSTOM_ROW } = await import('../src/blocks/dynamic.js');
  const doc = new Document();
  const b = desk();
  // Deuxième paramètre de visibilité : étiquette (attribut NUM, clé 4) affichée ou non.
  b.dyn.params.push({ id: 'P3', type: 'visibility', name: 'Étiquette', p: [-200, 0], states: ['Avec numéro', 'Sans numéro'], hidden: { 'Sans numéro': [4] } });
  // Table : choix nommés qui règlent longueur et équipement.
  b.dyn.params.push({ id: 'P4', type: 'lookup', name: 'Modèle', p: [-200, -200], rows: [
    { label: 'Bureau 120', values: { P1: 1200, P2: 'Avec écran' } },
    { label: 'Bureau 180 sans écran', values: { P1: 1800, P2: 'Sans écran' } },
  ] });
  doc.blocks.set('BUREAU', b);
  assert.deepEqual([...hiddenKeys(b.dyn, { P2: 'Sans écran', P3: 'Sans numéro' })].sort(), [2, 4], 'objets cachés par l’un ou l’autre paramètre');
  assert.equal(evaluate(b, { P2: 'Sans écran', P3: 'Sans numéro' }).length, 2);
  let id;
  doc.transaction('i', () => { id = doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [{ type: 'TEXT', layer: '0', tag: 'NUM', text: 'B7', p: [1100, 100, 0], h: 50, rot: 0 }] }).id; });
  const ins = doc.get(id);
  // Choix d'une ligne : longueur et état réglés ensemble.
  const e1 = withValue(doc, ins, 'P4', 'Bureau 180 sans écran');
  assert.deepEqual([e1.dyn.P1, e1.dyn.P2, e1.dyn.P4], [1800, 'Sans écran', 'Bureau 180 sans écran']);
  // Réglage manuel : la table affiche « Personnalisé » si aucune ligne ne correspond.
  const e2 = withValue(doc, e1, 'P1', 2000);
  assert.equal(e2.dyn.P4, CUSTOM_ROW);
  const e3 = withValue(doc, e2, 'P1', 1800);
  assert.equal(e3.dyn.P4, 'Bureau 180 sans écran', 'la ligne correspondante est retrouvée');
  assert.equal(matchingRow(b.dyn, b.dyn.params[3], { P1: 1200 }), 'Bureau 120');
  // Attribut caché avec son état, rendu à nouveau visible dans l'autre état.
  const e4 = withValue(doc, e3, 'P3', 'Sans numéro');
  assert.ok(e4.attribs[0].dynHidden, 'attribut caché avec sa définition');
  assert.ok(!withValue(doc, e4, 'P3', 'Avec numéro').attribs[0].dynHidden);
  const parts = explode(doc, e4);
  assert.ok(!parts.some((x) => x.type === 'TEXT' && x.text === 'B7'), 'décomposé sans l’attribut caché');
  // DXF : attribut écrit invisible pour AutoCAD, redevenu dynamique à la relecture.
  doc.transaction('m', () => doc.update(e4));
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const bi = [...back.entities.values()][0];
  assert.deepEqual([bi.attribs[0].dynHidden, bi.attribs[0].invisible], [true, undefined]);
  assert.ok(!syncAttribs(back, withValue(back, bi, 'P3', 'Avec numéro')).attribs[0].dynHidden);
});

test('éditeur de blocs : deuxième paramètre de visibilité, états indépendants', async () => {
  const doc = new Document();
  doc.blocks.set('BUREAU', desk());
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -500, minY: -500, maxX: 3000, maxY: 2000 });
  editor.settings.osnap = false;
  let id;
  doc.transaction('i', () => { id = doc.add({ type: 'INSERT', name: 'BUREAU', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] }).id; });
  editor.setSelection([id]);
  await run('EDITBLOC');
  await run('BVPARAM', '-200,0', 'Bord');
  assert.equal(session.visibilities().length, 2);
  assert.equal(session.visibility().name, 'Bord', 'nouveau paramètre actif');
  await run('BVNOUVEAU', 'Sans bord');
  editor.setSelection([3]);
  await run('BVCACHER');
  session.setVisState('Sans écran', 'P2');
  assert.deepEqual([...renderer.hiddenIds].sort(), [2, 3], 'cachés : écran (Équipement) et bord (Bord)');
  session.setVisParam('P2');
  assert.equal(session.visState(), 'Sans écran');
  await run('BFERMER', 'Oui');
  const vis = doc.blocks.get('BUREAU').dyn.params.filter((p) => p.type === 'visibility');
  assert.deepEqual(vis.map((p) => p.name), ['Visibilité', 'Bord']);
  assert.deepEqual(vis[1].hidden['Sans bord'], [3]);
  editor.settings.osnap = true;
});
