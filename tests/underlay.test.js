// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des fonds PDF et images (ATTACHER) : géométrie, lecture des PDF (pdf.js), affichage net au zoom,
// accrochage aux traits du PDF, DXF / DWG (écrits et relus, fichiers d'AutoCAD), tracé, PDFIMPORT.
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { findSnap } from '../src/editor/snap.js';
import { makeUnderlay, pageToWorld, worldToPage, visibleAt, underlayScale, resolvePending, pdfUnitMm, defName } from '../src/underlay/underlay.js';
import { setSourceLoader, ensureSource, nativeSize, getSource, imageDpi } from '../src/underlay/sources.js';
import { extractPage } from '../src/underlay/vectors.js';
import { importPdfVectors, fitArc, colorProps, nearestLineweight } from '../src/underlay/import.js';
import { lookPixel, lookOf } from '../src/underlay/raster.js';
import { registerUnderlayCommands } from '../src/underlay/commands.js';
import { setGeometry } from '../src/ui/panels.js';

// Fichiers des fonds : cherchés dans tests/fixtures par leur nom (chemin d'origine ignoré).
setSourceLoader(async (path) => {
  const name = String(path).split(/[\\/]/).pop();
  const r = await fetch(`./fixtures/${encodeURIComponent(name)}`).catch(() => null);
  return r?.ok ? r.arrayBuffer() : null;
});
const PDF = 'C:\\Projets\\Archi\\demo-acad.pdf';
const PNG = 'C:\\Projets\\Archi\\damier.png';
const A3 = [420.1583333, 297.0388889];

test('fonds : repère de la page, échelle comme AutoCAD, découpe (inversée), page provisoire recalée', () => {
  const doc = new Document();
  doc.header.insunits = 4;
  const e = makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [1000, 2000], scale: 50, rot: Math.PI / 6, unitMm: pdfUnitMm(doc) });
  assert.near(G.len(e.u), A3[0] * 50, 1e-6, 'largeur : mm du papier × échelle');
  assert.near(underlayScale(e, 1), 50, 1e-9);
  const w = pageToWorld(e, 0.25, 0.75);
  const st = worldToPage(e, w[0], w[1]);
  assert.point(st, [0.25, 0.75], 1e-9);
  assert.equal(defName(e), 'demo-acad - 1');
  assert.equal(pdfUnitMm({ header: { insunits: 1 } }), 25.4, 'dessin en pouces : PDF en pouces');
  const c = { ...e, clip: { pts: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]], invert: false } };
  assert.ok(visibleAt(c, 0.3, 0.3) && !visibleAt(c, 0.8, 0.8));
  const inv = { ...c, clip: { ...c.clip, invert: true } };
  assert.ok(!visibleAt(inv, 0.3, 0.3) && visibleAt(inv, 0.8, 0.8), 'découpe inversée');
  assert.ok(visibleAt({ ...c, clip: { ...c.clip, off: true } }, 0.8, 0.8), 'découpe désactivée');
  // Fond relu d'un fichier : page A3 provisoire, puis vraie taille (A4) à la même échelle et rotation.
  const pend = { ...e, native: [420, 297], pending: { scale: 50, unitMm: 1, clipLocal: [[0, 0], [100, 0], [100, 50]], clipOn: true, invert: false } };
  const r = resolvePending(pend, [297, 210]);
  assert.near(G.len(r.u), 297 * 50, 1e-6);
  assert.near(Math.atan2(r.u[1], r.u[0]), Math.PI / 6, 1e-12);
  assert.point(r.clip.pts[1], [100 / 297, 0], 1e-12, 'découpe : mm de la page → (s, t)');
  assert.ok(!r.pending);
});

test('fonds : lecture d’un PDF tracé par AutoCAD (pages, taille, calques) et d’une image (résolution)', async () => {
  const src = await ensureSource(PDF);
  assert.equal(src.status, 'ok');
  assert.equal(src.pageCount, 1);
  const size = await nativeSize(src, 1);
  assert.near(size[0], 420.158, 0.01, 'A3 paysage');
  assert.ok(src.ocg.some((g) => g.name === 'A-MURS'), 'calques du PDF = calques AutoCAD');
  const img = await ensureSource(PNG);
  assert.equal(img.status, 'ok');
  assert.deepEqual([img.width, img.height], [300, 200]);
  assert.near(img.dpi, 100, 0.1, 'résolution PNG (pHYs)');
  assert.equal(imageDpi(new Uint8Array([1, 2, 3])), null);
  const missing = await ensureSource('C:\\nulle-part\\absent.pdf');
  assert.equal(missing.status, 'missing');
});

