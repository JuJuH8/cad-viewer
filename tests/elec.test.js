// SPDX-License-Identifier: GPL-3.0-or-later
// Tests électricité : calculs NIBT, symboles, tableaux et circuits, schéma unifilaire, légende,
// enregistrement DXF, commandes (pose, tableau, circuit).
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { izOf, tempFactor, groupFactor, ratingFor, voltageDrop, maxLength, sizeCircuit, sizeBoard } from '../src/elec/nibt.js';
import { SYMBOLS, CATEGORIES, ATTRS, ensureSymbolBlock, symbolInsert, refreshAttribs, blockNameOf } from '../src/elec/symbols.js';
import { boards, devices, nextCircuitId, nextBoardName, estimateLength, computeInstallation, assignCircuit, setCircuit, boardCircuits } from '../src/elec/circuits.js';
import { singleLineEntities, legendEntities } from '../src/elec/schema.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { registerElecCommands } from '../src/elec/commands.js';

test('NIBT : courants admissibles et facteurs de correction (CEI 60364-5-52)', () => {
  assert.equal(izOf(1.5, 'B2', 2), 16.5);
  assert.equal(izOf(2.5, 'C', 3), 24);
  assert.equal(izOf(10, 'E', 2), 70);
  assert.equal(tempFactor(40), 0.87);
  assert.equal(tempFactor(32), 0.94, 'température arrondie au palier supérieur');
  assert.equal(groupFactor(3, 'B2'), 0.7);
  assert.equal(groupFactor(10, 'B2'), 0.5);
  assert.equal(groupFactor(3, 'E'), 0.82, 'chemin de câbles perforé');
  assert.near(izOf(1.5, 'B2', 2, { ambient: 40, group: 3 }), 16.5 * 0.87 * 0.7, 1e-9);
  assert.equal(ratingFor(8.7, 10), 10);
  assert.equal(ratingFor(10.2), 13);
  assert.equal(ratingFor(70), 80);
});

test('NIBT : chute de tension et longueur protégée', () => {
  // 2 kW monophasé, cos φ 1, 30 m en 1,5 mm² : 2 × 30 × 8,7 × 0,0225 / 1,5 / 230 = 3,40 %
  assert.near(voltageDrop({ ib: 2000 / 230, len: 30, s: 1.5, ph: 1, cosphi: 1 }), 3.4026, 1e-3);
  // Triphasé : √3 × L × Ib × (ρ/S cos φ + λ sin φ) / 400
  const tri = voltageDrop({ ib: 16, len: 50, s: 2.5, ph: 3, cosphi: 0.85 });
  assert.near(tri, (Math.sqrt(3) * 50 * 16 * ((0.0225 / 2.5) * 0.85 + 0.00008 * Math.sqrt(1 - 0.85 ** 2)) * 100) / 400, 1e-9);
  assert.near(maxLength({ s: 1.5, rating: 13, curve: 'B' }), 94.36, 0.01);
  assert.near(maxLength({ s: 1.5, rating: 13, curve: 'C' }), 47.18, 0.01);
});

test('NIBT : dimensionnement des circuits (protection, section, DDR, imposés)', () => {
  const lum = sizeCircuit({ type: 'LUMIERE', p: 10 * 40, len: 20 });
  assert.equal(lum.rating, 10);
  assert.equal(lum.s, 1.5);
  assert.equal(lum.cable, '3×1,5 mm²');
  assert.ok(lum.ok && !lum.rcd);
  const pr = sizeCircuit({ type: 'PRISES', p: 8 * 300, n: 16, len: 25 });
  assert.near(pr.ks, 0.1 + 0.9 / 16, 1e-12, 'simultanéité des prises');
  assert.equal(pr.rating, 13, 'prises T13 : 13 A au minimum');
  assert.ok(pr.rcd && pr.protection.includes('DDR 30 mA'));
  // Circuit long : section augmentée pour la chute de tension (≤ 4 % avec 1 % en amont).
  const long = sizeCircuit({ type: 'FORCE', p: 3000, len: 60, upstream: 1 });
  assert.ok(long.s > 2.5, `section ${long.s}`);
  assert.ok(long.duTotal <= 4 + 1e-9);
  // Triphasé 7 kW (cuisinière) : Ib = 7000 / (√3 × 400 × 0,85)
  const k = sizeCircuit({ type: 'FORCE', p: 7000, ph: 3, len: 15 });
  assert.near(k.ib, 7000 / (Math.sqrt(3) * 400 * 0.85), 1e-9);
  assert.equal(k.rating, 13);
  assert.equal(k.cable, '5×1,5 mm²');
  // Valeurs imposées non conformes : signalées.
  const bad = sizeCircuit({ type: 'FORCE', p: 3600, rating: 10, s: 1.5, len: 120, curve: 'C' });
  assert.ok(!bad.ok);
  assert.ok(bad.warnings.some((w) => w.includes('supérieur à la protection')));
  assert.ok(bad.warnings.some((w) => w.includes('chute de tension')));
  assert.ok(bad.warnings.some((w) => w.includes('longueur protégée')));
  const board = sizeBoard([lum, pr, k], { ks: 0.8, len: 20 });
  assert.near(board.p, lum.pabs + pr.pabs + k.pabs, 1e-9);
  assert.equal(board.ph, 3);
});

test('symboles : blocs avec attributs, insertion sur le calque SIA de la catégorie', () => {
  const doc = new Document();
  for (const [k, s] of Object.entries(SYMBOLS)) {
    const ents = s.draw();
    assert.ok(ents.length, `${k} dessiné`);
    assert.ok(CATEGORIES[s.cat], `${k} : catégorie connue`);
    const nums = JSON.stringify(ents).match(/-?\d+(\.\d+)?|null|NaN/g) || [];
    assert.ok(!nums.includes('NaN') && !nums.includes('null'), `${k} : coordonnées valides`);
  }
  const name = ensureSymbolBlock(doc, 'PR2');
  assert.equal(name, blockNameOf('PR2'));
  assert.deepEqual(doc.blocks.get(name).entities.filter((e) => e.type === 'ATTDEF').map((e) => e.tag), ATTRS.map((a) => a.tag));
  const ins = doc.transaction('pose', () => doc.add(symbolInsert(doc, 'PR2', [1000, 2000], { size: 250, elec: { board: 'TD1', circuit: 'P3' } })));
  assert.equal(ins.layer, 'ELE-FORCE-APPAREILS');
  assert.equal(doc.layers.get(ins.layer).color, 10);
  assert.equal(ins.attribs[0].text, 'P3');
  assert.equal(ins.attribs[1].text, '300 W');
  assert.equal(ins.attribs[0].layer, 'ELE-FORCE-TEXTES');
  assert.equal(ins.sx, 250);
  const e = structuredClone(ins);
  e.elec.p = 2500;
  refreshAttribs(e);
  assert.equal(e.attribs[1].text, '2,5 kW');
  // L'aperçu ne crée pas de calque (aucune opération dans l'historique)
  const d2 = new Document();
  symbolInsert(d2, 'LUM', [0, 0], { preview: true });
  assert.ok(!d2.layers.has(CATEGORIES.LUMIERE.layer));
  assert.equal(d2.undoStack.length, 0);
});

