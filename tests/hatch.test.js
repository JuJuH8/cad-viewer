// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des hachures : fichiers .pat, motifs intégrés, lignes du motif (échelle, angle, origine), commande,
// modification, hachures associatives, couleur de fond, DXF (écrit et relu, hachure faite dans AutoCAD).
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { parsePat, BUILTIN, patternLines, defFromHatch, loadPatFile } from '../src/hatch/patterns.js';
import { registerHatchCommands, makeHatch, setHatchField, hatchArea, recomputeLoops } from '../src/hatch/commands.js';
import { patternSegments } from '../src/hatch.js';
import { transformEntity } from '../src/core/entities.js';

const segsOf = (lines, loop) => patternSegments({ definitionLines: lines.map((l) => ({ angle: l.angle, base: { x: l.base[0], y: l.base[1] }, offset: { x: l.offset[0], y: l.offset[1] }, dashLengths: l.dashes })) }, [loop]) || [];
const square = (n) => [[0, 0], [n, 0], [n, n], [0, n]];

test('motifs : lecture d’un fichier .pat (commentaires, plusieurs familles, tirets), motifs intégrés', () => {
  const pats = parsePat(`;; essai
*ESSAI, Motif d'essai ; commentaire
0, 0,0, 0,2
90, 1,0, 0,4, 2,-1, 0,-1
*VIDE, sans ligne
*AUTRE
45, 0,0, 0,3`);
  assert.deepEqual([...pats.keys()], ['ESSAI', 'AUTRE'], 'motif sans ligne ignoré');
  const e = pats.get('ESSAI');
  assert.equal(e.desc, "Motif d'essai");
  assert.deepEqual(e.lines[1], { angle: 90, x: 1, y: 0, dx: 0, dy: 4, dashes: [2, -1, 0, -1] });
  for (const [name, def] of BUILTIN) {
    const segs = segsOf(patternLines(def, { scale: 1 }), square(30));
    assert.ok(segs.length > 4, `${name} : motif dessiné (${segs.length / 2} traits)`);
  }
});

