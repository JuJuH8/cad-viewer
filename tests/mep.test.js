// SPDX-License-Identifier: GPL-3.0-or-later
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { registerMepCommands, parseSection, quantities, quantitiesCsv } from '../src/mep/commands.js';
import { mepGeometry, mepLength, mepToEntities } from '../src/mep/geometry.js';
import { findClashes } from '../src/mep/clash.js';
import { Tessellator } from '../src/core/tessellate.js';
import { writeDxf } from '../src/io/dxf-writer.js';
import { readDrawing } from '../src/dwg-loader.js';
import { importDatabase } from '../src/io/importer.js';
import { transformEntity } from '../src/core/entities.js';
import * as G from '../src/core/geom.js';

const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-2000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const editor = new Editor(renderer, { print: () => {} });
registerCommands(editor);
registerMepCommands(editor);
const tick = () => new Promise((r) => setTimeout(r, 0));

function fresh() {
  const doc = new Document();
  doc.header.insunits = 4; // mm
  renderer.setDocument(doc);
  editor.setDocument(doc);
  return doc;
}
// Commandes de dessin de réseaux : en continu (tronçon suivant) jusqu'à deux fois Entrée — une Entrée de plus ici.
const DRAW = new Set(['GA', 'GAINE', 'DUCT', 'CA', 'CANA', 'CANALISATION', 'PIPE', 'TUYAU', 'TUBE', 'TUBEELEC', 'CONDUIT', 'CDC', 'CHEMINCABLE', 'TRAY', 'AJOUTSELECT']);
async function run(cmd, ...inputs) {
  editor.run(cmd);
  await tick();
  for (const x of inputs) { editor.submit(x); await tick(); }
  await tick();
  if (DRAW.has(cmd.toUpperCase()) && editor.running && inputs.at(-1) === '') { editor.submit(''); await tick(); await tick(); }
}

test('MEP : lecture des sections', () => {
  assert.deepEqual(parseSection('400x200'), { shape: 'rect', w: 400, h: 200 });
  assert.deepEqual(parseSection('600 × 300'), { shape: 'rect', w: 600, h: 300 });
  assert.deepEqual(parseSection('Ø250'), { shape: 'round', d: 250 });
  assert.deepEqual(parseSection('d160'), { shape: 'round', d: 160 });
  assert.equal(parseSection('abc'), null);
});

test('MEP : commande GAINE (soufflage 400×200) et rendu en double trait', async () => {
  const doc = fresh();
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '5000,0', '5000,3000', '');
  const [e] = [...doc.entities.values()];
  assert.equal(e.type, 'LWPOLYLINE');
  assert.equal(e.mep.kind, 'duct');
  assert.equal(e.mep.system, 'SOUF');
  assert.equal(e.mep.w, 400); assert.equal(e.mep.h, 200); assert.equal(e.mep.z, 2700);
  assert.equal(e.layer, 'MEP-CVC-SOUF');
  assert.equal(doc.layers.get('MEP-CVC-SOUF').color, 5);
  // Coude à rayon (par défaut) : 2 bords (avec un arc chacun) + 2 extrémités.
  const g = mepGeometry(e);
  assert.equal(g.lines.length, 4);
  const left = g.lines[0].entity;
  assert.point(left.pts[0], [0, 200], 1e-9);
  assert.ok(left.bulges.some((b) => Math.abs(b) > 1e-9), 'le bord intérieur contient un arc');
  // Arc intérieur : rayon d'axe 400 − demi-largeur 200 = 200, centré en (4600, 400).
  const i = left.bulges.findIndex((b) => Math.abs(b) > 1e-9);
  assert.point(left.pts[i], [4600, 200], 1e-9);
  assert.point(left.pts[i + 1], [4800, 400], 1e-9);
  assert.equal(g.labels[0].text, '400×200');
  assert.near(mepLength(e), 8000, 1e-9, 'longueur mesurée sur l’axe, de sommet à sommet');
  // Coude en onglet sur demande : 2 bords + 2 extrémités + 1 arête de coude.
  const miter = mepGeometry({ ...e, mep: { ...e.mep, elbow: 'miter' } });
  assert.equal(miter.lines.length, 5);
  assert.point(miter.lines[0].entity.pts[1], [4800, 200], 1e-9);
});

test('MEP : CANALISATION et CHEMINCABLE, métré en mètres et CSV', async () => {
  const doc = fresh();
  await run('CA', 'EF', '32', '2500', '0,0', '10000,0', '');
  await run('CA', 'EF', '32', '2500', '0,1000', '2500,1000', '');
  await run('CA', 'ECS', '25', '2500', '0,2000', '4000,2000', '4000,6000', '');
  await run('CDC', 'CFO', '300x60', '2900', '0,5000', '12000,5000', '');
  const rows = quantities(doc);
  const ef = rows.find((r) => r.system === 'EF');
  assert.near(ef.length, 12.5, 1e-9);
  assert.equal(ef.section, 'Ø32');
  assert.equal(ef.runs, 2);
  const ecs = rows.find((r) => r.system === 'ECS');
  assert.near(ecs.length, 8, 1e-9);
  assert.equal(ecs.elbows, 1);
  const cdc = rows.find((r) => r.system === 'CFO');
  assert.equal(cdc.section, 'CDC 300×60');
  assert.equal(cdc.type, 'Chemin de câbles');
  const csv = quantitiesCsv(rows);
  assert.ok(csv.startsWith('﻿"Domaine";"Système"'), 'CSV avec BOM et point-virgule (Excel français)');
  assert.ok(csv.includes('"12,50"'), 'longueur au format décimal français');
});

test('MEP : déplacer / tourner une gaine conserve ses paramètres', () => {
  const e = { type: 'LWPOLYLINE', layer: 'MEP-CVC-SOUF', pts: [[0, 0], [1000, 0]], bulges: [0, 0], closed: false, z: 2700, mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  const r = transformEntity(e, G.rotation(Math.PI / 2, 0, 0));
  assert.equal(r.mep.w, 400);
  assert.point(r.pts[1], [0, 1000], 1e-9);
  const g = mepGeometry(r);
  assert.point(g.lines[0].entity.pts[0], [-200, 0], 1e-9);
});

test('MEP : décomposition, tessellation et enregistrement DXF', async () => {
  const doc = fresh();
  await run('GA', 'REP', 'Ø250', '2800', '0,0', '3000,0', '');
  const [e] = [...doc.entities.values()];
  const parts = new Tessellator(doc).entity(e);
  assert.ok(parts[0].segs.length > 0);
  assert.equal(parts[0].texts[0].lines[0], 'Ø250');
  const ents = mepToEntities(e);
  assert.equal(ents.filter((x) => x.type === 'TEXT').length, 1);
  assert.ok(ents.every((x) => !x.mep));
  await run('CA', 'ECS', '25', '2500', '0,1000', '4000,1000', '4000,3000', '');
  const text = writeDxf(doc);
  assert.ok(text.includes('CVMEP0'), 'paramètres MEP en données étendues');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const restored = [...back.entities.values()];
  assert.equal(restored.length, 2, 'les deux objets MEP sont reconstruits (pas de traits isolés)');
  const duct = restored.find((x) => x.mep?.kind === 'duct');
  assert.equal(duct.mep.system, 'REP'); assert.equal(duct.mep.d, 250); assert.equal(duct.mep.z, 2800);
  assert.equal(duct.layer, 'MEP-CVC-REP');
  assert.point(duct.pts[1], [3000, 0], 1e-9);
  const pipe = restored.find((x) => x.mep?.kind === 'pipe');
  assert.equal(pipe.pts.length, 3);
  assert.equal(back.blocks.size, 0, 'les blocs de dessin MEP ne restent pas dans le document');
  await fetch('/__out/mep-reseaux.dxf', { method: 'POST', body: text });
});

test('MEP : polyligne longue — données étendues sur plusieurs applications', async () => {
  const doc = fresh();
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push(`${i * 1000},${(i % 2) * 700}`);
  await run('GA', 'SOUF', '500x250', '2700', ...pts, '');
  const text = writeDxf(doc);
  assert.ok(text.includes('CVMEP2'), 'le JSON est réparti sur plusieurs applications');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const [e] = [...back.entities.values()];
  assert.equal(e.pts.length, 40);
  assert.equal(e.mep.w, 500);
  await fetch('/__out/mep-long.dxf', { method: 'POST', body: text });
});

test('MEP : CONVMEP — lignes bout à bout converties en un seul réseau', async () => {
  const doc = fresh();
  await run('L', '0,0', '3000,0', '3000,2000', '');   // deux lignes qui se touchent
  await run('L', '6000,0', '9000,0', '');              // une ligne isolée
  editor.setSelection([...doc.entities.keys()]);
  await run('CONVMEP', 'Gaine', 'EXT', '300x150', '2600');
  const ents = [...doc.entities.values()];
  assert.equal(ents.length, 2, 'deux réseaux : la chaîne de deux lignes, et la ligne isolée');
  assert.ok(ents.every((e) => e.mep?.system === 'EXT' && e.mep.w === 300 && e.layer === 'MEP-CVC-EXT'));
  const chain = ents.find((e) => e.pts.length === 3);
  assert.ok(chain, 'la chaîne a trois sommets');
  doc.undo();
  assert.equal(doc.entities.size, 3, 'annuler restaure les lignes d’origine');
});

test('MEP : interférences selon le plan ET l’altitude', () => {
  const mk = (id, system, kind, pts, sec) => ({ id, type: 'LWPOLYLINE', pts, bulges: pts.map(() => 0), mep: { kind, system, ...sec } });
  const duct = mk(1, 'SOUF', 'duct', [[0, 0], [10000, 0]], { shape: 'rect', w: 600, h: 300, z: 2800 });
  const pipeLow = mk(2, 'EF', 'pipe', [[5000, -3000], [5000, 3000]], { shape: 'round', d: 50, z: 2000 });   // passe dessous
  const pipeHit = mk(3, 'ECS', 'pipe', [[3000, -3000], [3000, 3000]], { shape: 'round', d: 50, z: 2850 });  // traverse la gaine
  const tray = mk(4, 'CFO', 'tray', [[0, 250], [10000, 250]], { shape: 'rect', w: 300, h: 60, z: 2960 });   // juste au-dessus de la gaine (2950)
  const sameSys = mk(5, 'SOUF', 'duct', [[8000, 0], [8000, 4000]], { shape: 'rect', w: 400, h: 200, z: 2800 }); // raccordement
  const clashes = findClashes([duct, pipeLow, pipeHit, tray, sameSys]);
  const pairs = clashes.map((c) => `${c.a}-${c.b}`).sort();
  assert.deepEqual(pairs, ['1-3'], `paires : ${pairs.join(', ')}`);
  // Avec un jeu minimal de 20 mm, le chemin de câbles (10 mm au-dessus de la gaine) devient un conflit.
  const withGap = findClashes([duct, pipeLow, pipeHit, tray], { clearance: 20 }).map((c) => `${c.a}-${c.b}`).sort();
  assert.deepEqual(withGap, ['1-3', '1-4']);
});

test('ENREGDWG : réseau MEP → DWG par AutoCAD → réseau intelligent à la relecture', async () => {
  const status = await fetch('/__dwg/status').then((r) => r.json()).catch(() => ({ available: false }));
  if (!status.available) return; // AutoCAD absent : test sans objet sur cette machine
  const doc = fresh();
  await run('GA', 'AN', '500x300', '3000', '0,0', '6000,0', '6000,4000', '');
  const res = await fetch('/__dwg', { method: 'POST', body: writeDxf(doc) });
  assert.equal(res.status, 200);
  const dwg = await res.arrayBuffer();
  assert.equal(new TextDecoder().decode(new Uint8Array(dwg, 0, 6)), 'AC1032', 'DWG 2018');
  const back = importDatabase(await readDrawing(dwg, 'x.dwg')).doc;
  const [e] = [...back.entities.values()];
  assert.equal(e.mep?.system, 'AN');
  assert.equal(e.mep.w, 500);
  assert.equal(e.pts.length, 3);
});

test('MEP : piquage — la gaine secondaire s’arrête sur la paroi de la gaine principale', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2800', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '400x200', '2800', '5000,0', '5000,4000', '');   // départ sur l'axe de la principale
  await run('GA', 'SOUF', '400x200', '2800', '7000,3000', '7000,100', ''); // arrivée à l'intérieur de la principale
  await run('GA', 'SOUF', '400x200', '2800', '10000,0', '14000,0', '');     // prolongement (pas un piquage)
  editor.settings.osnap = true;
  const [main, b1, b2, cont] = [...doc.entities.values()];
  assert.point(main.pts[0], [0, 0]);
  assert.point(b1.pts[0], [5000, 300], 1e-9);
  assert.point(b2.pts[1], [7000, 300], 1e-9);
  assert.point(cont.pts[0], [10000, 0], 1e-9);
});

