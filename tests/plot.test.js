// SPDX-License-Identifier: GPL-3.0-or-later
// Tests du tracé : tables de styles de tracé (CTB : lecture, écriture au format AutoCAD, application), PDF avec
// styles, mise en page qui garde sa table, affichage des styles dans une présentation.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { emptyTable, parseCtb, writeCtb, aciOf, plotColor, styleFor, findTable, BUILTIN, saveUserTable, deleteUserTable, allTables } from '../src/plot/styles.js';
import { FOREGROUND } from '../src/colors.js';

test('styles de tracé : couleurs d’index, couleur tracée (imposée, niveaux de gris, trame)', () => {
  assert.equal(aciOf(0xff0000), 1);
  assert.equal(aciOf(FOREGROUND), 7);
  assert.equal(aciOf(0xfe0303), 1, 'couleur vraie : index le plus proche');
  assert.equal(plotColor(null, FOREGROUND), 0x000000, 'blanc / noir : noir sur le papier');
  assert.equal(plotColor({ color: 0x0000ff, screen: 100 }, 0xff0000), 0x0000ff, 'couleur imposée');
  assert.equal(plotColor({ color: null, grayscale: true, screen: 100 }, 0xff0000), 0x4c4c4c, 'niveaux de gris');
  assert.equal(plotColor({ color: 0x000000, screen: 50 }, 0xff0000), 0x808080, 'trame 50 %');
  const mono = findTable('monochrome.ctb');
  assert.ok(mono?.builtin && styleFor(mono, 0x00ff00).color === 0);
  assert.ok(BUILTIN.length >= 5);
});

test('styles de tracé : fichier .ctb au format AutoCAD (en-tête, somme Adler-32, styles relus)', async () => {
  const t = emptyTable('essai.ctb', 'Table d’essai');
  t.styles[0] = { ...t.styles[0], color: 0x0000ff, linetype: 1, lineweight: 0.7, screen: 80, description: 'gaines' };
  t.styles[7] = { ...t.styles[7], color: 0x000000, grayscale: true, lineweight: 0.13 };
  const bytes = await writeCtb(t);
  assert.equal(new TextDecoder('latin1').decode(bytes.subarray(0, 48)), 'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec');
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(56, true), bytes.length - 60, 'taille compressée');
  // Somme Adler-32 des données compressées (contrôlée par AutoCAD).
  let a = 1, b = 0;
  for (const x of bytes.subarray(60)) { a = (a + x) % 65521; b = (b + a) % 65521; }
  assert.equal(dv.getUint32(48, true), ((b << 16) | a) >>> 0);
  const back = await parseCtb(bytes.buffer, 'essai.ctb');
  assert.deepEqual(back.styles[0], t.styles[0]);
  assert.deepEqual(back.styles[7], t.styles[7]);
  assert.deepEqual(back.styles[5], t.styles[5], 'couleur 6 : comme l’objet');
  assert.equal(back.description, 'Table d’essai');
  // Tables de l'utilisateur.
  saveUserTable({ ...t, name: 'zz-test.ctb' });
  assert.ok(allTables().has('zz-test.ctb'));
  deleteUserTable('zz-test.ctb');
  assert.ok(!allTables().has('zz-test.ctb'));
});

const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);

