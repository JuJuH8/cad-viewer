// SPDX-License-Identifier: GPL-3.0-or-later
// Tests de l'extraction des attributs (EXTRACTATT) : comptage, regroupement, blocs imbriqués (position et calque),
// paramètres dynamiques, CSV pour Excel, tableau dans le dessin mis à jour par MAJEXTRACTION, réglages gardés dans le DXF.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { collectInserts, inventory, extractTable, toCsv } from '../src/blocks/extract.js';

const att = (tag, text, p = [0, 0, 0]) => ({ type: 'TEXT', layer: '0', tag, text, p, h: 1, rot: 0 });
const ins = (name, p, attribs = [], extra = {}) => ({ type: 'INSERT', layer: 'ELEC', name, p: [...p, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs, ...extra });

function sample() {
  const doc = new Document();
  doc.addLayer('ELEC');
  doc.blocks.set('PRISE', { name: 'PRISE', base: [0, 0, 0], flags: 0, entities: [{ type: 'CIRCLE', layer: '0', c: [0, 0, 0], r: 1 }] });
  doc.blocks.set('LUMINAIRE', { name: 'LUMINAIRE', base: [0, 0, 0], flags: 0, entities: [{ type: 'CIRCLE', layer: '0', c: [0, 0, 0], r: 2 }] });
  doc.blocks.set('VANNE', {
    name: 'VANNE', base: [0, 0, 0], flags: 0, entities: [{ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [1, 0, 0], k: 1 }],
    dyn: { params: [{ id: 'v1', type: 'visibility', name: 'Visibilité', states: ['DN20', 'DN25'], hidden: {} }], actions: [] },
  });
  // Bloc contenant deux prises (circuit C3), sur le calque 0 : elles prennent le calque de l'insertion.
  doc.blocks.set('GROUPE', {
    name: 'GROUPE', base: [0, 0, 0], flags: 0, entities: [
      { type: 'INSERT', layer: '0', name: 'PRISE', p: [10, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [att('CIRCUIT', 'C3'), att('PIECE', 'Local; technique')] },
      { type: 'INSERT', layer: '0', name: 'PRISE', p: [20, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [att('CIRCUIT', 'C3'), att('PIECE', 'Local; technique')] },
    ],
  });
  doc.transaction('x', () => {
    doc.add(ins('PRISE', [0, 0], [att('CIRCUIT', 'C1'), att('PIECE', 'Bureau')]));
    doc.add(ins('PRISE', [5, 0], [att('CIRCUIT', 'C1'), att('PIECE', 'Bureau')]));
    doc.add(ins('PRISE', [5, 5], [att('CIRCUIT', 'C2'), att('PIECE', 'Salle')]));
    doc.add(ins('LUMINAIRE', [0, 10], [att('TYPE', 'LED 36 W'), att('PUISSANCE', '36')]));
    doc.add(ins('LUMINAIRE', [5, 10], [att('TYPE', 'LED 36 W'), att('PUISSANCE', '36')]));
    doc.add(ins('VANNE', [0, 20], [], { dyn: { v1: 'DN25' } }));
    doc.add(ins('GROUPE', [100, 0], [], { rot: Math.PI / 2, layer: 'MEUBLES' }));
  });
  doc.undoStack = [];
  return doc;
}

test('extraction : comptage, regroupement, tri, blocs imbriqués, paramètres dynamiques', () => {
  const doc = sample();
  const items = collectInserts(doc);
  const inv = inventory(items);
  assert.deepEqual(Object.fromEntries(inv.blocks), { PRISE: 3, LUMINAIRE: 2, VANNE: 1, GROUPE: 1 });
  assert.deepEqual([...inv.tags.keys()].sort(), ['CIRCUIT', 'PIECE', 'PUISSANCE', 'TYPE']);
  let t = extractTable(items, { blocks: ['PRISE'], columns: ['count', 'name', 'att:CIRCUIT', 'att:PIECE'] });
  assert.deepEqual(t.head, ['Nombre', 'Nom', 'CIRCUIT', 'PIECE']);
  assert.deepEqual(t.rows, [['2', 'PRISE', 'C1', 'Bureau'], ['1', 'PRISE', 'C2', 'Salle']]);
  t = extractTable(items, { blocks: ['PRISE'], columns: ['count', 'att:CIRCUIT'], combine: false });
  assert.equal(t.rows.length, 3, 'une ligne par bloc sans regroupement');
  t = extractTable(items, { blocks: ['PRISE'], columns: ['count', 'att:CIRCUIT'], sort: [{ key: 'count', desc: true }] });
  assert.deepEqual(t.rows[0], ['2', 'C1'], 'tri par nombre décroissant');
  // Blocs imbriqués : position dans le monde, calque hérité, regroupés avec leurs valeurs.
  const all = collectInserts(doc, { nested: true });
  const c3 = all.filter((it) => it.attrs.CIRCUIT === 'C3');
  assert.equal(c3.length, 2);
  assert.near(c3[0].p[0], 100, 1e-9); assert.near(c3[0].p[1], 10, 1e-9);
  assert.near(c3[0].rot, Math.PI / 2, 1e-9);
  assert.equal(c3[0].layer, 'MEUBLES', 'calque 0 → calque de l’insertion');
  t = extractTable(all, { blocks: ['PRISE'], columns: ['count', 'att:CIRCUIT', 'layer'] });
  assert.deepEqual(t.rows.find((r) => r[1] === 'C3'), ['2', 'C3', 'MEUBLES']);
  // Paramètre dynamique.
  t = extractTable(items, { blocks: ['VANNE'], columns: ['count', 'name', 'dyn:Visibilité'] });
  assert.deepEqual(t.rows, [['1', 'VANNE', 'DN25']]);
  // Sélection.
  const sel = [...doc.entities.values()].filter((e) => e.name === 'PRISE' && e.p[1] === 0).map((e) => e.id);
  assert.equal(collectInserts(doc, { ids: sel }).length, 2);
  // Positions et CSV pour Excel (BOM, « ; », décimales à virgule, guillemets).
  t = extractTable(all, { blocks: ['PRISE'], columns: ['count', 'att:PIECE', 'x'], combine: false });
  const csv = toCsv(t);
  assert.ok(csv.startsWith('﻿Nombre;PIECE;Position X\r\n'));
  assert.ok(csv.includes('1;"Local; technique";100\r\n'), 'valeur avec « ; » entre guillemets');
  const t2 = extractTable([{ ...items[0], p: [1.25, 0, 0] }], { columns: ['x'] });
  assert.equal(toCsv(t2).split('\r\n')[1], '1,25', 'décimale à virgule');
});

test('extraction : tableau dans le dessin, MAJEXTRACTION, réglages gardés dans le DXF', async () => {
  const { Renderer } = await import('../src/render/renderer.js');
  const { Editor } = await import('../src/editor/editor.js');
  const { registerCommands } = await import('../src/editor/commands.js');
  const { registerExtractCommands } = await import('../src/blocks/extract-dialog.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:400px;height:300px;';
  document.body.appendChild(host);
  const renderer = new Renderer(host);
  const editor = new Editor(renderer, { print: () => {} });
  registerCommands(editor);
  registerExtractCommands(editor);
  const doc = sample();
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try { localStorage.removeItem('cv.extractatt'); } catch { /* sans stockage */ }
  editor.run('EXTRACTATT');
  await tick();
  const dlg = document.getElementById('extract-dialog');
  assert.ok(dlg?.open, 'boîte ouverte');
  // Colonnes : nombre, nom (par défaut) + CIRCUIT ; blocs : PRISE seulement.
  const set = (sel, v) => { const el = dlg.querySelector(sel); el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  dlg.querySelector('[data-act="no-blocks"]').click();
  set('[data-block="PRISE"]', true);
  set('[data-col="att:CIRCUIT"]', true);
  const preview = [...dlg.querySelectorAll('.ex-preview tbody tr')].map((r) => r.innerText.split('\t'));
  assert.deepEqual(preview, [['2', 'PRISE', 'C1'], ['1', 'PRISE', 'C2']]);
  dlg.querySelector('[data-act="table"]').click();
  await tick(); await tick();
  editor.submit('2.5'); await tick();
  editor.submit('0,-50'); await tick(); await tick();
  const tableIns = [...doc.entities.values()].find((e) => e.extract);
  assert.ok(tableIns, 'tableau inséré avec ses réglages');
  const texts = () => doc.blocks.get(tableIns.name).entities.filter((x) => x.type === 'TEXT').map((x) => x.text);
  assert.ok(texts().includes('C2') && texts().includes('EXTRACTION DES BLOCS'));
  // Modification du dessin puis mise à jour.
  const p2 = [...doc.entities.values()].find((e) => e.attribs?.[0]?.text === 'C2');
  doc.transaction('x', () => doc.update({ ...p2, attribs: [att('CIRCUIT', 'C9'), att('PIECE', 'Salle')] }));
  editor.setSelection([]);
  editor.run('MAJEXTRACTION'); await tick();
  assert.ok(texts().includes('C9') && !texts().includes('C2'), 'tableau mis à jour');
  doc.undo();
  assert.ok(texts().includes('C2'), 'mise à jour annulable');
  // DXF : réglages relus, sélection d'origine retrouvée par les poignées.
  const sel = [...doc.entities.values()].filter((e) => e.name === 'PRISE' && e.p[1] === 0).map((e) => e.id);
  doc.transaction('x', () => doc.update({ ...doc.get(tableIns.id), extract: { ...tableIns.extract, ids: sel } }));
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const bt = [...back.entities.values()].find((e) => e.extract);
  assert.ok(bt, 'réglages relus');
  assert.deepEqual(bt.extract.columns, ['count', 'name', 'att:CIRCUIT']);
  assert.equal(bt.extract.ids?.length, 2);
  assert.ok(bt.extract.ids.every((id) => back.get(id)?.name === 'PRISE' && back.get(id).p[1] === 0), 'mêmes objets choisis');
  const { refreshExtraction } = await import('../src/blocks/extract-dialog.js');
  back.transaction('x', () => refreshExtraction(back, bt));
  const btexts = back.blocks.get(bt.name).entities.filter((x) => x.type === 'TEXT').map((x) => x.text);
  assert.ok(btexts.includes('C1') && !btexts.includes('C2'), 'mise à jour après réouverture : sélection respectée');
  host.remove();
});
