// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des découpes : géométrie découpée par un polygone, DECOUPXREF (XCLIP) des blocs et références, fenêtres de
// présentation non rectangulaires (FMULT Polygonale / Objet, DECOUPFENETRE), fichiers d'AutoCAD et DXF de l'appli.
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { registerClipCommands, clipViewport } from '../src/editor/xclip.js';
import { clipSegment, clipParts, isConvex } from '../src/core/clip.js';

const SQ = [[0, 0], [10, 0], [10, 10], [0, 10]];
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]; // en L (concave)

test('découpe par un polygone : segments (convexe, concave, inversé), triangles, textes', () => {
  assert.deepEqual(clipSegment(-5, 5, 15, 5, SQ), [[0, 5, 10, 5]]);
  assert.deepEqual(clipSegment(-5, 5, 15, 5, SQ, true), [[-5, 5, 0, 5], [10, 5, 15, 5]], 'inversé : l’extérieur');
  assert.deepEqual(clipSegment(-5, 7, 15, 7, L), [[0, 7, 4, 7]], 'concave : seulement la partie dans le L');
  assert.ok(isConvex(SQ) && !isConvex(L));
  const parts = [{ segs: [-5, 5, 0, 15, 5, 0], tris: [-5, -5, 0, 5, -5, 0, 5, 5, 0], pts: [2, 2, 0, 20, 20, 0], texts: [{ x: 1, y: 1 }, { x: 50, y: 1 }] }];
  clipParts(parts, SQ);
  assert.deepEqual(parts[0].segs, [0, 5, 0, 10, 5, 0]);
  const area = (t) => { let a = 0; for (let i = 0; i + 8 < t.length; i += 9) a += Math.abs((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 6] - t[i]) * (t[i + 4] - t[i + 1])) / 2; return a; };
  assert.near(area(parts[0].tris), 12.5, 1e-9, 'triangle découpé exactement (contour convexe)');
  assert.deepEqual(parts[0].pts, [2, 2, 0]);
  assert.equal(parts[0].texts.length, 1);
});

const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const editor = new Editor(renderer, { print: () => {} });
registerCommands(editor);
registerClipCommands(editor);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function type(...xs) { for (const x of xs) { editor.submit(x); await tick(); } }
async function run(cmd, ...xs) { editor.run(cmd); await tick(); await type(...xs); await tick(); }
const segCount = (id) => renderer.cache.get(id).parts.reduce((n, p) => n + (p.noPlot ? 0 : p.segs.length / 6), 0);

function gridDoc() {
  const doc = new Document();
  doc.header.insunits = 4;
  const ents = [];
  for (let k = 0; k <= 10; k++) {
    ents.push({ type: 'LINE', layer: '0', p1: [k * 10, 0, 0], p2: [k * 10, 100, 0] }, { type: 'LINE', layer: '0', p1: [0, k * 10, 0], p2: [100, k * 10, 0] });
  }
  doc.blocks.set('GRILLE', { name: 'GRILLE', base: [0, 0, 0], flags: 0, entities: ents });
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  return doc;
}

test('DECOUPXREF : rectangle, inversée, désactivée, polyligne du contour, supprimée ; la découpe suit l’insertion', async () => {
  const doc = gridDoc();
  let ins;
  doc.transaction('t', () => { ins = doc.add({ type: 'INSERT', layer: '0', name: 'GRILLE', p: [1000, 0, 0], sx: 2, sy: 2, sz: 1, rot: 0, attribs: [] }); });
  const full = segCount(ins.id);
  editor.setSelection([ins.id]);
  await run('DECOUPXREF', 'N', 'R', '1020,20', '1100,100');
  let e = doc.get(ins.id);
  assert.ok(e.clip && !e.clip.invert, 'découpe');
  assert.point(e.clip.pts[0], [10, 10], 1e-9, 'contour en coordonnées du bloc');
  const clipped = segCount(ins.id);
  assert.ok(clipped < full, `géométrie découpée (${clipped} < ${full})`);
  assert.ok(renderer.cache.get(ins.id).parts.some((p) => p.noPlot && p.segs.length), 'cadre affiché (non tracé)');
  // La découpe suit l'insertion déplacée.
  doc.transaction('déplacer', () => doc.update({ ...doc.get(ins.id), p: [2000, 0, 0] }));
  assert.equal(segCount(ins.id), clipped);
  await run('DECOUPXREF', 'D');
  assert.ok(doc.get(ins.id).clip.off);
  assert.equal(segCount(ins.id), full, 'désactivée : tout le bloc');
  await run('DECOUPXREF', 'A');
  await run('DECOUPXREF', 'P');
  const pl = [...doc.entities.values()].find((x) => x.type === 'LWPOLYLINE');
  assert.ok(pl && pl.pts.length === 4 && G.dist(pl.pts[0], [2020, 20]) < 1e-9, 'polyligne du contour (monde)');
  await run('DECOUPXREF', 'N', 'I', 'R', '2020,20', '2100,100');
  assert.ok(doc.get(ins.id).clip.invert, 'inversée');
  assert.ok(segCount(ins.id) > clipped, 'inversée : l’extérieur gardé');
  await run('DECOUPXREF', 'S');
  assert.ok(!doc.get(ins.id).clip);
  editor.setSelection([]);
});

