// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des champs (CHAMP / FIELD) : analyse des codes d'AutoCAD, formats (fichier, dates, échelle, aire),
// somme de contrôle, champs dépendants (attribut modifié → texte recalculé, annulable), commandes -CHAMP,
// MAJCHAMP, MODIFTEXTE, DXF de l'appli relu, DXF et DWG d'AutoCAD.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import {
  parseCode, evaluateField, formatDate, formatFileName, formatNumber, checksum, updateFields, installFieldHooks, fieldCode,
} from '../src/core/fields.js';

const F = (code, refs = [], extra = {}) => ({ type: 'TEXT', layer: '0', p: [0, 0, 0], h: 2.5, rot: 0, text: '', align: 'left', valign: 'baseline', wf: 1, field: { code, refs }, ...extra });

test('champs : analyse, formats (fichier, date, échelle, aire, longueur), somme de contrôle d’AutoCAD', () => {
  const parts = parseCode('Plan %<\\AcVar Filename \\f "%fn2">% / %<\\AcObjProp Object(%<\\_ObjIdx 0>%).CustomScale \\f "%ps[1:,]%lu2%ct1%pr0">%');
  assert.equal(parts.length, 4);
  assert.equal(parts[1].expr.name, 'Filename');
  assert.equal(parts[1].expr.format, '%fn2');
  assert.equal(parts[3].expr.prop, 'CustomScale');
  assert.equal(parts[3].expr.idx, 0);
  const path = 'C:\\Projets\\MEP\\Plan-01.dwg';
  assert.equal(formatFileName(path, '%fn2'), 'Plan-01');
  assert.equal(formatFileName(path, '%fn6'), 'Plan-01.dwg');
  assert.equal(formatFileName(path, '%tc1%fn2'), 'PLAN-01');
  assert.equal(formatFileName(path, ''), path);
  assert.equal(formatFileName(path, '%fn1'), 'C:\\Projets\\MEP');
  const d = new Date(2026, 9, 16, 14, 5, 9);
  assert.equal(formatDate(d, 'dd.MM.yyyy'), '16.10.2026');
  assert.equal(formatDate(d, 'd MMMM yyyy'), '16 octobre 2026');
  assert.equal(formatDate(d, 'dddd dd.MM.yy HH:mm:ss'), 'vendredi 16.10.26 14:05:09');
  assert.equal(formatNumber(0.01, '%ps[1:,]%lu2%ct1%pr0'), '1:100', 'format d’AutoCAD (%ct1 : inverse)');
  assert.equal(formatNumber(0.01, '%sn'), '0.010000');
  assert.equal(formatNumber(1234.5, '%lu2%pr1%ds44'), '1234,5');
  assert.equal(formatNumber(12500000, '%lu2%pr2%ct8[1e-06]%ps[, m²]'), '12.50 m²');
  // Somme de contrôle : valeurs relevées dans des DXF d'AutoCAD 2024.
  assert.equal(checksum('16.10.2026'), 2731);
  assert.equal(checksum('Indice : B2'), 4300);
  assert.equal(checksum('Présentation1'), 9492);
  assert.equal(checksum('Plan champs'), 6651);
});

