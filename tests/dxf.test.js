// SPDX-License-Identifier: GPL-3.0-or-later
// Enregistrement DXF : aller-retour (écriture puis relecture par l'application) sur tous les exemples.
// Les fichiers produits sont aussi déposés dans out/ pour une validation dans AutoCAD.
import { test, assert, sample } from './harness.js';
import { readDrawing } from '../src/dwg-loader.js';
import { importDatabase } from '../src/io/importer.js';
import { writeDxf } from '../src/io/dxf-writer.js';
import { Tessellator } from '../src/core/tessellate.js';
import { Document } from '../src/core/document.js';

const files = await fetch('/samples/index.json').then((r) => r.json()).catch(() => []);

function measure(doc) {
  const t = new Tessellator(doc, { shx: false }); // textes SHX : comptés comme textes (traits selon l'arrivée des polices)
  let segs = 0, tris = 0, texts = 0;
  const types = {};
  for (const e of doc.entities.values()) {
    if (e.space !== 'model') continue;
    const k = e.type === 'BLOCKREF' ? 'INSERT' : e.type === 'POLY3D' && e.pts.every((p) => !p[2]) ? 'LWPOLYLINE' : e.type;
    types[k] = (types[k] || 0) + 1;
    for (const p of t.entity(e)) { segs += p.segs.length / 6; tris += p.tris.length / 9; texts += p.texts.length; }
  }
  return { segs, tris, texts, types };
}

async function save(name, text) {
  await fetch(`/__out/${encodeURIComponent(name)}`, { method: 'POST', body: text });
}

for (const name of files) {
  test(`DXF : aller-retour de ${name}`, async () => {
    const buf = await fetch(`/samples/${encodeURIComponent(name)}`).then((r) => r.arrayBuffer());
    const { doc } = importDatabase(await readDrawing(buf, name));
    const text = writeDxf(doc);
    await save(name.replace(/\.(dwg|dxf)$/i, '') + '.roundtrip.dxf', text);
    const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf'));
    const a = measure(doc), b = measure(back.doc);
    assert.deepEqual(b.types, a.types, `types : ${JSON.stringify(b.types)} au lieu de ${JSON.stringify(a.types)}`);
    const close = (x, y) => Math.abs(x - y) <= Math.max(3, y * 0.01);
    assert.ok(close(b.segs, a.segs), `segments ${b.segs} au lieu de ${a.segs}`);
    assert.ok(close(b.tris, a.tris), `triangles ${b.tris} au lieu de ${a.tris}`);
    assert.equal(b.texts, a.texts, `textes ${b.texts} au lieu de ${a.texts}`);
    assert.equal(back.doc.layers.size, doc.layers.size, 'nombre de calques');
  });
}

test('DXF : dessin créé dans l’application (accents, couleurs, calques)', async () => {
  const doc = new Document();
  doc.addLayer('CVC-Soufflage é', { color: 5 });
  doc.currentLayer = 'CVC-Soufflage é';
  doc.add({ type: 'LINE', p1: [0, 0, 0], p2: [100, 0, 0] });
  doc.add({ type: 'CIRCLE', c: [50, 50, 0], r: 20, color: 1 });
  doc.add({ type: 'ARC', c: [0, 0, 0], r: 30, a0: 0, a1: Math.PI / 2, rgb: 0x336699 });
  doc.add({ type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 0.5, 0], closed: true, z: 0, width: 0 });
  doc.add({ type: 'TEXT', p: [0, -10, 0], h: 2.5, rot: 0, text: 'Gaine 400×200 — débit 1 200 m³/h', align: 'left', valign: 'baseline', wf: 1 });
  const text = writeDxf(doc);
  await save('cree-dans-app.dxf', text);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const ents = [...back.entities.values()];
  assert.equal(ents.length, 5);
  assert.ok(back.layers.has('CVC-Soufflage é'), 'calque accentué conservé');
  assert.equal(back.layers.get('CVC-Soufflage é').color, 5);
  const t = ents.find((e) => e.type === 'TEXT');
  assert.equal(t.text, 'Gaine 400×200 — débit 1 200 m³/h');
  assert.equal(ents.find((e) => e.type === 'CIRCLE').color, 1);
  assert.equal(ents.find((e) => e.type === 'ARC').rgb, 0x336699);
  const pl = ents.find((e) => e.type === 'LWPOLYLINE');
  assert.ok(pl.closed);
  assert.near(pl.bulges[1], 0.5, 1e-12);
});

test('Xrefs : A-01 + « Grid Plan » + « Wall Base » attachées, puis liées à l’enregistrement DXF', async () => {
  const { attachXref, missingXrefs } = await import('../src/io/xref.js');
  const load = async (n) => importDatabase(await readDrawing(await sample(`${n}.dwg`), `${n}.dwg`)).doc;
  const doc = await load('A-01');
  assert.deepEqual(missingXrefs(doc).sort(), ['Grid Plan', 'Wall Base']);
  for (const n of ['Grid Plan', 'Wall Base']) assert.ok(attachXref(doc, n, await load(n)) > 0);
  assert.equal(missingXrefs(doc).length, 0);
  assert.ok([...doc.layers.keys()].some((l) => l.startsWith('Wall Base|')), 'calques préfixés comme dans AutoCAD');
  const before = measure(doc);
  assert.ok(before.segs > 20000, 'le fond de plan est dessiné');
  const text = writeDxf(doc);
  await save('A-01-xrefs-liees.dxf', text);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const after = measure(back);
  assert.ok(Math.abs(after.segs - before.segs) <= before.segs * 0.01, `segments ${after.segs} au lieu de ${before.segs}`);
  assert.equal(missingXrefs(back).length, 0, 'xrefs liées : plus rien à charger');
});

test('DXF : toutes les présentations et leurs fenêtres (torsion comprise) — validé AutoCAD', async () => {
  const buf = await sample('Site Layout Plan.dwg');
  const { doc } = importDatabase(await readDrawing(buf, 'x.dwg'));
  const text = writeDxf(doc);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.deepEqual(back.spaces.map((s) => s.label), doc.spaces.map((s) => s.label));
  const per = (d) => d.spaces.filter((s) => s.id !== 'model').map((s) => [...d.entities.values()].filter((e) => e.space === s.id).length);
  assert.deepEqual(per(back), per(doc), 'contenu de chaque présentation');
  const vp = (d) => [...d.entities.values()].filter((e) => e.type === 'VIEWPORT').map((e) => [e.c[0], e.c[1], e.w, e.h, e.vc[0], e.vc[1], e.vh, e.twist]);
  const a = vp(doc), b = vp(back);
  assert.equal(b.length, 4);
  a.forEach((row, i) => row.forEach((v, k) => assert.near(b[i][k], v, 1e-6)));
  // Feuille de la présentation active : première fenêtre de la section ENTITIES, ID 1.
  const ent = text.slice(text.indexOf('ENTITIES'));
  const first = ent.slice(ent.indexOf('VIEWPORT'));
  assert.ok(/\n 69\r?\n1\r?\n/.test(first.slice(0, 600)), 'feuille active en ID 1');
});