test('MEP : étiquette avec ligne de rappel et altitude en mètres', async () => {
  const doc = fresh();
  doc.header.annoScale = 50;
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '5000,0', '');
  editor.run('ETIQMEP'); await tick();
  const [sx, sy] = renderer.toScreen(2500, 0);
  editor.computeCursor([sx, sy]); editor.click(false); await tick();
  editor.submit('3500,1500'); await tick();
  editor.submit(''); await tick();
  editor.settings.osnap = true;
  const t = [...doc.entities.values()].find((e) => e.type === 'TEXT');
  assert.equal(t.text, 'SOUF 400×200 — Z +2,70 m');
  assert.equal(t.layer, 'MEP-CVC-SOUF');
  const leader = [...doc.entities.values()].find((e) => e.type === 'LWPOLYLINE' && !e.mep);
  assert.point(leader.pts[0], [2500, 0], 1e-6);
});

test('MEP : terminaux (BOUCHE) comptés au métré, conservés dans le DXF, ignorés par les interférences', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '6000,0', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '200', '1000,1000', '3000,1000', '5000,1000', '');
  await run('BOUCHE', 'BOUCHE', 'EXT', '160', '2700', '90', '2000,-2000', '');
  editor.settings.osnap = true;
  const terms = [...doc.entities.values()].filter((e) => e.mep?.kind === 'terminal');
  assert.equal(terms.length, 4);
  assert.equal(terms[0].type, 'INSERT');
  assert.ok(doc.blocks.has(terms[0].name));
  const rows = quantities(doc);
  const diff = rows.find((r) => r.section === '600×600');
  assert.equal(diff.count, 3);
  assert.equal(rows.find((r) => r.section === 'Ø160').count, 1);
  assert.ok(quantitiesCsv(rows).includes('"Quantité"'));
  // Les interférences ne plantent pas en présence de terminaux.
  assert.equal(findClashes([...doc.entities.values()]).length, 0);
  // Aller-retour DXF : les terminaux restent des terminaux.
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const t2 = [...back.entities.values()].filter((e) => e.mep?.kind === 'terminal');
  assert.equal(t2.length, 4);
  assert.equal(t2[0].mep.terminal, 'DIFF');
  assert.ok(back.blocks.has(t2[0].name), 'le bloc du symbole est conservé');
});

test('MEP : la paroi de la gaine principale s’interrompt au droit d’un piquage (et se referme s’il part)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2800', '0,0', '10000,0', '');
  const main = [...doc.entities.values()][0];
  const wallSegs = () => renderer.cache.get(main.id).parts[0].segs;
  const before = wallSegs().length;
  await run('GA', 'SOUF', '400x200', '2800', '5000,0', '5000,4000', '');
  const after = wallSegs();
  assert.ok(after.length > before, 'la paroi supérieure est coupée en deux morceaux');
  // Aucun segment de la paroi y = 300 ne traverse l'ouverture 4800 → 5200.
  for (let i = 0; i < after.length; i += 6) {
    if (Math.abs(after[i + 1] - 300) > 1e-6 || Math.abs(after[i + 4] - 300) > 1e-6) continue;
    const x0 = Math.min(after[i], after[i + 3]), x1 = Math.max(after[i], after[i + 3]);
    assert.ok(x1 <= 4800 + 1e-6 || x0 >= 5200 - 1e-6, `segment ${x0} → ${x1} dans l’ouverture`);
  }
  // L'extrémité du piquage posée sur la paroi n'est pas fermée par un trait (té ouvert).
  const bseg = renderer.cache.get([...doc.entities.values()][1].id).parts[0].segs;
  for (let i = 0; i < bseg.length; i += 6) {
    const horizontal = Math.abs(bseg[i + 1] - bseg[i + 4]) < 1e-6 && Math.abs(bseg[i + 1] - 300) < 1e-6;
    assert.ok(!horizontal, 'pas de trait de fermeture sur la paroi');
  }
  // Le piquage supprimé : la paroi redevient continue.
  const branch = [...doc.entities.values()][1];
  doc.transaction('e', () => doc.remove(branch.id));
  assert.equal(wallSegs().length, before);
  editor.settings.osnap = true;
});

test('MEP : réduction entre deux sections en prolongement, jonction continue à section égale', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2800', '0,0', '5000,0', '');
  await run('GA', 'SOUF', '400x200', '2800', '5000,0', '9000,0', '');
  await run('GA', 'SOUF', '400x200', '2800', '9000,0', '12000,0', '');
  editor.settings.osnap = true;
  const [a, b, c] = [...doc.entities.values()];
  const segsOf = (e) => {
    const s = renderer.cache.get(e.id).parts[0].segs, out = [];
    for (let i = 0; i < s.length; i += 6) out.push([[s[i], s[i + 1]], [s[i + 3], s[i + 4]]]);
    return out;
  };
  const near = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  const has = (segs, p, q) => segs.some(([u, v]) => (near(u, p) && near(v, q)) || (near(u, q) && near(v, p)));
  // Réduction dessinée par la gaine la plus étroite : 300 mm de long.
  assert.ok(has(segsOf(b), [5000, 300], [5300, 200]), 'côté gauche de la réduction');
  assert.ok(has(segsOf(b), [5000, -300], [5300, -200]), 'côté droit de la réduction');
  // Pas de trait de jonction à x = 5000 (ni sur A ni sur B), ni à x = 9000 (sections égales).
  const vertical = (segs, x) => segs.some(([u, v]) => Math.abs(u[0] - x) < 1e-6 && Math.abs(v[0] - x) < 1e-6);
  assert.ok(!vertical(segsOf(a), 5000) && !vertical(segsOf(b), 5000), 'jonction de la réduction ouverte');
  assert.ok(!vertical(segsOf(b), 9000) && !vertical(segsOf(c), 9000), 'jonction continue à section égale');
  assert.ok(vertical(segsOf(a), 0) && vertical(segsOf(c), 12000), 'les extrémités libres restent fermées');
});

test('MEP : flèches de sens (SENS) et sélection des semblables (SELECTSIM)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'EF', '32', '2500', '0,0', '10000,0', '');
  await run('CA', 'EF', '32', '2500', '0,1000', '10000,1000', '');
  await run('CA', 'ECS', '25', '2500', '0,2000', '10000,2000', '');
  const [a] = [...doc.entities.values()];
  const n0 = mepGeometry(a).lines.length;
  editor.run('SENS'); await tick();
  const [sx, sy] = renderer.toScreen(5000, 0);
  editor.computeCursor([sx, sy]); editor.click(false); await tick();
  editor.submit(''); await tick();
  assert.equal(doc.get(a.id).mep.flow, 1);
  const g = mepGeometry(doc.get(a.id));
  assert.equal(g.lines.length, n0 + 2, 'une flèche (deux traits) sur le tronçon');
  const tip = g.lines.at(-1).pts[1];
  assert.ok(tip[0] > 2500, 'la flèche pointe dans le sens du tracé');
  editor.setSelection([a.id]);
  await run('SELECTSIM');
  editor.settings.osnap = true;
  assert.equal(editor.selection.size, 2, 'les deux canalisations EF, pas l’ECS');
});