test('champs : évaluation (présentation, fenêtre, attribut, aire), champs dépendants recalculés et annulables', () => {
  const doc = new Document();
  doc.fileName = 'C:\\Projets\\Plan-01.dxf';
  doc.spaces.push({ id: 'P1', label: 'Rez' });
  installFieldHooks(doc);
  let vp, ins, poly, t1, t2, t3, t4;
  doc.transaction('x', () => {
    vp = doc.add({ type: 'VIEWPORT', layer: '0', space: 'P1', c: [100, 100, 0], w: 100, h: 50, vc: [0, 0], vh: 5000, twist: 0 });
    ins = doc.add({ type: 'INSERT', layer: '0', name: 'CART', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [{ type: 'TEXT', tag: 'INDICE', text: 'B2', p: [0, 0, 0], h: 1, rot: 0 }] });
    poly = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [5000, 0], [5000, 2500], [0, 2500]], bulges: [0, 0, 0, 0], closed: true, z: 0 });
    t1 = doc.add(F(`Échelle ${fieldCode('scale', '%ps[1:,]%lu2%ct1%pr0')}`, [{ id: vp.id }], { space: 'P1' }));
    t2 = doc.add(F(`Indice ${fieldCode('attrib', '')}`, [{ id: ins.id, tag: 'INDICE' }]));
    t3 = doc.add(F(`${fieldCode('ctab', '')} – ${fieldCode('filename', '%fn2')}`, [], { space: 'P1' }));
    t4 = doc.add(F(fieldCode('area', '%lu2%pr2%ct8[1e-06]%ps[, m²]'), [{ id: poly.id }]));
  });
  updateFields(doc, {}, { quiet: true });
  assert.equal(doc.get(t1.id).text, 'Échelle 1:100');
  assert.equal(doc.get(t2.id).text, 'Indice B2');
  assert.equal(doc.get(t3.id).text, 'Rez – Plan-01');
  assert.equal(doc.get(t4.id).text, '12.50 m²');
  // L'attribut change : le texte qui le cite suit, dans la même étape d'annulation.
  doc.transaction('Indice', () => doc.update({ ...doc.get(ins.id), attribs: [{ ...doc.get(ins.id).attribs[0], text: 'C1' }] }));
  assert.equal(doc.get(t2.id).text, 'Indice C1');
  doc.transaction('Polyligne', () => doc.update({ ...doc.get(poly.id), pts: [[0, 0], [10000, 0], [10000, 2500], [0, 2500]] }));
  assert.equal(doc.get(t4.id).text, '25.00 m²');
  doc.undo();
  assert.equal(doc.get(t4.id).text, '12.50 m²', 'annulé avec l’objet cité');
  doc.transaction('x', () => doc.remove(vp.id));
  assert.equal(doc.get(t1.id).text, 'Échelle ####', 'objet cité supprimé');
});

