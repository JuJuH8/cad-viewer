// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des polices SHX : lecture des fichiers (shapes, unifont), codes de forme (vecteurs, déplacements, arcs
// d'octants et par renflement, sous-formes, échelle, pile, commandes verticales), textes dessinés en traits,
// styles de texte (DXF), comparaison avec AutoCAD sur les vraies polices (si le serveur les trouve).
import { test, assert } from './harness.js';
import { Document, defaultStyle } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { parseShx, glyph, measure, codeFor, lineStrokes } from '../src/fonts/shx.js';
import { setFontFetcher, loadShx, shxFont, isShx, fontKey } from '../src/fonts/registry.js';

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
// Police « shapes 1.0 » : formes { numéro: octets } (nom vide), informations (above, below).
function shapesFont(shapes, above = 6, below = 2) {
  const all = [[0, [above, below, 0, 0], 'TEST'], ...Object.entries(shapes).map(([k, b]) => [+k, [...b, 0], ''])];
  const head = enc('AutoCAD-86 shapes 1.0\r\n\x1a');
  const defs = all.map(([num, b, name]) => [num, [...enc(name), 0, ...b]]);
  const out = [...head];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  u16(1); u16(255); u16(defs.length);
  for (const [num, d] of defs) { u16(num); u16(d.length); }
  for (const [, d] of defs) out.push(...d);
  return new Uint8Array(out);
}
// Police « unifont 1.0 » : formes sur deux octets.
function unifont(shapes, above = 10, below = 3) {
  const out = [...enc('AutoCAD-86 unifont 1.0\r\n\x1a')];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  const info = [...enc('UNI'), 0, above, below, 0, 0, 0, 0];
  const n = Object.keys(shapes).length + 1;
  out.push(n & 255, (n >> 8) & 255, 0, 0);
  u16(info.length);
  out.push(...info);
  for (const [k, b] of Object.entries(shapes)) {
    const d = [0, ...b, 0];
    u16(+k); u16(d.length); out.push(...d);
  }
  return new Uint8Array(out);
}
const box = (strokes) => {
  const p = strokes.flat();
  return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
};
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('SHX : codes de forme (vecteurs, sous-forme, échelle, pile, déplacements, commande verticale)', () => {
  const f = parseShx(shapesFont({
    73: [1, 0x64, 2, 0x6c, 0x20], // « I » : trait vertical de 6, avance 2
    88: [7, 73, 7, 73], // « X » : deux « I » (sous-formes)
    76: [1, 0x40, 4, 2, 0x20, 3, 2, 0x20], // « L » : 4, puis ×2 → 4, puis ÷2 → 2 : 10 vers l'est
    80: [5, 1, 0x24, 6, 2, 0x40], // « P » : pile (retour au départ, plume levée)
    68: [1, 9, 2, 0, 0, 0xfe, 0, 0], // « D » : déplacements multiples (2,0) puis (0,-2)
    86: [14, 8, 5, 5, 1, 0x40], // « V » : déplacement réservé au texte vertical, sauté
  }));
  assert.equal(f.kind, 'shapes');
  assert.equal(f.above, 6);
  const I = glyph(f, 73);
  assert.deepEqual(I.strokes, [[[0, 0], [0, 6]]]);
  assert.deepEqual(I.adv, [2, 0]);
  const X = glyph(f, 88);
  assert.equal(X.strokes.length, 2);
  assert.ok(near(box(X.strokes), [0, 0, 2, 6]), 'sous-formes placées à la suite');
  assert.deepEqual(X.adv, [4, 0]);
  assert.ok(near(box(glyph(f, 76).strokes), [0, 0, 10, 0]), 'échelle ×2 puis ÷2');
  assert.deepEqual(glyph(f, 80).adv, [4, 0], 'pile : point courant rétabli');
  assert.ok(near(box(glyph(f, 68).strokes), [0, -2, 2, 0]), 'déplacements multiples (code 9)');
  assert.ok(near(box(glyph(f, 86).strokes), [0, 0, 4, 0]), 'code 14 : commande sautée');
});