test('fonds : réglages d’affichage (fond sombre, monochrome, estompage, blanc transparent)', () => {
  const dark = lookOf({ fade: 0, contrast: 100, adjust: true, whiteOff: true }, { dark: true, bg: 0x212830 });
  assert.deepEqual(lookPixel(0, 0, 0, 1, dark).map((v) => +v.toFixed(3)), [1, 1, 1, 1], 'noir → blanc sur fond sombre');
  assert.ok(lookPixel(1, 1, 1, 1, dark)[3] < 0.01, 'blanc du papier transparent');
  const L = lookOf({ fade: 50, contrast: 100, mono: true, adjust: true }, { dark: false, bg: 0xffffff });
  const [r, g, b] = lookPixel(1, 0, 0, 1, L);
  assert.ok(Math.abs(r - g) < 1e-9 && Math.abs(g - b) < 1e-9, 'monochrome : gris');
  assert.ok(r > 0.6, 'estompé vers le papier');
});

// Moteur de rendu et éditeur (comme un utilisateur).
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const log = [];
const editor = new Editor(renderer, { print: (m) => log.push(m) });
registerCommands(editor);
registerUnderlayCommands(editor);
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = async (cond, ms = 8000) => { const t0 = performance.now(); while (!cond() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return cond(); };
async function type(...xs) { for (const x of xs) { editor.submit(x); await tick(); } }

function fresh() {
  const doc = new Document();
  doc.header.insunits = 4;
  renderer.setDocument(doc);
  editor.setDocument(doc);
  return doc;
}

test('fonds : affichage (texture de base, détail net au zoom), cadre sélectionnable, accrochage aux traits', async () => {
  const doc = fresh();
  let e;
  doc.transaction('t', () => { e = doc.add(makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [0, 0], scale: 100, layer: '0' })); });
  renderer.fit();
  const it = () => renderer.underlays.items.get(e.id);
  assert.ok(await wait(() => it()?.base), 'texture de base prête');
  assert.ok(it().base.w >= 2048, `texture de base ≈ 200 ppp (${it().base.w} px)`);
  // Zoom fort : texture de détail de la zone visible.
  const a = pageToWorld(e, 0.5, 0.2), b = pageToWorld(e, 0.6, 0.3);
  renderer.fit({ minX: a[0], minY: a[1], maxX: b[0], maxY: b[1] });
  renderer.render(true);
  assert.ok(await wait(() => it()?.detail), 'texture de détail');
  assert.ok(it().detail.s0 <= 0.5 + 1e-9 && it().detail.s1 >= 0.6 - 1e-9, 'détail : zone visible');
  // Cadre : sélection en cliquant dessus.
  assert.equal(renderer.pick(pageToWorld(e, 0, 0.5), 50), e.id, 'cadre du fond');
  // Accrochage : extrémité et milieu d'un trait du PDF.
  await renderer.underlays.prepareSnap(e);
  const snapG = it().snap;
  let k = -1;
  for (let i = 0; i < snapG.lines.length; i += 4) {
    const L = Math.hypot(snapG.lines[i + 2] - snapG.lines[i], snapG.lines[i + 3] - snapG.lines[i + 1]);
    if (L > 0.05 && L < 0.3 && snapG.lines[i] > 0.3 && snapG.lines[i] < 0.6) { k = i; break; }
  }
  assert.ok(k >= 0);
  const p0 = pageToWorld(e, snapG.lines[k], snapG.lines[k + 1]), p1 = pageToWorld(e, snapG.lines[k + 2], snapG.lines[k + 3]);
  const modes = new Set(['end', 'mid', 'int', 'nea']);
  const s1 = findSnap({ renderer, doc, p: [p0[0] + 40, p0[1] - 30], tol: 150, modes });
  assert.equal(s1?.k, 'end');
  assert.point(s1.p, p0, 1e-6);
  const s2 = findSnap({ renderer, doc, p: [(p0[0] + p1[0]) / 2 + 20, (p0[1] + p1[1]) / 2 + 20], tol: 150, modes });
  assert.equal(s2?.k, 'mid');
  // Calque du PDF masqué : ses traits ne sont plus accrochables.
  const ocgOf = snapG.ocgNames[snapG.lineOcg[k / 4]];
  doc.transaction('t', () => doc.modify(e.id, (x) => { x.ocgOff = [ocgOf]; }));
  await renderer.underlays.prepareSnap(doc.get(e.id));
  const s3 = findSnap({ renderer, doc, p: [p0[0] + 40, p0[1] - 30], tol: 150, modes: new Set(['end']) });
  assert.ok(!s3 || G.dist(s3.p, p0) > 1e-3, `trait du calque masqué « ${ocgOf} » ignoré`);
});

