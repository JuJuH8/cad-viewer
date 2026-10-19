// SPDX-License-Identifier: GPL-3.0-or-later
// Tests de la lecture des blocs dynamiques d'AutoCAD : visibilité (états, objets cachés, état des insertions),
// paramètres linéaire / point / rotation / inversion et leurs actions (bloc d'essai BOITIER_TEST créé dans AutoCAD,
// insertions modifiées dans AutoCAD), modifications dans l'appli comparées à celles d'AutoCAD, poignées, tables de
// consultation, éléments non gérés, aller-retour DXF de l'appli, objets invisibles (code 60), nom effectif.
import { test, assert } from './harness.js';
import { applyAcadDynamic, effectiveName, buildAcadDyn, sameGeometry } from '../src/blocks/acad-dynamic.js';
import { blockForInsert, withValue, evaluate, valueOf, dynGrips, valueFromPoint, pointPosition } from '../src/blocks/dynamic.js';
import { scanInvisible } from '../src/dxf-adapter.js';

const types = (doc, e) => blockForInsert(doc, e).entities.map((x) => x.type).join(',');

async function load(name) {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  return importDatabase(await readDrawing(await (await fetch(`./fixtures/${name}`)).arrayBuffer(), name)).doc;
}

test('blocs dynamiques d’AutoCAD : visibilité relue (DXF et DWG), états des insertions, changement d’état', async () => {
  for (const f of ['bloc-dyn-visibilite-autocad.dxf', 'bloc-dyn-visibilite-autocad.dwg']) {
    const doc = await load(f);
    const b = doc.blocks.get('VANNE_TEST');
    const p = b?.dyn?.params?.[0];
    assert.ok(p, `${f} : paramètre de visibilité`);
    assert.equal(p.name, 'Visibilité1');
    assert.deepEqual(p.states, ['EtatVisibilité0', 'Rond', 'Carre']);
    assert.equal(p.def, 'EtatVisibilité0');
    const ins = [...doc.entities.values()].filter((e) => e.type === 'INSERT');
    assert.equal(ins.length, 2);
    assert.ok(ins.every((e) => e.name === 'VANNE_TEST'), `${f} : insertions rattachées au bloc dynamique`);
    assert.deepEqual([...doc.blocks.keys()], ['VANNE_TEST'], `${f} : représentation anonyme retirée`);
    const [a, c] = ins.sort((x, y) => x.p[0] - y.p[0]);
    assert.equal(types(doc, a), 'LINE,CIRCLE,LWPOLYLINE', `${f} : état par défaut`);
    assert.equal(types(doc, c), 'LINE,LWPOLYLINE', `${f} : état « Carre »`);
    const r = withValue(doc, c, p.id, 'Rond');
    assert.equal(types(doc, r), 'LINE,CIRCLE', `${f} : état « Rond »`);
  }
});

test('blocs dynamiques d’AutoCAD : aller-retour DXF de l’appli, objets invisibles, nom effectif', async () => {
  const doc = await load('bloc-dyn-visibilite-autocad.dxf');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const ins = [...back.entities.values()].filter((e) => e.type === 'INSERT').sort((x, y) => x.p[0] - y.p[0]);
  assert.equal(ins[1].name, 'VANNE_TEST');
  assert.equal(Object.values(ins[1].dyn)[0], 'Carre', 'état gardé');
  assert.equal(types(back, ins[1]), 'LINE,LWPOLYLINE');
  // Objets invisibles du DXF d'AutoCAD : le cercle caché de la représentation *U3.
  const text = new TextDecoder('latin1').decode(await (await fetch('./fixtures/bloc-dyn-visibilite-autocad.dxf')).arrayBuffer());
  assert.ok(scanInvisible(text).size >= 1, 'objets invisibles relus');
  // Bloc dynamique avec un paramètre non géré (linéaire modifié) : la représentation est gardée, nom effectif affiché.
  const blocks = new Map([
    ['PORTE', { name: 'PORTE', entities: [{ type: 'LINE', handle: 'A1', p1: [0, 0, 0], p2: [1, 0, 0] }, { type: 'LINE', handle: 'A2', p1: [0, 0, 0], p2: [0, 1, 0], defHidden: true }] }],
    ['*U5', { name: '*U5', entities: [{ type: 'LINE', p1: [0, 0, 0], p2: [2, 0, 0] }] }],
  ]);
  const ents = [{ type: 'INSERT', name: '*U5', handle: 'B1', p: [0, 0, 0] }, { type: 'INSERT', name: 'PORTE', handle: 'B2', p: [5, 0, 0] }];
  const info = {
    defs: new Map([['10', { name: 'PORTE', params: [{ kind: 'visibility', id: 3, name: 'Vis', pt: [0, 0], current: 0, all: ['A1', 'A2'], states: [{ name: 'Simple', ents: ['A1'] }, { name: 'Double', ents: ['A1', 'A2'] }] }], other: [{ type: 'BLOCKLINEARPARAMETER', id: 7, pt: [0, 0] }], points: [[0, 0]] }]]),
    reps: new Map([['*U5', '10']]),
    inserts: new Map([['B1', { dyn: '10', values: new Map([[3, { str: 'Double' }], [7, { num: 2 }]]) }]]),
  };
  const unused = applyAcadDynamic(blocks, ents, info);
  assert.equal(ents[0].name, '*U5', 'représentation gardée (paramètre linéaire modifié)');
  assert.equal(effectiveName(ents[0]), 'PORTE');
  assert.equal(ents[1].name, 'PORTE');
  assert.deepEqual(ents[1].dyn, { acv3: 'Simple' }, 'insertion de la définition : état par défaut');
  assert.deepEqual(unused, []);
});