// Petite installation : TP (origine) → TD1 ; lumière et prises sur TD1, chauffe-eau sur TP. Dessin en mm.
function installation() {
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('installation', () => {
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [], supplyLen: 15 } }));
    doc.add(symbolInsert(doc, 'TABLEAU', [20000, 0], { elec: { kind: 'board', board: 'TD1', parent: 'TP', circuits: [] } }));
    for (let i = 0; i < 6; i++) doc.add(symbolInsert(doc, 'LUM', [20000 + i * 2000, 5000], { elec: { board: 'TD1', circuit: 'L1' } }));
    for (let i = 0; i < 4; i++) doc.add(symbolInsert(doc, 'PR2', [20000 + i * 3000, -3000], { elec: { board: 'TD1', circuit: 'P1' } }));
    doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [0, 6000], { elec: { board: 'TP', circuit: 'F1' } }));
    doc.add(symbolInsert(doc, 'RJ45', [22000, -3000], {})); // courant faible : pas de circuit
  });
  return doc;
}

test('circuits : numérotation, longueurs estimées, arborescence et chutes de tension cumulées', () => {
  const doc = installation();
  assert.equal(boards(doc).length, 2);
  assert.equal(devices(doc).length, 12);
  assert.equal(nextBoardName(doc), 'TD2');
  assert.equal(nextCircuitId(doc, 'TD1', 'LUMIERE'), 'L2');
  assert.equal(nextCircuitId(doc, 'TD1', 'PRISES'), 'P2');
  assert.near(estimateLength([0, 0], [[10000, 5000]], 0.001), 15 * 1.15 + 3, 1e-9, 'trajet orthogonal + 15 % + 3 m');
  const circuitsTP = boardCircuits(doc, boards(doc).find((b) => b.elec.board === 'TP'));
  assert.deepEqual(circuitsTP.map((c) => [c.id, c.type]), [['F1', 'FORCE'], ['→TD1', 'TABLEAU']]);
  const inst = computeInstallation(doc, { unitM: 0.001 });
  const td1 = inst.get('TD1'), tp = inst.get('TP');
  const l1 = td1.circuits.find((c) => c.def.id === 'L1');
  assert.equal(l1.p, 240);
  assert.equal(l1.r.rating, 10);
  const p1 = td1.circuits.find((c) => c.def.id === 'P1');
  assert.equal(p1.n, 8, 'prises doubles : 2 prises chacune');
  assert.ok(p1.r.rcd);
  // Puissance du tableau secondaire remontée dans le circuit qui l'alimente.
  const feeder = tp.circuits.find((c) => c.def.sub === 'TD1');
  assert.near(feeder.p, td1.p, 1e-9);
  assert.near(td1.p, (l1.r.pabs + p1.r.pabs) * 0.8, 1e-9, 'simultanéité du tableau 0,8');
  // Chutes de tension cumulées : origine → TP (branchement 15 m) → TD1 → circuits.
  assert.ok(tp.supply.duTotal > 0);
  assert.near(td1.upstream, feeder.r.duTotal, 1e-12);
  assert.near(l1.r.duTotal, td1.upstream + l1.r.du, 1e-12);
  assert.ok(feeder.r.duTotal > tp.supply.duTotal);
});

test('circuits : rattachement et réglages imposés (annulables)', () => {
  const doc = installation();
  const lums = devices(doc).filter((d) => d.elec.sym === 'LUM').slice(0, 2).map((d) => d.id);
  doc.transaction('circuit', () => {
    assignCircuit(doc, lums, 'TD1', 'L2');
    setCircuit(doc, 'TD1', 'L2', { type: 'LUMIERE', label: 'Couloir', len: 40, s: 2.5 });
  });
  assert.equal(doc.get(lums[0]).elec.circuit, 'L2');
  assert.equal(doc.get(lums[0]).attribs[0].text, 'L2');
  const inst = computeInstallation(doc, { unitM: 0.001 });
  const l2 = inst.get('TD1').circuits.find((c) => c.def.id === 'L2');
  assert.equal(l2.len, 40, 'longueur imposée');
  assert.equal(l2.r.s, 2.5, 'section imposée');
  assert.equal(l2.def.label, 'Couloir');
  doc.undo();
  assert.equal(doc.get(lums[0]).elec.circuit, 'L1');
  assert.equal(computeInstallation(doc, { unitM: 0.001 }).get('TD1').circuits.some((c) => c.def.id === 'L2'), false);
});

test('schéma unifilaire et légende', () => {
  const doc = installation();
  const inst = computeInstallation(doc, { unitM: 0.001 });
  const s = singleLineEntities(inst.get('TD1'), { h: 125 });
  const texts = s.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.ok(texts.some((t) => t.startsWith('TABLEAU TD1')));
  assert.ok(texts.includes('L1') && texts.includes('P1'));
  assert.ok(texts.includes('B10') && texts.includes('B13'), 'protections des départs');
  assert.ok(texts.includes('30 mA'), 'DDR des prises');
  assert.ok(texts.some((t) => t.startsWith('Alimentation : 5×')));
  assert.ok(s.width > 0 && s.height > 0);
  const leg = legendEntities(doc, [...devices(doc), ...boards(doc)], { size: 250, h: 125 });
  const lt = leg.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.ok(lt.includes('Luminaire') && lt.includes('6'), 'luminaires comptés');
  assert.ok(lt.includes('Prise double T13') && lt.includes('4'));
  assert.ok(lt.includes('Prise informatique (RJ45)'));
  assert.ok(leg.entities.some((e) => e.type === 'INSERT' && e.name === blockNameOf('LUM')));
});

test('électricité : enregistrement DXF (données, attributs, réglages des circuits)', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const doc = installation();
  doc.transaction('r', () => setCircuit(doc, 'TD1', 'L1', { label: 'Bureaux é', method: 'C' }));
  const text = writeDxf(doc);
  await fetch('/__out/elec.dxf', { method: 'POST', body: text }).catch(() => {});
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'e.dxf')).doc;
  const bs = boards(back);
  assert.deepEqual(bs.map((b) => b.elec.board).sort(), ['TD1', 'TP']);
  const td1 = bs.find((b) => b.elec.board === 'TD1');
  assert.equal(td1.elec.parent, 'TP');
  assert.deepEqual(td1.elec.circuits.find((c) => c.id === 'L1'), { id: 'L1', label: 'Bureaux é', method: 'C' });
  const lum = devices(back).find((d) => d.elec.sym === 'LUM');
  assert.equal(lum.elec.circuit, 'L1');
  assert.equal(lum.attribs.find((a) => a.tag === 'CIRCUIT')?.text, 'L1', 'attribut relu');
  assert.ok(back.layers.has('ELE-LUMIERE-APPAREILS'));
  const inst = computeInstallation(back, { unitM: 0.001 });
  assert.equal(inst.get('TD1').circuits.find((c) => c.def.id === 'L1').r.method, 'C');
});

// Commandes, comme un utilisateur : tableau, pose de luminaires, circuit.
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const log = [];
const editor = new Editor(renderer, { print: (m) => log.push(m) });
registerCommands(editor);
const api = registerElecCommands(editor);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function type(...xs) { for (const x of xs) { editor.submit(x); await tick(); } }