test('fonds : -ATTACHER (échelle du plan), DECOUPFOND, Propriétés, annulation', async () => {
  const doc = fresh();
  editor.run('-ATTACHER');
  await tick();
  await type(PDF);
  await wait(() => editor.request?.prompt?.startsWith('Plan'));
  await type('100', '0', '0,0');
  await wait(() => [...doc.entities.values()].some((x) => x.type === 'UNDERLAY'));
  const e = [...doc.entities.values()].find((x) => x.type === 'UNDERLAY');
  assert.ok(e, 'fond joint');
  assert.near(G.len(e.u), A3[0] * 100, 0.01, 'plan au 1:100 dans un dessin en mm');
  assert.equal(e.layer, 'PDF-demo-acad', 'calque propre au fond');
  // Découpe rectangulaire (garder l'intérieur).
  editor.setSelection([e.id]);
  editor.run('DECOUPFOND');
  await tick();
  await type('R', '0,0', '21000,14850', 'I');
  await wait(() => doc.get(e.id).clip);
  const c = doc.get(e.id).clip;
  assert.ok(c && !c.invert && c.pts.length === 4, 'découpe enregistrée');
  assert.near(Math.max(...c.pts.map((q) => q[0])), 21000 / G.len(e.u), 1e-9);
  // Propriétés : échelle du plan et estompage.
  const x = structuredClone(doc.get(e.id));
  assert.ok(setGeometry(x, 'ulPlan', '50', doc));
  assert.near(G.len(x.u), A3[0] * 50, 0.01);
  assert.ok(setGeometry(x, 'ulFade', '120', doc));
  assert.equal(x.fade, 80, 'estompage limité à 80 %');
  doc.undo();
  assert.ok(!doc.get(e.id).clip, 'découpe annulée');
  editor.setSelection([]);
});

test('fonds : DXF écrit et relu (PDF tourné, découpe inversée, calques masqués, images), classes AutoCAD', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('t', () => {
    doc.addLayer('FONDS', { color: 8 });
    doc.add(makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [1000, 2000], scale: 100, rot: Math.PI / 12, layer: 'FONDS', fade: 30, mono: true, ocgOff: ['A-TEXTE'], clip: { pts: [[0.1, 0.1], [0.6, 0.15], [0.5, 0.7], [0.15, 0.6]], invert: true } }));
    doc.add(makeUnderlay({ kind: 'image', path: PNG, native: [300, 200], pixel: 0.254, p: [-50000, 0], scale: 100, layer: 'FONDS', clip: { pts: [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]], invert: false } }));
    doc.add(makeUnderlay({ kind: 'image', path: PNG, native: [300, 200], pixel: 0.254, p: [-50000, 10000], scale: 100, rot: 0.3, layer: 'FONDS', clip: { pts: [[0.1, 0.1], [0.9, 0.2], [0.5, 0.9]], invert: true } }));
  });
  const text = writeDxf(doc);
  assert.ok(/\n91\n1\n/.test(text.replace(/ +/g, '')) || text.includes(' 91\n1\n'), 'nombre d’objets des classes (sinon AutoCAD fait des proxys)');
  assert.ok(text.includes('ACAD_PDFDEFINITIONS') && text.includes('ACAD_IMAGE_DICT') && text.includes('demo-acad - 1'));
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const r4 = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
  const pick = (e) => r4({ kind: e.kind, layer: e.layer, p: e.p, u: e.u, v: e.v, clip: e.clip, fade: e.fade, mono: e.mono, adjust: e.adjust, ocgOff: e.ocgOff, whiteOff: e.whiteOff });
  const a = [...doc.entities.values()].map(pick);
  const b = [...back.entities.values()].filter((e) => e.type === 'UNDERLAY').map((e) => (e.pending ? resolvePending(e, A3) : e)).map(pick);
  assert.deepEqual(b, a);
});