const inserts = (doc) => [...doc.entities.values()].filter((e) => e.type === 'INSERT').sort((a, b) => a.p[0] - b.p[0]);
const param = (doc, name) => doc.blocks.get('BOITIER_TEST').dyn.params.find((p) => p.name === name);
const FLIP = "Etat d'inversion1";

test('blocs dynamiques d’AutoCAD : linéaire, point, rotation, inversion et leurs actions (DXF et DWG)', async () => {
  for (const f of ['bloc-dyn-actions-autocad.dxf', 'bloc-dyn-actions-autocad.dwg']) {
    const doc = await load(f);
    const dyn = doc.blocks.get('BOITIER_TEST')?.dyn;
    assert.equal(dyn?.acad, 2, `${f} : bloc converti avec ses actions`);
    assert.deepEqual(dyn.params.map((p) => p.type).sort(), ['flip', 'linear', 'point', 'rotation']);
    assert.deepEqual(dyn.actions.map((a) => a.type).sort(), ['flip', 'move', 'rotate', 'stretch']);
    // Les actions transforment aussi les paramètres de leur jeu de sélection.
    const rot = dyn.actions.find((a) => a.type === 'rotate');
    assert.ok(rot.params.includes(param(doc, 'Distance1').id), `${f} : la rotation emporte le paramètre linéaire`);
    // Les 4 insertions (dont 3 modifiées dans AutoCAD) rattachées : géométrie identique à celle d'AutoCAD.
    const ins = inserts(doc);
    assert.equal(ins.length, 4);
    assert.ok(ins.every((e) => e.name === 'BOITIER_TEST' && !e.effName), `${f} : insertions rattachées`);
    assert.deepEqual([...doc.blocks.keys()], ['BOITIER_TEST'], `${f} : représentations *U retirées`);
    const [, i2, i3, i4] = ins;
    assert.near(valueOf(param(doc, 'Distance1'), i2.dyn), 60, 1e-6);
    assert.near(valueOf(param(doc, 'Angle1'), i2.dyn), 0.5, 1e-6);
    assert.equal(valueOf(param(doc, FLIP), i2.dyn), 1);
    assert.near(valueOf(param(doc, 'Distance1'), i3.dyn), 25, 1e-6);
    assert.near(valueOf(param(doc, 'Angle1'), i3.dyn), 1.5, 1e-6);
    // Position du point comme dans AutoCAD (« Position1 X / Y » relus dans AutoCAD).
    assert.point(pointPosition(doc, i3, param(doc, 'Position1')), [27.9471, -34.1478], 1e-3);
    assert.near(valueOf(param(doc, 'Distance1'), i4.dyn), 70, 1e-6);
  }
});

test('blocs dynamiques d’AutoCAD : modifications dans l’appli identiques à celles faites dans AutoCAD', async () => {
  const doc = await load('bloc-dyn-actions-autocad.dxf');
  const ref = await load('bloc-dyn-actions-autocad-modifie.dxf'); // mêmes insertions modifiées dans AutoCAD
  const [i1, , , i4] = inserts(doc);
  let e1 = withValue(doc, i1, param(doc, 'Distance1').id, 55);
  e1 = withValue(doc, e1, param(doc, 'Angle1').id, Math.PI / 6);
  e1 = withValue(doc, e1, param(doc, FLIP).id, 1);
  const p = param(doc, 'Position1');
  const e4 = withValue(doc, i4, p.id, valueFromPoint(doc, i4, p.id, [326, 21]));
  const [r1, , , r4] = inserts(ref);
  assert.ok(!r1.effName && !r4.effName, 'insertions modifiées dans AutoCAD rattachées');
  const B = doc.blocks.get('BOITIER_TEST'), RB = ref.blocks.get('BOITIER_TEST');
  assert.ok(sameGeometry(evaluate(B, e1.dyn), evaluate(RB, r1.dyn)), 'longueur, angle, inversion');
  assert.ok(sameGeometry(evaluate(B, e4.dyn), evaluate(RB, r4.dyn)), 'point déplacé');
  assert.point(pointPosition(doc, e1, p), [12.5, -38.9904], 1e-3);
  // L'attribut suit l'étiquette déplacée et inversée (texte gardé lisible, comme AutoCAD).
  assert.point(e1.attribs[0].p, r1.attribs[0].p, 0.05);
  // Une petite variation d'un paramètre est bien détectée par la comparaison.
  assert.ok(!sameGeometry(evaluate(B, { ...e1.dyn, [param(doc, 'Angle1').id]: Math.PI / 6 + 1e-3 }), evaluate(RB, r1.dyn)));
});