test('commandes : TABLEAU, POSESYMBOLE, CIRCUIT', async () => {
  const doc = new Document();
  doc.header.insunits = 4;
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -5000, minY: -5000, maxX: 20000, maxY: 20000 });
  editor.settings.osnap = false;
  editor.run('TABLEAU');
  await tick();
  await type('', '0,0');
  assert.equal(boards(doc).length, 1);
  assert.equal(boards(doc)[0].elec.board, 'TP');
  api.state.key = 'LUM';
  api.state.board = 'TP';
  api.state.circuit = 'L1';
  editor.run('POSESYMBOLE');
  await tick();
  await type('2000,3000', '4000,3000', 'R', '90', '6000,3000', '');
  const lums = devices(doc);
  assert.equal(lums.length, 3);
  assert.ok(lums.every((d) => d.elec.board === 'TP' && d.elec.circuit === 'L1'));
  assert.near(lums[2].rot, Math.PI / 2, 1e-9, 'rotation');
  assert.equal(lums[0].sx, 250, 'taille : 5 mm au 1:50');
  editor.setSelection(lums.slice(0, 2).map((d) => d.id));
  editor.run('CIRCUIT');
  await tick();
  await type('L5');
  assert.equal(doc.get(lums[0].id).elec.circuit, 'L5');
  assert.equal(doc.get(lums[2].id).elec.circuit, 'L1');
  assert.equal(boards(doc)[0].elec.circuits.find((c) => c.id === 'L5')?.type, 'LUMIERE');
  editor.settings.osnap = true;
});

// --- bibliothèque DWG (palettes d'outils CADnorm ou autre) --------------------------------
const libraryModule = await import('../src/elec/library.js');

// Bibliothèque de test : blocs en cm avec étiquettes CADnorm (CN_*), comme le DWG de blocs d'une palette.
function testLibrary() {
  const { createLibrary } = libraryModule;
  const src = new Document();
  src.header.insunits = 5;
  src.ltypes = new Map([['CACHE', { name: 'CACHE', description: 'Caché', dashes: [6.35, -3.175] }]]);
  src.transaction('bibliothèque', () => {
    src.addLayer('EVI01--1E-(force-appareils)', { color: 10 });
    src.addLayer('EVI012--E-(tableaux-secondaires)', { color: 12 });
    src.addLayer('Z---------(cn_blocs_trames)', { color: 8 });
  });
  const att = (tag, y, invisible = false) => ({ type: 'ATTDEF', layer: '0', color: 0, p: [0, y, 0], h: invisible ? 5 : 12.5, rot: 0, text: '', tag, prompt: tag, align: 'center', valign: 'middle', wf: 1, invisible });
  const pl = (pts) => ({ type: 'LWPOLYLINE', layer: '0', color: 0, pts, bulges: pts.map(() => 0), closed: false, z: 0, width: 0 });
  const block = (name, entities) => src.blocks.set(name, { name, base: [0, 0, 0], flags: 2, xref: false, entities });
  block('cn_PR-T13x2', [pl([[0, 0], [0, 9.5]]), { type: 'ARC', layer: '0', color: 0, c: [0, 9.5, 0], r: 12, a0: 0, a1: Math.PI },
    { type: 'LINE', layer: '0', color: 0, ltype: 'CACHE', p1: [-12, 9.5, 0], p2: [12, 9.5, 0] },
    att('CN_LIB_SUP', 69), att('CN_LIB_INF', 51.5), att('CN_DESIGN', -15, true), att('CN_FOURN', -25, true)]);
  block('cn_TABLEAU-CFO', [{ type: 'HATCH', layer: 'Z---------(cn_blocs_trames)', color: 7, solid: true, pattern: 'SOLID', loops: [[[-40, 0], [40, 0], [40, 20], [-40, 20]]], lines: [], z: 0 },
    pl([[-40, 0], [40, 0], [40, 20], [-40, 20], [-40, 0]]), att('CN_TAB_NO', 10.8), att('CN_LIB_SUP', 56.5), att('CN_LIB_INF', 39)]);
  block('cn_LUM-FLUO-2x36W', [pl([[-60, -8], [60, -8], [60, 8], [-60, 8], [-60, -8]]), att('CN_LIB_SUP', 41.5), att('CN_LIB_INF', 24)]);
  block('cn_COND-T', [pl([[0, 0], [10, 10]])]);
  const tool = (name, layer) => ({ name, block: name, layer, scale: 1, source: 'Blocs.dwg' });
  const palettes = [
    { name: 'FORCE_Cn', tools: [tool('cn_TABLEAU-CFO', 'EVI012--E-(tableaux-secondaires)'), tool('cn_PR-T13x2', 'EVI01--1E-(force-appareils)'), tool('cn_COND-T', 'EVI01--1E-(force-appareils)'), tool('cn_INCONNU', 'EVI01--1E-(force-appareils)')] },
    { name: 'LUMIERE_Cn', tools: [tool('cn_LUM-FLUO-2x36W', 'EVI061--E-(lumiere-appareils)')] },
  ];
  return createLibrary({ folder: 'C:\\Bibliotheque', palettes, docs: [['Blocs.dwg', src]] });
}

test('bibliothèque : classement des outils (symbole équivalent, catégorie, puissance)', () => {
  const { classifyTool, categoryOfLayer, textLayerOf } = libraryModule;
  const c = (block, layer) => classifyTool({ name: block, block, layer });
  assert.deepEqual(c('cn_PR-T13x2', 'EVI01--1E-(force-appareils)'), { cat: 'FORCE', sym: 'PR2', p: 300, ph: 1, label: 'PR-T13x2' });
  assert.equal(c('cn_PR-T13x3_CDEE', 'EVI01--1E-(force-appareils)').sym, 'PR3');
  assert.equal(c('cn_PR-CEE-32A', 'EVI01--1E-(force-appareils)').sym, 'PR_FORCE');
  assert.equal(c('cn_LUM-FLUO-2x36W', 'EVI061--E-(lumiere-appareils)').p, 72, 'puissance lue dans le nom');
  assert.equal(c('cn_LUM-FLUO-1x14-24W-MUR', 'EVI061--E-(lumiere-appareils)').sym, 'LUM_MUR');
  assert.equal(c('cn_SPOT-LED-1C-ENC', 'EVI061--E-(lumiere-appareils)').sym, 'SPOT');
  assert.equal(c('cn_INT-SCH-3', 'EVI061-3E-(lumiere-commande)').sym, 'INT_VV');
  assert.equal(c('cn_TABLEAU-CFO', 'EVI02--1E-(secours-appareils)').cat, 'TABLEAUX', 'tableau de secours');
  assert.equal(c('cn_MOTEUR-ELE', 'EVI01--8E-(fenetres-appareils)').sym, 'STORE_MOT', 'fenêtre motorisée comme un store');
  assert.equal(c('cn_MOTEUR-ELE', 'EVI01--1E-(force-appareils)').sym, 'MOTEUR');
  assert.equal(c('cn_INT-PRISE-SCH-0', 'EVI061-3E-(lumiere-commande)').p, 200, 'interrupteur + prise : la prise compte');
  assert.equal(c('cn_DET-FUMEE', 'ESI151--E-(di-appareils)').sym, 'DF');
  assert.equal(c('cn_KNX-POUSS-SIMPLE', 'E-I56---E-(domotique-appareils)').sym, 'CFA_APP');
  assert.equal(c('cn_CENTRALE-ECL-SEC', 'EVI063--E-(ecl-sec-appareils)').p, 0, 'centrale : puissance à saisir');
  assert.ok(c('cn_COND-T', 'EVI01--1E-(force-appareils)').plain, 'conduite : bloc simple');
  assert.ok(c('cn_SIGN-EVAC-FEU-EXTINCTEUR', 'ESI152--E-(securite-appareils)').plain, 'signalétique : bloc simple');
  assert.ok(c('cn_CH-C-TRACE', 'E-I042--E-(ch-cables-trace)').plain);
  assert.equal(categoryOfLayer('EVI023-1E-(asi-appareils)'), 'FORCE');
  assert.equal(categoryOfLayer('ESI122--E-(horloges-appareils)'), 'CFA');
  assert.equal(categoryOfLayer('XYZ'), null);
  assert.equal(textLayerOf('EVI02--1E-(secours-appareils)', 'FORCE'), 'EVI02--1T-(secours-textes)');
  assert.equal(textLayerOf('EVI061--E-(lumiere-appareils)', 'LUMIERE'), 'EVI061--T-(lumiere-textes)');
  assert.equal(textLayerOf('EVI012--E-(tableaux-secondaires)', 'TABLEAUX'), 'EVI012--T-(tableaux-textes)');
});