test('fonds : fichiers d’AutoCAD (DXF et DWG : PDF tourné, image, découpes rectangle et inversée)', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const load = async (f) => importDatabase(await readDrawing(await (await fetch(`./fixtures/${f}`)).arrayBuffer(), f)).doc;
  for (const f of ['fonds-autocad.dxf', 'fonds-autocad.dwg']) {
    const doc = await load(f);
    const pdf = [...doc.entities.values()].find((e) => e.type === 'UNDERLAY' && e.kind === 'pdf');
    const img = [...doc.entities.values()].find((e) => e.type === 'UNDERLAY' && e.kind === 'image');
    assert.ok(pdf && img, `${f} : fond PDF et image`);
    assert.equal(pdf.path, '.\\demo-acad.pdf');
    const r = resolvePending(pdf, A3);
    assert.near(G.len(r.u), A3[0] * 2, 1e-3, `${f} : échelle 2`);
    assert.near(Math.atan2(r.u[1], r.u[0]), Math.PI / 6, 1e-9, `${f} : rotation 30°`);
    assert.point(pdf.p, [100, 200], 1e-9);
    assert.near(G.len(img.u), 300 * 127.000254, 1e-3, `${f} : image (300 pixels × taille du pixel)`);
  }
  const clips = await load('fonds-decoupes-autocad.dxf');
  const uls = [...clips.entities.values()].filter((e) => e.type === 'UNDERLAY');
  const inv = uls.find((e) => e.kind === 'pdf' && e.pending.invert);
  const rect = uls.find((e) => e.kind === 'pdf' && !e.pending.invert);
  assert.ok(inv && rect, 'découpe inversée (bit 16) et normale');
  const rr = resolvePending(rect, A3);
  assert.ok(rr.clip && !rr.clip.off, 'code 280 absent : découpe active (11 par défaut)');
  assert.near(Math.max(...rr.clip.pts.map((q) => q[0])), 210 / A3[0], 1e-6, 'découpe en mm de la page');
  const img = uls.find((e) => e.kind === 'image');
  assert.point(img.clip.pts[2], [0.5, 0.5], 1e-5, 'image : quart inférieur gauche (pixels, y vers le bas)');
});

test('fonds : tracé PDF (image sous les traits, cadre non tracé)', async () => {
  const doc = fresh();
  doc.transaction('t', () => {
    doc.add(makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [0, 0], scale: 100, layer: '0', fade: 20 }));
    doc.add({ type: 'LINE', layer: '0', color: 1, p1: [0, -1000, 0], p2: [42000, -1000, 0] });
  });
  const { plotPdf } = await import('../src/io/pdf.js');
  const r = await plotPdf(renderer, doc, { paper: 'A3', landscape: true, box: { minX: -500, minY: -2000, maxX: 42500, maxY: 30000 }, scale: null, frame: false, mono: false });
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
  assert.ok(/\/Subtype \/Image/.test(txt), 'fond rendu en image dans le PDF');
  assert.ok(txt.indexOf('/Im') >= 0 && txt.indexOf(' Do') >= 0, 'image dessinée');
  assert.equal(r.segments, 1, 'seule la ligne est un trait (cadre du fond non tracé)');
});