test('TRACER : PDF vectoriel à l’échelle 1:50 sur A3', async () => {
  const { plotPdf } = await import('../src/io/pdf.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '10000,6000', '');
  await run('TEXTE', '0,-1000', '250', '0', 'Plan CVC — niveau R+1', '');
  editor.settings.osnap = true;
  const r = await plotPdf(renderer, doc, { paper: 'A3', landscape: true, box: { minX: -500, minY: -2000, maxX: 11000, maxY: 7000 }, scale: 50, mono: true, title: 'Test' });
  assert.ok(r.blob.size > 2000, 'PDF non vide');
  assert.ok(r.segments > 4, 'les traits du réseau sont tracés');
  assert.equal(r.texts, 2, 'étiquette de section + texte');
  assert.near(r.scale, 50, 1e-9, 'dessin en mm au 1:50');
  const head = new TextDecoder().decode(new Uint8Array(await r.blob.slice(0, 5).arrayBuffer()));
  assert.equal(head, '%PDF-');
  await fetch('/__out/test-trace.pdf', { method: 'POST', body: r.blob });
});

async function clickAt(p) {
  renderer.fit(renderer.robustExtents());
  const [sx, sy] = renderer.toScreen(p[0], p[1]);
  editor.computeCursor([sx, sy]);
  editor.click(false);
  await tick();
  await tick();
}

test('MEP : DEBITS cumule les bouches, DIMENSIONNER découpe et redimensionne le réseau', async () => {
  const { buildNetwork, computeFlows, flowSections, sizeFor, velocity } = await import('../src/mep/network.js');
  assert.deepEqual(sizeFor(1200, { vmax: 4, h: 300 }), { shape: 'rect', w: 300, h: 300 });
  assert.deepEqual(sizeFor(500, { vmax: 4, shape: 'round' }), { shape: 'round', d: 250 });
  assert.near(velocity(1200, { shape: 'rect', w: 300, h: 300 }), 1200 / 3600 / 0.09, 1e-9);
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '20000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '5000,0', '5000,4000', '');
  await run('GA', 'SOUF', '300x200', '2700', '12000,0', '12000,4000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '200', '5000,2000', '5000,4000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '300', '12000,4000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '500', '20000,0', '');
  await run('BOUCHE', 'GRILLE', 'REP', '600x300', '2700', '400', '8000,300', ''); // autre système : ignorée
  const ducts = [...doc.entities.values()].filter((e) => e.mep?.kind === 'duct');
  const [main, b1, b2] = ducts;
  assert.point(b1.pts[0], [5000, 300], 1e-6); // piquage posé sur la paroi (gaine de 600 de large)
  const net = buildNetwork([...doc.entities.values()]);
  assert.equal(net.links.get(main.id).length, 2);
  assert.equal(net.unconnected.length, 1, 'la grille de reprise n’a pas de gaine REP');
  const flows = computeFlows(net, main.id, 0);
  assert.equal(flows.get(main.id).q, 1200);
  assert.equal(flows.get(b1.id).q, 400);
  assert.equal(flows.get(b2.id).q, 300);
  assert.deepEqual(flowSections(flows.get(main.id)).map((x) => x.q), [1200, 800, 500]);
  // DEBITS : débit écrit sur chaque gaine (affiché dans l'étiquette).
  await run('DEBITS');
  await clickAt([300, 0]);
  assert.equal(doc.get(main.id).mep.q, 1200);
  assert.equal(doc.get(b1.id).mep.q, 400);
  // DIMENSIONNER à 4 m/s : principal 300 → 200 → 150 de large (hauteur 300 conservée).
  await run('DIMRES');
  await clickAt([300, 0]);
  editor.submit('4');
  await tick(); await tick();
  editor.settings.osnap = true;
  const after = [...doc.entities.values()].filter((e) => e.mep?.kind === 'duct');
  const mains = after.filter((e) => Math.abs(e.pts[0][1]) < 1e-6 && Math.abs(e.pts.at(-1)[1]) < 1e-6).sort((a, b) => a.pts[0][0] - b.pts[0][0]);
  assert.deepEqual(mains.map((e) => e.mep.w), [300, 200, 150], JSON.stringify(mains.map((e) => [e.pts, e.mep.w, e.mep.q])));
  assert.equal(mains[0].id, main.id, 'le morceau de départ garde l’identifiant');
  assert.near(mains[0].pts.at(-1)[0], 5000 + 150 + 100, 1e-6);
  assert.deepEqual(mains.map((e) => e.mep.q), [1200, 800, 500]);
  // Les piquages sont recalés sur les nouvelles parois (demi-largeurs 150 et 100).
  assert.point(doc.get(b1.id).pts[0], [5000, 150], 1e-6);
  const nb2 = doc.get(b2.id);
  assert.point(nb2.pts[0], [12000, 100], 1e-6);
  // Branche 1 : deux bouches en ligne → deux morceaux (150 puis 100 de large, hauteur 200).
  const branch1 = after.filter((e) => Math.abs(e.pts[0][0] - 5000) < 1e-6 && Math.abs(e.pts.at(-1)[0] - 5000) < 1e-6);
  assert.deepEqual(branch1.map((e) => e.mep.w).sort((a, b) => b - a), [150, 100]);
  // Une réduction est dessinée sur le morceau le plus étroit (traits obliques).
  const neighbors = after;
  const g = mepGeometry(mains[1], neighbors);
  const oblique = g.lines.filter((l) => l.pts && Math.abs(l.pts[0][1] - l.pts[1][1]) > 1e-6 && Math.abs(l.pts[0][0] - l.pts[1][0]) > 1e-6);
  assert.equal(oblique.length, 2, 'réduction 300 → 200');
  // Affichage : les morceaux créés ensemble se voient (pas de trait de fermeture à la jonction).
  const xj = mains[1].pts.at(-1)[0];
  let caps = 0;
  for (const id of [mains[1].id, mains[2].id]) {
    for (const part of renderer.cache.get(id).parts) {
      for (let i = 0; i < part.segs.length; i += 6) {
        if (Math.abs(part.segs[i] - xj) < 1e-6 && Math.abs(part.segs[i + 3] - xj) < 1e-6) caps++;
      }
    }
  }
  assert.equal(caps, 0, 'pas de trait de fermeture entre deux morceaux');
  // Les débits survivent à l'enregistrement DXF.
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const qs = [...back.entities.values()].filter((e) => e.mep?.kind === 'duct').map((e) => e.mep.q).sort((a, b) => a - b);
  assert.deepEqual(qs, [...after.map((e) => e.mep.q)].sort((a, b) => a - b));
  const terms = [...back.entities.values()].filter((e) => e.mep?.kind === 'terminal').map((e) => e.mep.q).sort((a, b) => a - b);
  assert.deepEqual(terms, [200, 200, 300, 400, 500]);
});

test('MEP : tronçons de débit sur une gaine en biais (longueur non entière)', async () => {
  const { flowSections } = await import('../src/mep/network.js');
  const L = Math.hypot(2875, 2875);
  assert.deepEqual(flowSections({ entry: 0, length: L, taps: [{ s: L, q: 90 }] }).map((x) => x.q), [90]);
  assert.deepEqual(flowSections({ entry: L, length: L, taps: [{ s: L / 3, q: 50 }, { s: 0, q: 40 }] }).map((x) => x.q), [40, 90]);
  // Bouche à un poil au-delà de l'extrémité (arrondis) : rattachée à l'extrémité.
  assert.deepEqual(flowSections({ entry: 0, length: L, taps: [{ s: L + 1e-9, q: 70 }] }).map((x) => x.q), [70]);
});

test('MEP : pertes de charge (abaques), chemin critique et équilibrage', async () => {
  const { frictionRate, dynamicPressure, buildNetwork, computeFlows, pressureDrops, ZETA } = await import('../src/mep/network.js');
  // Valeurs d'abaque (acier galvanisé, air 20 °C).
  assert.near(frictionRate(1000, { shape: 'rect', w: 400, h: 200 }), 0.60, 0.03);
  assert.near(frictionRate(500, { shape: 'round', d: 250 }), 0.45, 0.03);
  const doc = fresh();
  editor.settings.osnap = false;
  // Gaine 400×200 : 10 m, coude à 90°, 5 m, bouche de 1000 m³/h au bout ; piquage court vers une 2e bouche.
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '10000,5000', '');
  await run('GA', 'SOUF', '200x200', '2700', '3000,0', '3000,2000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '1000', '10000,5000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '200', '3000,2000', '');
  editor.settings.osnap = true;
  const ents = [...doc.entities.values()];
  const main = ents.find((e) => e.mep?.kind === 'duct' && e.pts.length === 3);
  const net = buildNetwork(ents);
  const flows = computeFlows(net, main.id, 0);
  const r = pressureDrops(net, flows, main.id, 0, { terminalDp: 20 });
  assert.equal(r.terminals.length, 2);
  const m = main.mep;
  // Bouche lointaine : frottement 3 m à 1200 m³/h + 12 m à 1000 m³/h, té traversé, coude, bouche.
  const expected = frictionRate(1200, m) * 3 + frictionRate(1000, m) * 12
    + ZETA.teeStraight * dynamicPressure(1000, m) + ZETA.elbowRadius * dynamicPressure(1000, m) + 20;
  assert.near(r.max, expected, 1e-6);
  assert.equal(r.critical.q, 1000);
  assert.ok(r.terminals[1].dp < r.max, 'la bouche proche est moins défavorisée');
  assert.deepEqual(r.critical.path, [main.id]);
});

test('MEP plomberie : appareils sanitaires, débit probable (DTU 60.11) et diamètres', async () => {
  const { buildNetwork, computeFlows, simultaneity, pipeSizeFor, designFlow } = await import('../src/mep/network.js');
  assert.equal(simultaneity(1), 1);
  assert.near(simultaneity(3), 0.8 / Math.SQRT2, 1e-12);
  assert.equal(pipeSizeFor(0.12, 1.5), 12);
  assert.equal(pipeSizeFor(0.294, 1.5), 16);
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'EF', '32', '2500', '0,0', '10000,0', '');
  await run('CA', 'EF', '20', '2500', '4000,0', '4000,3000', '');
  await run('APP', 'LAVABO', 'EF', '900', '4000,3000', '');
  await run('APP', 'DOUCHE', 'EF', '900', '4000,1500', '');
  await run('APP', 'WC', 'EF', '900', '10000,0', '');
  await run('APP', 'WC', 'ECS');                    // pas d'eau chaude pour un WC : refusé
  const ents = [...doc.entities.values()];
  const fixtures = ents.filter((e) => e.mep?.kind === 'terminal');
  assert.equal(fixtures.length, 3);
  assert.ok(doc.blocks.has(fixtures[0].name));
  const main = ents.find((e) => e.mep?.kind === 'pipe' && e.pts[0][0] === 0);
  const net = buildNetwork(ents, 'pipe');
  const flows = computeFlows(net, main.id, 0);
  const info = flows.get(main.id);
  assert.near(info.q, 0.52, 1e-9);
  assert.equal(info.n, 3);
  assert.near(designFlow(info, 'pipe', 'EF'), 0.52 * 0.8 / Math.SQRT2, 1e-9);
  // DIMENSIONNER à 1,5 m/s : principal Ø16 (0,294 l/s) puis Ø12 (WC seul) ; branche Ø16 (2 appareils, y = 0,8).
  await run('DIMRES');
  renderer.fit(renderer.robustExtents());
  const [sx, sy] = renderer.toScreen(100, 0);
  editor.computeCursor([sx, sy]);
  editor.click(false);
  await tick(); await tick();
  editor.submit('1.5');
  await tick(); await tick();
  editor.settings.osnap = true;
  const pipes = [...doc.entities.values()].filter((e) => e.mep?.kind === 'pipe');
  const mains = pipes.filter((e) => Math.abs(e.pts[0][1]) < 1e-6 && Math.abs(e.pts.at(-1)[1]) < 1e-6).sort((a, b) => a.pts[0][0] - b.pts[0][0]);
  assert.deepEqual(mains.map((e) => e.mep.d), [16, 12], JSON.stringify(mains.map((e) => [e.pts, e.mep.d, e.mep.q])));
  assert.near(mains[0].mep.q, 0.294, 1e-3);
  const branch = pipes.filter((e) => Math.abs(e.pts[0][0] - 4000) < 1e-6);
  assert.ok(branch.some((e) => e.mep.d === 14 || e.mep.d === 16), JSON.stringify(branch.map((e) => [e.mep.d, e.mep.q])));
  const g = mepGeometry(mains[0], pipes);
  assert.ok(g.labels[0].text.includes('l/s'), g.labels[0].text);
});

test('MEP chauffage : émetteurs (débit = P / ρcΔT), pas de simultanéité, dimensionnement', async () => {
  const { buildNetwork, computeFlows, hydronicFlow, designFlow } = await import('../src/mep/network.js');
  assert.near(hydronicFlow(2000, 10), 2000 / 41860, 1e-12);
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'CH-D', '26', '400', '0,0', '8000,0', '');
  await run('EM', 'RADIATEUR', 'CH-D', '2000', '10', '200', '3000,0', '6000,0', '8000,0', '');
  await run('EM', 'VENTILO', 'EG-D', '3000', '5', '2700', '0,5000', '');
  editor.settings.osnap = true;
  const ents = [...doc.entities.values()];
  const rads = ents.filter((e) => e.mep?.terminal === 'RADIATEUR');
  assert.equal(rads.length, 3);
  assert.near(rads[0].mep.q, 0.0478, 1e-4);
  assert.equal(ents.find((e) => e.mep?.terminal === 'VENTILO').mep.dt, 5);
  const main = ents.find((e) => e.mep?.kind === 'pipe');
  const net = buildNetwork(ents, 'pipe');
  const flows = computeFlows(net, main.id, 0);
  const info = flows.get(main.id);
  assert.equal(info.n, 3);
  assert.near(designFlow(info, 'pipe', 'CH-D'), 3 * 0.0478, 1e-3, 'chauffage : débits additionnés');
  assert.ok(designFlow(info, 'pipe', 'EF') < info.q, 'sanitaire : simultanéité');
  assert.equal(net.unconnected.length, 1, 'le ventilo-convecteur EG n’est pas sur le réseau CH');
});

test('MEP : un bout mort après le dernier piquage garde la section précédente', async () => {
  const { buildNetwork, computeFlows, resizeNetwork } = await import('../src/mep/network.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '6000,0', '6000,3000', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '500', '6000,3000', '');
  editor.settings.osnap = true;
  const ents = [...doc.entities.values()];
  const main = ents.find((e) => e.mep?.kind === 'duct' && e.pts[1][0] === 10000);
  const net = buildNetwork(ents);
  const res = resizeNetwork(net, computeFlows(net, main.id, 0), { vmax: 4 });
  const pieces = res.find((r) => r.id === main.id).pieces;
  assert.equal(pieces.length, 1, 'pas de découpe vers le bout mort');
  assert.ok(pieces[0].mep.w >= 150);
});

test('MEP : calorifuge dessiné en tirets, compté dans les interférences, conservé en DXF', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '5000,0', '');
  await run('GA', 'REP', '400x200', '2700', '0,420', '5000,420', ''); // 20 mm de jeu entre les parois
  editor.settings.osnap = true;
  const [a, b] = [...doc.entities.values()];
  assert.equal(findClashes([a, b]).length, 0, 'sans calorifuge : pas de conflit');
  doc.transaction('calo', () => { doc.modify(a.id, (x) => { x.mep.ins = 25; }); doc.modify(b.id, (x) => { x.mep.ins = 25; }); });
  const a2 = doc.get(a.id), b2 = doc.get(b.id);
  assert.equal(findClashes([a2, b2]).length, 1, 'avec 25 mm de calorifuge : conflit');
  const g = mepGeometry(a2, [b2]);
  const ins = g.lines.filter((l) => l.ins);
  assert.equal(ins.length, 2);
  assert.near(Math.abs(ins[0].entity.pts[0][1]), 225, 1e-6);
  // Rendu : plus de segments (tirets) qu'une gaine sans calorifuge.
  const n = (e) => renderer.cache.get(e.id).parts.reduce((s, p) => s + p.segs.length, 0);
  assert.ok(n(a2) > 2 * 6 * 2, 'tirets du calorifuge tracés');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  assert.deepEqual([...back.entities.values()].map((e) => e.mep.ins), [25, 25]);
});

test('MEP : COUPE (sections à l’altitude, coupe oblique, réseau vu en élévation, repère en plan)', async () => {
  const { sectionEntities } = await import('../src/mep/section.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '0,5000', '');            // coupé à angle droit
  await run('CA', 'EF', '32', '2400', '1000,0', '3000,2000', '');                // coupé à 45°
  await run('GA', 'REP', '600x300', '2900', '-500,1500', '3500,1500', '');       // parallèle, 1 m derrière la coupe
  editor.settings.osnap = true;
  // Ligne de coupe y = 1000 de x = -1000 à x = 4000 ; la vue regarde vers +y (à gauche du tracé).
  const ents = sectionEntities([...doc.entities.values()], [-1000, 1000], [4000, 1000], { depth: 2000, base: [0, -10000], unitM: 0.001, textH: 100, layer: 'MEP-COUPE' });
  const rect = ents.find((e) => e.type === 'LWPOLYLINE' && e.layer.includes('SOUF'));
  assert.ok(rect, 'section de la gaine de soufflage');
  assert.point(rect.pts[0], [1000 - 200, -10000 + 2600], 1e-6);
  assert.point(rect.pts[2], [1000 + 200, -10000 + 2800], 1e-6);
  const circ = ents.find((e) => e.type === 'CIRCLE');
  assert.point(circ.c, [3000, -10000 + 2400], 1e-6); // canalisation coupée en x = 2000
  assert.near(circ.r, 16, 1e-9);
  // Reprise parallèle derrière la coupe : deux traits horizontaux (bas / haut) de x = 500 à 4500.
  const elev = ents.filter((e) => e.type === 'LINE' && e.layer.includes('REP'));
  assert.equal(elev.length, 2);
  assert.near(elev[0].p1[1], -10000 + 2750, 1e-6);
  assert.ok(ents.some((e) => e.type === 'TEXT' && e.text === 'Z +2,70'));
  // Commande complète : repère de coupe en plan + coupe insérée.
  await run('COUPE', '-1000,1000', '4000,1000', '2000', '0,-10000');
  assert.ok([...doc.entities.values()].some((e) => e.type === 'TEXT' && e.text === 'COUPE A-A'));
  assert.equal([...doc.entities.values()].filter((e) => e.type === 'TEXT' && e.text === 'A').length, 2);
});

test('MEP : ETIQMEP « Tous » étiquette chaque réseau visible', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '5000,0', '');
  await run('CA', 'EF', '20', '2300', '0,2000', '4000,2000', '');
  editor.settings.osnap = true;
  await run('ETIQ', 't');
  const texts = [...doc.entities.values()].filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.equal(texts.length, 2, JSON.stringify(texts));
  assert.ok(texts.some((t) => t.startsWith('SOUF 400×200 — Z +2,70')));
  assert.ok(texts.some((t) => t.startsWith('EF Ø20 — Z +2,30')));
});