test('bibliothèque : pose d’un bloc (copie du bloc, calques, échelle, attributs CADnorm), annulation', () => {
  const { libraryInsert, insertScale, blockSvg } = libraryModule;
  const lib = testLibrary();
  assert.equal(lib.count, 4, 'outil sans bloc écarté');
  const tool = lib.palettes[0].tools.find((t) => t.block === 'cn_PR-T13x2');
  const doc = new Document();
  doc.header.insunits = 4;
  const s = insertScale(doc, lib.docOf(tool), tool, { annoScale: 50, unitMm: 1 });
  assert.equal(s, 10, 'cm → mm au 1:50');
  assert.equal(insertScale(doc, lib.docOf(tool), tool, { annoScale: 100, unitMm: 1, factor: 1.5 }), 30);
  const prev = libraryInsert(doc, lib, tool, [1000, 2000], { scale: s, preview: true });
  assert.ok(doc.blocks.has('cn_PR-T13x2'), 'bloc copié pour l’aperçu');
  assert.ok(!doc.layers.has('EVI01--1E-(force-appareils)'), 'aperçu : aucun calque créé');
  assert.equal(prev.attribs.length, 4);
  let id;
  doc.transaction('pose', () => { id = doc.add(libraryInsert(doc, lib, tool, [1000, 2000], { scale: s, rot: Math.PI, elec: { board: 'TP', circuit: 'P3' } })).id; });
  const e = doc.get(id);
  assert.equal(e.layer, 'EVI01--1E-(force-appareils)');
  assert.equal(doc.layers.get('EVI01--1E-(force-appareils)').color, 10, 'propriétés du calque de la bibliothèque');
  assert.ok(doc.layers.has('EVI01--1T-(force-textes)'), 'calque des textes');
  assert.ok(doc.ltypes?.has('CACHE'), 'type de ligne du bloc copié');
  assert.deepEqual({ sym: e.elec.sym, cat: e.elec.cat, p: e.elec.p, block: e.elec.block, board: e.elec.board, circuit: e.elec.circuit },
    { sym: 'PR2', cat: 'FORCE', p: 300, block: 'cn_PR-T13x2', board: 'TP', circuit: 'P3' });
  const sup = e.attribs.find((a) => a.tag === 'CN_LIB_SUP');
  assert.equal(sup.text, 'P3');
  assert.equal(e.attribs.find((a) => a.tag === 'CN_LIB_INF').text, '300 W');
  assert.equal(sup.layer, 'EVI01--1T-(force-textes)');
  assert.near(sup.p[0], 1000, 1e-6);
  assert.near(sup.p[1], 2000 - 690, 1e-6, 'attribut tourné avec le bloc');
  assert.near(sup.rot, 0, 1e-9, 'texte jamais à l’envers');
  assert.near(sup.h, 125, 1e-9);
  assert.ok(e.attribs.find((a) => a.tag === 'CN_DESIGN').invisible, 'attribut invisible conservé');
  assert.ok(blockSvg(lib.docOf(tool), tool.block).includes('<path'), 'aperçu SVG');
  doc.undo();
  assert.ok(!doc.get(id) && !doc.layers.has('EVI01--1E-(force-appareils)') && !doc.layers.has('EVI01--1T-(force-textes)'), 'annulation complète');
});

test('bibliothèque : tableau et appareils dans le bilan, étiquettes, légende, DXF', async () => {
  const { libraryInsert } = libraryModule;
  const lib = testLibrary();
  const [tab, pr, cond] = lib.palettes[0].tools;
  const lum = lib.palettes[1].tools[0];
  const doc = new Document();
  doc.header.insunits = 4;
  const ids = [];
  doc.transaction('pose', () => {
    ids.push(doc.add(libraryInsert(doc, lib, tab, [0, 0], { scale: 10, elec: { kind: 'board', board: 'TD2', parent: '', circuits: [] } })).id);
    for (let i = 0; i < 3; i++) ids.push(doc.add(libraryInsert(doc, lib, pr, [2000 + i * 1500, 1000], { scale: 10, elec: { board: 'TD2', circuit: 'P1' } })).id);
    ids.push(doc.add(libraryInsert(doc, lib, lum, [2000, 4000], { scale: 10, elec: { board: 'TD2', circuit: 'L1' } })).id);
    ids.push(doc.add(libraryInsert(doc, lib, cond, [0, 3000], { scale: 10 })).id);
  });
  const board = doc.get(ids[0]);
  assert.equal(board.elec.kind, 'board');
  assert.equal(board.attribs.find((a) => a.tag === 'CN_TAB_NO').text, 'TD2', 'nom du tableau dans le symbole');
  assert.equal(board.attribs.find((a) => a.tag === 'CN_LIB_SUP').text, '');
  assert.ok(!doc.get(ids[5]).elec, 'conduite sans données électriques');
  const inst = computeInstallation(doc, { unitM: 0.001 }).get('TD2');
  const p1 = inst.circuits.find((c) => c.def.id === 'P1');
  assert.equal(p1.def.type, 'PRISES');
  assert.equal(p1.p, 900);
  assert.equal(p1.n, 6, '3 prises doubles = 6 prises');
  assert.ok(p1.r.rcd, 'DDR 30 mA sur le circuit de prises');
  assert.equal(inst.circuits.find((c) => c.def.id === 'L1').p, 72);
  doc.transaction('circuit', () => assignCircuit(doc, [ids[1]], 'TD2', 'P2'));
  assert.equal(doc.get(ids[1]).attribs.find((a) => a.tag === 'CN_LIB_SUP').text, 'P2', 'étiquette CADnorm mise à jour');
  assert.equal(doc.get(ids[1]).attribs.find((a) => a.tag === 'CN_FOURN').text, '', 'attribut non géré inchangé');
  const leg = legendEntities(doc, [...devices(doc), ...boards(doc)], { size: 250, h: 125 });
  const texts = leg.entities.filter((x) => x.type === 'TEXT').map((x) => x.text);
  assert.ok(texts.includes('PR-T13x2') && texts.includes('LUM-FLUO-2x36W') && texts.includes('TABLEAU-CFO'), 'libellés des blocs');
  assert.ok(leg.entities.some((x) => x.type === 'INSERT' && x.name === 'cn_PR-T13x2' && x.sx === 10), 'bloc d’origine à son échelle');
  // Enregistrement DXF et relecture.
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const text = writeDxf(doc);
  await fetch('/__out/elec-biblio.dxf', { method: 'POST', body: text }).catch(() => {});
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'b.dxf')).doc;
  assert.ok(back.blocks.has('cn_PR-T13x2') && back.blocks.has('cn_TABLEAU-CFO'));
  const bpr = devices(back).find((d) => d.elec.block === 'cn_PR-T13x2' && d.elec.circuit === 'P2');
  assert.ok(bpr, 'données électriques relues');
  assert.equal(bpr.attribs.find((a) => a.tag === 'CN_LIB_SUP')?.text, 'P2');
  assert.ok(bpr.attribs.find((a) => a.tag === 'CN_DESIGN')?.invisible, 'attribut invisible relu');
  assert.equal(boards(back)[0].elec.board, 'TD2');
});