test('blocs dynamiques d’AutoCAD : poignées et aller-retour DXF de l’appli', async () => {
  const doc = await load('bloc-dyn-actions-autocad.dxf');
  const ins = inserts(doc);
  for (const e of ins) {
    const grips = dynGrips(doc, e);
    assert.equal(grips.length, 4);
    // Une poignée laissée à sa place ne change pas la valeur.
    for (const g of grips.filter((x) => !x.click)) {
      const q = doc.blocks.get('BOITIER_TEST').dyn.params.find((x) => x.id === g.param);
      const v = valueFromPoint(doc, e, g.param, g.p), w = valueOf(q, e.dyn);
      if (Array.isArray(w)) assert.point(v, w, 1e-6); else assert.near(v, w, 1e-6);
    }
    // Poignée linéaire avancée de 10 dans sa direction : longueur + 10.
    const gl = grips.find((g) => g.shape === 'arrow');
    const q = [gl.p[0] + 10 * Math.cos(gl.dir), gl.p[1] + 10 * Math.sin(gl.dir)];
    assert.near(valueFromPoint(doc, e, gl.param, q), valueOf(param(doc, 'Distance1'), e.dyn) + 10, 1e-6);
  }
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  assert.equal(back.blocks.get('BOITIER_TEST')?.dyn?.acad, 2, 'bloc relu avec ses actions');
  const again = inserts(back);
  ins.forEach((e, i) => assert.ok(sameGeometry(evaluate(back.blocks.get('BOITIER_TEST'), again[i].dyn), evaluate(doc.blocks.get('BOITIER_TEST'), e.dyn)), `insertion ${i + 1}`));
});

test('blocs dynamiques d’AutoCAD : table de consultation, éléments non gérés', () => {
  // Bloc : un trait mis à l'échelle par un paramètre linéaire, une table de consultation « x1 / x2 ».
  const keysOf = new Map([['L1', [1]]]);
  const nodes = [
    { kind: 'linear', param: true, id: 1, type: 'BLOCKLINEARPARAMETER', name: 'Taille', base: [0, 0], end: [10, 0], pt: [0, 0], vset: { flags: 0 } },
    { kind: 'lookup', param: true, id: 2, type: 'BLOCKLOOKUPPARAMETER', name: 'Echelle', pt: [0, 5], action: 4 },
    { kind: 'action', action: 'scale', id: 3, type: 'BLOCKSCALEACTION', params: [2], sel: ['L1'], conns: [[1, 'UpdatedBaseX'], [1, 'UpdatedBaseY'], [1, 'Scale']], dependent: true, offset: [0, 0], basePt: [0, 0] },
    {
      kind: 'action', action: 'lookup', id: 4, type: 'BLOCKLOOKUPACTION', params: [], sel: [], conns: [],
      table: { rows: 2, cols: 2, values: ['10', 'x1', '20', 'x2'], columns: [{ node: 1, conn: 'UpdatedDistance', lookup: false }, { node: 2, conn: 'lookupString', lookup: true, reverse: true }] },
    },
  ];
  const dyn = buildAcadDyn({ name: 'ECH', params: [], nodes }, keysOf, new Set(['L1']));
  const lk = dyn.params.find((p) => p.type === 'lookup');
  assert.deepEqual(lk.rows, [{ label: 'x1', values: { ac1: 10 } }, { label: 'x2', values: { ac1: 20 } }]);
  const block = { name: 'ECH', base: [0, 0], entities: [{ type: 'LINE', k: 1, handle: 'L1', p1: [0, 0, 0], p2: [10, 0, 0] }], dyn };
  const doc = { blocks: new Map([['ECH', block]]) };
  const e = withValue(doc, { type: 'INSERT', name: 'ECH', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, dyn: {} }, lk.id, 'x2');
  assert.equal(e.dyn.ac1, 20, 'la ligne de la table règle le paramètre linéaire');
  assert.point(evaluate(block, e.dyn)[0].p2, [20, 0], 1e-9, 'échelle ×2');
  // Élément non géré (paramètre polaire) : actions non converties (seule la visibilité le serait).
  const polar = { kind: 'other', param: true, id: 9, type: 'BLOCKPOLARPARAMETER' };
  assert.equal(buildAcadDyn({ name: 'P', params: [], nodes: [...nodes, polar] }, keysOf, new Set()), null);
});