test('MEP 3D : terminaux en volumes, calorifuge en enveloppe translucide', async () => {
  const { buildMep3d } = await import('../src/mep/mep3d.js');
  const duct = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [3000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700, ins: 25 } };
  const diff = { id: 2, type: 'INSERT', p: [1500, 0, 0], rot: 0, mep: { kind: 'terminal', terminal: 'DIFF', system: 'SOUF', w: 600, h: 600, z: 2600 } };
  const g = buildMep3d([duct, diff], () => 0x3366ff, { x: 0, y: 0, z: 0 });
  const meshes = g.children.filter((c) => c.isMesh);
  assert.equal(meshes.length, 2, 'réseau + terminal (même couleur) puis calorifuge');
  const ins = g.children.find((c) => c.name === 'calorifuge');
  assert.ok(ins && ins.material.transparent);
  ins.geometry.computeBoundingBox();
  assert.near(ins.geometry.boundingBox.max.y, 225, 1e-6);
});

test('MEP : CORRESPROP reporte système, section, altitude et calorifuge ; CSV d’équilibrage', async () => {
  const { pressureCsv } = await import('../src/mep/commands.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2900', '0,0', '5000,0', '');
  await run('GA', 'REP', '300x200', '2500', '0,2000', '5000,2000', '');
  editor.settings.osnap = true;
  const [a, b] = [...doc.entities.values()];
  doc.transaction('calo', () => doc.modify(a.id, (x) => { x.mep.ins = 30; }));
  renderer.fit(renderer.robustExtents());
  editor.run('MA');
  await tick();
  editor.answer({ id: a.id, p: [2500, 0] }); await tick();
  editor.answer({ id: b.id, p: [2500, 2000] }); await tick();
  editor.submit(''); await tick();
  const nb = doc.get(b.id);
  assert.equal(nb.mep.system, 'SOUF');
  assert.deepEqual([nb.mep.w, nb.mep.h, nb.mep.z, nb.mep.ins], [600, 300, 2900, 30]);
  assert.equal(nb.layer, a.layer);
  const csv = pressureCsv({ max: 41.2, terminals: [{ id: 1, q: 300, dp: 41.2 }, { id: 2, q: 200, dp: 33.05 }] }, (id) => `Bouche ${id}`);
  assert.ok(csv.startsWith('\ufeffBouche;Débit'));
  assert.ok(csv.includes('Bouche 2;200;33,1;8,2'), csv);
});

test('TRACER : épaisseurs de ligne des calques et des objets dans le PDF', async () => {
  const { plotPdf } = await import('../src/io/pdf.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '');
  await run('L', '0,2000', '10000,2000', '');
  editor.settings.osnap = true;
  const duct = [...doc.entities.values()].find((e) => e.mep);
  doc.setLayer(duct.layer, { lweight: 50 }); // calque du soufflage : 0,50 mm
  const box = { minX: -500, minY: -1000, maxX: 10500, maxY: 3000 };
  const widths = async (opts) => {
    const r = await plotPdf(renderer, doc, { paper: 'A3', landscape: true, box, scale: 50, mono: true, title: 'Ép.', ...opts });
    const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
    return [...txt.matchAll(/(\d+\.\d+) w/g)].map((m) => parseFloat(m[1]));
  };
  const has = (list, mm) => list.some((v) => Math.abs(v - (mm * 72) / 25.4) < 1e-3);
  const w1 = await widths({ lineweights: true });
  assert.ok(has(w1, 0.5), `0,50 mm attendu dans ${w1}`);
  assert.ok(has(w1, 0.18), `0,18 mm (défaut) attendu dans ${w1}`);
  const w2 = await widths({ lineweights: false });
  assert.ok(!has(w2, 0.5) && has(w2, 0.13), 'mode « Fines » : tout à 0,13 mm');
});

test('Épaisseurs dans les blocs : calque propre, DuBloc, DuCalque sur le calque 0, et tracé PDF', async () => {
  const { Tessellator } = await import('../src/core/tessellate.js');
  const { partLineweight } = await import('../src/core/document.js');
  const { plotPdf } = await import('../src/io/pdf.js');
  const doc = fresh();
  doc.blocks.set('FOND', { name: 'FOND', base: [0, 0, 0], entities: [
    { type: 'LINE', layer: 'MURS', color: 256, p1: [0, 0, 0], p2: [1000, 0, 0] },
    { type: 'LINE', layer: '0', color: 256, lweight: -2, p1: [0, 100, 0], p2: [1000, 100, 0] },
    { type: 'LINE', layer: '0', color: 256, p1: [0, 200, 0], p2: [1000, 200, 0] },
  ] });
  doc.transaction('blocs', () => {
    doc.addLayer('MURS', { lweight: 50 });
    doc.addLayer('X', { lweight: 25 });
    doc.add({ type: 'INSERT', name: 'FOND', layer: 'X', color: 256, lweight: 35, p: [0, 0, 0], sx: 1, sy: 1, rot: 0 });
  });
  const ins = [...doc.entities.values()].find((e) => e.type === 'INSERT');
  const lws = new Tessellator(doc).entity(ins).map((p) => partLineweight(doc, p)).sort((a, b) => a - b);
  assert.deepEqual(lws, [25, 35, 50], 'DuCalque sur 0 → calque X, DuBloc → insertion, MURS → 0,50');
  // Insertion DuCalque : DuBloc prend l'épaisseur du calque de l'insertion.
  doc.transaction('dc', () => { const { lweight, ...rest } = doc.get(ins.id); doc.update(rest); });
  const lws2 = new Tessellator(doc).entity(doc.get(ins.id)).map((p) => partLineweight(doc, p)).sort((a, b) => a - b);
  assert.deepEqual(lws2, [25, 25, 50]);
  const r = await plotPdf(renderer, doc, { paper: 'A4', landscape: true, box: { minX: -100, minY: -100, maxX: 1100, maxY: 300 }, scale: 10, mono: true, title: 'B', lineweights: true });
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
  const w = [...txt.matchAll(/(\d+\.\d+) w/g)].map((m) => parseFloat(m[1]));
  const has = (mm) => w.some((v) => Math.abs(v - (mm * 72) / 25.4) < 1e-3);
  assert.ok(has(0.5) && has(0.25), `0,50 et 0,25 mm attendus dans ${w}`);
});

test('MEP : RETOUR crée le réseau retour parallèle (système, côté, entraxe)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'CH-D', '26', '400', '0,0', '5000,0', '5000,3000', '');
  const aller = [...doc.entities.values()][0];
  editor.setSelection([aller.id]);
  await run('RET', '150', '2000,-500');
  editor.settings.osnap = true;
  const ret = [...doc.entities.values()].find((e) => e.mep?.system === 'CH-R');
  assert.ok(ret, 'réseau CH-R créé');
  assert.ok(doc.layers.has(ret.layer) && ret.layer.includes('CH-R'));
  assert.point(ret.pts[0], [0, -150], 1e-9);
  assert.point(ret.pts[1], [5150, -150], 1e-9, 'coude décalé à l’extérieur');
  assert.equal(ret.mep.d, 26);
});

test('MEP : NUMEROTER (repères par système, bulle dessinée par le réseau) et NOMENCLATURE', async () => {
  const { billOfMaterials, bomCsv } = await import('../src/mep/fabrication.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '5000,0', '9000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '0,0', '0,3000', '3000,3000', '');
  await run('CA', 'EF', '20', '2300', '0,-2000', '4000,-2000', '');
  editor.settings.osnap = true;
  await run('NUM', '');
  const runs = [...doc.entities.values()].filter((e) => e.mep);
  assert.deepEqual(runs.map((e) => e.mep.num).sort(), ['EF-001', 'SOUF-001', 'SOUF-002']);
  assert.equal(runs.find((e) => e.pts[0][0] === 0 && e.mep.system === 'SOUF').mep.num, 'SOUF-001', 'tri de gauche à droite');
  const g = mepGeometry(runs[0], []);
  assert.ok(g.labels.some((l) => l.text === runs[0].mep.num), 'bulle de repère');
  const rows = billOfMaterials([...doc.entities.values()]);
  assert.equal(rows.length, 3);
  const souf1 = rows.find((r) => r.num === 'SOUF-001');
  assert.near(souf1.length, 6, 1e-9);
  assert.equal(souf1.elbows, 1);
  assert.ok(bomCsv(rows).includes('SOUF-001;SOUF;Gaine;300×200;6,00;1;0;2,70'), bomCsv(rows));
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  assert.deepEqual([...back.entities.values()].filter((e) => e.mep).map((e) => e.mep.num).sort(), ['EF-001', 'SOUF-001', 'SOUF-002']);
  await run('NUM', 'e');
  assert.ok([...doc.entities.values()].every((e) => !e.mep?.num), 'repères effacés');
});

test('MEP (relecture) : pertes de charge indépendantes de l’unité du dessin ; coupures confondues sans morceau nul', async () => {
  const { buildNetwork, computeFlows, pressureDrops, splitPoints } = await import('../src/mep/network.js');
  // Même réseau en mm et en cm : même perte de charge.
  const mk = (k) => {
    const duct = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [10000 / k, 0]], bulges: [0, 0], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400 / k, h: 200 / k, z: 2700 / k } };
    const term = { id: 2, type: 'INSERT', p: [10000 / k, 0, 0], mep: { kind: 'terminal', terminal: 'DIFF', system: 'SOUF', w: 600 / k, h: 600 / k, q: 1000 } };
    const net = buildNetwork([duct, term]);
    return pressureDrops(net, computeFlows(net, 1, 0), 1, 0, { terminalDp: 0, unitMm: k }).max;
  };
  assert.near(mk(10), mk(1), 1e-6);
  assert.near(mk(1), 6.03, 0.3);
  // Deux coupures repoussées au même endroit : un seul point de coupe.
  const e = { pts: [[0, 0], [10000, 0]] };
  const pieces = splitPoints(e, [5400, 5400, 5400.0000001]);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.s1 - p.s0 > 1));
});

test('COUPE (relecture) : tronçon vu découpé à la profondeur, pas de section double à un sommet', async () => {
  const { sectionEntities } = await import('../src/mep/section.js');
  // Gaine en L dont le sommet est sur la ligne de coupe y = 0 : une seule section.
  const L = { id: 1, type: 'LWPOLYLINE', layer: 'MEP-CVC-SOUF', pts: [[0, -2000], [0, 0], [0, 3000]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  let ents = sectionEntities([L], [-1000, 0], [1000, 0], { depth: 2000, base: [0, 0], textH: 100, layer: 'C' });
  assert.equal(ents.filter((e) => e.type === 'LWPOLYLINE').length, 1, 'une seule section');
  // Tronçon oblique qui s'éloigne au-delà de la profondeur : sa partie visible est tracée.
  const oblique = { id: 2, type: 'LWPOLYLINE', layer: 'MEP-PLB-EF', pts: [[-500, 500], [500, 5000]], mep: { kind: 'pipe', system: 'EF', d: 32, z: 2400 } };
  ents = sectionEntities([oblique], [-1000, 0], [1000, 0], { depth: 2000, base: [0, 0], textH: 100, layer: 'C' });
  const lines = ents.filter((e) => e.type === 'LINE' && e.layer === 'MEP-PLB-EF');
  assert.equal(lines.length, 2, 'dessus et dessous de la canalisation vus');
  const xmax = Math.max(...lines.map((l) => Math.max(l.p1[0], l.p2[0])));
  assert.near(xmax, 1000 + (-500 + (1000 * 1500) / 4500), 1e-6, 'arrêtée à la profondeur de vue');
});

test('MEP : pertes de charge des réseaux d’eau (frottement, hauteur statique, débit probable)', async () => {
  const { frictionRate, buildNetwork, computeFlows, pressureDrops, designFlow } = await import('../src/mep/network.js');
  // Abaque : Ø intérieur 20 mm à 0,2 l/s ≈ 0,3 kPa/m.
  assert.near(frictionRate(0.2, { kind: 'pipe', shape: 'round', d: 20 }), 300, 40);
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'EF', '20', '2300', '0,0', '10000,0', '');
  await run('APP', 'LAVABO', 'EF', '900', '10000,0', '');
  editor.settings.osnap = true;
  const ents = [...doc.entities.values()];
  const pipe = ents.find((e) => e.mep?.kind === 'pipe');
  const net = buildNetwork(ents, 'pipe');
  const flows = computeFlows(net, pipe.id, 0);
  const r = pressureDrops(net, flows, pipe.id, 0, { terminalDp: 100000, staticHead: true });
  const expected = frictionRate(designFlow(flows.get(pipe.id), 'pipe', 'EF'), pipe.mep) * 10 + 100000 + 998 * 9.81 * (0.9 - 2.3);
  assert.near(r.max, expected, 1e-6);
  assert.ok(r.max < 100000, 'appareil plus bas que la canalisation : gain de pression statique');
});

test('MEP : RESERVATIONS (mur double regroupé, jeu, calorifuge, mur dans un bloc)', async () => {
  const { findReservations } = await import('../src/mep/reservations.js');
  const doc = fresh();
  editor.settings.osnap = false;
  doc.transaction('murs', () => doc.addLayer('A-MURS'));
  doc.currentLayer = 'A-MURS';
  await run('L', '3000,-2000', '3000,2000', '');   // mur de 200 : deux faces
  await run('L', '3200,-2000', '3200,2000', '');
  doc.blocks.set('CLOISON', { name: 'CLOISON', base: [0, 0, 0], entities: [{ type: 'LINE', layer: 'A-MURS', p1: [0, -2000, 0], p2: [0, 2000, 0] }] });
  doc.add({ type: 'INSERT', name: 'CLOISON', layer: '0', p: [6000, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [] });
  doc.currentLayer = '0';
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '9000,0', '');
  editor.settings.osnap = true;
  const duct = [...doc.entities.values()].find((e) => e.mep);
  doc.transaction('calo', () => doc.modify(duct.id, (x) => { x.mep.ins = 25; }));
  await run('RESA', 'a', '50');
  const resa = [...doc.entities.values()].filter((e) => e.layer === 'MEP-RESERVATIONS' && e.type === 'TEXT').map((e) => e.text);
  assert.deepEqual(resa, ['R 550×350', 'R 550×350'], 'deux réservations (mur double regroupé + cloison du bloc), section + calorifuge + jeu');
  const list = findReservations([doc.get(duct.id)], [{ type: 'LINE', layer: 'A-MURS', p1: [3000, -9, 0], p2: [3000, 9, 0] }, { type: 'LINE', layer: 'A-MURS', p1: [3200, -9, 0], p2: [3200, 9, 0] }]);
  assert.equal(list.length, 1);
  assert.near(list[0].thickness, 200, 1e-9);
  assert.point(list[0].p, [3100, 0], 1e-9);
});

test('MEP : raccordements maintenus (piquage suit la gaine déplacée, prolongement suit l’étirement, un seul annuler)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '5000,0', '5000,4000', '');
  const [main, branch] = [...doc.entities.values()];
  assert.point(doc.get(branch.id).pts[0], [5000, 300], 1e-6);
  editor.setSelection([main.id]);
  await run('M', '0,0', '0,-1000');
  assert.point(doc.get(branch.id).pts[0], [5000, -700], 1e-6, 'le piquage suit la paroi déplacée');
  assert.point(doc.get(branch.id).pts[1], [5000, 4000], 1e-6, 'l’autre extrémité ne bouge pas');
  doc.undo();
  assert.point(doc.get(branch.id).pts[0], [5000, 300], 1e-6, 'un seul annuler pour les deux');
  // Prolongement bout à bout : étirer l'extrémité de A emmène le début de B.
  const d2 = fresh();
  await run('GA', 'SOUF', '400x200', '2700', '0,5000', '5000,5000', '');
  await run('GA', 'SOUF', '300x200', '2700', '5000,5000', '9000,5000', '');
  const [A, B] = [...d2.entities.values()];
  d2.transaction('étirer', () => d2.update({ ...d2.get(A.id), pts: [[0, 5000], [6000, 5000]] }));
  assert.point(d2.get(B.id).pts[0], [6000, 5000], 1e-6);
  editor.settings.osnap = true;
});