test('commandes : POSEBIBLIO (tableau puis appareils de la bibliothèque)', async () => {
  const lib = testLibrary();
  const doc = new Document();
  doc.header.insunits = 4;
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -5000, minY: -5000, maxX: 20000, maxY: 20000 });
  editor.settings.osnap = false;
  api.useLibrary(lib);
  api.state.factor = 1;
  api.state.tool = { pal: 'FORCE_Cn', block: 'cn_TABLEAU-CFO', name: 'cn_TABLEAU-CFO' };
  editor.run('POSEBIBLIO');
  await tick();
  await type('', '0,0');
  assert.equal(boards(doc).length, 1);
  assert.equal(boards(doc)[0].elec.block, 'cn_TABLEAU-CFO');
  assert.equal(boards(doc)[0].sx, 10, 'échelle : cm → mm, 1:50');
  api.state.board = boards(doc)[0].elec.board;
  api.state.circuit = 'P1';
  api.state.tool = { pal: 'FORCE_Cn', block: 'cn_PR-T13x2', name: 'cn_PR-T13x2' };
  editor.run('POSEBIBLIO');
  await tick();
  await type('2000,1000', 'R', '90', '4000,1000', '');
  const devs = devices(doc);
  assert.equal(devs.length, 2);
  assert.ok(devs.every((d) => d.elec.block === 'cn_PR-T13x2' && d.elec.circuit === 'P1' && d.elec.board === api.state.board));
  assert.near(devs[1].rot, Math.PI / 2, 1e-9);
  editor.settings.osnap = true;
});

// Installation avec chemins de câbles CFO (altitude du dessous 2,90 m) : tableau TP en (0, 0), chemin principal
// (0,1000) → (20000,1000) → (20000,8000), chemin piqué sur sa paroi en x = 12000 vers le nord.
function routedInstallation() {
  const doc = new Document();
  doc.header.insunits = 4;
  const tray = (pts) => ({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-CFO', color: 256, pts, bulges: pts.map(() => 0), closed: false, z: 2900, width: 0,
    mep: { kind: 'tray', system: 'CFO', shape: 'rect', w: 300, h: 60, z: 2900, elbow: 'radius', maker: 'OBO', ri: 150 } });
  doc.transaction('installation', () => {
    doc.add(tray([[0, 1000], [20000, 1000], [20000, 8000]]));
    doc.add(tray([[12000, 1150], [12000, 9000]]));
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [] } }));
    for (const p of [[5000, 1500], [11000, 1500], [21000, 6000]]) doc.add(symbolInsert(doc, 'LUM', p, { elec: { board: 'TP', circuit: 'L1' } }));
    doc.add(symbolInsert(doc, 'LUM', [12500, 8000], { elec: { board: 'TP', circuit: 'L2' } }));
    doc.add(symbolInsert(doc, 'PR2', [8000, 500], { elec: { board: 'TP', circuit: 'P1' } }));
    doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [50000, 50000], { elec: { board: 'TP', circuit: 'F1' } })); // loin de tout chemin
  });
  return doc;
}

test('cheminement : longueurs par les chemins de câbles (plus court chemin, piquage, hauteurs, réserve)', () => {
  const doc = routedInstallation();
  const tp = computeInstallation(doc, { unitM: 0.001 }).get('TP');
  const c = (id) => tp.circuits.find((x) => x.def.id === id);
  // L1 : chemin de s = 0 à s = 25 m (coude compris) ; raccordements : tableau 1 m + |2,9 − 1,8| = 2,1 m,
  // luminaires 0,5 + 0,3 (deux fois) et 1 + 0,3 ; réserve 10 % + 0,5 m par extrémité (4).
  assert.equal(c('L1').lenSrc, 'chemins');
  assert.near(c('L1').route.trayLen, 25, 1e-9);
  assert.near(c('L1').route.accessLen, 2.1 + 0.8 + 0.8 + 1.3, 1e-9);
  assert.near(c('L1').len, 35, 1e-9);
  // L2 : par le piquage (12 m + 0,15 m jusqu'à l'axe du chemin principal + 6,85 m sur le chemin piqué).
  assert.near(c('L2').route.trayLen, 19, 1e-9);
  assert.near(c('L2').len, 25.1, 1e-9);
  assert.equal(c('L2').route.trays.size, 2, 'deux chemins empruntés');
  // P1 : prise à 0,30 m, descente de 2,60 m.
  assert.near(c('P1').len, 15.5, 1e-9);
  // F1 : appareil hors de portée des chemins → longueur estimée comme avant.
  assert.equal(c('F1').lenSrc, 'estimée');
  assert.near(c('F1').len, Math.round((100 * 1.15 + 3) * 10) / 10, 1e-9);
  // Longueur réelle utilisée pour la chute de tension.
  assert.near(c('L1').r.len, 35, 1e-9);
  // Remplissage : 3 câbles (L1, L2, P1) sur le chemin principal, 1 sur le chemin piqué.
  const inst = computeInstallation(doc, { unitM: 0.001 });
  const main = inst.fill.find((f) => f.tray.pts.length === 3);
  assert.deepEqual(main.cables.map((x) => x.circuit).sort(), ['L1', 'L2', 'P1']);
  assert.near(main.fill, (main.cables.reduce((s, x) => s + Math.PI * x.d * x.d / 4, 0) / (300 * 60)) * 100, 1e-9);
  assert.ok(main.ok);
  assert.equal(inst.fill.length, 2);
});

test('données électriques : valeurs modifiables (réserve, systèmes), annulation, enregistrement DXF', async () => {
  const { withElecValue, elecData } = await import('../src/elec/settings.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const doc = routedInstallation();
  const len = (d, id) => computeInstallation(d, { unitM: 0.001 }).get('TP').circuits.find((x) => x.def.id === id).len;
  doc.setHeader({ elecData: withElecValue(doc, 'routing', 'reservePct', '0') });
  assert.near(len(doc, 'L2'), 22.9, 1e-9, 'sans réserve de longueur');
  assert.equal(withElecValue(doc, 'routing', 'reservePct', 'abc'), undefined, 'saisie invalide refusée');
  doc.setHeader({ elecData: withElecValue(doc, 'network', 'duMax', '3,5') });
  assert.equal(elecData(doc).network.duMax, 3.5);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'e.dxf')).doc;
  assert.deepEqual(back.header.elecData, { routing: { reservePct: 0 }, network: { duMax: 3.5 } });
  assert.near(len(back, 'L2'), 22.9, 1e-9);
  // Valeur par défaut retapée : retirée des données enregistrées.
  doc.setHeader({ elecData: withElecValue(doc, 'routing', 'reservePct', '10') });
  assert.deepEqual(doc.header.elecData, { network: { duMax: 3.5 } });
  doc.undo();
  assert.equal(elecData(doc).routing.reservePct, 0, 'annulable');
  // Chemins d'un autre système ignorés : tout est estimé.
  doc.setHeader({ elecData: withElecValue(doc, 'routing', 'systems', 'CFA') });
  assert.equal(computeInstallation(doc, { unitM: 0.001 }).get('TP').circuits.find((x) => x.def.id === 'L1').lenSrc, 'estimée');
});

