// SPDX-License-Identifier: GPL-3.0-or-later
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import {
  transformEntity, curvesOf, intersectCurves, gripsOf, applyGrip, snapPointsOf, polylineCurves, insertMatrix,
} from '../src/core/entities.js';
import { Document } from '../src/core/document.js';
import { Tessellator, partsBox, colorToken, strokeDashed } from '../src/core/tessellate.js';

test('entités : déplacer et tourner une ligne', () => {
  const l = { type: 'LINE', p1: [0, 0, 0], p2: [10, 0, 0] };
  const r = transformEntity(l, G.rotation(Math.PI / 2, 0, 0));
  assert.point(r.p2, [0, 10], 1e-12);
  assert.equal(r.p2[2], 0);
  assert.equal(l.p2[0], 10, 'l’original ne doit pas changer');
});

test('entités : miroir d’un arc conserve le sens anti-horaire', () => {
  const a = { type: 'ARC', c: [0, 0, 0], r: 5, a0: 0, a1: Math.PI / 2 }; // quart supérieur droit
  const m = transformEntity(a, G.mirroring([0, 0], [0, 1])); // symétrie par l’axe Y
  const s = G.polar(m.c, m.a0, m.r), e = G.polar(m.c, m.a1, m.r);
  assert.point(s, [0, 5], 1e-12);
  assert.point(e, [-5, 0], 1e-12);
});

test('entités : miroir d’une polyligne inverse les bulges', () => {
  const p = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0]], bulges: [0.5, 0], closed: false, z: 0 };
  const m = transformEntity(p, G.mirroring([0, 0], [1, 0]));
  assert.equal(m.bulges[0], -0.5);
  const mid1 = G.polar(polylineCurves(p)[0].c, G.arcMidAngle(polylineCurves(p)[0].a0, polylineCurves(p)[0].a1), polylineCurves(p)[0].r);
  const c2 = polylineCurves(m)[0];
  const mid2 = G.polar(c2.c, G.arcMidAngle(c2.a0, c2.a1), c2.r);
  assert.point(mid2, [mid1[0], -mid1[1]], 1e-9);
});

test('entités : rotation et miroir d’une insertion de bloc', () => {
  const ins = { type: 'INSERT', name: 'B', p: [10, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] };
  const r = transformEntity(ins, G.rotation(Math.PI / 2, 0, 0));
  assert.point(r.p, [0, 10], 1e-12);
  assert.near(r.rot, Math.PI / 2, 1e-12);
  const mir = transformEntity(ins, G.mirroring([0, 0], [0, 1]));
  // Le point (1, 0) du bloc doit aller en (-11, 0) : symétrie de (11, 0).
  const p = G.apply(insertMatrix(mir), 1, 0);
  assert.point(p, [-11, 0], 1e-12);
  const q = G.apply(insertMatrix(mir), 0, 1);
  assert.point(q, [-10, 1], 1e-12);
});

test('entités : intersections ligne / cercle / arc', () => {
  const l = curvesOf({ type: 'LINE', p1: [-10, 0], p2: [10, 0] })[0];
  const c = curvesOf({ type: 'CIRCLE', c: [0, 0], r: 5 })[0];
  const a = curvesOf({ type: 'ARC', c: [0, 0], r: 5, a0: 0, a1: Math.PI / 2 })[0];
  assert.equal(intersectCurves(l, c).length, 2);
  const la = intersectCurves(l, a);
  assert.equal(la.length, 1);
  assert.point(la[0], [5, 0], 1e-9);
  const short = curvesOf({ type: 'LINE', p1: [-2, 0], p2: [2, 0] })[0];
  assert.equal(intersectCurves(short, c).length, 0);
  assert.equal(intersectCurves(short, c, true).length, 2);
});

test('entités : poignées de ligne, de cercle et d’arc', () => {
  const l = { type: 'LINE', p1: [0, 0, 0], p2: [10, 0, 0] };
  const g = gripsOf(l);
  assert.equal(g.length, 3);
  assert.point(applyGrip(l, g[2], [10, 10]).p2, [10, 10]);
  assert.point(applyGrip(l, g[1], [6, 1]).p1, [1, 1]); // la poignée du milieu déplace la ligne
  const c = { type: 'CIRCLE', c: [0, 0, 0], r: 5 };
  assert.near(applyGrip(c, gripsOf(c)[1], [0, 8]).r, 8);
  const a = { type: 'ARC', c: [0, 0, 0], r: 5, a0: 0, a1: Math.PI };
  const a2 = applyGrip(a, gripsOf(a)[1], [0, 10]); // milieu tiré vers le haut
  assert.point(G.polar(a2.c, a2.a0, a2.r), [5, 0], 1e-9);
  assert.point(G.polar(a2.c, a2.a1, a2.r), [-5, 0], 1e-9);
  assert.point(G.polar(a2.c, G.arcMidAngle(a2.a0, a2.a1), a2.r), [0, 10], 1e-9);
});

