// SPDX-License-Identifier: GPL-3.0-or-later
// Tests du SCU (UCS) : conversions, saisie des coordonnées (absolues, relatives, polaires, *SCG), ORTHO / POLAIRE /
// repérage dans le SCU, commandes SCU (origine, axe X, Z, objet, nommés, précédent, général) et SCUICONE, angles
// d'orientation, DXF de l'appli relu, DXF et DWG d'AutoCAD (en-tête $UCS…, table UCS).
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { toUcs, fromUcs, ucsOf, ucsFromPoints, isWorld } from '../src/core/ucs.js';
import { parseCoord } from '../src/editor/parse.js';
import { orthoPoint, polarPoint, trackPoint } from '../src/editor/snap.js';

const D30 = Math.PI / 6;
const U = { origin: [100, 50], angle: D30, name: '' };
const near = (a, b, eps = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;

test('SCU : conversions, saisie des coordonnées, ORTHO, POLAIRE et repérage alignés', () => {
  const p = fromUcs(U, [10, 0]);
  assert.ok(near(p, [100 + 10 * Math.cos(D30), 55]), `${p}`);
  assert.ok(near(toUcs(U, p), [10, 0]));
  assert.ok(isWorld({ origin: [0, 0], angle: 0 }) && !isWorld(U));
  assert.ok(near(ucsFromPoints([1, 1], [1, 5]).origin, [1, 1]));
  assert.near(ucsFromPoints([1, 1], [1, 5]).angle, Math.PI / 2, 1e-12);
  // Saisie : absolue dans le SCU, relative tournée, polaire depuis l'axe X du SCU, *x,y en coordonnées générales.
  assert.ok(near(parseCoord('10,0', null, U).p, p));
  assert.ok(near(parseCoord('@10,0', [0, 0], U).p, [10 * Math.cos(D30), 5]));
  assert.ok(near(parseCoord('10<90', null, U).p, [100 - 5, 50 + 10 * Math.cos(D30)]));
  assert.ok(near(parseCoord('@10<0', [1, 1], U).p, [1 + 10 * Math.cos(D30), 6]));
  assert.ok(near(parseCoord('*10,0', null, U).p, [10, 0]));
  assert.ok(near(parseCoord('*10<90', null, U).p, [0, 10]));
  assert.ok(near(parseCoord('3,4', null, null).p, [3, 4]), 'sans SCU : inchangé');
  // ORTHO et POLAIRE dans le SCU.
  const q = orthoPoint([0, 0], fromUcs({ origin: [0, 0], angle: D30 }, [10, 1]), D30);
  assert.ok(near(toUcs({ origin: [0, 0], angle: D30 }, q), [10, 0]), 'ortho le long de l’axe X du SCU');
  const pol = polarPoint([0, 0], [Math.cos(D30 + 0.02) * 10, Math.sin(D30 + 0.02) * 10], 45, 4, D30);
  assert.near(pol.angle, D30, 1e-12);
  const tr = trackPoint([[0, 0]], [Math.cos(D30) * 10 + 0.01, Math.sin(D30) * 10], 0.5, 90, D30);
  assert.ok(tr && near(tr.p, [Math.cos(D30) * 10, Math.sin(D30) * 10], 0.02), 'repérage le long de l’axe X du SCU');
});

test('SCU : commandes (origine et axe X, Z, objet, nommés, précédent, général), LIGNE et TEXTE dans le SCU, annulation', async () => {
  const { Renderer } = await import('../src/render/renderer.js');
  const { Editor } = await import('../src/editor/editor.js');
  const { registerCommands } = await import('../src/editor/commands.js');
  const { registerUcsCommands } = await import('../src/editor/ucs.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:400px;height:300px;';
  document.body.appendChild(host);
  const renderer = new Renderer(host);
  const out = [];
  const editor = new Editor(renderer, { print: (s) => out.push(s) });
  registerCommands(editor);
  registerUcsCommands(editor);
  const doc = new Document();
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const run = async (...xs) => { editor.run(xs[0]); await tick(); for (const x of xs.slice(1)) { editor.submit(x); await tick(); } await tick(); };
  await run('SCU', 'OR', '100,50');
  assert.ok(near(ucsOf(doc).origin, [100, 50]) && ucsOf(doc).angle === 0);
  await run('SCU', 'Z', '30');
  assert.near(ucsOf(doc).angle, D30, 1e-12);
  await run('SCU', 'N', 'E', 'BATIMENT');
  assert.equal(doc.ucsTable.get('BATIMENT').name, 'BATIMENT');
  assert.equal(ucsOf(doc).name, 'BATIMENT');
  // LIGNE : coordonnées tapées dans le SCU (comme AutoCAD : 0,0 → 10,0 donne 100,50 → 108,66,55).
  await run('LIGNE', '0,0', '10,0', '');
  const ln = [...doc.entities.values()].find((e) => e.type === 'LINE');
  assert.ok(near(ln.p1, [100, 50]) && near(ln.p2, [100 + 10 * Math.cos(D30), 55]), `${ln.p1} ${ln.p2}`);
  // TEXTE : rotation par défaut alignée sur l'axe X du SCU.
  await run('TEXTE', '0,5', '2.5', '', 'Repère', '');
  const t = [...doc.entities.values()].find((e) => e.type === 'TEXT');
  if (t) assert.near(t.rot, D30, 1e-9, 'texte aligné sur le SCU');
  // Général, précédent, restaurer, supprimer.
  await run('SCU', 'G');
  assert.ok(isWorld(ucsOf(doc)));
  await run('SCU', 'P');
  assert.equal(ucsOf(doc).name, 'BATIMENT', 'SCU précédent');
  await run('SCU', '');
  assert.ok(isWorld(ucsOf(doc)), 'Entrée : SCU général');
  await run('SCU', 'N', 'R', 'batiment');
  assert.near(ucsOf(doc).angle, D30, 1e-12);
  doc.undo();
  assert.ok(isWorld(ucsOf(doc)), 'changement de SCU annulable');
  // Origine + point de l'axe X.
  await run('SCU', '10,10', '10,20');
  assert.ok(near(ucsOf(doc).origin, [10, 10]));
  assert.near(ucsOf(doc).angle, Math.PI / 2, 1e-12);
  // Objet : ligne → origine à l'extrémité proche, axe X le long de la ligne.
  await run('SCU', 'G');
  renderer.fit({ minX: 90, minY: 40, maxX: 120, maxY: 70 });
  await run('SCU', 'OB', '*102.598,51.5');
  assert.ok(near(ucsOf(doc).origin, [100, 50]), `${ucsOf(doc).origin}`);
  assert.near(ucsOf(doc).angle, D30, 1e-9);
  await run('SCU', 'N', 'S', 'BATIMENT');
  assert.ok(!doc.ucsTable.has('BATIMENT'), 'SCU nommé supprimé');
  await run('SCUICONE', 'D');
  assert.equal(doc.header.ucsIcon.on, false);
  host.remove();
});

test('SCU : DXF de l’appli relu ; DXF et DWG d’AutoCAD (SCU courant et SCU nommés)', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const load = async (buf, name) => importDatabase(await readDrawing(buf, name)).doc;
  const doc = new Document();
  doc.transaction('x', () => {
    doc.add({ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [10, 0, 0] });
    doc.setTableEntry('ucsTable', 'AXE B', { name: 'Axe B', origin: [5, 7], angle: -0.4 });
    doc.setHeader({ ucs: { model: { origin: [100, 50], angle: D30, name: 'BATIMENT' } }, ucsIcon: { on: true, origin: false } }, { light: true });
  });
  const text = writeDxf(doc);
  assert.ok(text.includes('$UCSORG') && text.includes('AcDbUCSTableRecord'));
  const back = await load(new TextEncoder().encode(text).buffer, 'x.dxf');
  const u = ucsOf(back, 'model');
  assert.ok(near(u.origin, [100, 50]) && Math.abs(u.angle - D30) < 1e-9 && u.name === 'BATIMENT', 'SCU courant relu');
  const b = back.ucsTable.get('AXE B');
  assert.ok(b && near(b.origin, [5, 7]) && near([Math.cos(b.angle), Math.sin(b.angle)], [Math.cos(-0.4), Math.sin(-0.4)]), 'SCU nommé relu');
  for (const f of ['scu-autocad.dxf', 'scu-autocad.dwg']) {
    const d = await load(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f);
    const cu = ucsOf(d, 'model');
    assert.ok(near(cu.origin, [100, 50], 1e-6) && Math.abs(cu.angle - D30) < 1e-6, `${f} : SCU courant`);
    assert.equal(cu.name, 'BATIMENT', `${f} : nom du SCU courant`);
    assert.deepEqual([...d.ucsTable.keys()].sort(), ['BATIMENT', 'DECALE'], `${f} : SCU nommés`);
    assert.ok(near(d.ucsTable.get('DECALE').origin, [10, 20], 1e-9) && Math.abs(d.ucsTable.get('DECALE').angle) < 1e-9);
    // La ligne tracée par AutoCAD de 0,0 à 10,0 dans ce SCU.
    const l = [...d.entities.values()].find((e) => e.type === 'LINE' && near(e.p1, [100, 50], 1e-6));
    assert.ok(l && near(toUcs(cu, l.p2), [10, 0], 1e-4), `${f} : ligne dans le SCU`);
  }
});