test('cheminement : commande CHEMINEMENT et onglets du bilan (chemins de câbles, données électriques)', async () => {
  const doc = routedInstallation();
  renderer.setDocument(doc);
  editor.setDocument(doc);
  log.length = 0;
  editor.run('CHEMINEMENT');
  await tick();
  const drawn = [...doc.entities.values()].filter((e) => e.wire);
  assert.ok(drawn.length >= 8, 'trajets et raccordements dessinés');
  assert.ok(drawn.every((e) => e.layer === 'ELE-FILS-NORMAL' && e.color === 256), 'réseau normal : calque des fils, couleur du calque');
  assert.ok(log.some((m) => /Fils de 3 départ\(s\).*1 départ\(s\) sans chemin/.test(m)), log.join(' | '));
  editor.run('CHEMINEMENT');
  await tick();
  assert.equal([...doc.entities.values()].filter((e) => e.wire).length, drawn.length, 'trajets remplacés, pas doublés');
  api.openBilan();
  const dlg = document.getElementById('elec-bilan');
  assert.ok(/CDC/.test(dlg.innerHTML), 'origine des longueurs affichée');
  assert.ok(/Court-circuit au jeu de barres/.test(dlg.innerHTML) && /Ik1 min \(A\)/.test(dlg.innerHTML), 'courants de court-circuit affichés');
  dlg.querySelector('[data-tab="chemins"]').click();
  assert.ok(/L1, |TP\.L1/.test(dlg.innerHTML) && /Remplissage/.test(dlg.innerHTML));
  dlg.querySelector('[data-tab="donnees"]').click();
  const input = dlg.querySelector('input[data-g="routing"][data-k="reserveEnd"]');
  input.value = '1';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(doc.header.elecData.routing.reserveEnd, 1);
  assert.ok(dlg.querySelector('input[data-k="reserveEnd"]').classList.contains('set'));
  dlg.querySelector('[data-tab="bilan"]').click();
  dlg.close();
});

test('cheminement : tubes noyés (dalle) reliés au chemin de câbles, remplissage des tubes, commande TUBE', async () => {
  const { conduitInner, wireDiameter } = await import('../src/elec/routing.js');
  const { findClashes } = await import('../src/mep/clash.js');
  const doc = routedInstallation();
  // Tube M20 en dalle (axe à 2,80 m) partant à 20 cm de l'axe du chemin principal (x = 3000) vers un luminaire.
  doc.transaction('tube', () => {
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-TUB-CFO', color: 256, pts: [[3000, 1200], [3000, 6000], [6000, 6000]], bulges: [0, 0, 0], closed: false, z: 2800, width: 0,
      mep: { kind: 'pipe', conduit: true, embed: 'dalle', system: 'TUB-CFO', shape: 'round', d: 20, z: 2800 } });
    doc.add(symbolInsert(doc, 'LUM', [6000, 6000], { elec: { board: 'TP', circuit: 'L3' } }));
  });
  const inst = computeInstallation(doc, { unitM: 0.001 });
  const l3 = inst.get('TP').circuits.find((x) => x.def.id === 'L3');
  // Chemin 3 m + raccord 0,2 m (+ 0,1 m de dénivelé) + tube 7,8 m + descente de 0,2 m au luminaire, au bout du tube.
  assert.equal(l3.lenSrc, 'chemins');
  assert.near(l3.route.trayLen, 3 + 0.3 + 7.8 + 0.2, 1e-9);
  assert.near(l3.len, 15.7, 1e-9);
  const tube = inst.fill.find((f) => f.conduit);
  assert.deepEqual(tube.cables.map((c) => [c.circuit, c.cores, c.wires]), [['L3', 3, true]]);
  assert.near(tube.fill, (3 * Math.PI * wireDiameter(l3.r.s) ** 2 / 4) / (Math.PI * conduitInner(20) ** 2 / 4) * 100, 1e-9);
  assert.equal(tube.max, 33);
  assert.ok(tube.ok);
  // Tube noyé : pas de conflit avec les réseaux.
  assert.equal(findClashes([...doc.entities.values()]).filter((c) => [c.a, c.b].some((id) => doc.get(id)?.mep?.conduit)).length, 0);
});

test('cheminement : un tube va d’un point A à un point B (boîtes de dérivation, boîte sur CDC), jamais emprunté en partie', async () => {
  const { SYMBOLS, CATEGORIES } = await import('../src/elec/symbols.js');
  const doc = routedInstallation();
  const tube = (pts, embed = 'dalle', z = 2800) => ({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-TUB-CFO', color: 256, pts, bulges: pts.map(() => 0), closed: false, z, width: 0,
    mep: { kind: 'pipe', conduit: true, embed, system: 'TUB-CFO', shape: 'round', d: 20, z } });
  let t1, t2, t3;
  doc.transaction('boîtes', () => {
    doc.add(symbolInsert(doc, 'BD_CDC', [15000, 1000]));            // sur le chemin principal (y = 1000)
    doc.add(symbolInsert(doc, 'BD_ENC', [15000, 5000]));            // boîte encastrée en dalle
    t1 = doc.add(tube([[15000, 1000], [15000, 5000]]));
    t2 = doc.add(tube([[15000, 5000], [17000, 5000]]));
    t3 = doc.add(tube([[15000, 5000], [15000, 7000]]));
    doc.add(symbolInsert(doc, 'LUM', [17000, 5000], { elec: { board: 'TP', circuit: 'L4' } }));
    doc.add(symbolInsert(doc, 'LUM', [15000, 7000], { elec: { board: 'TP', circuit: 'L4' } }));
    doc.add(symbolInsert(doc, 'LUM', [15200, 3000], { elec: { board: 'TP', circuit: 'L5' } })); // à 20 cm du milieu du tube t1
  });
  assert.equal(SYMBOLS.BD_CDC.cat, 'CHEMINEMENT');
  assert.ok(CATEGORIES.CHEMINEMENT && SYMBOLS.BD_ENC.node && SYMBOLS.BD_CDC.onTray);
  const tp = computeInstallation(doc, { unitM: 0.001 }).get('TP');
  const c = (id) => tp.circuits.find((x) => x.def.id === id);
  // L4 : chemin 15 m, boîte sur CDC (0,1 m de dénivelé chemin → tube), tube 4 m jusqu'à la boîte, puis 2 m + 2 m de tubes
  // jusqu'aux luminaires (0,2 m de descente chacun) ; raccordement du tableau au chemin 2,1 m.
  assert.equal(c('L4').lenSrc, 'chemins');
  assert.near(c('L4').route.trayLen, 15 + 0.1 + 4 + 2.2 + 2.2, 1e-9);
  assert.near(c('L4').route.accessLen, 2.1, 1e-9);
  assert.deepEqual([t1.id, t2.id, t3.id].map((id) => c('L4').route.trays.has(id)), [true, true, true]);
  // L5 : pas d'entrée au milieu du tube t1 : raccordé au chemin de câbles (2 m + 0,3 m).
  assert.ok(![t1.id, t2.id, t3.id].some((id) => c('L5').route.trays.has(id)));
  assert.near(c('L5').route.accessLen, 2.1 + 2.3, 1e-9);
  // Tube qui aboutit au milieu d'un autre tube : pas de piquage, le luminaire au bout n'est pas desservi par les tubes.
  doc.transaction('piquage', () => {
    doc.add(tube([[15000, 4000], [13500, 4000]]));
    doc.add(symbolInsert(doc, 'LUM', [13500, 4000], { elec: { board: 'TP', circuit: 'L6' } }));
  });
  const l6 = computeInstallation(doc, { unitM: 0.001 }).get('TP').circuits.find((x) => x.def.id === 'L6');
  assert.ok(![t1.id].some((id) => l6.route.trays.has(id)), 'pas de passage par le milieu de t1');
});