test('SHX : arcs (octants dans les deux sens, fractionnaire, renflement)', () => {
  const f = parseShx(shapesFont({
    79: [2, 8, 2, 0, 1, 10, 2, 0x60, 2, 8, 3, 0], // « O » : cercle complet r = 2 partant du bas (octant 6)
    67: [2, 8, 0, 2, 1, 10, 2, 0xc4], // « C » : r = 2, depuis l'octant 4, 4 octants dans le sens horaire (bit fort)
    66: [1, 12, 4, 0, 127], // « B » : demi-cercle par renflement de (0,0) à (4,0), sens trigonométrique
    65: [1, 13, 4, 0, 127, 4, 0, 129, 0, 0], // « A » : deux demi-cercles opposés (code 13)
  }));
  const O = glyph(f, 79);
  assert.ok(near(box(O.strokes), [0, 0, 4, 4], 1e-9), 'cercle : 0 → 4');
  assert.deepEqual(O.adv.map((v) => +v.toFixed(9)), [5, 0]);
  assert.ok(near(box(glyph(f, 67).strokes), [0, 2, 4, 4], 1e-9), 'arc horaire par le haut');
  assert.ok(near(box(glyph(f, 66).strokes), [0, -2, 4, 0], 1e-9), 'renflement : arc sous la corde');
  assert.ok(near(box(glyph(f, 65).strokes), [0, -2, 8, 2], 1e-9), 'code 13 : arcs successifs');
});

test('SHX : polices Unicode (sous-formes sur deux octets), symboles, caractère absent, mesure', () => {
  const f = parseShx(unifont({
    0x49: [1, 0xa4, 2, 0xac, 0x30], // « I » : 10 de haut, avance 3
    0xd8: [7, 0, 0x49, 7, 0, 0x49], // « Ø » : deux « I » (sous-forme 0x0049 sur deux octets)
    0x3f: [1, 0x54, 2, 0x5c, 0x40], // « ? »
  }));
  assert.equal(f.kind, 'unifont');
  assert.equal(f.above, 10);
  assert.deepEqual(glyph(f, 0xd8).adv, [6, 0]);
  assert.equal(codeFor(f, 'Ø'), 0xd8);
  assert.equal(codeFor(f, '\u2205'), 0xd8, 'diamètre ⌀ : Ø de la police');
  assert.equal(codeFor(f, 'Z'), 0x3f, 'caractère absent : « ? »');
  assert.near(measure(f, 'II'), 0.6, 1e-12, 'largeur pour une hauteur de 1 (2 × 3 / 10)');
  const st = lineStrokes(f, 'I', { widthFactor: 2, oblique: Math.PI / 4 });
  assert.ok(near(st[0][1], [1, 1], 1e-12), 'oblique 45° et largeur ×2 : (0, 1) → (1, 1)');
  assert.ok(isShx('romans') && isShx('ROMANS.SHX') && !isShx('arial.ttf') && !isShx(''));
  assert.equal(fontKey('C:\\Fonts\\RomanS.shx'), 'romans');
});

// Rendu : police d'essai servie par le chargeur des tests.
const TEST_FONT = unifont({
  0x41: [1, 0x34, 0x3c, 2, 0x10], // « A » : trait 3 haut et retour, avance 1 (hauteur des majuscules 10)
  0x20: [2, 0x40],
  0x3f: [2, 0x40],
});
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);

