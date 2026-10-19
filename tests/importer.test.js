// SPDX-License-Identifier: GPL-3.0-or-later
// Non-régression : le nouvel import (document éditable) doit produire la même géométrie
// que la visionneuse v1 (SceneBuilder) sur tous les fichiers d'exemple.
import { test, assert, sample } from './harness.js';
import { readDrawing } from '../src/dwg-loader.js';
import { importDatabase } from '../src/io/importer.js';
import { Tessellator } from '../src/core/tessellate.js';
import { SceneBuilder } from '../src/scene-builder.js';

const files = await fetch('/samples/index.json').then((r) => r.json()).catch(() => []);

function countV1(db) {
  // La v1 lisait l'espace objet dans db.entities en se fiant à isInPaperSpace, que libredwg-web ne
  // renseigne pas (les présentations y étaient mêlées) : on pose le drapeau pour comparer à l'identique.
  const ms = db.tables?.BLOCK_RECORD?.entries?.find((b) => /^\*model_space$/i.test(b.name));
  if (ms?.entities?.length) {
    const inModel = new Set(ms.entities.map((e) => e.handle));
    for (const e of db.entities) e.isInPaperSpace = !inModel.has(e.handle);
  }
  const r = new SceneBuilder(db).build('model');
  let segs = 0, tris = 0;
  for (const b of r.layers.values()) {
    for (const a of b.lines.values()) segs += a.length / 6;
    for (const a of b.fills.values()) tris += a.length / 9;
  }
  return { segs, tris, texts: r.texts.length };
}

function countV2(doc) {
  const t = new Tessellator(doc, { linetypes: false, widths: false, shx: false }); // la v1 traçait tout en continu, sans largeur ni police SHX
  let segs = 0, tris = 0, texts = 0;
  for (const e of doc.entities.values()) {
    if (e.space !== 'model') continue;
    for (const p of t.entity(e)) {
      segs += p.segs.length / 6;
      tris += p.tris.length / 9;
      texts += p.texts.length;
    }
  }
  return { segs, tris, texts };
}

for (const name of files) {
  test(`import : ${name} identique à la v1`, async () => {
    const buf = await fetch(`/samples/${encodeURIComponent(name)}`).then((r) => r.arrayBuffer());
    const db = await readDrawing(buf, name);
    const v1 = countV1(db);
    // La v1 dessinait en double les attributs (copie de libredwg-web parmi les entités) : on les retire.
    const dup = (db.entities || []).filter((e) => e.type === 'ATTRIB' && !e.isInPaperSpace && !(e.flags & 1) && e.isVisible !== false
      && String((typeof e.text === 'object' ? e.text?.text : e.text) || '').trim() && ((typeof e.text === 'object' ? e.text?.textHeight : e.textHeight) > 0)).length;
    v1.texts -= dup;
    const { doc, stats } = importDatabase(db);
    const v2 = countV2(doc);
    const close = (a, b) => Math.abs(a - b) <= Math.max(2, b * 0.01);
    assert.ok(close(v2.segs, v1.segs), `segments v2=${v2.segs} v1=${v1.segs}`);
    assert.ok(close(v2.tris, v1.tris), `triangles v2=${v2.tris} v1=${v1.tris}`);
    assert.equal(v2.texts, v1.texts, `textes v2=${v2.texts} v1=${v1.texts}`);
    assert.ok(doc.entities.size > 0);
    assert.equal(stats.skipped.size, 0, `ignorés : ${[...stats.skipped].join(', ')}`);
  });
}

test('lecture DWG en parallèle (3 workers) identique à la lecture complète', async () => {
  const { readDrawingAsync } = await import('../src/dwg-loader.js');
  for (const name of ['Floor Plan Sample.dwg', 'VW252-02-0200.dwg', 'A-01.dwg']) {
    const buf = await sample(name);
    const full = await readDrawing(buf, name);
    // readDrawingAsync se replie sur une lecture directe en cas d'erreur (avec un avertissement) :
    // on vérifie que la lecture parallèle a bien eu lieu.
    const warn = console.warn;
    let fellBack = false;
    console.warn = (...a) => { fellBack = true; warn(...a); };
    const par = await readDrawingAsync(buf, name, 3).finally(() => { console.warn = warn; });
    assert.ok(!fellBack, `${name} : lecture parallèle sans repli`);
    const sig = (db) => db.entities.map((e) => e.handle + e.type).join(',');
    const blocks = (db) => db.tables.BLOCK_RECORD.entries.map((b) => `${b.name}:${b.entities.map((e) => e.handle).join('.')}`).join('|');
    assert.equal(par.entities.length, full.entities.length, name);
    assert.ok(sig(par) === sig(full), `${name} : même ordre des entités`);
    assert.ok(blocks(par) === blocks(full), `${name} : mêmes blocs`);
    const a = importDatabase(full).doc, b = importDatabase(par).doc;
    assert.equal(b.entities.size, a.entities.size);
  }
});