test('MEP : raccordements — réseau coupé en deux (rien ne bouge) et section agrandie (piquage recalé)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '600x300', '2700', '10000,0', '14000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '7000,0', '7000,4000', '');
  const [A, B, C] = [...doc.entities.values()];
  assert.point(doc.get(C.id).pts[0], [7000, 300], 1e-6);
  // Coupure de A en deux morceaux : le prolongement B et le piquage C (sur le 2e morceau) restent en place.
  doc.transaction('couper', () => {
    const a = doc.get(A.id);
    doc.update({ ...a, pts: [[0, 0], [5000, 0]] });
    const { id, ...rest } = a;
    doc.add({ ...rest, pts: [[5000, 0], [10000, 0]] });
  });
  assert.point(doc.get(B.id).pts[0], [10000, 0], 1e-6, 'prolongement inchangé');
  assert.point(doc.get(C.id).pts[0], [7000, 300], 1e-6, 'piquage inchangé');
  doc.undo();
  // Section agrandie 600 → 800 : le piquage recule sur la nouvelle paroi.
  doc.transaction('section', () => { const a = doc.get(A.id); doc.update({ ...a, mep: { ...a.mep, w: 800 } }); });
  assert.point(doc.get(C.id).pts[0], [7000, 400], 1e-6, 'piquage sur la paroi agrandie');
  editor.settings.osnap = true;
});

test('Propriétés MEP : vitesse juste pour un dessin en mètres', async () => {
  const { geometryRows } = await import('../src/ui/panels.js');
  const doc = fresh();
  doc.header = { ...(doc.header || {}), insunits: 6 };
  const e = { type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [5, 0]], mep: { kind: 'pipe', system: 'EF', d: 0.032, q: 0.5, z: 0 } };
  const html = geometryRows(e, doc);
  const m = html.match(/Vitesse \(m\/s\)<\/label><span class="ro">([\d,]+)/);
  assert.ok(m, html);
  assert.equal(m[1], '0,62', '0,5 l/s dans Ø32 mm');
  const duct = { type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [5, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 0.4, h: 0.2, q: 1152, z: 0 } };
  assert.ok(geometryRows(duct, doc).includes('>4,00<'), '1152 m³/h dans 400×200 : 4 m/s');
});

test('MEP : raccordements en cascade (piquage sur un prolongement étiré)', async () => {
  const G = await import('../src/core/geom.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '600x300', '2700', '10000,0', '20000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '15000,0', '15000,4000', '');
  editor.settings.osnap = true;
  const [A, C, B] = [...doc.entities.values()];
  assert.point(doc.get(B.id).pts[0], [15000, 300], 1e-6);
  doc.transaction('déplacer', () => doc.update({ ...doc.get(A.id), pts: [[0, -1000], [10000, -1000]] }));
  const c = doc.get(C.id), b = doc.get(B.id);
  assert.point(c.pts[0], [10000, -1000], 1e-6, 'prolongement étiré');
  const d = G.closestOnSegment(b.pts[0], c.pts[0], c.pts[1]).d;
  assert.near(d, 300, 1, 'piquage recalé sur la paroi du prolongement étiré');
  assert.point(b.pts[1], [15000, 4000], 1e-6);
  doc.undo();
  assert.point(doc.get(B.id).pts[0], [15000, 300], 1e-6, 'un seul annuler');
  assert.point(doc.get(C.id).pts[0], [10000, 0], 1e-6);
});

test('SUPPORTS : entraxes, positions (extrémités, coudes), remplacement, métré, DXF', async () => {
  const S = await import('../src/mep/supports.js');
  assert.equal(S.supportSpacing({ kind: 'duct', shape: 'rect', w: 400, h: 200 }), 3);
  assert.equal(S.supportSpacing({ kind: 'duct', shape: 'rect', w: 1200, h: 400 }), 2.4);
  assert.equal(S.supportSpacing({ kind: 'tray', w: 300 }), 1.5);
  assert.equal(S.supportSpacing({ kind: 'pipe', system: 'EF', d: 16 }), 1.5);
  assert.equal(S.supportSpacing({ kind: 'pipe', system: 'CH-D', d: 12 }), 1.25);
  assert.equal(S.supportSpacing({ kind: 'pipe', system: 'EU', d: 100 }), 1);
  assert.equal(S.supportSpacing({ kind: 'pipe', system: 'EU', d: 40 }), 0.5);
  // Gaine droite de 10 m : 30 cm des bouts, 4 intervalles ≤ 3 m.
  const straight = { type: 'LWPOLYLINE', pts: [[0, 0], [10000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200 } };
  assert.deepEqual(S.supportPositions(straight).map((s) => Math.round(s.p[0])), [300, 2650, 5000, 7350, 9700]);
  // Coude à 90° (rayon 400) : supports à 30 cm de la fin du coude de chaque côté.
  const elbow = { type: 'LWPOLYLINE', pts: [[0, 0], [6000, 0], [6000, 4000]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200 } };
  const pos = S.supportPositions(elbow).map((s) => s.p.map(Math.round));
  assert.deepEqual(pos, [[300, 0], [2800, 0], [5300, 0], [6000, 700], [6000, 3700]]);
  // Dessin en mètres : mêmes positions, en m.
  const m = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 0.4, h: 0.2 } };
  assert.near(S.supportPositions(m, 1000)[0].p[0], 0.3, 1e-9);
  assert.equal(S.supportPositions(m, 1000).length, 5);

  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '');
  await run('SUPPORTS', 'Tous', '0');
  editor.settings.osnap = true;
  const sups = () => [...doc.entities.values()].filter(S.isSupport);
  assert.equal(sups().length, 5);
  const s0 = sups()[0];
  assert.equal(s0.layer, 'MEP-SUPPORTS');
  assert.equal(s0.mep.type, 'Suspente trapèze');
  assert.near(s0.sy, 400 + 100, 1e-9, 'traverse : largeur + 2 × 50 mm');
  assert.ok(doc.blocks.has('CV_SUPPORT'));
  // Relancer avec un entraxe imposé de 2 m : les anciens supports sont remplacés.
  await run('SUPPORTS', 'Tous', '2');
  assert.equal(sups().length, 6);
  doc.undo();
  assert.equal(sups().length, 5, 'annuler revient aux 5 supports');
  const { quantities } = await import('../src/mep/commands.js');
  const q = quantities(doc).find((r) => r.type.startsWith('Support'));
  assert.equal(q.count, 5);
  assert.equal(q.section, '400×200');
  // DXF : paramètres conservés.
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  await fetch('/__out/supports.dxf', { method: 'POST', body: text });
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const bs = [...back.entities.values()].filter(S.isSupport);
  assert.equal(bs.length, 5);
  assert.equal(bs[0].mep.type, 'Suspente trapèze');
  assert.near(bs[0].sy, 500, 1e-6);
});

test('SUPPORTS : jonction bout à bout sans doublon (demi-entraxe de chaque côté)', async () => {
  const S = await import('../src/mep/supports.js');
  const mep = { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200 };
  const a = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [5000, 0]], mep };
  const b = { id: 2, type: 'LWPOLYLINE', pts: [[5000, 0], [10000, 0]], mep: { ...mep, w: 300 } };
  assert.deepEqual(S.joinedEnds(a, [a, b]), [false, true]);
  const pipe = { id: 3, type: 'LWPOLYLINE', pts: [[0, 0], [3000, 0]], mep: { kind: 'pipe', system: 'EF', d: 22, ins: 9 } };
  assert.near(S.supportEntities(pipe)[0].sy, 22 + 18 + 60, 1e-9, 'collier : diamètre + calorifuge + jeu');
  const xs = [...S.supportEntities(a, 1, 0, [a, b]), ...S.supportEntities(b, 1, 0, [a, b])].map((s) => Math.round(s.p[0]));
  assert.deepEqual(xs, [300, 1900, 3500, 6500, 8100, 9700]);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  assert.ok(Math.max(...gaps) <= 3000, `entraxes ${gaps}`);
});

test('PENTE : réseau d’évacuation en pente depuis le rejet, fils d’eau alignés, coupe / interférences / étiquette', async () => {
  const Sy = await import('../src/mep/systems.js');
  const e0 = { type: 'LWPOLYLINE', pts: [[0, 0], [1000, 0], [1000, 1000]], mep: { kind: 'pipe', system: 'EU', d: 100, z: 100, z1: 120 } };
  assert.near(Sy.slopeOf(e0), 0.01, 1e-12);
  assert.deepEqual(Sy.vertexZ(e0), [100, 110, 120]);
  assert.equal(Sy.slopeText(e0), '1 %');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'EU', '100', '0', '0,0', '10000,0', '');
  await run('CA', 'EU', '50', '0', '5000,0', '5000,3000', '');
  const [col, br] = [...doc.entities.values()];
  await run('PENTE');
  await clickAt([200, 0]);
  editor.submit('-500'); await tick();
  editor.submit('1'); await tick(); await tick();
  editor.settings.osnap = true;
  const c = doc.get(col.id), b = doc.get(br.id);
  assert.near(c.mep.z, -500, 1e-9, 'point bas au rejet');
  assert.near(c.mep.z1, -400, 1e-9, '10 m à 1 %');
  // Branchement au milieu du collecteur : axe du collecteur à x = 5000 → −450 ; fils d'eau alignés : −450 − 50 + 25.
  assert.near(b.mep.z, -475, 1e-9);
  assert.near(b.mep.z1, -475 + 30, 1e-9, '3 m à 1 %');
  assert.equal(Sy.slopeText(c), '1 %');
  // Étiquette du réseau : pente affichée.
  const parts = renderer.cache.get(c.id).parts;
  assert.ok(parts.some((p) => p.texts.some((t) => t.lines[0].includes('pente 1 %'))), 'étiquette');
  doc.undo();
  assert.equal(doc.get(col.id).mep.z1, undefined, 'un seul annuler');
  doc.redo();
  // Coupe à x = 2000 : altitude interpolée (−480).
  const { sectionEntities } = await import('../src/mep/section.js');
  const sec = sectionEntities([doc.get(col.id)], [2000, -1000], [2000, 1000], { base: [0, 0], depth: 10, textH: 50, unitM: 0.001 });
  const circ = sec.find((x) => x.type === 'CIRCLE');
  assert.near(circ.c[1], -480, 1e-6, 'coupe : axe à −0,48 m');
  assert.ok(sec.some((x) => x.type === 'TEXT' && x.text === 'Z -0,48'), 'cote d’altitude de la coupe');
  // Interférences : une gaine horizontale à −380 (100 de haut) ne touche le collecteur que du côté haut.
  const { findClashes } = await import('../src/mep/clash.js');
  const duct = { id: 999, type: 'LWPOLYLINE', pts: [[9000, -1000], [9000, 1000]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 200, h: 100, z: -380 } };
  assert.equal(findClashes([doc.get(col.id), duct]).length, 1, 'en pente, le collecteur atteint la gaine côté haut');
  const duct2 = { ...duct, pts: [[1000, -1000], [1000, 1000]] };
  assert.equal(findClashes([doc.get(col.id), duct2]).length, 0, 'côté bas, le collecteur passe dessous');
  // Vue 3D : cylindre incliné (axe à −500 au rejet, −400 au bout).
  const { buildMep3d } = await import('../src/mep/mep3d.js');
  const THREE = await import('three');
  const g3 = buildMep3d([doc.get(col.id)], () => 0x888888, { x: 0, y: 0, z: 0 });
  const mesh = (g3.group || g3).children.find((x) => x.isMesh);
  const pos = mesh.geometry.attributes.position;
  let zl = -Infinity, zr = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getX(i) < 100) zl = Math.max(zl, pos.getZ(i));
    if (pos.getX(i) > 9900) zr = Math.max(zr, pos.getZ(i));
  }
  assert.near(zl, -450, 1, '3D : dessus au rejet');
  assert.near(zr, -350, 1, '3D : dessus au point haut');
  assert.ok(THREE.REVISION);
});

