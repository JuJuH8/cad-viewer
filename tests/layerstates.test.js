// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des états de calques (ETATCALQUE) : enregistrer / restaurer avec masque, calque courant, calques absents,
// renommage d'un calque, ligne de commande, fichier .las d'AutoCAD (lecture et écriture à l'octet près) et DXF
// (états d'AutoCAD relus, aller-retour de l'appli).
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { captureState, restoreState, stateMatches, MASK, parseLas, writeLas, encodeLas, decodeLas } from '../src/core/layerstates.js';
import { saveLayerState, applyLayerState, findLayerState, editLayerState } from '../src/ui/layerstates.js';

function sample() {
  const doc = new Document();
  doc.addLayer('MURS', { color: 3 });
  doc.addLayer('GAINES', { color: 1, lweight: 50 });
  doc.addLayer('TEXTES');
  doc.ltypes = new Map([['DASHED', { name: 'DASHED', dashes: [5, -2] }]]);
  doc.currentLayer = 'MURS';
  doc.undoStack = [];
  return doc;
}

test('états de calques : enregistrer, modifier, restaurer (masque, calque courant, annulation)', () => {
  const doc = sample();
  saveLayerState(doc, 'Coordination', { desc: 'Tout visible' });
  const st = findLayerState(doc, 'coordination');
  assert.equal(st.name, 'Coordination');
  assert.equal(st.current, 'MURS');
  assert.equal(st.layers.length, 4);
  assert.ok(stateMatches(doc, st), 'identique juste après l’enregistrement');
  doc.transaction('x', () => {
    doc.setLayer('TEXTES', { on: false });
    doc.setLayer('GAINES', { frozen: true, color: 5, lweight: 25, ltype: 'DASHED' });
    doc.setLayer('MURS', { locked: true, plot: false, rgb: 0xff8000 });
  });
  doc.currentLayer = 'TEXTES';
  assert.ok(!stateMatches(doc, st));
  // Couleur seulement.
  doc.transaction('r', () => restoreState(doc, st, { mask: MASK.color }));
  assert.equal(doc.layers.get('GAINES').color, 1);
  assert.equal(doc.layers.get('MURS').rgb, undefined, 'couleur vraie retirée');
  assert.equal(doc.layers.get('GAINES').frozen, true, 'gel non restauré (hors masque)');
  doc.undo();
  assert.equal(doc.layers.get('GAINES').color, 5, 'annulable');
  // Tout.
  const r = applyLayerState(doc, 'Coordination');
  assert.equal(r.changed, 3);
  assert.equal(doc.currentLayer, 'MURS', 'calque courant de l’état');
  const g = doc.layers.get('GAINES');
  assert.ok(!g.frozen && g.color === 1 && g.lweight === 50 && g.ltype === 'Continuous');
  assert.ok(doc.layers.get('TEXTES').on && !doc.layers.get('MURS').locked && doc.layers.get('MURS').plot !== false);
  assert.ok(stateMatches(doc, st));
});

