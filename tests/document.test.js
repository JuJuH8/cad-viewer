// SPDX-License-Identifier: GPL-3.0-or-later
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';

const line = (x) => ({ type: 'LINE', p1: [x, 0, 0], p2: [x + 10, 0, 0] });

test('document : ajout, modification, suppression puis annuler / rétablir', () => {
  const doc = new Document();
  const a = doc.transaction('ligne', () => doc.add(line(0)));
  assert.equal(doc.entities.size, 1);
  assert.equal(a.layer, '0');
  doc.transaction('déplacer', () => doc.modify(a.id, (e) => { e.p1[0] += 5; e.p2[0] += 5; }));
  assert.equal(doc.get(a.id).p1[0], 5);
  doc.transaction('effacer', () => doc.remove(a.id));
  assert.equal(doc.entities.size, 0);

  assert.equal(doc.undo(), 'effacer');
  assert.equal(doc.get(a.id).p1[0], 5);
  assert.equal(doc.undo(), 'déplacer');
  assert.equal(doc.get(a.id).p1[0], 0);
  assert.equal(doc.undo(), 'ligne');
  assert.equal(doc.entities.size, 0);
  assert.equal(doc.undo(), null);

  doc.redo(); doc.redo();
  assert.equal(doc.get(a.id).p1[0], 5);
});

test('document : une transaction regroupe plusieurs opérations et émet un seul changement', () => {
  const doc = new Document();
  const events = [];
  doc.on((c) => events.push(c));
  doc.transaction('copie', () => { doc.add(line(0)); doc.add(line(20)); doc.add(line(40)); });
  assert.equal(events.length, 1);
  assert.equal(events[0].added.size, 3);
  doc.undo();
  assert.equal(doc.entities.size, 0);
  assert.equal(events.length, 2);
  assert.equal(events[1].removed.size, 3);
});

test('document : une erreur dans une transaction annule tout', () => {
  const doc = new Document();
  doc.transaction('base', () => doc.add(line(0)));
  assert.throws(() => doc.transaction('boum', () => { doc.add(line(1)); throw new Error('x'); }));
  assert.equal(doc.entities.size, 1);
  assert.equal(doc.undoStack.length, 1);
});

test('document : l’objet avant modification n’est pas altéré', () => {
  const doc = new Document();
  const a = doc.transaction('l', () => doc.add(line(0)));
  const before = doc.get(a.id);
  doc.transaction('m', () => doc.modify(a.id, (e) => { e.p1[0] = 99; }));
  assert.equal(before.p1[0], 0);
});

test('document : calques annulables, calque courant appliqué aux nouvelles entités', () => {
  const doc = new Document();
  doc.transaction('calque', () => doc.addLayer('CVC-SOUFFLAGE', { color: 5 }));
  doc.currentLayer = 'CVC-SOUFFLAGE';
  const e = doc.transaction('l', () => doc.add(line(0)));
  assert.equal(e.layer, 'CVC-SOUFFLAGE');
  doc.transaction('couleur', () => doc.setLayer('CVC-SOUFFLAGE', { color: 1 }));
  assert.equal(doc.layer('CVC-SOUFFLAGE').color, 1);
  doc.undo();
  assert.equal(doc.layer('CVC-SOUFFLAGE').color, 5);
});

test('document : renommer et supprimer des calques, avec annulation', () => {
  const doc = new Document();
  doc.transaction('c', () => { doc.addLayer('ANCIEN', { color: 3 }); doc.addLayer('VIDE'); });
  doc.blocks.set('B', { name: 'B', base: [0, 0, 0], entities: [{ type: 'LINE', layer: 'ANCIEN', p1: [0, 0, 0], p2: [1, 0, 0] }] });
  const e = doc.transaction('l', () => doc.add({ type: 'LINE', layer: 'ANCIEN', p1: [0, 0, 0], p2: [5, 0, 0] }));
  assert.ok(doc.renameLayer('ANCIEN', 'NOUVEAU'));
  assert.ok(!doc.layers.has('ANCIEN'));
  assert.equal(doc.layers.get('NOUVEAU').color, 3);
  assert.equal(doc.get(e.id).layer, 'NOUVEAU');
  assert.equal(doc.blocks.get('B').entities[0].layer, 'NOUVEAU', 'les blocs suivent aussi');
  assert.ok(!doc.renameLayer('NOUVEAU', 'VIDE'), 'nom déjà pris');
  doc.undo();
  assert.ok(doc.layers.has('ANCIEN') && !doc.layers.has('NOUVEAU'));
  assert.equal(doc.get(e.id).layer, 'ANCIEN');
  assert.ok(!doc.transaction('s', () => doc.deleteLayer('ANCIEN')), 'calque utilisé : non supprimé');
  assert.ok(doc.transaction('s', () => doc.deleteLayer('VIDE')));
  assert.ok(!doc.layers.has('VIDE'));
  doc.undo();
  assert.ok(doc.layers.has('VIDE'));
});

test('sauvegarde automatique : sérialisation complète et restauration', async () => {
  const { serialize, deserialize } = await import('../src/io/autosave.js');
  const doc = new Document();
  doc.transaction('c', () => doc.addLayer('MEP-CVC-SOUF', { color: 5 }));
  doc.ltypes = new Map([['DASHED', { name: 'DASHED', dashes: [300, -150] }]]);
  doc.blocks.set('B', { name: 'B', base: [0, 0, 0], entities: [line(0)] });
  doc.transaction('e', () => {
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-CVC-SOUF', pts: [[0, 0], [10, 0]], bulges: [0, 0], closed: false, z: 2700, mep: { kind: 'duct', system: 'SOUF', w: 400, h: 200, z: 2700 } });
    doc.add({ type: 'INSERT', name: 'B', p: [5, 5, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] });
  });
  const back = deserialize(JSON.parse(JSON.stringify(serialize(doc))));
  assert.equal(back.entities.size, 2);
  assert.equal([...back.entities.values()][0].mep.w, 400);
  assert.ok(back.blocks.has('B'));
  assert.equal(back.layers.get('MEP-CVC-SOUF').color, 5);
  assert.equal(back.ltypes.get('DASHED').dashes[0], 300);
  const e = back.transaction('n', () => back.add(line(9)));
  assert.ok(e.id > 2, 'les nouveaux identifiants ne réutilisent pas les anciens');
});

test('sauvegarde automatique : relecture d’un dessin de 300 000 objets (pas de débordement de pile)', async () => {
  const { serialize, deserialize } = await import('../src/io/autosave.js');
  const doc = new Document();
  const ents = [];
  for (let i = 0; i < 300000; i++) ents.push({ type: 'LINE', layer: '0', p1: [i, 0, 0], p2: [i, 1, 0] });
  doc.load(ents);
  const back = deserialize(structuredClone(serialize(doc)));
  assert.equal(back.entities.size, 300000);
  assert.equal(back.nextId, 300001);
});