test('champs : -CHAMP (fichier, attribut, ajout à un texte), MAJCHAMP, MODIFTEXTE', async () => {
  const { Renderer } = await import('../src/render/renderer.js');
  const { Editor } = await import('../src/editor/editor.js');
  const { registerCommands } = await import('../src/editor/commands.js');
  const { registerFieldCommands } = await import('../src/editor/field-commands.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:400px;height:300px;';
  document.body.appendChild(host);
  const renderer = new Renderer(host);
  const editor = new Editor(renderer, { print: () => {} });
  registerCommands(editor);
  registerFieldCommands(editor);
  const doc = new Document();
  doc.fileName = 'Plan-02.dwg';
  installFieldHooks(doc);
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const run = async (...xs) => { editor.run(xs[0]); await tick(); for (const x of xs.slice(1)) { editor.submit(x); await tick(); } await tick(); };
  await run('-CHAMP', 'Fichier', 'F1', '0,0', '2.5');
  const t = [...doc.entities.values()].find((e) => e.field);
  assert.equal(t?.text, 'Plan-02');
  let ins;
  doc.blocks.set('CART', { name: 'CART', base: [0, 0, 0], flags: 0, entities: [{ type: 'CIRCLE', layer: '0', c: [0, 0, 0], r: 1 }] });
  doc.transaction('x', () => { ins = doc.add({ type: 'INSERT', layer: '0', name: 'CART', p: [100, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [{ type: 'TEXT', tag: 'INDICE', text: 'A', p: [100, 0, 0], h: 2, rot: 0 }, { type: 'TEXT', tag: 'DATE', text: 'x', p: [100, -3, 0], h: 2, rot: 0 }] }); });
  renderer.fit({ minX: 90, minY: -10, maxX: 110, maxY: 10 });
  await run('-CHAMP', 'Attribut', '100,1', 'INDICE', '100,-20', '2.5');
  const ta = [...doc.entities.values()].find((e) => e.field?.refs?.[0]?.tag === 'INDICE');
  assert.equal(ta?.text, 'A');
  // Ajout à un texte choisi.
  let plain;
  doc.transaction('x', () => { plain = doc.add({ type: 'TEXT', layer: '0', p: [0, -40, 0], h: 2.5, rot: 0, text: 'Dessin', align: 'left', valign: 'baseline', wf: 1 }); });
  editor.setSelection([plain.id]);
  await run('-CHAMP', 'Fichier', 'F2');
  assert.equal(doc.get(plain.id).text, 'Dessin Plan-02.dwg');
  // Fichier renommé : MAJCHAMP.
  doc.fileName = 'Plan-03.dwg';
  editor.setSelection([]);
  await run('MAJCHAMP');
  assert.equal(doc.get(t.id).text, 'Plan-03');
  // MODIFTEXTE : texte changé à la main → plus de champ.
  renderer.fit({ minX: -10, minY: -50, maxX: 30, maxY: 10 });
  await run('MODIFTEXTE', '*1,0.5', 'Texte libre', '');
  assert.ok(!doc.get(t.id).field && doc.get(t.id).text === 'Texte libre');
  host.remove();
});

test('champs : DXF de l’appli relu ; DXF et DWG d’AutoCAD (codes, objets cités, valeurs)', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const load = async (buf, name) => importDatabase(await readDrawing(buf, name)).doc;
  const doc = new Document();
  doc.fileName = 'Plan-01.dxf';
  let ins, poly;
  doc.transaction('x', () => {
    ins = doc.add({ type: 'INSERT', layer: '0', name: 'CART', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [{ type: 'TEXT', layer: '0', tag: 'INDICE', text: 'B2', p: [0, 0, 0], h: 1, rot: 0 }] });
    doc.blocks.set('CART', { name: 'CART', base: [0, 0, 0], flags: 2, entities: [{ type: 'ATTDEF', layer: '0', tag: 'INDICE', prompt: 'Indice', text: 'A', p: [0, 0, 0], h: 1, rot: 0 }] });
    poly = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], bulges: [0, 0, 0, 0], closed: true, z: 0 });
    doc.add(F(`Plan ${fieldCode('filename', '%fn2')} du ${fieldCode('savedate', 'dd.MM.yyyy')}`));
    doc.add(F(`Indice ${fieldCode('attrib', '')}`, [{ id: ins.id, tag: 'INDICE' }]));
    doc.add({ ...F(fieldCode('area', '%lu2%pr2%ct8[1e-06]%ps[, m²]'), [{ id: poly.id }]), type: 'MTEXT', width: 0, attach: 1 });
  });
  updateFields(doc, { saveDate: new Date(2026, 9, 16) }, { quiet: true });
  const text = writeDxf(doc);
  assert.ok(text.includes('ACAD_FIELD') && text.includes('AcDbField') && text.includes('FIELDLIST'));
  const back = await load(new TextEncoder().encode(text).buffer, 'x.dxf');
  const fs = [...back.entities.values()].filter((e) => e.field);
  assert.equal(fs.length, 3, 'trois champs relus');
  const byCode = (re) => fs.find((e) => re.test(e.field.code));
  assert.equal(byCode(/Filename/).field.code, `Plan ${fieldCode('filename', '%fn2')} du ${fieldCode('savedate', 'dd.MM.yyyy')}`);
  const att = byCode(/TextString/);
  assert.equal(back.get(att.field.refs[0].id)?.type, 'INSERT');
  assert.equal(att.field.refs[0].tag, 'INDICE');
  const area = byCode(/Area/);
  assert.equal(back.get(area.field.refs[0].id)?.type, 'LWPOLYLINE');
  back.fileName = 'Plan-01.dxf';
  assert.equal(evaluateField(back, area, {}), '1.00 m²');
  for (const f of ['champs-autocad.dxf', 'champs-autocad.dwg']) {
    const d = await load(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f);
    const list = [...d.entities.values()].filter((e) => e.field);
    assert.equal(list.length, 9, `${f} : 9 champs`);
    const ind = list.find((e) => /TextString/.test(e.field.code));
    assert.equal(evaluateField(d, ind, {}), 'Indice : B2', `${f} : attribut cité`);
    const sc = list.find((e) => /CustomScale/.test(e.field.code));
    assert.equal(d.get(sc.field.refs[0].id)?.type, 'VIEWPORT', `${f} : fenêtre citée`);
    d.fileName = 'C:\\plans\\champs.dwg';
    assert.equal(evaluateField(d, list.find((e) => /Filename \\f "%fn2"/.test(e.field.code) && e.type === 'TEXT'), {}), 'Fichier : champs');
    assert.ok(d.header.saveDate, `${f} : date d’enregistrement lue`);
  }
});