test('MULTILEADER (DWG créé par AutoCAD) : lignes, flèche, palier et texte identiques à l’explosion d’AutoCAD', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = await (await fetch('/tests/fixtures/mleader.dwg')).arrayBuffer();
  const r = importDatabase(await readDrawing(buf, 'mleader.dwg'));
  assert.equal(r.stats.skipped.get('MULTILEADER'), undefined, 'plus ignorés');
  const refs = [...r.doc.entities.values()].filter((e) => e.type === 'BLOCKREF' && e.kind === 'MLEADER');
  assert.equal(refs.length, 3);
  // « Gaine EU » : repère de (5000, 3000) à (5600, 2400), MLEADERSCALE 100.
  const blk = refs.map((x) => r.doc.blocks.get(x.name)).find((b) => b.entities.some((e) => e.text === 'Gaine EU'));
  const by = (t) => blk.entities.find((e) => e.type === t);
  const mt = by('MTEXT');
  assert.point(mt.p, [5645, 2409], 1e-6, 'texte (position d’AutoCAD)');
  assert.near(mt.h, 18, 1e-9);
  assert.equal(mt.attach, 1);
  const dog = by('LINE');
  assert.point(dog.p1, [5600, 2400], 1e-6);
  assert.point(dog.p2, [5636, 2400], 1e-6, 'palier de 0,36 × 100');
  const pl = by('LWPOLYLINE');
  assert.point(pl.pts[0], [5012.73, 2987.27], 0.01, 'la ligne part du dos de la flèche');
  assert.point(pl.pts.at(-1), [5600, 2400], 1e-6);
  const so = by('SOLID');
  assert.point(so.pts[0], [5000, 3000], 1e-6, 'pointe');
  assert.point(so.pts[1], [5014.85, 2989.39], 0.01);
  assert.point(so.pts[2], [5010.61, 2985.15], 0.01);
});

test('MULTILEADER (DXF écrit par AutoCAD) : hauteur du texte relue malgré dxf-json', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = await (await fetch('/tests/fixtures/mleader.dxf')).arrayBuffer();
  const r = importDatabase(await readDrawing(buf, 'mleader.dxf'));
  const refs = [...r.doc.entities.values()].filter((e) => e.type === 'BLOCKREF' && e.kind === 'MLEADER');
  assert.equal(refs.length, 3);
  const mts = refs.flatMap((x) => r.doc.blocks.get(x.name).entities.filter((e) => e.type === 'MTEXT'));
  assert.deepEqual(mts.map((m) => m.text).sort(), ['Gaine EU', 'SOUF 400x200', 'VMC 01']);
  assert.ok(mts.every((m) => Math.abs(m.h - 18) < 1e-9), mts.map((m) => m.h).join(','));
  const eu = mts.find((m) => m.text === 'Gaine EU');
  assert.point(eu.p, [5645, 2409], 1e-6);
});

test('LEADER (DWG créé par AutoCAD) : flèche DIMASZ × DIMSCALE et ligne au dos de la flèche, comme l’explosion d’AutoCAD', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = await (await fetch('/tests/fixtures/leader.dwg')).arrayBuffer();
  const r = importDatabase(await readDrawing(buf, 'leader.dwg'));
  const ref = [...r.doc.entities.values()].find((e) => e.type === 'BLOCKREF' && e.kind === 'LEADER');
  assert.ok(ref, 'repère converti');
  const ents = r.doc.blocks.get(ref.name).entities;
  const so = ents.find((e) => e.type === 'SOLID'), pl = ents.find((e) => e.type === 'LWPOLYLINE');
  assert.point(so.pts[0], [1000, 1000], 1e-6, 'pointe');
  assert.point(so.pts[1], [1012.18, 1013.59], 0.01);
  assert.point(so.pts[2], [1015.93, 1008.9], 0.01);
  assert.point(pl.pts[0], [1014.06, 1011.24], 0.01, 'départ de la ligne (AutoCAD)');
  assert.point(pl.pts.at(-1), [3000, 1800], 1e-6);
});