test('METRE : pièces de forme (coudes par angle, réductions, piquages, tés)', async () => {
  const { fittings } = await import('../src/mep/fabrication.js');
  const { quantities } = await import('../src/mep/commands.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '10000,5000', '');
  await run('GA', 'SOUF', '300x200', '2700', '5000,0', '5000,3000', '');
  await run('GA', 'SOUF', '400x300', '2700', '10000,5000', '10000,9000', '13000,12000', '');
  await run('CA', 'EF', '20', '2500', '0,-2000', '8000,-2000', '');
  await run('CA', 'EF', '14', '2500', '4000,-2000', '4000,-4000', '');
  editor.settings.osnap = true;
  const f = fittings([...doc.entities.values()]).map((x) => `${x.system}|${x.type}|${x.section}|${x.count}`);
  assert.deepEqual(f, [
    'EF|Té|Ø14 sur Ø20|1',
    'SOUF|Coude 45°|400×300|1',
    'SOUF|Coude 90°|600×300|1',
    'SOUF|Piquage|300×200 sur 600×300|1',
    'SOUF|Réduction|600×300 → 400×300|1',
  ]);
  const rows = quantities(doc).filter((r) => r.fitting);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.count === 1 && r.length === 0));
});

test('MEP : raccordements — sélection modifiée ensemble, piquage sur un coude, ordre indifférent, pente conservée', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('GA', 'SOUF', '300x200', '2700', '5000,0', '5000,3000', '');
  const [main, br] = [...doc.entities.values()];
  assert.point(doc.get(br.id).pts[0], [5000, 300], 1e-6);
  // Largeur changée sur la gaine ET le piquage (même transaction) : le piquage est recalé quand même.
  doc.transaction('props', () => {
    doc.update({ ...doc.get(main.id), mep: { ...doc.get(main.id).mep, w: 800 } });
    doc.update({ ...doc.get(br.id), mep: { ...doc.get(br.id).mep, w: 400 } });
  });
  assert.point(doc.get(br.id).pts[0], [5000, 400], 1e-6, 'piquage sur la nouvelle paroi');
  // Piquage sur un coude intérieur d'une canalisation.
  const d2 = fresh();
  await run('CA', 'EF', '20', '2500', '0,0', '1000,0', '2000,0', '');
  await run('CA', 'EF', '16', '2500', '1000,0', '1000,800', '');
  const [m2, b2] = [...d2.entities.values()];
  d2.transaction('dépl', () => d2.update({ ...d2.get(m2.id), pts: d2.get(m2.id).pts.map((p) => [p[0], p[1] - 500]) }));
  assert.point(d2.get(b2.id).pts[0], [1000, -500], 1e-6, 'le piquage suit');
  // Trois canalisations au même point : l'étirement de A emmène B1 et B2, quel que soit l'ordre.
  const d3 = fresh();
  await run('CA', 'EF', '20', '2500', '0,0', '1000,0', '');
  await run('CA', 'EF', '20', '2500', '1000,0', '2000,0', '');
  await run('CA', 'EF', '16', '2500', '1000,0', '1000,800', '');
  const [A, B1, B2] = [...d3.entities.values()];
  d3.transaction('étirer', () => d3.update({ ...d3.get(A.id), pts: [[0, 0], [900, 0]] }));
  assert.point(d3.get(B1.id).pts[0], [900, 0], 1e-6);
  assert.point(d3.get(B2.id).pts[0], [900, 0], 1e-6);
  // Pente conservée : coupure et ajustement d'une canalisation EU de 10 m à 1 %.
  const d4 = fresh();
  await run('CA', 'EU', '100', '0', '0,0', '10000,0', '');
  const [eu] = [...d4.entities.values()];
  d4.transaction('pente', () => d4.update({ ...d4.get(eu.id), mep: { ...d4.get(eu.id).mep, z: 0, z1: 100 } }));
  const { breakEntity } = await import('../src/core/path.js');
  d4.transaction('couper', () => {
    const e = d4.get(eu.id);
    const parts = breakEntity(e, [5000, 0], [5000, 0]);
    d4.remove(e.id);
    for (const x of parts) d4.add(x);
  });
  const pieces = [...d4.entities.values()].sort((a, b) => a.pts[0][0] - b.pts[0][0]);
  assert.deepEqual(pieces.map((x) => [Math.round(x.mep.z), Math.round(x.mep.z1)]), [[0, 50], [50, 100]], 'coupure : pente continue');
  d4.transaction('ajuster', () => d4.update({ ...d4.get(pieces[1].id), pts: [[5000, 0], [8000, 0]] }));
  assert.near(d4.get(pieces[1].id).mep.z1, 80, 1e-9, 'raccourcie : altitude de fin sur la pente');
  editor.settings.osnap = true;
});