test('SHX : textes dessinés en traits (style du texte), redessinés quand la police arrive, tracé sans police PDF', async () => {
  setFontFetcher(async (key) => (key === 'essai' ? TEST_FONT.buffer.slice(0) : null));
  try {
    const doc = new Document();
    doc.header.insunits = 4;
    doc.styles.set('ESSAI', defaultStyle({ name: 'ESSAI', font: 'essai.shx' }));
    doc.transaction('t', () => {
      doc.add({ type: 'TEXT', layer: '0', p: [0, 0, 0], h: 10, rot: 0, text: 'AAA', align: 'left', valign: 'baseline', wf: 1, style: 'ESSAI' });
      doc.add({ type: 'TEXT', layer: '0', p: [0, 50, 0], h: 10, rot: 0, text: 'AAA', align: 'left', valign: 'baseline', wf: 1 });
    });
    renderer.setDocument(doc);
    await loadShx('essai.shx');
    await new Promise((r) => setTimeout(r, 80)); // police arrivée : textes redessinés
    const [shxId, arialId] = [...doc.entities.keys()];
    const parts = renderer.cache.get(shxId).parts;
    const segs = parts.flatMap((p) => p.segs);
    assert.equal(segs.length / 6, 6, 'trois « A » = six segments');
    const t = parts.flatMap((p) => p.texts)[0];
    assert.ok(t.shx, 'élément texte gardé pour la sélection (non dessiné)');
    assert.near(t.w, 3 * 1, 1e-9, 'largeur : 3 avances de 1');
    assert.ok(!renderer.cache.get(arialId).parts.some((p) => p.segs.length), 'style Standard (Arial) : texte normal');
    const { plotPdf } = await import('../src/io/pdf.js');
    const r = await plotPdf(renderer, doc, { paper: 'A4', landscape: true, box: { minX: -10, minY: -10, maxX: 100, maxY: 70 }, scale: null, frame: false, mono: false });
    assert.equal(r.segments, 6, 'texte SHX tracé en traits');
    assert.equal(r.texts, 1, 'seul le texte Arial est écrit en police PDF');
  } finally {
    setFontFetcher(null);
  }
});

test('SHX : styles de texte écrits et relus en DXF (police, largeur, oblique, style courant)', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = new Document();
  doc.header.insunits = 4;
  doc.header.textstyle = 'NOTES';
  doc.styles.set('NOTES', defaultStyle({ name: 'NOTES', font: 'romans.shx', widthFactor: 0.8, oblique: Math.PI / 12 }));
  doc.transaction('t', () => doc.add({ type: 'TEXT', layer: '0', p: [0, 0, 0], h: 2.5, rot: 0, text: 'Bureau', align: 'left', valign: 'baseline', wf: 0.8, style: 'NOTES', obl: 0.1 }));
  const text = writeDxf(doc);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const st = back.styles.get('NOTES');
  assert.ok(st, 'style relu');
  assert.equal(st.font, 'romans.shx');
  assert.near(st.widthFactor, 0.8, 1e-9);
  assert.near(st.oblique, Math.PI / 12, 1e-9);
  const t = [...back.entities.values()][0];
  assert.equal(t.style, 'NOTES');
  assert.near(t.obl, 0.1, 1e-9);
  assert.equal(back.header.textstyle, 'NOTES');
});

test('SHX : vraies polices d’AutoCAD (si disponibles) — boîtes identiques à TEXTBOX d’AutoCAD 2024', async () => {
  // Boîtes mesurées dans AutoCAD 2024 (TEXTBOX, hauteur 10) : [xmin, ymin, xmax, ymax].
  const REF = [
    ['txt', 'AutoCAD 1234', [0, 0, 113.3333, 10]], ['txt', 'mmm,;-_()', [0, -1.6667, 70, 10]],
    ['simplex', 'Bureau 2.5m', [0, 0, 95.2381, 10]], ['simplex', 'mmm,;-_()', [0, -3.3333, 88.0952, 11.9048]],
    ['romans', 'Echelle 1:50', [1.9048, 0, 93.3333, 10]], ['romans', 'WWW iii', [0.9524, 0, 54.2857, 10]],
  ];
  let checked = 0;
  for (const [name, str, ref] of REF) {
    const font = await loadShx(`${name}.shx`);
    if (!font) continue; // police absente (AutoCAD non installé) : rien à comparer
    const p = lineStrokes(font, str).flat().map(([x, y]) => [x * 10, y * 10]);
    const b = [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
    assert.ok(near(b, ref, 1e-3), `${name} « ${str} » : ${b.map((v) => v.toFixed(4))} au lieu de ${ref}`);
    checked++;
  }
  assert.ok(checked === 0 || checked === REF.length, 'toutes les polices ou aucune');
  assert.ok(shxFont('arial.ttf') === null, 'police TrueType : pas de SHX');
});