function drawing() {
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('d', () => {
    doc.addLayer('MURS', { color: 8 });
    doc.addLayer('GAINES', { color: 1 });
    doc.add({ type: 'LWPOLYLINE', layer: 'MURS', pts: [[0, 0], [12000, 0], [12000, 8000], [0, 8000]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
    doc.add({ type: 'LINE', layer: 'GAINES', p1: [1000, 4000, 0], p2: [11000, 4000, 0] });
  });
  renderer.setDocument(doc);
  return doc;
}

test('tracé PDF avec une table de styles : couleur, épaisseur, type de ligne et trame imposés', async () => {
  const doc = drawing();
  const { plotPdf } = await import('../src/io/pdf.js');
  const t = emptyTable('essai.ctb');
  t.styles[0] = { ...t.styles[0], color: 0x0000ff, linetype: 1, lineweight: 0.7 };
  t.styles[7] = { ...t.styles[7], color: 0x000000, screen: 30, lineweight: 0.35 };
  const r = await plotPdf(renderer, doc, { paper: 'A4', landscape: true, box: { minX: -500, minY: -500, maxX: 12500, maxY: 8500 }, scale: null, styles: t, frame: false });
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
  const widths = [...txt.matchAll(/([\d.]+) w/g)].map((m) => (parseFloat(m[1]) * 25.4) / 72);
  const has = (mm) => widths.some((v) => Math.abs(v - mm) < 1e-3);
  assert.ok(has(0.7) && has(0.35), `épaisseurs imposées (${widths.map((v) => v.toFixed(2))})`);
  assert.ok(/0\.? 0\.? 1\.? RG/.test(txt), 'gaine en bleu');
  assert.ok(/\[[\d. ]+\] 0\.? d/.test(txt), 'tirets imposés');
  assert.ok(/0\.7\d* G/.test(txt) || /0\.7\d* 0\.7\d* 0\.7\d* RG/.test(txt), 'murs tramés (gris clair)');
  // Sans styles de tracé : couleurs et épaisseurs des objets.
  const r2 = await plotPdf(renderer, doc, { paper: 'A4', landscape: true, box: { minX: -500, minY: -500, maxX: 12500, maxY: 8500 }, scale: null, mono: false, frame: false });
  const txt2 = new TextDecoder('latin1').decode(new Uint8Array(await r2.blob.arrayBuffer()));
  assert.ok(/1\.? 0\.? 0\.? RG/.test(txt2), 'gaine rouge sans table');
});

test('mise en page : table de styles gardée (DXF) et styles affichés dans la présentation', async () => {
  const doc = drawing();
  const { makePlot, sheetOf } = await import('../src/layout/sheet.js');
  doc.setSpaces([...doc.spaces, { id: '*Paper_Space_T1', label: 'P', plot: makePlot('A3', true, { ctb: 'grayscale.ctb', showStyles: true }) }]);
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  assert.ok(text.includes('grayscale.ctb'));
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.equal(back.spaces.find((s) => s.label === 'P')?.plot?.ctb, 'grayscale.ctb');
  // Affichage : couleur tracée (niveaux de gris) dans la présentation, couleur de l'objet dans l'espace objet.
  renderer.setSpace('*Paper_Space_T1', sheetOf(doc.spaces[1]));
  renderer.setPlotStyles(findTable('grayscale.ctb'));
  assert.equal(renderer.plotMap(0xff0000), 0x4c4c4c);
  renderer.setSpace('model', null);
  assert.equal(renderer.plotMap(0xff0000), 0xff0000, 'espace objet inchangé');
  renderer.setPlotStyles(null);
});

test('styles nommés : fichier .stb au format AutoCAD, recherche par nom (« Style_1 » = « Style 1 »)', async () => {
  const { emptyStb, stbStyle, isStb } = await import('../src/plot/styles.js');
  const t = emptyStb('essai.stb', 'Essai', [['Murs porteurs', { color: 0x000000, lineweight: 0.5 }], ['Fond 30%', { color: 0x000000, screen: 30 }]]);
  const bytes = await writeCtb(t);
  assert.equal(new TextDecoder('latin1').decode(bytes.subarray(0, 48)), 'PIAFILEVERSION_2.0,STBVER1,compress\r\npmzlibcodec');
  const back = await parseCtb(bytes.buffer, 'essai.stb');
  assert.ok(isStb(back), 'table de styles nommés');
  assert.deepEqual(back.styles.map((s) => s.name), ['Normal', 'Murs porteurs', 'Fond 30%']);
  assert.equal(back.styles[1].lineweight, 0.5);
  assert.equal(back.styles[1].color, 0x000000);
  assert.equal(back.styles[2].screen, 30);
  assert.equal(back.styles[0].color, null, 'Normal : comme l’objet');
  assert.equal(stbStyle(back, 'Murs_porteurs')?.lineweight, 0.5, 'nom avec « _ » comme dans les tables d’AutoCAD');
  assert.ok(findTable('acad.stb') && findTable('monochrome.stb'), 'tables intégrées');
});

test('styles nommés : dessin d’AutoCAD relu (DXF et DWG), écrit puis relu, tracé PDF par style', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const load = async (name, bytes) => importDatabase(await readDrawing(bytes || await (await fetch(`./fixtures/${name}`)).arrayBuffer(), name)).doc;
  const pstyles = (doc) => [...doc.entities.values()].filter((e) => e.type !== 'VIEWPORT').map((e) => e.pstyle || '-');
  for (const f of ['styles-nommes-autocad.dxf', 'styles-nommes-autocad.dwg']) {
    const doc = await load(f);
    assert.equal(doc.header.pstylemode, 0, `${f} : dessin en styles nommés`);
    assert.equal(doc.layers.get('MURS').pstyle, 'Style 1', `${f} : style du calque`);
    assert.equal(doc.layers.get('MEUBLES').pstyle, 'Normal');
  }
  const doc = await load('styles-nommes-autocad.dxf');
  assert.deepEqual(pstyles(doc), ['-', 'Normal', '-', 'Style 1'], 'styles imposés aux objets (DXF)');
  const back = await load('x.dxf', new TextEncoder().encode(writeDxf(doc)).buffer);
  assert.equal(back.header.pstylemode, 0);
  assert.equal(back.layers.get('MURS').pstyle, 'Style 1');
  assert.deepEqual(pstyles(back), ['-', 'Normal', '-', 'Style 1'], 'aller-retour DXF');
  // Tracé : le style du calque MURS (« Style 1 » : bleu, 0,7 mm) s'applique au trait sans style propre ; « Normal »
  // imposé au deuxième trait le laisse comme l'objet ; le trait du calque 0 en « Style 1 » est bleu aussi.
  const { emptyStb } = await import('../src/plot/styles.js');
  const { plotPdf } = await import('../src/io/pdf.js');
  renderer.setDocument(doc);
  const t = emptyStb('essai.stb', '', [['Style 1', { color: 0x0000ff, lineweight: 0.7 }]]);
  t.styles[0].color = 0xff0000; // Normal : rouge
  const r = await plotPdf(renderer, doc, { paper: 'A4', landscape: true, box: { minX: -10, minY: -10, maxX: 110, maxY: 110 }, scale: null, styles: t, frame: false });
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
  assert.ok(/0\.? 0\.? 1\.? RG/.test(txt), 'Style 1 en bleu');
  assert.ok(/1\.? 0\.? 0\.? RG/.test(txt), 'Normal en rouge');
  const widths = [...txt.matchAll(/([\d.]+) w/g)].map((m) => (parseFloat(m[1]) * 25.4) / 72);
  assert.ok(widths.some((v) => Math.abs(v - 0.7) < 1e-3), 'épaisseur du style');
});