test('Relecture : interférences en pente sur un recouvrement, coupe d’un réseau presque parallèle, supports', async () => {
  const { findClashes } = await import('../src/mep/clash.js');
  const A = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [10000, 0]], mep: { kind: 'pipe', system: 'EF', d: 100, z: 2500 } };
  const B = { id: 2, type: 'LWPOLYLINE', pts: [[0, 0], [10000, 0]], mep: { kind: 'pipe', system: 'CH-D', d: 100, z: 2700, z1: 2300 } };
  assert.equal(findClashes([A, B]).length, 1, 'B descend à travers A vers x = 5 m');
  const B2 = { ...B, mep: { ...B.mep, z: 2700, z1: 2650 } };
  assert.equal(findClashes([A, B2]).length, 0, 'toujours au-dessus : pas de conflit');
  // Coupe : tronçon qui croise la coupe à 2° → vu en élévation (pas supprimé).
  const { sectionEntities } = await import('../src/mep/section.js');
  const ang = (2 * Math.PI) / 180;
  const run = { id: 3, type: 'LWPOLYLINE', layer: 'X', pts: [[-1000 * Math.cos(ang), -1000 * Math.sin(ang)], [1000 * Math.cos(ang), 1000 * Math.sin(ang)]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  const sec = sectionEntities([run], [-2000, 0], [2000, 0], { base: [0, 0], depth: 2000, textH: 50, unitM: 0.001 });
  assert.ok(sec.some((x) => x.type === 'LINE' && x.layer === 'X'), 'dessiné en élévation');
  // Supports : zone libre courte → un seul support ; altitude sur réseau en pente ; tolérance des canalisations.
  const S = await import('../src/mep/supports.js');
  const short = { type: 'LWPOLYLINE', pts: [[0, 0], [650, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200 } };
  assert.equal(S.supportPositions(short).length, 1, '650 mm : un support');
  const eu = { id: 4, type: 'LWPOLYLINE', pts: [[0, 0], [2000, 0]], mep: { kind: 'pipe', system: 'EU', d: 100, z: 0, z1: 20 } };
  const sups = S.supportEntities(eu);
  assert.ok(sups.every((x) => Math.abs(x.mep.z - x.p[0] / 100) < 1e-9), 'altitude du support sur la pente');
  const moved = { ...eu, pts: [[0, 5], [2000, 5]] };
  assert.equal(S.supportsOn(sups.map((x, i) => ({ ...x, id: 100 + i })), [moved]).length, sups.length, 'retrouvés malgré un léger décalage (Ø100)');
  const pa = { id: 5, type: 'LWPOLYLINE', pts: [[0, 0], [1000, 0]], mep: { kind: 'pipe', system: 'EF', d: 20 } };
  const pb = { id: 6, type: 'LWPOLYLINE', pts: [[1000.01, 0], [2000, 0]], mep: { kind: 'pipe', system: 'EF', d: 20 } };
  assert.deepEqual(S.joinedEnds(pa, [pa, pb]), [false, true], 'jonction de canalisations reconnue');
});

test('METRE : pièces de forme aux jonctions bout à bout (coude entre deux réseaux, té à trois réseaux)', async () => {
  const { fittings } = await import('../src/mep/fabrication.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('CA', 'EF', '32', '2500', '0,0', '1000,0', '');
  await run('CA', 'EF', '32', '2500', '1000,0', '2000,0', '');
  await run('CA', 'EF', '20', '2500', '1000,0', '1000,800', '');
  await run('CA', 'EF', '20', '2500', '1000,800', '1600,800', '');
  editor.settings.osnap = true;
  const f = fittings([...doc.entities.values()]).map((x) => `${x.type}|${x.section}|${x.count}`);
  assert.deepEqual(f, ['Coude 90°|Ø20|1', 'Té|Ø20 sur Ø32|1']);
});

test('ACCESSOIRE : registre, vanne, clapets coupe-feu aux murs, métré et DXF', async () => {
  const A = await import('../src/mep/accessories.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('CA', 'EF', '20', '2500', '0,-2000', '5000,-2000', '');
  doc.transaction('mur', () => {
    doc.addLayer('A-MUR', {});
    doc.add({ type: 'LINE', layer: 'A-MUR', p1: [5900, -1000, 0], p2: [5900, 1000, 0] });
    doc.add({ type: 'LINE', layer: 'A-MUR', p1: [6100, -1000, 0], p2: [6100, 1000, 0] });
  });
  editor.run('ACC'); await tick();
  editor.submit('r'); await tick();
  await clickAt([3000, 0]);
  editor.submit(''); await tick();
  editor.run('ACC'); await tick();
  editor.submit('v'); await tick();
  await clickAt([2000, -2000]);
  editor.submit(''); await tick();
  await run('ACC', 'm');
  editor.settings.osnap = true;
  const accs = [...doc.entities.values()].filter(A.isAccessory);
  assert.equal(accs.length, 3);
  const reg = accs.find((x) => x.mep.type === 'registre');
  assert.point(reg.p, [3000, 0], 1e-6);
  assert.near(reg.sx, 200, 1e-9); assert.near(reg.sy, 640, 1e-9);
  const ccf = accs.find((x) => x.mep.type === 'ccf');
  assert.point(ccf.p, [6000, 0], 1e-6, 'clapet au milieu du mur');
  assert.ok(accs.some((x) => x.mep.type === 'vanne' && x.mep.system === 'EF'));
  const { quantities } = await import('../src/mep/commands.js');
  const rows = quantities(doc).filter((r) => ['Registre', 'Vanne', 'Clapet coupe-feu'].includes(r.type));
  assert.equal(rows.length, 3);
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  await fetch('/__out/accessoires.dxf', { method: 'POST', body: text });
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.equal([...back.entities.values()].filter(A.isAccessory).length, 3, 'conservés en DXF');
});

test('PERTESCHARGE : les accessoires en ligne (registre, clapet coupe-feu) ajoutent ζ × pression dynamique', async () => {
  const N = await import('../src/mep/network.js');
  const A = await import('../src/mep/accessories.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '720', '10000,0', '');
  editor.settings.osnap = true;
  const duct = [...doc.entities.values()].find((e) => e.mep?.kind === 'duct');
  const calc = () => {
    const net = N.buildNetwork([...doc.entities.values()]);
    const flows = N.computeFlows(net, duct.id, 0);
    return N.pressureDrops(net, flows, duct.id, 0, { terminalDp: 0, unitMm: 1 }).max;
  };
  const dp0 = calc();
  A.ensureAccessoryBlock(doc, 'registre');
  A.ensureAccessoryBlock(doc, 'ccf');
  doc.transaction('acc', () => {
    doc.add(A.accessoryOn(doc.get(duct.id), [3000, 0], 'registre'));
    doc.add(A.accessoryOn(doc.get(duct.id), [6000, 0], 'ccf'));
  });
  const pd = N.dynamicPressure(720, doc.get(duct.id).mep);
  assert.near(calc() - dp0, (0.3 + 0.5) * pd, 1e-9, 'registre 0,3 + clapet 0,5');
  assert.ok(pd > 3 && pd < 8, `pression dynamique plausible à 2,5 m/s : ${pd}`);
});

test('Vue 3D : supports (traverse sous la gaine, tiges) et accessoires en volume', async () => {
  const S = await import('../src/mep/supports.js');
  const A = await import('../src/mep/accessories.js');
  const { buildMep3d } = await import('../src/mep/mep3d.js');
  const THREE = await import('three');
  const duct = { id: 1, type: 'LWPOLYLINE', layer: 'X', pts: [[0, 0], [3000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  const sup = { id: 2, ...S.supportEntities(duct)[0] };
  assert.equal(sup.mep.h, 200);
  const acc = { id: 3, ...A.accessoryOn(duct, [1500, 0], 'registre') };
  const box = (ents) => new THREE.Box3().setFromObject(buildMep3d(ents, () => 0x888888, { x: 0, y: 0, z: 0 }));
  const bs = box([sup]);
  assert.near(bs.min.z, 2700 - 100 - 40, 1e-6, 'traverse sous la gaine');
  assert.ok(bs.max.z > 2700 + 400, 'tiges vers le plafond');
  const ba = box([acc]);
  assert.near(ba.max.z - ba.min.z, 240, 1e-6, 'accessoire : hauteur de la gaine + 40');
  assert.near(ba.max.x - ba.min.x, 200, 1e-6, 'longueur du registre');
});

test('TABLEMETRE : tableau du métré inséré en bloc (cadre, en-têtes, lignes), conservé en DXF', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '10000,0', '10000,5000', '');
  await run('CA', 'EF', '20', '2500', '0,-2000', '5000,-2000', '');
  await run('TABLEMETRE', 'm', '100', '20000,10000');
  editor.settings.osnap = true;
  const ins = [...doc.entities.values()].find((e) => e.type === 'INSERT' && /^CV_TABLE_/.test(e.name));
  assert.ok(ins, 'tableau inséré');
  assert.point(ins.p, [20000, 10000], 1e-9);
  const blk = doc.blocks.get(ins.name);
  const texts = blk.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.ok(texts.includes('MÉTRÉ DES RÉSEAUX') && texts.includes('Désignation') && texts.includes('400×200') && texts.includes('15,00'), texts.join(' | '));
  assert.ok(blk.entities.filter((e) => e.type === 'LINE').length >= 8, 'cadre et lignes');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const text = writeDxf(doc);
  await fetch('/__out/tablemetre.dxf', { method: 'POST', body: text });
  assert.ok(text.includes('CV_TABLE_1'));
});

test('Montées / descentes : symbole en plan (une diagonale pour une montée, deux pour une descente) et tronçon vertical en 3D', async () => {
  const { mepGeometry } = await import('../src/mep/geometry.js');
  const { riseDrops } = await import('../src/mep/systems.js');
  const mep = { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 };
  const A = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [5000, 0]], mep };
  const B = { id: 2, type: 'LWPOLYLINE', pts: [[5000, 0], [9000, 0]], mep: { ...mep, z: 3200 } };
  const C = { id: 3, type: 'LWPOLYLINE', pts: [[9000, 0], [9000, 4000]], mep: { ...mep, z: 3200 } };
  assert.deepEqual(riseDrops(A, [B, C]).map((r) => [r.end, r.dz]), [[1, 500]]);
  assert.equal(riseDrops(B, [A, C]).length, 1, 'vu de B : descente vers A');
  assert.equal(riseDrops(C, [A, B]).length, 0, 'même altitude : rien');
  const near = (l, x, y) => l.pts.some((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6);
  const la = mepGeometry(A, [B, C]).lines.filter((l) => l.pts);
  assert.ok(la.some((l) => l.pts.length === 5 && near(l, 4800, -200) && near(l, 5200, 200)), 'carré à la section autour de la jonction');
  const diagonals = la.filter((l) => l.pts.length === 2 && G.dist(l.pts[0], l.pts[1]) > 500 && Math.abs(l.pts[0][0] - l.pts[1][0]) > 300);
  assert.equal(diagonals.length, 1, 'montée : une diagonale');
  assert.ok(!mepGeometry(B, [A, C]).lines.some((l) => l.pts?.length === 5), 'symbole dessiné une seule fois');
  // Descente (B plus bas que A).
  const B2 = { ...B, mep: { ...mep, z: 2200 } };
  const ld = mepGeometry(A, [B2]).lines.filter((l) => l.pts && l.pts.length === 2 && Math.abs(l.pts[0][0] - l.pts[1][0]) > 300 && Math.abs(l.pts[0][1] - l.pts[1][1]) > 300);
  assert.equal(ld.length, 2, 'descente : deux diagonales');
  // 3D : tronçon vertical de 2 700 à 3 200 à la jonction.
  const { buildMep3d } = await import('../src/mep/mep3d.js');
  const THREE = await import('three');
  const g3 = buildMep3d([A, B], () => 0x888888, { x: 0, y: 0, z: 0 });
  const box = new THREE.Box3().setFromObject(g3);
  assert.near(box.max.z, 3300, 1e-6);
  const count = (g) => g.children.find((x) => x.isMesh).geometry.attributes.position.count;
  const flat = buildMep3d([A, { ...B, mep: { ...mep } }], () => 0x888888, { x: 0, y: 0, z: 0 });
  assert.equal(count(g3) - count(flat), 36, 'une pièce verticale (boîte) de plus');
});

test('Montées / descentes dans PERTESCHARGE (hauteur + deux coudes) et dans le METRE (deux coudes à 90°)', async () => {
  const N = await import('../src/mep/network.js');
  const { fittings } = await import('../src/mep/fabrication.js');
  const doc = fresh();
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x200', '2700', '0,0', '5000,0', '');
  await run('GA', 'SOUF', '400x200', '2700', '5000,0', '9000,0', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '720', '9000,0', '');
  editor.settings.osnap = true;
  const [A, B] = [...doc.entities.values()].filter((e) => e.mep?.kind === 'duct');
  const calc = () => {
    const net = N.buildNetwork([...doc.entities.values()]);
    return N.pressureDrops(net, N.computeFlows(net, A.id, 0), A.id, 0, { terminalDp: 0, unitMm: 1 }).max;
  };
  const dp0 = calc();
  doc.transaction('monter', () => { const b = doc.get(B.id); doc.update({ ...b, z: 3700, mep: { ...b.mep, z: 3700 } }); });
  const m = doc.get(B.id).mep;
  const expected = N.frictionRate(720, m) * 1.0 + 2 * N.ZETA.elbowRadius * N.dynamicPressure(720, m);
  assert.near(calc() - dp0, expected, 1e-9, '1 m de montée + 2 coudes');
  const f = fittings([...doc.entities.values()]).filter((x) => x.type === 'Coude 90°');
  assert.equal(f.reduce((a, x) => a + x.count, 0), 2, 'deux coudes au METRE');
});

test('INTERFERENCES : rapport CSV et repères numérotés dans le dessin', async () => {
  const { clashesCsv, clashMarkers, CLASH_LAYER } = await import('../src/mep/commands.js');
  const { findClashes } = await import('../src/mep/clash.js');
  const A = { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [10000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  const B = { id: 2, type: 'LWPOLYLINE', pts: [[5000, -2000], [5000, 2000]], mep: { kind: 'pipe', system: 'EF', d: 32, z: 2700 } };
  const clashes = findClashes([A, B]);
  assert.equal(clashes.length, 1);
  const csv = clashesCsv(clashes, (id) => (id === 1 ? 'SOUF 400×200' : 'EF Ø32'));
  assert.ok(csv.startsWith('\ufeffN°;Réseau A;Réseau B'), csv);
  assert.ok(csv.includes('1;SOUF 400×200;EF Ø32;') && csv.includes(';5000;0;'), csv);
  const m = clashMarkers(clashes, 100);
  assert.equal(m.length, 2);
  assert.ok(m[0].type === 'CIRCLE' && m[0].layer === CLASH_LAYER && m[1].text === '1');
});

test('HAUTEURLIBRE : réseaux sous la hauteur libre (section, calorifuge, pente, chemin de câbles)', async () => {
  const { lowRuns } = await import('../src/mep/commands.js');
  const runs = [
    { id: 1, type: 'LWPOLYLINE', pts: [[0, 0], [1000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 300, z: 2700 } }, // dessous 2550
    { id: 2, type: 'LWPOLYLINE', pts: [[0, 0], [1000, 0]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700, ins: 50 } }, // 2550
    { id: 3, type: 'LWPOLYLINE', pts: [[0, 0], [10000, 0]], mep: { kind: 'pipe', system: 'EU', d: 100, z: 2500, z1: 2600 } }, // 2450
    { id: 4, type: 'LWPOLYLINE', pts: [[0, 0], [1000, 0]], mep: { kind: 'tray', system: 'CFO', w: 300, h: 60, z: 2600 } }, // 2600
  ];
  const low = lowRuns(runs, 2580);
  assert.deepEqual(low.map((x) => x.id), [3, 1, 2], 'du plus bas au plus haut');
  assert.near(low[0].bottom, 2450, 1e-9);
  assert.near(low[1].gap, 30, 1e-9);
  // Commande : sélection des réseaux trop bas.
  const doc = fresh();
  doc.header = { ...doc.header, insunits: 4 };
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '400x300', '2700', '0,0', '5000,0', '');
  await run('GA', 'SOUF', '400x200', '3000', '0,2000', '5000,2000', '');
  editor.settings.osnap = true;
  await run('HSP', '2.6');
  assert.equal(editor.selection.size, 1, 'une gaine sous 2,60 m');
  document.getElementById('hsp-dialog')?.close();
});

test('COUPE : murs coupés (bande hachurée sur la hauteur d’étage, face isolée en trait)', async () => {
  const { sectionEntities } = await import('../src/mep/section.js');
  const duct = { id: 1, type: 'LWPOLYLINE', layer: 'X', pts: [[1000, -1000], [1000, 1000]], mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } };
  const walls = [
    { type: 'LINE', layer: 'A-MUR', p1: [2000, -1000, 0], p2: [2000, 1000, 0] },
    { type: 'LINE', layer: 'A-MUR', p1: [2200, -1000, 0], p2: [2200, 1000, 0] },
    { type: 'LINE', layer: 'A-MUR', p1: [4000, -1000, 0], p2: [4000, 1000, 0] },
  ];
  const sec = sectionEntities([duct], [0, 0], [5000, 0], { base: [0, 0], depth: 10, textH: 50, unitM: 0.001, layer: 'C', walls });
  const band = sec.find((x) => x.type === 'LWPOLYLINE' && x.layer === 'C');
  assert.ok(band, 'bande du mur');
  assert.deepEqual(band.pts.map((p) => p.map(Math.round)), [[2000, 0], [2200, 0], [2200, 3000], [2000, 3000]], 'mur de 20 cm sur 3 m');
  assert.ok(sec.some((x) => x.type === 'LINE' && x.layer === 'C' && x.p1[0] === 4000 && x.p2[0] === 4000 && x.p2[1] === 3000), 'face isolée');
  assert.ok(sec.filter((x) => x.type === 'LINE' && x.layer === 'C' && x.p1[0] === 2000 && x.p2[0] === 2200).length >= 10, 'hachures');
});

test('RACCORDER : branchements des bouches sur la gaine la plus proche (piquage, diamètre selon le débit)', async () => {
  const N = await import('../src/mep/network.js');
  const doc = fresh();
  doc.header = { ...doc.header, insunits: 4 };
  editor.settings.osnap = false;
  await run('GA', 'SOUF', '600x300', '2700', '0,0', '10000,0', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '300', '3000,2500', '7000,-2500', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2700', '300', '9000,0', '');
  editor.settings.osnap = true;
  const main = [...doc.entities.values()].find((e) => e.mep?.kind === 'duct');
  await run('RACCORDER', 'Toutes', '3');
  const branches = [...doc.entities.values()].filter((e) => e.mep?.kind === 'duct' && e.id !== main.id);
  assert.equal(branches.length, 2, 'la bouche posée sur la gaine n’a pas de branchement');
  const b1 = branches.find((e) => e.pts[0][1] > 0);
  assert.point(b1.pts[0], [3000, 2500], 1e-6);
  assert.point(b1.pts[1], [3000, 300], 1e-6, 'arrêté sur la paroi');
  assert.equal(b1.mep.shape, 'round');
  assert.equal(b1.mep.d, 200, '300 m³/h à 3 m/s → Ø200');
  // Les débits remontent par les branchements.
  const net = N.buildNetwork([...doc.entities.values()]);
  assert.equal(N.computeFlows(net, main.id, 0).get(main.id).q, 900);
});

test('CALORIFUGEAUTO : épaisseurs selon le système et le diamètre', async () => {
  const { insulationFor } = await import('../src/mep/commands.js');
  assert.equal(insulationFor('CH-D', 20), 20);
  assert.equal(insulationFor('ECS', 40), 30);
  assert.equal(insulationFor('EG-R', 54), 25);
  assert.equal(insulationFor('EF', 20), 0, 'eau froide : rien par défaut');
  const doc = fresh();
  doc.header = { ...doc.header, insunits: 4 };
  editor.settings.osnap = false;
  await run('CA', 'CH-D', '26', '2500', '0,0', '5000,0', '');
  await run('CA', 'EF', '20', '2500', '0,1000', '5000,1000', '');
  editor.settings.osnap = true;
  await run('CALOAUTO', 'Toutes');
  const [ch, ef] = [...doc.entities.values()];
  assert.equal(doc.get(ch.id).mep.ins, 30);
  assert.ok(!doc.get(ef.id).mep.ins);
});

test('CHEMINCABLE : tronçons droits, coudes du catalogue (OBO), onglet faute de place, option Coudes', async () => {
  const { filletedAxis, elbowRadius, elbowPlan } = await import('../src/mep/geometry.js');
  const S = await import('../src/mep/supports.js');
  const { fittings } = await import('../src/mep/fabrication.js');
  const { buildMep3d } = await import('../src/mep/mep3d.js');
  const doc = fresh();
  await run('CDC', 'CFO', '300x60', '2900', '0,0', '5000,0', '5000,3000', '');
  const [e] = [...doc.entities.values()];
  assert.equal(e.mep.elbow, 'radius');
  assert.equal(e.mep.maker, 'OBO');
  assert.equal(e.mep.ri, 150, 'rayon intérieur du catalogue OBO (mm)');
  assert.equal(elbowRadius(e), 300, 'rayon d’axe = rayon intérieur + demi-largeur');
  // Bords : arc intérieur de rayon 150 (de (4700,150) à (4850,300)), arc extérieur de rayon 450, le reste droit.
  const g = mepGeometry(e);
  const inner = g.lines.map((l) => l.entity).filter(Boolean).find((x) => G.dist(x.pts[0], [0, 150]) < 1e-9);
  const k = inner.bulges.findIndex((b) => Math.abs(b) > 1e-9);
  assert.equal(inner.bulges.filter((b) => Math.abs(b) > 1e-9).length, 1, 'un seul arc : au coude');
  assert.point(inner.pts[k], [4700, 150], 1e-9);
  assert.point(inner.pts[k + 1], [4850, 300], 1e-9);

  // Tronçon de 400 entre deux coudes de 300 de tangente : le premier passe à onglet (signalé), pas de courbe continue.
  const zig = { ...e, pts: [[0, 0], [5000, 0], [5000, 400], [9000, 400]], bulges: [0, 0, 0, 0] };
  const plan = elbowPlan(zig);
  assert.deepEqual(plan.short, [1]);
  assert.deepEqual(plan.t.map(Math.round), [0, 0, 300, 0]);
  const ax = filletedAxis(zig, elbowRadius(zig));
  assert.equal(ax.bulges.filter((b) => b).length, 1, 'un seul coude à rayon');
  assert.deepEqual(ax.corners, [1], 'angle vif au premier sommet');
  const gz = mepGeometry(zig);
  assert.equal(gz.lines.length, 5, '2 bords + 2 extrémités + 1 arête de coude à onglet');
  // Les deux coudes tiennent si le tronçon fait au moins 600.
  assert.deepEqual(elbowPlan({ ...zig, pts: [[0, 0], [5000, 0], [5000, 600], [9000, 600]] }).short, []);
  // Gaine : comportement inchangé (rayon réduit si la place manque).
  assert.deepEqual(elbowPlan({ ...zig, mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 300, h: 200 } }).short, []);

  // Supports : la zone du coude n'est retirée qu'au coude à rayon.
  const lastOnFirst = (x) => Math.max(...S.supportPositions(x).filter((s) => Math.abs(s.p[1]) < 1e-9).map((s) => s.p[0]));
  assert.near(lastOnFirst(zig), 4700, 1e-6, 'onglet : support à 30 cm du sommet');
  assert.near(lastOnFirst({ ...zig, pts: [[0, 0], [5000, 0], [5000, 600], [9000, 600]] }), 4400, 1e-6, 'coude à rayon : 30 cm après la fin du coude');
  // Métré des pièces : coude à onglet distingué.
  const types = fittings([{ ...zig, id: 99 }]).map((f) => f.type).sort();
  assert.deepEqual(types, ['Coude 90°', 'Coude 90° à onglet']);
  // 3D : coude à rayon découpé en morceaux (plus de volumes qu'à onglet).
  const n3 = (x) => buildMep3d([x], () => 0x888888, { x: 0, y: 0, z: 0 }).children[0].geometry.attributes.position.count;
  assert.ok(n3(e) > n3({ ...e, mep: { ...e.mep, elbow: 'miter' } }), '3D : coude arrondi');

  // Option « Coudes » au point de départ : onglet retenu pour les chemins suivants, puis Lanz.
  await run('CDC', 'CFO', '300x60', '2900', 'C', 'Onglet', '0,8000', '5000,8000', '5000,9000', '');
  const miter = [...doc.entities.values()].at(-1);
  assert.equal(miter.mep.elbow, 'miter');
  assert.equal(miter.mep.ri, undefined);
  await run('CDC', 'CFO', '300x60', '2900', '0,12000', '5000,12000', '');
  assert.equal([...doc.entities.values()].at(-1).mep.elbow, 'miter', 'choix retenu');
  await run('CDC', 'CFO', '300x60', '2900', 'C', 'Lanz', '0,14000', '5000,14000', '');
  assert.equal([...doc.entities.values()].at(-1).mep.maker, 'LANZ');
  await run('CDC', 'CFO', '300x60', '2900', 'C', 'obo', '0,16000', '5000,16000', '');
  assert.equal([...doc.entities.values()].at(-1).mep.maker, 'OBO');
});

test('TUBE : tube électrique (système, diamètre, pose, altitude), étiquette, métré', async () => {
  const doc = fresh();
  await run('TUBE', 'TUB-CFO', '25', 'Mur', '1100', '0,0', '3000,0', '');
  const t = [...doc.entities.values()].find((e) => e.mep?.conduit);
  assert.deepEqual([t.mep.system, t.mep.d, t.mep.embed, t.mep.z, t.layer], ['TUB-CFO', 25, 'mur', 1100, 'MEP-ELEC-TUB-CFO']);
  assert.equal(mepGeometry(t).labels[0].text, 'M25 noyé en mur');
  const row = quantities(doc).find((r) => r.system === 'TUB-CFO');
  assert.deepEqual([row.type, row.section, row.length], ['Tube électrique', 'M25', 3]);
});

test('Clic droit : « Dessiner un(e) … » (AJOUTSELECT) reproduit canalisation, chemin de câbles, tube, ligne, bloc ; menu contextuel', async () => {
  const { addSelectedLabel } = await import('../src/editor/commands.js');
  const { installContextMenu } = await import('../src/ui/context-menu.js');
  const doc = fresh();
  await run('CDC', 'CFO', '400x60', '3100', '0,0', '6000,0', '');
  await run('TUBE', 'TUB-CFA', '25', 'Mur', '1200', '0,1000', '3000,1000', '');
  await run('CANALISATION', 'EF', '40', '2400', '0,2000', '4000,2000', '');
  const ents = () => [...doc.entities.values()];
  const tray = ents().find((e) => e.mep?.kind === 'tray'), tube = ents().find((e) => e.mep?.conduit), pipe = ents().find((e) => e.mep?.kind === 'pipe' && !e.mep.conduit);
  assert.equal(addSelectedLabel(editor, tray), 'un chemin de câbles CFO 400×60');
  assert.equal(addSelectedLabel(editor, tube), 'un tube TUB-CFA M25 noyé en mur');
  assert.equal(addSelectedLabel(editor, pipe), 'une canalisation EF Ø40');
  // Autres valeurs proposées par les commandes : la reproduction ne pose aucune question.
  await run('CDC', 'CFO', '200x60', '2600', '0,-5000', '1000,-5000', '');
  for (const [src, kind] of [[tray, 'tray'], [tube, 'conduit'], [pipe, 'pipe']]) {
    editor.setSelection([src.id]);
    await run('AJOUTSELECT', '10000,0', '10000,5000', '13000,5000', '');
    const e = ents().at(-1);
    assert.deepEqual([e.mep.system, e.mep.w || e.mep.d, e.mep.z, e.layer, e.pts.length], [src.mep.system, src.mep.w || src.mep.d, src.mep.z, src.layer, 3], kind);
    assert.equal(!!e.mep.conduit, kind === 'conduit');
  }
  assert.equal(ents().at(-3).mep.maker, tray.mep.maker, 'mêmes coudes');
  // Ligne : calque et couleur de l'original, calque courant rétabli ensuite.
  doc.transaction('l', () => { doc.addLayer('A-MURS', {}); doc.add({ type: 'LINE', layer: 'A-MURS', color: 3, p1: [0, 0, 0], p2: [100, 0, 0] }); });
  const line = ents().at(-1);
  editor.setSelection([line.id]);
  await run('AJOUTSELECT', '0,500', '800,500', '');
  const l2 = ents().at(-1);
  assert.deepEqual([l2.type, l2.layer, l2.color, doc.currentLayer], ['LINE', 'A-MURS', 3, '0']);
  // Bloc : même bloc et mêmes données, à la position cliquée.
  doc.transaction('b', () => { doc.setTableEntry('blocks', 'B1', { name: 'B1', base: [0, 0, 0], entities: [] }); doc.add({ type: 'INSERT', name: 'B1', layer: '0', p: [0, 0, 0], sx: 2, sy: 2, sz: 2, rot: 0, cols: 1, rows: 1, dc: 0, dr: 0, attribs: [], mep: { kind: 'terminal', terminal: 'DIFF', system: 'SOUF', q: 300 } }); });
  const ins = ents().at(-1);
  assert.equal(addSelectedLabel(editor, ins), '« Diffuseur plafonnier carré » SOUF');
  editor.setSelection([ins.id]);
  await run('AJOUTSELECT', '5000,7000', '6000,7000', '');
  const copies = ents().filter((e) => e.type === 'INSERT' && e.name === 'B1');
  assert.equal(copies.length, 3);
  assert.deepEqual([copies[1].p.slice(0, 2), copies[2].p.slice(0, 2), copies[2].sx, copies[2].mep.q], [[5000, 7000], [6000, 7000], 2, 300]);
  // Menu : « Dessiner … » en tête sur un objet ; « Répéter » dans le vide.
  const menu = installContextMenu({ editor });
  const onTray = menu.items({ ids: [tray.id] }).filter((i) => i.k);
  assert.equal(onTray[0].text, 'Dessiner un chemin de câbles CFO 400×60');
  assert.ok(['cmd:DEPLACER', 'cmd:COPIER', 'cmd:ROTATION', 'cmd:EFFACER'].every((k) => onTray.some((i) => i.k === k)));
  assert.ok(!menu.items({ ids: [tray.id, pipe.id] }).some((i) => i.k === 'cmd:AJOUTSELECT'), 'plusieurs objets : pas de « Dessiner »');
  assert.ok(menu.items({ ids: [] }).filter((i) => i.k)[0].text.startsWith('Répéter'));
  editor.ui.onContextMenu = null;
});

test('dessin en continu : CHEMINCABLE, TUBE… enchaînent les tronçons jusqu’à deux fois Entrée ou Échap', async () => {
  const doc = fresh();
  editor.run('CDC'); await tick();
  for (const x of ['CFO', '300x60', '2900', '0,0', '5000,0', '', '0,2000', '5000,2000', '5000,4000', '', '0,6000', '3000,6000']) { editor.submit(x); await tick(); }
  // Échap pendant le troisième tronçon : il est gardé, la commande s'arrête.
  editor.cancel(); await tick(); await tick();
  const trays = [...doc.entities.values()].filter((e) => e.mep?.kind === 'tray');
  assert.equal(trays.length, 3);
  assert.deepEqual(trays.map((t) => t.pts.length), [2, 3, 2]);
  assert.ok(trays.every((t) => t.mep.w === 300 && t.mep.z === 2900), 'mêmes réglages pour chaque tronçon');
  assert.ok(!editor.running);
  // Deux fois Entrée : fin.
  editor.run('TUBE'); await tick();
  for (const x of ['TUB-CFO', '20', 'Fauxplafond', '2900', '0,8000', '2000,8000', '', '0,9000', '2000,9000', '', '']) { editor.submit(x); await tick(); }
  await tick();
  const tubes = [...doc.entities.values()].filter((e) => e.mep?.conduit);
  assert.equal(tubes.length, 2);
  assert.ok(tubes.every((t) => t.mep.embed === 'fauxplafond' && t.ltype === 'DASHDOT'));
  assert.ok(!editor.running, 'deux fois Entrée terminent la commande');
});