test('LEADER (DXF écrit par AutoCAD) : surcharge DSTYLE (DIMSCALE 100) appliquée', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = await (await fetch('/tests/fixtures/leader.dxf')).arrayBuffer();
  const r = importDatabase(await readDrawing(buf, 'leader.dxf'));
  const ref = [...r.doc.entities.values()].find((e) => e.type === 'BLOCKREF' && e.kind === 'LEADER');
  const ents = r.doc.blocks.get(ref.name).entities;
  assert.point(ents.find((e) => e.type === 'LWPOLYLINE').pts[0], [1014.06, 1011.24], 0.01);
  assert.point(ents.find((e) => e.type === 'SOLID').pts[2], [1015.93, 1008.9], 0.01);
});

test('polylignes à largeur variable (DWG créé par AutoCAD) : flèche pleine, largeurs conservées en DXF', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const buf = await (await fetch('/tests/fixtures/plwidth.dwg')).arrayBuffer();
  const doc = importDatabase(await readDrawing(buf, 'p.dwg')).doc;
  const arrow = [...doc.entities.values()].find((e) => e.type === 'LWPOLYLINE' && e.widths);
  assert.ok(arrow, 'largeurs par segment lues');
  assert.deepEqual(arrow.widths, [[20, 20], [80, 0], [0, 0]]);
  // Aire de la bande : 500 × 20 (corps) + 200 × 80 / 2 (pointe) = 18 000.
  const t = new Tessellator(doc);
  let a = 0;
  for (const p of t.entity(arrow)) {
    const s = p.tris;
    for (let i = 0; i + 8 < s.length; i += 9) a += Math.abs((s[i + 3] - s[i]) * (s[i + 7] - s[i + 1]) - (s[i + 6] - s[i]) * (s[i + 4] - s[i + 1])) / 2;
  }
  assert.near(a, 18000, 1e-6);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const arrow2 = [...back.entities.values()].find((e) => e.type === 'LWPOLYLINE' && e.widths);
  assert.deepEqual(arrow2?.widths, [[20, 20], [80, 0], [0, 0]], 'aller-retour DXF');
});

test('DWG réenregistré par AutoCAD : supports aux XDATA illisibles par LibreDWG reconstruits depuis leur réseau', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const buf = await (await fetch('/tests/fixtures/demo-mep-acad.dwg')).arrayBuffer();
  const doc = importDatabase(await readDrawing(buf, 'demo.dwg')).doc;
  const sup = [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.name === 'CV_SUPPORT');
  assert.equal(sup.length, 62);
  assert.equal(sup.filter((e) => e.mep?.kind === 'support').length, 62, 'tous ont leurs paramètres');
  assert.ok(sup.every((e) => e.mep.system && e.mep.section && e.mep.type), 'système, section, type');
  const acc = [...doc.entities.values()].filter((e) => e.mep?.kind === 'accessory');
  assert.equal(acc.length, 13);
});

test('XLINE / RAY (DWG et DXF créés par AutoCAD) : lus, dessinés sans fausser l’emprise, réécrits en DXF', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  for (const f of ['xline.dwg', 'xline.dxf']) {
    const doc = importDatabase(await readDrawing(await (await fetch('/tests/fixtures/' + f)).arrayBuffer(), f)).doc;
    const xl = [...doc.entities.values()].filter((e) => e.type === 'XLINE');
    assert.equal(xl.length, 2, f);
    const x = xl.find((e) => !e.ray), r = xl.find((e) => e.ray);
    assert.point(x.p, [1000, 1000], 1e-6);
    assert.point(x.dir, [2 / Math.sqrt(5), 1 / Math.sqrt(5)], 1e-9);
    assert.point(r.dir, [0, 1], 1e-9);
    const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
    assert.equal([...back.entities.values()].filter((e) => e.type === 'XLINE' && e.ray).length, 1, 'RAY réécrite');
  }
});