test('PDFIMPORT : plan tracé par AutoCAD → objets fidèles au dessin d’origine (murs, textes, calques)', async () => {
  const src = await ensureSource(PDF);
  const e = { ...makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [0, 0], scale: 100 }), id: 1 };
  const data = await extractPage(src, 1);
  const res = importPdfVectors(e, data, { layers: 'pdf' });
  assert.ok(res.counts.lines > 100 && res.counts.texts === 42, `objets : ${JSON.stringify(res.counts)}`);
  assert.ok(res.layers.has('A-MURS') && res.layers.has('MEP-CVC-SOUF'), 'calques du PDF');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const orig = importDatabase(await readDrawing(await (await fetch(`../samples/${encodeURIComponent('Démo MEP.dxf')}`)).arrayBuffer(), 'demo.dxf')).doc;
  const segsOf = (x) => (x.type === 'LINE' ? [[x.p1, x.p2]] : x.type === 'LWPOLYLINE' ? x.pts.map((p, i) => [p, x.pts[(i + 1) % x.pts.length]]).slice(0, x.closed ? undefined : -1) : []);
  const murO = [...orig.entities.values()].filter((x) => x.layer === 'A-MURS' && x.space === 'model').flatMap(segsOf);
  const murI = res.entities.filter((x) => x.layer === 'A-MURS').flatMap(segsOf);
  const minOf = (s, i) => Math.min(...s.flat().map((p) => p[i]));
  const dx = minOf(murO, 0) - minOf(murI, 0), dy = minOf(murO, 1) - minOf(murI, 1);
  let worst = 0;
  for (const [a, b] of murO) for (const p of [a, b]) {
    let best = Infinity;
    for (const [c, d] of murI) best = Math.min(best, G.distToSegment([p[0] - dx, p[1] - dy], c, d));
    worst = Math.max(worst, best);
  }
  assert.ok(worst / 100 < 0.05, `murs : écart ${(worst / 100).toFixed(3)} mm du papier (< 0,05)`);
  const t = res.entities.find((x) => x.type === 'TEXT' && x.text === 'Bureau 1');
  const o = [...orig.entities.values()].find((x) => x.type === 'TEXT' && x.text === 'Bureau 1');
  assert.equal(t.layer, 'A-TEXTE', 'texte : calque du PDF');
  assert.near(t.h, o.h, 1, 'hauteur du texte');
  assert.point([t.p[0] + dx, t.p[1] + dy], o.p, 10, 'position du texte');
  // Calque du PDF masqué : rien d'importé sur ce calque.
  const sans = importPdfVectors({ ...e, ocgOff: ['A-MURS'] }, data, { layers: 'pdf' });
  assert.ok(!sans.layers.has('A-MURS'));
});

test('PDFIMPORT : arcs reconnus, couleurs et épaisseurs', () => {
  // Quart de cercle de rayon 100 en Bézier (k = 0,5523).
  const k = 0.5522847498 * 100;
  // Une Bézier s'écarte du vrai cercle de 0,027 % du rayon : tolérance de l'import (0,05).
  const a = fitArc([100, 0], [100, k], [k, 100], [0, 100], 0.05);
  assert.ok(a, 'arc reconnu');
  assert.point(a.c, [0, 0], 1e-3);
  assert.near(a.r, 100, 1e-3);
  assert.near(a.bulge, Math.tan(Math.PI / 8), 1e-3, 'bulge d’un quart de cercle');
  assert.equal(fitArc([0, 0], [30, 80], [70, -80], [100, 0], 0.05), null, 'courbe en S : pas un arc');
  assert.deepEqual(colorProps(0x000000), { color: 7 });
  assert.deepEqual(colorProps(0xff0000), { color: 1 }, 'couleur d’index exacte');
  assert.deepEqual(colorProps(0x123456), { color: 256, rgb: 0x123456 });
  assert.equal(nearestLineweight(0.5), 50);
  assert.equal(nearestLineweight(0.17), 18);
});

test('PDFIMPORT : commande (zone entière, calques du PDF, fond gardé), annulation', async () => {
  const doc = fresh();
  let e;
  doc.transaction('t', () => { e = doc.add(makeUnderlay({ kind: 'pdf', path: PDF, native: A3, p: [0, 0], scale: 100, layer: '0' })); });
  await ensureSource(PDF);
  editor.setSelection([e.id]);
  editor.run('PDFIMPORT');
  await tick();
  await type('T', 'P', 'O');
  assert.ok(await wait(() => doc.entities.size > 300), 'objets créés');
  assert.ok(doc.get(e.id), 'fond gardé');
  assert.ok(doc.layers.has('A-MURS'));
  const n = doc.entities.size;
  doc.undo();
  assert.equal(doc.entities.size, 1, `annulé en une étape (${n} → 1)`);
  assert.ok(getSource(PDF));
});