test('états de calques : calques absents, calque courant jamais gelé, renommage, ligne de commande', async () => {
  const doc = sample();
  doc.transaction('x', () => doc.setLayer('TEXTES', { frozen: true }));
  saveLayerState(doc, 'Gel');
  doc.transaction('x', () => { doc.setLayer('TEXTES', { frozen: false }); doc.addLayer('NOUVEAU'); });
  doc.currentLayer = 'TEXTES';
  const st = { ...findLayerState(doc, 'Gel'), current: 'ABSENT' };
  doc.transaction('r', () => restoreState(doc, st, { offMissing: true }));
  assert.equal(doc.layers.get('TEXTES').frozen, false, 'le calque courant n’est pas gelé');
  assert.equal(doc.layers.get('NOUVEAU').on, false, 'calque absent de l’état désactivé');
  // Renommage d'un calque : l'état suit.
  doc.renameLayer('GAINES', 'VENTILATION');
  assert.ok(findLayerState(doc, 'Gel').layers.some((s) => s.name === 'VENTILATION'));
  assert.ok(!findLayerState(doc, 'Gel').layers.some((s) => s.name === 'GAINES'));
  // Modifier : nom, description, masque.
  assert.ok(editLayerState(doc, 'Gel', { newName: 'Sans textes', desc: 'Plan sans textes', mask: MASK.on | MASK.frozen }));
  assert.equal(findLayerState(doc, 'Gel'), null);
  assert.equal(findLayerState(doc, 'sans textes').mask, 3);
  // Ligne de commande.
  const { Renderer } = await import('../src/render/renderer.js');
  const { Editor } = await import('../src/editor/editor.js');
  const { registerCommands } = await import('../src/editor/commands.js');
  const { registerLayerStateCommands } = await import('../src/ui/layerstates.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:400px;height:300px;';
  document.body.appendChild(host);
  const out = [];
  const renderer = new Renderer(host);
  const editor = new Editor(renderer, { print: (s) => out.push(s) });
  registerCommands(editor);
  registerLayerStateCommands(editor);
  renderer.setDocument(doc);
  editor.setDocument(doc);
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const run = async (...xs) => { editor.run(xs[0]); await tick(); for (const x of xs.slice(1)) { editor.submit(x); await tick(); } await tick(); };
  await run('-ETATCALQUE', 'Enregistrer', 'Phase 1');
  assert.ok(findLayerState(doc, 'Phase 1'), 'enregistré en ligne de commande');
  doc.transaction('x', () => doc.setLayer('MURS', { on: false }));
  await run('-ETATCALQUE', 'Restaurer', 'Phase 1');
  assert.equal(doc.layers.get('MURS').on, true, 'restauré en ligne de commande');
  await run('-ETATCALQUE', 'Renommer', 'Phase 1', 'Phase 2');
  assert.ok(findLayerState(doc, 'Phase 2') && !findLayerState(doc, 'Phase 1'), 'renommé');
  await run('-ETATCALQUE', 'Supprimer', 'Phase 2');
  assert.equal(findLayerState(doc, 'Phase 2'), null, 'supprimé');
  host.remove();
});

test('états de calques : fichier .las d’AutoCAD (lecture, réécriture à l’octet près)', async () => {
  const bytes = new Uint8Array(await (await fetch('./fixtures/etats-calques-autocad.las')).arrayBuffer());
  const [st, ...rest] = parseLas(decodeLas(bytes));
  assert.equal(rest.length, 0);
  assert.equal(st.name, 'Complet');
  assert.equal(st.current, 'MURS');
  assert.equal(st.mask, 255);
  const L = Object.fromEntries(st.layers.map((s) => [s.name, s]));
  assert.ok(L['ÉLEC'], 'nom accentué lu en cp1252');
  assert.equal(L['ÉLEC'].rgb, 0xff8000);
  assert.equal(L['ÉLEC'].color, 30);
  assert.ok(L.VERR.locked && L.VERR.plot);
  assert.ok(!L.NOPLOT.plot && L.NOPLOT.on);
  assert.ok(L.VPGEL.newVp && !L.VPGEL.frozen);
  assert.equal(L.TRANSP.transparency, 33554559);
  assert.equal(L.GAINES.lweight, 50);
  const again = encodeLas(writeLas([st]));
  assert.equal(again.length, bytes.length, 'même taille');
  assert.ok(again.every((b, i) => b === bytes[i]), 'fichier .las identique à celui d’AutoCAD');
});

test('états de calques : DXF et DWG d’AutoCAD relus, aller-retour DXF de l’appli', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const las = parseLas(decodeLas(new Uint8Array(await (await fetch('./fixtures/etats-calques-autocad.las')).arrayBuffer())))[0];
  const norm = (st) => JSON.stringify({ ...st, layers: [...st.layers].sort((a, b) => a.name.localeCompare(b.name)) });
  for (const f of ['etats-calques-autocad.dxf', 'etats-calques-autocad.dwg']) {
    const doc = importDatabase(await readDrawing(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f)).doc;
    const st = findLayerState(doc, 'Complet');
    assert.ok(st, `${f} : état lu`);
    assert.equal(norm(st), norm(las), `${f} : même contenu que le .las d’AutoCAD`);
  }
  // Aller-retour de l'appli.
  const doc = sample();
  doc.addLayer('ÉLEC', { color: 30, rgb: 0x123456 });
  doc.transaction('x', () => doc.setLayer('GAINES', { ltype: 'DASHED', frozen: true, locked: true }));
  saveLayerState(doc, 'Phase A', { desc: 'Description accentuée : été' });
  doc.transaction('x', () => doc.setLayer('TEXTES', { on: false, plot: false }));
  saveLayerState(doc, 'Phase B', { mask: MASK.on | MASK.color });
  const text = writeDxf(doc);
  assert.ok(text.includes('ACAD_LAYERSTATES'));
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.equal(back.layerStates.size, 2);
  for (const name of ['Phase A', 'Phase B']) {
    const a = findLayerState(doc, name), b = findLayerState(back, name);
    assert.ok(b, `${name} relu`);
    assert.equal(b.desc, a.desc);
    assert.equal(b.mask, a.mask);
    assert.equal(b.current, a.current);
    const pick = (s) => [...s.layers].map(({ name: n, on, frozen, locked, plot, color, rgb, ltype, lweight }) => ({ n, on, frozen, locked, plot, color, rgb, ltype: ltype.toUpperCase(), lweight })).sort((x, y) => x.n.localeCompare(y.n));
    assert.deepEqual(pick(b), pick(a), `${name} : calques identiques`);
  }
  // Les états enregistrés depuis un DXF sont restaurables tels quels.
  back.transaction('x', () => back.setLayer('GAINES', { frozen: false }));
  applyLayerState(back, 'Phase A');
  assert.equal(back.layers.get('GAINES').frozen, true);
  assert.ok(captureState(back, 'x').layers.length >= 5);
});
