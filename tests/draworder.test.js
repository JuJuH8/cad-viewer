// SPDX-License-Identifier: GPL-3.0-or-later
// Tests de l'ordre de tracé (ORDRETRACE…) et des masques (MASQUE / WIPEOUT) : clés d'ordre, rendu au pixel
// (profondeur), textes effacés sous un masque, commandes, DXF de l'appli et fichiers d'AutoCAD (WIPEOUT, table de
// tri SORTENTSTABLE, WIPEOUTFRAME), tracé PDF.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { drawKey, bringToFront, sendToBack, placeAbove, placeUnder } from '../src/core/draworder.js';
import { Tessellator } from '../src/core/tessellate.js';

const line = (y, layer = '0', color = 7) => ({ type: 'LINE', layer, color, p1: [0, y, 0], p2: [100, y, 0] });
const order = (doc) => [...doc.entities.values()].sort((a, b) => drawKey(a) - drawKey(b)).map((e) => e.id);

test('ordre de tracé : premier plan, arrière-plan, au-dessus / au-dessous, nouveaux objets, annulation', () => {
  const doc = new Document();
  const ids = [];
  doc.transaction('x', () => { for (let i = 0; i < 5; i++) ids.push(doc.add(line(i)).id); });
  const [a, b, c, d, e] = ids;
  doc.transaction('o', () => bringToFront(doc, [b]));
  assert.deepEqual(order(doc), [a, c, d, e, b]);
  doc.transaction('o', () => sendToBack(doc, [d]));
  assert.deepEqual(order(doc), [d, a, c, e, b]);
  doc.transaction('o', () => placeAbove(doc, [a], [e]));
  assert.deepEqual(order(doc), [d, c, e, a, b]);
  doc.transaction('o', () => placeUnder(doc, [b, d], [c])); // ordre relatif gardé (d avant b)
  assert.deepEqual(order(doc), [d, b, c, e, a]);
  // Nouvel objet : au-dessus de tous ; une copie ne garde pas la clé de l'original.
  let f;
  doc.transaction('x', () => { f = doc.add({ ...doc.get(b), id: undefined }); });
  assert.equal(f.order, undefined);
  assert.equal(order(doc).at(-1), f.id);
  doc.undo(); doc.undo();
  assert.deepEqual(order(doc), [d, c, e, a, b], 'annulable');
  // Beaucoup d'allers-retours : renumérotation automatique, ordre toujours cohérent.
  for (let i = 0; i < 80; i++) doc.transaction('o', () => bringToFront(doc, [i % 2 ? a : c]));
  const o = order(doc);
  assert.equal(o.length, 5);
  assert.deepEqual(o.slice(-2), [c, a]);
  assert.ok(o.every((id) => drawKey(doc.get(id)) < doc.nextId), 'clés sous les futurs objets');
});

test('masque : géométrie (aplat de la couleur du fond, cadre selon WIPEOUTFRAME), transformation, poignées', async () => {
  const doc = new Document();
  let w;
  doc.transaction('x', () => { w = doc.add({ type: 'WIPEOUT', layer: '0', pts: [[0, 0], [40, 0], [10, 10]], z: 0 }); });
  const parts = () => new Tessellator(doc).entity(doc.get(w.id));
  let p = parts();
  const fill = p.find((x) => x.color === 'bg');
  assert.equal(fill.tris.length, 9, 'un triangle');
  assert.ok(p.some((x) => x.segs.length === 18 && !x.noPlot), 'cadre affiché et tracé (1, défaut)');
  doc.setHeader({ wipeoutFrame: 2 });
  p = parts();
  assert.ok(p.some((x) => x.segs.length && x.noPlot), 'cadre affiché non tracé (2)');
  doc.setHeader({ wipeoutFrame: 0 });
  assert.ok(!parts().some((x) => x.segs.length), 'cadre caché (0)');
  const { transformEntity, gripsOf, applyGrip } = await import('../src/core/entities.js');
  const G = await import('../src/core/geom.js');
  const moved = transformEntity(doc.get(w.id), G.translation(5, 5));
  assert.deepEqual(moved.pts[0], [5, 5]);
  const grips = gripsOf(doc.get(w.id));
  assert.equal(grips.length, 3);
  assert.deepEqual(applyGrip(doc.get(w.id), grips[2], [20, 30]).pts[2].slice(0, 2), [20, 30]);
});