test('fils par alimentation (normal, secours, ASI) et étiquettes sur tout objet (ETIQCIRCUIT)', async () => {
  const doc = routedInstallation();
  doc.transaction('boîtes', () => {
    doc.add(symbolInsert(doc, 'BD_CDC', [15000, 1000]));
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-TUB-CFO', color: 256, pts: [[15000, 1000], [15000, 5000]], bulges: [0, 0], closed: false, z: 2800, width: 0,
      mep: { kind: 'pipe', conduit: true, embed: 'fauxplafond', system: 'TUB-CFO', shape: 'round', d: 20, z: 2800 } });
    doc.add(symbolInsert(doc, 'LUM', [15000, 5000], { elec: { board: 'TP', circuit: 'L4' } }));
    setCircuit(doc, 'TP', 'L4', { supply: 'ASI' });
    setCircuit(doc, 'TP', 'L2', { type: 'SECOURS' });
  });
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.run('CHEMINEMENT');
  await tick();
  const layers = (id) => new Set([...doc.entities.values()].filter((e) => e.wire?.circuit === id).map((e) => e.layer));
  assert.deepEqual([...layers('L1')], ['ELE-FILS-NORMAL']);
  assert.deepEqual([...layers('L2')], ['ELE-FILS-SECOURS'], 'éclairage de secours : secours');
  assert.deepEqual([...layers('L4')], ['ELE-FILS-ASI'], 'alimentation imposée au circuit');
  assert.equal(doc.layers.get('ELE-FILS-ASI').color, 5);
  // Étiquettes : sur la boîte sur CDC (circuit qui y passe), sur le luminaire, sur le tube, sur un fil.
  const box = [...doc.entities.values()].find((e) => e.elec?.sym === 'BD_CDC');
  const tube = [...doc.entities.values()].find((e) => e.mep?.conduit);
  const wire = [...doc.entities.values()].find((e) => e.wire?.circuit === 'L1');
  const lum = [...doc.entities.values()].find((e) => e.elec?.circuit === 'L4');
  for (const [target, p] of [[box, box.p], [lum, lum.p], [tube, [15000, 3000]], [wire, wire.pts[0]]]) {
    const before = doc.entities.size;
    editor.run('ETIQCIRCUIT');
    await tick();
    editor.answer({ id: target.id, p });
    await tick();
    editor.submit('20000,20000');
    await tick();
    editor.submit('');
    await tick();
    const added = [...doc.entities.values()].slice(before - doc.entities.size);
    const texts = added.filter((e) => e.type === 'TEXT').map((e) => e.text);
    if (target === wire) assert.ok(texts.includes('TP.L1'), texts.join(','));
    else assert.ok(texts.includes('TP.L4') && texts.some((t) => /mm²/.test(t)), `${target.type} : ${texts.join(',')} — ${log.slice(-4).join(' | ')}`);
    const ok = added.filter((e) => e.type === 'TEXT').every((e) => (texts.includes('TP.L1') ? e.layer === 'ELE-FILS-NORMAL' : e.layer === 'ELE-FILS-ASI'));
    assert.ok(ok, 'étiquette sur le calque de l’alimentation');
    assert.equal(new Set(added.map((e) => e.group)).size, 1, 'étiquette groupée');
  }
});

test('tubes : poses de la légende (noyé plafond, sol, mur, faux-plancher, faux-plafond, CDC) et types de ligne', async () => {
  const { EMBED_LABELS, conduitLtype } = await import('../src/mep/systems.js');
  assert.deepEqual(Object.keys(EMBED_LABELS), ['dalle', 'sol', 'mur', 'fauxplancher', 'fauxplafond', 'cdc', 'apparent']);
  assert.deepEqual(['dalle', 'sol', 'fauxplafond', 'fauxplancher', 'cdc'].map(conduitLtype), ['Continuous', 'DASHED', 'DASHDOT', 'DASHDOT', 'Continuous']);
});

test('court-circuit : Ik3 max au tableau, Ik1 min en bout de départ, contrôles (pouvoir de coupure, déclenchement)', async () => {
  const { withElecValue } = await import('../src/elec/settings.js');
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('i', () => {
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [] } }));
    doc.add(symbolInsert(doc, 'TABLEAU', [10000, 0], { elec: { kind: 'board', board: 'TD1', parent: 'TP', circuits: [] } }));
    doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [0, 6000], { elec: { board: 'TP', circuit: 'F1' } }));
    setCircuit(doc, 'TP', 'F1', { len: 20, s: 2.5, rating: 16, curve: 'C' });
    setCircuit(doc, 'TP', '→TD1', { len: 30 });
  });
  let inst = computeInstallation(doc, { unitM: 0.001 });
  const tp = inst.get('TP');
  // Raccordement : Ik3 10 kA, Ik1 1 kA (valeurs générales) ; branchement de longueur nulle → mêmes valeurs au tableau.
  assert.near(tp.ik3, 10000, 1e-6);
  assert.near(tp.ik1, 1000, 1e-6);
  // F1 : boucle = source (0,2185 Ω, X/R 10) + 2 × (0,027 × 20 / 2,5 Ω ; 0,08 mΩ/m × 20 m).
  const zl = 0.95 * 230 / 1000, rl = zl / Math.sqrt(101), xl = 10 * rl;
  const f1 = tp.circuits.find((c) => c.def.id === 'F1');
  assert.near(f1.sc.ik1, 0.95 * 230 / Math.hypot(rl + 2 * 0.027 * 20 / 2.5, xl + 2 * 0.00008 * 20), 1e-6);
  assert.near(f1.sc.ik1, 433.1, 0.1);
  assert.equal(f1.sc.ia, 160, 'C16 : 10 × In');
  assert.ok(!f1.r.warnings.some((w) => /Ik/.test(w)));
  // Tableau aval : Ik plus faibles qu'au tableau d'origine, calculés à travers son câble d'alimentation.
  const td1 = inst.get('TD1');
  assert.ok(td1.ik3 < tp.ik3 && td1.ik1 < tp.ik1);
  // Départ trop long : déclenchement non garanti.
  doc.transaction('l', () => setCircuit(doc, 'TP', 'F1', { len: 80 }));
  inst = computeInstallation(doc, { unitM: 0.001 });
  const long = inst.get('TP').circuits.find((c) => c.def.id === 'F1');
  assert.ok(long.r.warnings.some((w) => /^Ik1 min 12\d A < seuil de déclenchement 160 A \(C16\)/.test(w)), long.r.warnings.join(' | '));
  assert.equal(long.r.ok, false);
  // Ik3 au raccordement plus élevé que le pouvoir de coupure des disjoncteurs (10 kA).
  doc.setHeader({ elecData: withElecValue(doc, 'network', 'ik3', '15') });
  inst = computeInstallation(doc, { unitM: 0.001 });
  assert.near(inst.get('TP').ik3, 15000, 1e-6);
  assert.ok(inst.get('TP').circuits.every((c) => c.r.warnings.some((w) => /Ik3 15,0 kA au tableau > pouvoir de coupure 10 kA/.test(w))));
  // Schéma unifilaire : Ik du jeu de barres et Ik1 de chaque départ.
  const texts = singleLineEntities(inst.get('TP'), { h: 2.5 }).entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.ok(texts.some((t) => /Ik3 max 15,00 kA/.test(t)));
  assert.ok(texts.some((t) => /^Ik1 \d+ A$/.test(t)));
});