test('entités : points d’accrochage', () => {
  const kinds = snapPointsOf({ type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 1, 0], closed: false }).map((s) => s.k);
  assert.deepEqual(kinds, ['end', 'end', 'end', 'mid', 'mid', 'cen']);
});

test('tessellation : bloc en cache et héritage DuBloc / calque 0', () => {
  const doc = new Document();
  doc.addLayer('ROUGE', { color: 1 });
  doc.blocks.set('B', {
    name: 'B', base: [0, 0, 0], entities: [
      { type: 'LINE', layer: '0', color: 0, p1: [0, 0, 0], p2: [1, 0, 0] },   // DuBloc, calque 0
      { type: 'LINE', layer: 'ROUGE', color: 256, p1: [0, 0, 0], p2: [0, 1, 0] }, // DuCalque, calque ROUGE
    ],
  });
  const t = new Tessellator(doc);
  const ins = { type: 'INSERT', name: 'B', layer: 'MEP', color: 3, p: [100, 0, 0], sx: 2, sy: 2, sz: 1, rot: 0, attribs: [] };
  const parts = t.entity(ins);
  const p0 = parts.find((p) => p.layer === 'MEP');
  assert.ok(p0, 'la ligne du calque 0 hérite du calque de l’insertion');
  assert.equal(p0.color, colorToken({ color: 3 }), 'DuBloc prend la couleur de l’insertion');
  assert.deepEqual(p0.segs, [100, 0, 0, 102, 0, 0]);
  const p1 = parts.find((p) => p.layer === 'ROUGE');
  assert.equal(p1.color, 'L:ROUGE');
  t.entity({ ...ins, p: [0, 0, 0] });
  assert.equal(t.blockCache.size, 1, 'la géométrie du bloc est calculée une seule fois');
  const box = partsBox(parts);
  assert.near(box.minX, 100); assert.near(box.maxX, 102); assert.near(box.maxY, 2);
});

test('types de ligne : motif tiret / espace / point le long d’une polyligne', () => {
  const segs = [];
  // Tiret 4, espace 2, point, espace 2 (longueur du motif 8) sur une ligne de 16.
  strokeDashed(segs, [[0, 0], [16, 0]], false, { dashes: [4, -2, 0, -2], total: 8 });
  const xs = [];
  for (let i = 0; i < segs.length; i += 6) xs.push([Math.round(segs[i] * 1000) / 1000, Math.round(segs[i + 3] * 1000) / 1000]);
  assert.equal(xs.length, 4);
  assert.deepEqual(xs[0], [0, 4]);
  assert.deepEqual(xs[2], [8, 12]);
  // Le motif continue d'un segment à l'autre (coin à x = 3).
  const s2 = [];
  strokeDashed(s2, [[0, 0], [3, 0], [3, 10]], false, { dashes: [4, -2], total: 6 });
  assert.near(s2[0], 0); assert.near(s2[3], 3);       // 3 unités sur le premier segment
  assert.near(s2[6], 3); assert.near(s2[10], 1, 1e-9); // puis 1 unité sur le second
});

test('types de ligne : calque en pointillés appliqué aux entités DuCalque', () => {
  const doc = new Document();
  doc.ltypes = new Map([['CACHE', { name: 'CACHE', dashes: [5, -5] }]]);
  doc.addLayer('RESEAU-REPRISE', { color: 3, ltype: 'CACHE' });
  const t = new Tessellator(doc);
  const [p] = t.entity({ type: 'LINE', layer: 'RESEAU-REPRISE', color: 256, p1: [0, 0, 0], p2: [100, 0, 0] });
  assert.equal(p.segs.length / 6, 10, 'dix tirets de 5 sur 100');
  const [q] = t.entity({ type: 'LINE', layer: 'RESEAU-REPRISE', color: 256, ltype: 'Continuous', p1: [0, 0, 0], p2: [100, 0, 0] });
  assert.equal(q.segs.length / 6, 1, 'un type de ligne explicite l’emporte sur le calque');
});