// Rendu réel : couleur d'un pixel du dessin et du calque des textes.
async function view(doc) {
  const { Renderer } = await import('../src/render/renderer.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:200px;height:200px;';
  document.body.appendChild(host);
  const r = new Renderer(host);
  r.setTheme('dark');
  r.setDocument(doc);
  r.fit({ minX: -10, minY: -10, maxX: 110, maxY: 110 });
  const glPixel = (x, y) => {
    r.render(true);
    const gl = r.webgl.getContext();
    const [sx, sy] = r.toScreen(x, y);
    const dpr = r.canvas.width / r.width;
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(sx * dpr), Math.round(r.canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  };
  const textAlpha = (x0, y0, x1, y1) => {
    r.render(true);
    const ctx = r.textLayer.getContext('2d');
    const dpr = r.textLayer.width / r.width;
    const [ax, ay] = r.toScreen(x0, y1), [bx, by] = r.toScreen(x1, y0);
    const d = ctx.getImageData(Math.round(ax * dpr), Math.round(ay * dpr), Math.max(1, Math.round((bx - ax) * dpr)), Math.max(1, Math.round((by - ay) * dpr))).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  };
  return { r, host, glPixel, textAlpha };
}

test('ordre de tracé et masques à l’écran : aplat au-dessus / au-dessous d’un trait, texte effacé sous un masque', async () => {
  const doc = new Document();
  let ln, solid, wipe, txt;
  doc.transaction('x', () => {
    ln = doc.add({ type: 'LINE', layer: '0', color: 3, p1: [0, 50, 0], p2: [100, 50, 0] }); // vert
    solid = doc.add({ type: 'SOLID', layer: '0', color: 1, pts: [[20, 20], [40, 20], [20, 80], [40, 80]], z: 0 }); // rouge
    txt = doc.add({ type: 'TEXT', layer: '0', color: 2, p: [60, 40, 0], h: 8, rot: 0, text: 'TEXTE', align: 'left', valign: 'baseline', wf: 1 });
  });
  const { r, host, glPixel, textAlpha } = await view(doc);
  const red = (c) => c[0] > 200 && c[1] < 60, green = (c) => c[1] > 150 && c[1] > c[0];
  assert.ok(red(glPixel(30, 50)), `aplat créé après le trait : au-dessus (${glPixel(30, 50)})`);
  doc.transaction('o', () => sendToBack(doc, [solid.id]));
  assert.ok(green(glPixel(30, 50)), `aplat à l’arrière-plan : le trait passe dessus (${glPixel(30, 50)})`);
  // Masque sur le trait et le texte.
  const before = textAlpha(60, 40, 95, 48);
  assert.ok(before > 10, 'texte dessiné');
  doc.transaction('x', () => { wipe = doc.add({ type: 'WIPEOUT', layer: '0', pts: [[55, 30], [100, 30], [100, 60], [55, 60]], z: 0 }); });
  assert.ok(!green(glPixel(80, 50)), 'trait caché par le masque');
  const bg = glPixel(80, 45);
  assert.ok(Math.abs(bg[0] - 0x16) < 8 && Math.abs(bg[1] - 0x16) < 8 && Math.abs(bg[2] - 0x15) < 8, `masque de la couleur du fond sombre #161615 (${bg})`);
  assert.ok(textAlpha(60, 40, 95, 48) < before / 10, 'texte effacé sous le masque');
  doc.transaction('o', () => bringToFront(doc, [txt.id]));
  assert.ok(textAlpha(60, 40, 95, 48) > before / 2, 'texte au premier plan : visible sur le masque');
  doc.transaction('o', () => sendToBack(doc, [wipe.id]));
  assert.ok(green(glPixel(80, 50)), 'masque à l’arrière-plan : le trait réapparaît');
  // La sélection ne désigne pas le masque par son intérieur.
  assert.ok(r.pick([80, 45], 0.5) !== wipe.id, 'intérieur du masque : pas désigné');
  assert.equal(r.pick([55, 45], 0.5), wipe.id, 'désigné par son cadre');
  host.remove();
});

test('MASQUE, ORDRETRACE, HACHURESARRIERE en ligne de commande ; hachure posée derrière son contour', async () => {
  const { Renderer } = await import('../src/render/renderer.js');
  const { Editor } = await import('../src/editor/editor.js');
  const { registerCommands } = await import('../src/editor/commands.js');
  const { registerWipeoutCommands } = await import('../src/editor/wipeout.js');
  const { registerHatchCommands } = await import('../src/hatch/commands.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-3000px;top:0;width:400px;height:300px;';
  document.body.appendChild(host);
  const renderer = new Renderer(host);
  const editor = new Editor(renderer, { print: () => {} });
  registerCommands(editor);
  registerWipeoutCommands(editor);
  registerHatchCommands(editor, {});
  const doc = new Document();
  renderer.setDocument(doc);
  editor.setDocument(doc);
  editor.settings.osnap = false;
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const run = async (...xs) => { editor.run(xs[0]); await tick(); for (const x of xs.slice(1)) { editor.submit(x); await tick(); } await tick(); };
  await run('MASQUE', '0,0', '10,0', '10,10', '0,10', '');
  const w = [...doc.entities.values()].find((e) => e.type === 'WIPEOUT');
  assert.ok(w && w.pts.length === 4, 'masque créé');
  await run('MASQUE', 'C', 'Désactivés');
  assert.equal(doc.header.wipeoutFrame, 0);
  let r1;
  doc.transaction('x', () => { r1 = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[20, 0], [40, 0], [40, 20], [20, 20]], bulges: [0, 0, 0, 0], closed: true, z: 0 }); });
  await run('MASQUE', 'P', '30,0', 'Oui');
  assert.ok(!doc.get(r1.id), 'polyligne effacée');
  assert.equal([...doc.entities.values()].filter((e) => e.type === 'WIPEOUT').length, 2);
  // ORDRETRACE arrière-plan sur le dernier masque.
  const last = [...doc.entities.values()].filter((e) => e.type === 'WIPEOUT').at(-1);
  editor.setSelection([last.id]);
  await run('ORDRETRACE', 'Arrière-plan');
  assert.equal(order(doc)[0], last.id);
  // Hachure par objet : derrière son contour.
  let sq;
  doc.transaction('x', () => { sq = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[50, 0], [60, 0], [60, 10], [50, 10]], bulges: [0, 0, 0, 0], closed: true, z: 0 }); });
  editor.setSelection([]);
  await run('-HACHURES', 'Plein', 'O', '55,0', '');
  const h = [...doc.entities.values()].find((e) => e.type === 'HATCH');
  if (h) assert.ok(drawKey(h) < drawKey(doc.get(sq.id)), 'hachure sous son contour');
  await run('HACHURESARRIERE');
  if (h) assert.equal(order(doc)[0], h.id, 'hachures à l’arrière-plan');
  host.remove();
});