test('DECOUPXREF : DXF écrit et relu (normale, inversée) ; découpes faites dans AutoCAD (DXF et DWG)', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = gridDoc();
  doc.transaction('t', () => {
    doc.add({ type: 'INSERT', layer: '0', name: 'GRILLE', p: [1000, 0, 0], sx: 2, sy: 2, sz: 2, rot: 0.5, attribs: [], clip: { pts: [[10, 10], [60, 10], [40, 70]], invert: false } });
    doc.add({ type: 'INSERT', layer: '0', name: 'GRILLE', p: [2000, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], clip: { pts: [[20, 20], [60, 20], [60, 70], [20, 70]], invert: true } });
  });
  const text = writeDxf(doc);
  assert.ok(text.includes('SPATIAL_FILTER') && text.includes('ACAD_INVERTEDCLIP_ROUNDTRIP'));
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const clips = [...back.entities.values()].filter((e) => e.type === 'INSERT').map((e) => e.clip);
  const orig = [...doc.entities.values()].map((e) => e.clip);
  clips.forEach((c, i) => {
    assert.equal(c.invert, orig[i].invert);
    c.pts.forEach((q, k) => assert.point(q, orig[i].pts[k], 1e-6, `découpe ${i} relue`));
  });
  for (const f of ['xclip-autocad.dxf', 'xclip-autocad.dwg']) {
    const d = importDatabase(await readDrawing(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f)).doc;
    const [a, b] = [...d.entities.values()].filter((e) => e.type === 'INSERT');
    assert.equal(a.clip.pts.length, 3, `${f} : triangle`);
    // Contour d'AutoCAD (monde) ramené dans le bloc : (1050, 20) dans une insertion ×2 tournée de 0,5 rad en (1000, 0).
    const m = [2 * Math.cos(0.5), 2 * Math.sin(0.5), -2 * Math.sin(0.5), 2 * Math.cos(0.5), 1000, 0];
    assert.point(G.apply(m, a.clip.pts[0][0], a.clip.pts[0][1]), [1050, 20], 1e-6, `${f} : contour en coordonnées du bloc`);
    assert.ok(b.clip.invert && b.clip.pts.length === 4, `${f} : découpe inversée (contour d’origine)`);
    assert.point(b.clip.pts[2], [60, 70], 1e-9);
  }
});

test('fenêtres non rectangulaires : FMULT Polygonale, DECOUPFENETRE Objet, gabarit et tracé ; fichiers d’AutoCAD', async () => {
  const { makePlot, sheetOf } = await import('../src/layout/sheet.js');
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('t', () => { for (let k = 0; k <= 20; k++) doc.add({ type: 'LINE', layer: '0', p1: [k * 500, 0, 0], p2: [k * 500, 10000, 0] }); });
  doc.setSpaces([...doc.spaces, { id: '*Paper_Space_T', label: 'P', plot: makePlot('A3', true) }]);
  doc.currentSpace = '*Paper_Space_T';
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.setSpace('*Paper_Space_T', sheetOf(doc.spaces[1]));
  editor.settings.osnap = false;
  await run('FMULT', 'P', '20,20', '200,20', '200,150', '120,200', '20,150', '', 'A');
  const v = [...doc.entities.values()].find((e) => e.type === 'VIEWPORT');
  assert.ok(v?.clip?.length === 5, 'fenêtre polygonale');
  assert.ok(Math.abs(v.w - 180) < 1e-9 && Math.abs(v.h - 180) < 1e-9, 'cadre = emprise du contour');
  assert.ok(editor.viewportAt([110, 100]) && !editor.viewportAt([195, 195]), 'fenêtre active seulement dans le contour');
  renderer.refreshViewports();
  renderer.render(true); // gabarit : pas d'erreur WebGL
  // Tracé : traits de l'espace objet coupés au contour.
  const { plotPdf } = await import('../src/io/pdf.js');
  const r = await plotPdf(renderer, doc, { sheet: sheetOf(doc.spaces[1]), lineweights: true });
  assert.ok(r.segments > 0, 'contenu tracé');
  // DECOUPFENETRE : cercle → contour ; le cercle devient le cadre.
  let circle;
  doc.transaction('t', () => { circle = doc.add({ type: 'CIRCLE', layer: '0', c: [300, 120, 0], r: 50, space: '*Paper_Space_T' }); });
  editor.setSelection([v.id]);
  editor.run('DECOUPFENETRE');
  await tick();
  await type('O');
  editor.cursor = { ...editor.cursor };
  editor.computeCursor(renderer.toScreen(350, 120));
  editor.click(false);
  await tick();
  const v2 = doc.get(v.id);
  assert.ok(v2.clip.length > 30 && !doc.get(circle.id), 'contour du cercle repris, cercle retiré');
  assert.near(v2.vh / v2.h, v.vh / v.h, 1e-9, 'échelle gardée');
  // Même vue : le point (300, 120) du papier montre le même point de l'espace objet.
  const { viewportMatrix } = await import('../src/render/viewports.js');
  const inv = (vp, p) => { const m = G.invert(viewportMatrix(vp)); return G.apply(m, p[0], p[1]); };
  assert.point(inv(v2, [300, 120]), inv(v, [300, 120]), 1e-6, 'vue inchangée');
  editor.setSelection([]);
  // DXF : contour écrit comme AutoCAD et relu.
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const bv = [...back.entities.values()].find((e) => e.type === 'VIEWPORT');
  assert.equal(bv.clip.length, v2.clip.length, 'contour relu');
  assert.ok(![...back.entities.values()].some((e) => e.type === 'LWPOLYLINE' && e.space !== 'model'), 'contour non importé comme objet');
  for (const f of ['fenetre-polygone-autocad.dxf', 'fenetre-polygone-autocad.dwg']) {
    const d = importDatabase(await readDrawing(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f)).doc;
    const fv = [...d.entities.values()].find((e) => e.type === 'VIEWPORT' && e.clip);
    assert.ok(fv && fv.clip.length === 5, `${f} : fenêtre polygonale d’AutoCAD`);
    assert.point(fv.clip[3], [120, 200], 1e-9);
  }
});