test('sélectivité : rapport des calibres, seuil magnétique de l’amont, fusible amont', async () => {
  const { selectivity } = await import('../src/elec/selectivity.js');
  const eq = { selRatio: 2, selRatioFuse: 1.6 };
  assert.equal(selectivity({ curve: 'C', rating: 40 }, { curve: 'B', rating: 13 }, 150, eq).kind, 'totale', 'Ik sous 5 × 40 A');
  const part = selectivity({ curve: 'C', rating: 40 }, { curve: 'B', rating: 13 }, 3000, eq);
  assert.deepEqual([part.kind, part.limit, part.text], ['partielle', 200, 'partielle jusqu’à 0,2 kA']);
  assert.equal(selectivity({ curve: 'C', rating: 40 }, { curve: 'B', rating: 32 }, 3000, eq).kind, 'non', 'rapport 1,25 < 2');
  assert.equal(selectivity({ curve: 'gG', rating: 63 }, { curve: 'B', rating: 32 }, 3000, eq).kind, 'totale', 'fusible : rapport 1,97 ≥ 1,6');
  // Dans l'installation : départs du tableau aval jugés par rapport au départ qui l'alimente.
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('i', () => {
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [] } }));
    doc.add(symbolInsert(doc, 'TABLEAU', [10000, 0], { elec: { kind: 'board', board: 'TD1', parent: 'TP', circuits: [] } }));
    doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [12000, 3000], { elec: { board: 'TD1', circuit: 'F1' } }));
    doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [12000, 6000], { elec: { board: 'TD1', circuit: 'F2' } }));
    setCircuit(doc, 'TP', '→TD1', { rating: 40, curve: 'C', len: 20 });
    setCircuit(doc, 'TD1', 'F1', { rating: 13 });
    setCircuit(doc, 'TD1', 'F2', { rating: 32 });
  });
  const td1 = computeInstallation(doc, { unitM: 0.001 }).get('TD1');
  const f = (id) => td1.circuits.find((c) => c.def.id === id);
  assert.equal(f('F1').sel.kind, 'partielle');
  assert.equal(f('F2').sel.kind, 'non');
  assert.ok(f('F2').r.warnings.some((w) => /sélectivité non assurée avec C40 en amont/.test(w)));
  assert.ok(!f('F1').r.warnings.some((w) => /sélectivité/.test(w)), 'partielle : information, pas une erreur');
  // Protection automatique de l'arrivée : au moins 2 × le plus fort calibre aval (départ C40 → 80 A).
  const tp = computeInstallation(doc, { unitM: 0.001 }).get('TP');
  assert.equal(tp.supply.rating, 80);
  assert.equal(tp.circuits.find((c) => c.def.sub === 'TD1').sel.kind !== 'non', true);
});

test('schémas unifilaires sur plusieurs pages A3 (cartouche, renvois), commande UNIFILAIRE Tous', async () => {
  const { singleLinePages } = await import('../src/elec/schema.js');
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('i', () => {
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [] } }));
    for (let i = 1; i <= 30; i++) doc.add(symbolInsert(doc, 'CHAUFFE_EAU', [i * 1000, 3000], { elec: { board: 'TP', circuit: `F${i}` } }));
  });
  const info = computeInstallation(doc, { unitM: 0.001 }).get('TP');
  const pages = singleLinePages(info, { h: 2.5, project: 'Essai', date: '17.10.2026' });
  assert.equal(pages.length, 3, '30 départs, 12 par page');
  assert.deepEqual([pages[0].width, pages[0].height], [420, 297], 'A3 paysage');
  const texts = pages.map((pg) => pg.entities.filter((e) => e.type === 'TEXT').map((e) => e.text));
  assert.ok(texts[0].includes('TABLEAU TP — page 1 / 3') && texts[0].includes('suite page 2 →'));
  assert.ok(texts[1].includes('← suite de la page 1') && texts[1].includes('suite page 3 →'));
  assert.ok(texts[2].includes('← suite de la page 2') && !texts[2].some((t) => /^suite page/.test(t)));
  assert.ok(texts[1].includes('2 / 3') && texts[1].includes('Essai') && texts[1].includes('17.10.2026'), 'cartouche');
  assert.equal(texts[0].filter((t) => /^F\d+$/.test(t)).length, 12);
  assert.equal(texts[2].filter((t) => /^F\d+$/.test(t)).length, 6);
  assert.ok(texts[0].some((t) => /^Alimentation/.test(t)) && !texts[1].some((t) => /^Alimentation/.test(t)), 'arrivée sur la première page');
  // Tout reste dans le cadre de la feuille.
  for (const pg of pages) for (const e of pg.entities) for (const q of e.type === 'LINE' ? [e.p1, e.p2] : e.type === 'TEXT' ? [e.p] : e.pts) {
    assert.ok(q[0] >= -1e-9 && q[0] <= 420 + 1e-9 && q[1] <= 1e-9 && q[1] >= -297 - 1e-9, `hors feuille : ${q}`);
  }
  // Commande : une présentation par page, A4 si le tableau tient sur une page, sinon A3 (18 départs par page).
  const { circuitsPerPage } = await import('../src/elec/schema.js');
  assert.deepEqual([circuitsPerPage('A4'), circuitsPerPage('A3')], [12, 18]);
  const d2 = installation();
  renderer.setDocument(d2);
  editor.setDocument(d2);
  log.length = 0;
  editor.run('UNIFILAIRE');
  await tick();
  await type('Tous');
  assert.ok(log.some((m) => /2 tableau\(x\), 2 présentation\(s\) 2 A4 paysage/.test(m)), log.join(' | '));
  const lay = d2.spaces.filter((s) => s.label.startsWith('Unifilaire '));
  assert.deepEqual(lay.map((s) => [s.plot.paper, s.plot.w, s.plot.h]), [['A4', 297, 210], ['A4', 297, 210]]);
  const onSheet = [...d2.entities.values()].filter((e) => e.space === lay[0].id);
  assert.ok(onSheet.length > 20 && onSheet.every((e) => e.layer === 'ELE-UNIFILAIRE'));
  for (const e of onSheet) for (const q of e.type === 'LINE' ? [e.p1, e.p2] : e.type === 'TEXT' ? [e.p] : e.pts) assert.ok(q[0] >= -1e-9 && q[0] <= 297 + 1e-9 && q[1] >= -1e-9 && q[1] <= 210 + 1e-9, `hors feuille A4 : ${q}`);
  // Refaite : même nombre de présentations, contenu remplacé.
  const n0 = d2.spaces.length, c0 = onSheet.length;
  editor.run('UNIFILAIRE');
  await tick();
  await type('Tous');
  assert.equal(d2.spaces.length, n0);
  assert.equal([...d2.entities.values()].filter((e) => e.space === lay[0].id).length, c0);
  // Gros tableau : pages A3.
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.run('UNIFILAIRE');
  await tick();
  const big = doc.spaces.filter((s) => s.label.startsWith('Unifilaire TP'));
  assert.deepEqual(big.map((s) => s.plot.paper), ['A3', 'A3'], '30 départs : 2 pages A3');
});