test('masques et ordre de tracé : DXF de l’appli relu ; DXF et DWG d’AutoCAD (WIPEOUT, SORTENTSTABLE, WIPEOUTFRAME)', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const load = async (buf, name) => importDatabase(await readDrawing(buf, name)).doc;
  // Appli : masque, cadres « affichés non tracés », ordre modifié, hachure associative (poignées réservées → table de tri).
  const doc = new Document();
  let l1, l2, w, sq;
  doc.transaction('x', () => {
    l1 = doc.add(line(0)); l2 = doc.add(line(10));
    w = doc.add({ type: 'WIPEOUT', layer: '0', pts: [[0, 0], [40, 0], [10, 10]], z: 0 });
    sq = doc.add({ type: 'LWPOLYLINE', layer: '0', pts: [[50, 0], [60, 0], [60, 10], [50, 10]], bulges: [0, 0, 0, 0], closed: true, z: 0 });
    doc.add({ type: 'HATCH', layer: '0', loops: [[[50, 0], [60, 0], [60, 10], [50, 10]]], solid: true, pattern: 'SOLID', lines: [], z: 0, assoc: { mode: 'objets', ids: [sq.id] } });
    doc.setHeader({ wipeoutFrame: 2 });
  });
  doc.transaction('o', () => { bringToFront(doc, [l1.id]); sendToBack(doc, [w.id]); });
  const sig = (d) => [...d.entities.values()].sort((a, b) => drawKey(a) - drawKey(b)).map((e) => `${e.type}:${JSON.stringify(e.p1 || e.pts?.[0] || e.loops?.[0]?.[0])}`);
  const text = writeDxf(doc);
  assert.ok(text.includes('\nWIPEOUT\n') && text.includes('SORTENTSTABLE') && text.includes('WIPEOUTFRAME'));
  const back = await load(new TextEncoder().encode(text).buffer, 'x.dxf');
  assert.equal(back.header.wipeoutFrame, 2);
  const bw = [...back.entities.values()].find((e) => e.type === 'WIPEOUT');
  assert.ok(bw.pts.every((q, i) => Math.hypot(q[0] - w.pts[i][0], q[1] - w.pts[i][1]) < 1e-9), 'contour du masque relu');
  assert.deepEqual(sig(back), sig(doc), 'ordre de tracé relu');
  // AutoCAD : hachure envoyée à l'arrière-plan, ligne y = 10 au premier plan, masque carré 40,-5 → 60,15.
  for (const f of ['masque-ordre-autocad.dxf', 'masque-ordre-autocad.dwg']) {
    const d = await load(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f);
    const o = [...d.entities.values()].filter((e) => e.space === 'model').sort((a, b) => drawKey(a) - drawKey(b));
    assert.equal(o[0].type, 'HATCH', `${f} : hachure à l’arrière-plan`);
    const top = o.at(-1);
    assert.ok(top.type === 'LINE' && top.p1[1] === 10, `${f} : ligne au premier plan`);
    const wo = o.find((e) => e.type === 'WIPEOUT');
    assert.deepEqual(wo.pts.map((q) => q.map((v) => Math.round(v * 1e6) / 1e6)), [[40, -5], [60, -5], [60, 15], [40, 15]], `${f} : contour du masque`);
    assert.equal(d.header.wipeoutFrame ?? 1, 1, `${f} : cadres affichés`);
  }
  const tri = await load(await (await fetch('./fixtures/masque-cadres-autocad.dxf')).arrayBuffer(), 'm.dxf');
  const t = [...tri.entities.values()].find((e) => e.type === 'WIPEOUT');
  assert.deepEqual(t.pts.map((q) => q.map((v) => Math.round(v * 1e6) / 1e6)), [[0, 0], [40, 0], [10, 10]], 'masque triangulaire (emprise non carrée)');
  assert.equal(tri.header.wipeoutFrame, 2, 'cadres affichés non tracés');
});

test('tracé PDF : le masque recouvre de blanc ce qui est tracé avant lui', async () => {
  const doc = new Document();
  doc.transaction('x', () => {
    doc.add(line(50));
    doc.add({ type: 'WIPEOUT', layer: '0', pts: [[40, 40], [60, 40], [60, 60], [40, 60]], z: 0 });
    doc.add(line(55));
  });
  const { r, host } = await view(doc);
  const { plotPdf } = await import('../src/io/pdf.js');
  const res = await plotPdf(r, doc, { paper: 'A4', landscape: true, box: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, mono: true });
  const pdf = await res.blob.text();
  const firstStroke = pdf.search(/\sl\s*\nS/);
  const white = pdf.search(/\n1\.?\s+g\n|\n1\.?\s+1\.?\s+1\.?\s+rg\n/);
  const lastStroke = pdf.lastIndexOf('\nS\n');
  assert.ok(firstStroke >= 0 && white > firstStroke && lastStroke > white, `ordre : trait, masque blanc, trait (${firstStroke}, ${white}, ${lastStroke})`);
  host.remove();
});