test('fenêtre de présentation : poignée de coin, contenu immobile sur la feuille', async () => {
  const { gripsOf, applyGrip } = await import('../src/core/entities.js');
  const { viewportMatrix } = await import('../src/render/viewports.js');
  const vp = { type: 'VIEWPORT', c: [100, 100, 0], w: 200, h: 100, vc: [5000, 3000], vh: 10000, twist: 0, target: [0, 0] };
  const grips = gripsOf(vp);
  assert.equal(grips.length, 5);
  const corner = grips.find((g) => g.k === 'vpc' && g.i === 2); // coin haut droit (200, 150)
  assert.point(corner.p, [200, 150], 1e-9);
  const out = applyGrip(vp, corner, [260, 180]);
  assert.point(out.c, [130, 115], 1e-9);
  assert.near(out.w, 260, 1e-9);
  assert.near(out.h / out.vh, vp.h / vp.vh, 1e-12, 'échelle conservée');
  const map = (v, x, y) => { const A = viewportMatrix(v); return [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]]; };
  assert.point(map(out, 1234, 5678), map(vp, 1234, 5678), 1e-9);
});

test('polylignes épaisses : bande pleine (aire = longueur × largeur), onglets fermés, anneau plein', async () => {
  const { Tessellator } = await import('../src/core/tessellate.js');
  const { Document } = await import('../src/core/document.js');
  const doc = new Document();
  const tess = new Tessellator(doc);
  const area = (e) => {
    let a = 0;
    for (const p of tess.entity(e)) {
      const t = p.tris;
      for (let i = 0; i + 8 < t.length; i += 9) a += Math.abs((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 6] - t[i]) * (t[i + 4] - t[i + 1])) / 2;
    }
    return a;
  };
  const base = { type: 'LWPOLYLINE', layer: '0', color: 256, z: 0 };
  assert.near(area({ ...base, pts: [[0, 0], [100, 0]], bulges: [0, 0], closed: false, width: 10 }), 1000, 1e-6);
  assert.near(area({ ...base, pts: [[0, 0], [100, 0], [100, 100], [0, 100]], bulges: [0, 0, 0, 0], closed: true, width: 10 }), 110 * 110 - 90 * 90, 1e-6, 'carré fermé, angles en onglet');
  assert.equal(area({ ...base, pts: [[0, 0], [100, 0]], bulges: [0, 0], closed: false, width: 0 }), 0, 'sans largeur : pas de bande');
  // Anneau (ANNEAU 0 / 20) : disque plein de rayon 10 (aire π × 100 à la tessellation près).
  const disc = { ...base, pts: [[-5, 0], [5, 0]], bulges: [1, 1], closed: true, width: 10 };
  assert.ok(Math.abs(area(disc) - Math.PI * 100) < Math.PI * 100 * 0.01, `aire ${area(disc)}`);
  const ring = { ...base, pts: [[-7.5, 0], [7.5, 0]], bulges: [1, 1], closed: true, width: 5 };
  assert.ok(Math.abs(area(ring) - Math.PI * (100 - 25)) < Math.PI * 75 * 0.01, `anneau ${area(ring)}`);
});

test('emprise d’un texte : rectangle du texte (plus de cercle de rayon = longueur)', async () => {
  const { Tessellator, partsBox } = await import('../src/core/tessellate.js');
  const { Document } = await import('../src/core/document.js');
  const doc = new Document();
  const t = { type: 'TEXT', layer: '0', color: 256, p: [20, 22, 0], h: 5, rot: 0, text: 'Démo MEP — plan CVC et plomberie — 1:100 (dessin créé dans CAD Viewer)', align: 'left', valign: 'baseline', wf: 1 };
  const b = partsBox(new Tessellator(doc).entity(t));
  assert.ok(b.minX >= 20 - 5 && b.minY >= 22 - 30, `boîte ${JSON.stringify(b)}`);
  assert.ok(b.maxX > 200, 'toute la largeur');
  // Texte centré tourné de 90° : la largeur part en Y.
  const r = partsBox(new Tessellator(doc).entity({ ...t, align: 'center', rot: Math.PI / 2 }));
  assert.ok(r.maxY - r.minY > 200 && r.maxX - r.minX < 60, JSON.stringify(r));
});
