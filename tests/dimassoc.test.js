// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des cotes associatives d'AutoCAD (objets DIMASSOC) : lecture (DXF et DWG d'AutoCAD), mise à jour dans l'appli
// identique à celle d'AutoCAD, écriture de vraies cotes avec leurs objets accrochés, références d'accrochage.
import { test, assert } from './harness.js';
import { toAcadRef, pointOfAcadRef, refFor, scanDimAssoc, dimDefPoints } from '../src/core/dimassoc.js';
import { installAssociativeDims } from '../src/editor/assoc.js';

async function load(name, bytes = null) {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = bytes || await (await fetch(`./fixtures/${name}`)).arrayBuffer();
  return importDatabase(await readDrawing(buf, name)).doc;
}
const dims = (doc) => [...doc.entities.values()].filter((e) => e.kind === 'DIMENSION').sort((a, b) => parseInt(a.handle, 16) - parseInt(b.handle, 16));
const byHandle = (doc, h) => [...doc.entities.values()].find((e) => String(e.handle).toUpperCase() === h);
const refs = (doc, d) => (d.meta.assoc || []).map((r) => (r ? `${doc.get(r.id).type}:${r.k}${r.i}` : '-')).join(' ');
// Cotes de la référence AutoCAD (handles) et objets accrochés attendus.
const EXPECTED = ['LINE:end0 LINE:end1', 'LINE:end0 LINE:end1', 'CIRCLE:circle0', 'ARC:circle0', 'LWPOLYLINE:end1 LWPOLYLINE:end2', 'LINE:mid0 LWPOLYLINE:end1', 'CIRCLE:cen0 LINE:end1'];

test('cotes associatives d’AutoCAD : lecture des DIMASSOC (DXF et DWG), types et points de définition', async () => {
  for (const f of ['cotes-assoc-autocad.dxf', 'cotes-assoc-autocad.dwg']) {
    const doc = await load(f);
    const list = dims(doc);
    assert.equal(list.length, 7, `${f} : 7 cotes`);
    assert.deepEqual(list.map((d) => d.meta.type), ['linear', 'aligned', 'radius', 'diameter', 'linear', 'linear', 'linear']);
    assert.deepEqual(list.map((d) => refs(doc, d)), EXPECTED, `${f} : objets accrochés`);
    assert.near(list[2].meta.r, 25, 1e-9, 'rayon');
    assert.point(list[3].meta.c, [300, 0], 1e-9, 'centre de l’arc (diamètre)');
  }
});

test('cotes associatives d’AutoCAD : mêmes modifications que dans AutoCAD → mêmes mesures', async () => {
  const doc = await load('cotes-assoc-autocad.dxf');
  installAssociativeDims(doc, () => 1);
  const line = byHandle(doc, '2BA'), pl = byHandle(doc, '2BE');
  // Dans AutoCAD : ligne déplacée de (10, 5), deux derniers sommets de la polyligne étirés de 20 en X.
  doc.transaction('essai', () => {
    doc.update({ ...line, p1: [10, 5, 0], p2: [110, 5, 0] });
    doc.update({ ...pl, pts: pl.pts.map((p, i) => (i >= 1 ? [p[0] + 20, p[1]] : p)) });
  });
  const got = dims(doc).map((d) => Math.round(d.meta.measurement * 1e4) / 1e4);
  assert.deepEqual(got, [100, 89.4427, 25, 80, 60, 195, 90], 'mesures relevées dans AutoCAD après les mêmes modifications');
});

test('cotes associatives : écrites comme vraies cotes avec leurs DIMASSOC, relues à l’identique', async () => {
  const doc = await load('cotes-assoc-autocad.dwg');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const text = writeDxf(doc);
  assert.equal((text.match(/\n *0\nDIMENSION\n/g) || []).length, 7, 'vraies cotes');
  const assoc = scanDimAssoc(text);
  assert.equal(assoc.size, 7, 'un DIMASSOC par cote');
  const kinds = [...assoc.values()].map((r) => r.map((x) => `${x.bit}:${x.osnap}`).join(' ')).sort();
  assert.ok(kinds.includes('0:13 1:1'), 'extrémités d’une ligne : départ (13) et extrémité (1)');
  assert.ok(kinds.includes('1:3'), 'cercle d’une cote de rayon : centre (3)');
  assert.ok(kinds.includes('0:2 1:1'), 'milieu (2) puis extrémité');
  assert.ok(/\n *2\n\*D\d+\n/.test(text), 'blocs des cotes anonymes (*D…)');
  const back = await load('x.dxf', new TextEncoder().encode(text).buffer);
  assert.deepEqual(dims(back).map((d) => refs(back, d)).sort(), [...EXPECTED].sort(), 'liens relus');
  assert.deepEqual(dims(back).map((d) => Math.round(d.meta.measurement * 1e4) / 1e4).sort((a, b) => a - b), [25, 60, 80, 89.4427, 100, 100, 200]);
});

test('cotes associatives : références d’accrochage appli ↔ AutoCAD', () => {
  const line = { id: 1, type: 'LINE', p1: [0, 0, 0], p2: [10, 0, 0] };
  const pl = { id: 2, type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 0, 0], closed: false };
  const arc = { id: 3, type: 'ARC', c: [0, 0], r: 5, a0: 0, a1: Math.PI / 2 };
  const cases = [[line, [0, 0]], [line, [10, 0]], [line, [5, 0]], [pl, [0, 0]], [pl, [10, 0]], [pl, [10, 10]], [pl, [10, 5]], [arc, [5, 0]], [arc, [0, 5]], [arc, [0, 0]]];
  for (const [e, p] of cases) {
    const ref = refFor(e, p);
    const a = toAcadRef(e, ref);
    assert.ok(a, `${e.type} ${p} : référence d’AutoCAD`);
    assert.point(pointOfAcadRef(e, a), p, 1e-9, `${e.type} ${p} : même point relu`);
  }
  assert.deepEqual(toAcadRef(pl, refFor(pl, [10, 10])), { osnap: 1, gs: 2, param: 1 }, 'sommet 2 = extrémité du segment 2');
  assert.deepEqual(toAcadRef(line, { id: 1, k: 'circle', i: 0 }), null);
  // Point de cote sur la deuxième ligne d'attache (code 10), comme AutoCAD.
  const d = dimDefPoints({ type: 'linear', p1: [0, 0], p2: [100, 40], loc: [50, 80], rotation: 0 });
  assert.point(d.p10, [100, 80], 1e-9);
});