test('motifs : lignes du motif dans le monde (échelle, angle, origine) et motif retrouvé depuis une hachure', () => {
  const [l] = patternLines({ lines: [{ angle: 0, x: 1, y: 0, dx: 0, dy: 2, dashes: [3, -1] }] }, { scale: 10, angle: Math.PI / 2, origin: [100, 0] });
  assert.near(l.angle, Math.PI / 2, 1e-12);
  assert.point(l.base, [100, 10], 1e-9, 'origine tournée et mise à l’échelle');
  assert.point(l.offset, [-20, 0], 1e-9, 'écart perpendiculaire (monde)');
  assert.deepEqual(l.dashes, [30, -10]);
  // Isolation en zigzag : traits de pente ±2 entre deux rangs.
  const z = segsOf(patternLines(BUILTIN.get('ISOLATION'), { scale: 1 }), square(20));
  for (let i = 0; i + 1 < z.length; i += 2) {
    const [a, b] = [z[i], z[i + 1]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    assert.near(Math.abs((b[1] - a[1]) / (b[0] - a[0])), 2, 1e-6, 'zigzag de pente 2');
  }
  // Motif retrouvé (hachure lue d'un fichier, sans définition) : mêmes lignes à la même échelle.
  const h = makeHatch([square(100)], { solid: false, def: BUILTIN.get('BRIQUE'), scale: 7, angle: 0.3, source: 'intégré' }, { origin: [5, 5] });
  const back = defFromHatch({ ...h, patDef: undefined });
  const again = patternLines(back, { scale: 7, angle: 0.3, origin: [5, 5] });
  again.forEach((x, i) => { assert.point(x.base, h.lines[i].base, 1e-9); assert.point(x.offset, h.lines[i].offset, 1e-9); });
});

// Éditeur.
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const editor = new Editor(renderer, { print: () => {} });
registerCommands(editor);
registerHatchCommands(editor);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function type(...xs) { for (const x of xs) { editor.submit(x); await tick(); } }
async function run(cmd, ...xs) { editor.run(cmd); await tick(); await type(...xs); await tick(); }
async function click(p) {
  editor.computeCursor(renderer.toScreen(p[0], p[1]));
  editor.click(false);
  await tick();
}
function fresh() {
  const doc = new Document();
  doc.header.insunits = 4;
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  return doc;
}

test('HACHURES (ligne de commande) : motif par son nom, échelle, angle ; Propriétés : échelle et fond', async () => {
  const doc = fresh();
  await run('REC', '0,0', '1000,600');
  renderer.fit();
  await run('-HACHURES', 'Autre', 'BRIQUE', '20', '0');
  await click([500, 300]);
  await type('');
  const h = [...doc.entities.values()].find((e) => e.type === 'HATCH');
  assert.ok(h, 'hachure créée');
  assert.equal(h.pattern, 'BRIQUE');
  assert.equal(h.patScale, 20);
  assert.ok(h.assoc && h.assoc.mode === 'point', 'associative par défaut');
  assert.near(hatchArea(h), 600000, 1e-6);
  const x = structuredClone(h);
  assert.ok(setHatchField(x, 'hScale', '40'));
  assert.near(Math.hypot(...x.lines[0].offset), 2 * Math.hypot(...h.lines[0].offset), 1e-9, 'échelle doublée : écart doublé');
  assert.ok(setHatchField(x, 'hBg', '8'));
  assert.equal(x.bg, 8);
  doc.transaction('t', () => doc.update(x));
  const parts = renderer.cache.get(h.id).parts;
  assert.ok(parts.some((p) => p.tris.length > 0), 'fond dessiné (aplat)');
  assert.ok(parts.some((p) => p.segs.length > 0), 'motif dessiné');
});

test('hachures associatives : le contour suit l’objet (objet fermé, point intérieur), association perdue si un objet disparaît', async () => {
  const doc = fresh();
  await run('REC', '0,0', '100,50');
  const rect = [...doc.entities.values()].at(-1);
  renderer.fit();
  // Par objet.
  await run('-HACHURES', 'Plein', 'O');
  await click([100, 25]);
  await type('');
  const h1 = [...doc.entities.values()].find((e) => e.type === 'HATCH');
  assert.equal(h1.assoc?.mode, 'objets');
  doc.transaction('étirer', () => doc.modify(rect.id, (r) => { r.pts[1] = [200, 0]; r.pts[2] = [200, 50]; }));
  assert.near(hatchArea(doc.get(h1.id)), 200 * 50, 1e-6, 'objet étiré : hachure étirée');
  doc.undo();
  assert.near(hatchArea(doc.get(h1.id)), 100 * 50, 1e-6, 'annulé ensemble');
  // Par point intérieur, contour fait de lignes.
  const doc2 = fresh();
  await run('L', '0,0', '100,0', '');
  await run('L', '100,0', '100,100', '');
  await run('L', '100,100', '0,100', '');
  await run('L', '0,100', '0,0', '');
  renderer.fit();
  await run('-HACHURES', 'Plein');
  await click([50, 50]);
  await type('');
  const h2 = [...doc2.entities.values()].find((e) => e.type === 'HATCH');
  assert.ok(h2.assoc?.ids.length >= 4, 'objets sources notés');
  const right = [...doc2.entities.values()].find((e) => e.type === 'LINE' && e.p1[0] === 100 && e.p2[0] === 100);
  const top = [...doc2.entities.values()].find((e) => e.type === 'LINE' && e.p1[1] === 100 && e.p2[1] === 100);
  const bottom = [...doc2.entities.values()].find((e) => e.type === 'LINE' && e.p1[1] === 0 && e.p2[1] === 0);
  doc2.transaction('déplacer', () => {
    doc2.modify(right.id, (l) => { l.p1 = [150, -10, 0]; l.p2 = [150, 110, 0]; });
    doc2.modify(top.id, (l) => { l.p1 = [160, 100, 0]; });
    doc2.modify(bottom.id, (l) => { l.p2 = [160, 0, 0]; });
  });
  assert.near(hatchArea(doc2.get(h2.id)), 150 * 100, 1e-6, 'cloison déplacée : hachure recalculée');
  // Hachure déplacée avec son contour : elle suit (point intérieur déplacé lui aussi).
  const ids = [...doc2.entities.keys()];
  doc2.transaction('tout déplacer', () => { for (const id of ids) doc2.update(transformEntity(doc2.get(id), G.translation(1000, 0))); });
  assert.ok(doc2.get(h2.id).assoc, 'toujours associative');
  assert.near(hatchArea(doc2.get(h2.id)), 150 * 100, 1e-6);
  // Un objet source effacé : association perdue, contour gardé.
  doc2.transaction('effacer', () => doc2.remove(right.id));
  assert.ok(!doc2.get(h2.id).assoc, 'plus associative');
  assert.near(hatchArea(doc2.get(h2.id)), 150 * 100, 1e-6, 'contour gardé');
  assert.equal(recomputeLoops(doc2, { assoc: { mode: 'objets', ids: [999999] } }), null);
});

test('hachures : DXF écrit et relu (motif, échelle, angle, fond, associativité), hachure faite dans AutoCAD', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = new Document();
  doc.header.insunits = 4;
  let rect, h;
  doc.transaction('t', () => {
    rect = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [400, 0], [400, 300], [0, 300]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
    h = doc.add({ ...makeHatch([rect.pts], { solid: false, def: BUILTIN.get('ANSI37'), scale: 50, angle: Math.PI / 6, source: 'intégré', bg: 151 }, { assoc: { mode: 'objets', ids: [rect.id] } }), layer: '0' });
  });
  const text = writeDxf(doc);
  assert.ok(text.includes('HATCHBACKGROUNDCOLOR'), 'couleur de fond (données étendues d’AutoCAD)');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const bh = [...back.entities.values()].find((e) => e.type === 'HATCH');
  const br = [...back.entities.values()].find((e) => e.type === 'LWPOLYLINE');
  assert.equal(bh.pattern, 'ANSI37');
  assert.near(bh.patScale, 50, 1e-9);
  assert.near(bh.patAngle, Math.PI / 6, 1e-9);
  assert.equal(bh.bg, 151);
  assert.deepEqual(bh.assoc?.ids, [br.id], 'associativité relue (poignée → objet)');
  bh.lines.forEach((l, i) => { assert.point(l.offset, h.lines[i].offset, 1e-6); assert.near(l.angle, h.lines[i].angle, 1e-9); });
  // Hachure faite dans AutoCAD : ANSI31, échelle 50, angle 30°, fond bleu (5), contour et îlots.
  const acad = importDatabase(await readDrawing(await (await fetch('./fixtures/hachure-fond-autocad.dxf')).arrayBuffer(), 'h.dxf')).doc;
  const ah = [...acad.entities.values()].find((e) => e.type === 'HATCH');
  assert.equal(ah.pattern, 'ANSI31');
  assert.near(ah.patScale, 50, 1e-9);
  assert.near(ah.patAngle, Math.PI / 6, 1e-6);
  assert.equal(ah.bg, 5, 'fond bleu lu');
  assert.ok(ah.loops.length === 3, 'contour et deux îlots');
});

test('hachures : fichiers .pat d’AutoCAD lus sur place (si présents)', async () => {
  const pats = await loadPatFile('acadiso.pat');
  if (!pats.size) return; // AutoCAD absent : rien à vérifier
  assert.ok(pats.has('ANSI31') && pats.has('AR-CONC'), 'motifs d’AutoCAD');
  const l = pats.get('ANSI31').lines[0];
  assert.deepEqual([l.angle, l.dy], [45, 3.175], 'acadiso.pat : en mm');
});
