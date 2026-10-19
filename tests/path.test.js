// SPDX-License-Identifier: GPL-3.0-or-later
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';
import { curvesOf } from '../src/core/entities.js';
import { trimEntity, extendEntity, offsetEntity, filletLines, joinEntities, pathOf, nearestParam } from '../src/core/path.js';
import { parseCoord, matchKeyword } from '../src/editor/parse.js';

const L = (x1, y1, x2, y2) => ({ type: 'LINE', layer: '0', color: 256, p1: [x1, y1, 0], p2: [x2, y2, 0] });
const cut = (...ents) => ents.flatMap((e) => curvesOf(e));

test('saisie : coordonnées absolues, relatives, polaires, distance', () => {
  assert.deepEqual(parseCoord('10,20').p, [10, 20]);
  assert.deepEqual(parseCoord('@5,-5', [10, 10]).p, [15, 5]);
  const p = parseCoord('@10<90', [1, 1]).p;
  assert.point(p, [1, 11], 1e-12);
  assert.equal(parseCoord('12.5').value, 12.5);
  assert.equal(parseCoord('abc'), null);
  assert.equal(matchKeyword('a', ['Arc', 'Clore', 'annUler']), 'Arc');
  assert.equal(matchKeyword('u', ['Arc', 'Clore', 'annUler']), 'annUler');
  assert.equal(matchKeyword('clo', ['Arc', 'Clore', 'annUler']), 'Clore');
});

test('ajuster : couper le milieu d’une ligne entre deux coupants', () => {
  const l = L(0, 0, 10, 0);
  const r = trimEntity(l, [5, 0], cut(L(3, -1, 3, 1), L(7, -1, 7, 1)));
  assert.equal(r.length, 2);
  assert.point(r[0].p1, [0, 0]); assert.point(r[0].p2, [3, 0]);
  assert.point(r[1].p1, [7, 0]); assert.point(r[1].p2, [10, 0]);
});

test('ajuster : couper une extrémité de ligne', () => {
  const r = trimEntity(L(0, 0, 10, 0), [9, 0], cut(L(3, -1, 3, 1), L(7, -1, 7, 1)));
  assert.equal(r.length, 1);
  assert.point(r[0].p2, [7, 0]);
});

test('ajuster : un cercle coupé par une ligne devient un arc', () => {
  const c = { type: 'CIRCLE', layer: '0', color: 256, c: [0, 0, 0], r: 5 };
  const r = trimEntity(c, [0, 5], cut(L(-10, 0, 10, 0)));
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'ARC');
  // On a cliqué en haut : il reste la moitié basse (de π à 2π).
  const mid = G.polar(r[0].c, G.arcMidAngle(r[0].a0, r[0].a1), r[0].r);
  assert.point(mid, [0, -5], 1e-9);
});

test('ajuster : polyligne coupée en deux', () => {
  const pl = { type: 'LWPOLYLINE', layer: '0', color: 256, pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 0, 0], closed: false, z: 0 };
  const r = trimEntity(pl, [10, 5], cut(L(9, 3, 11, 3), L(9, 7, 11, 7)));
  assert.equal(r.length, 2);
  assert.equal(r[0].type, 'LWPOLYLINE');
  assert.deepEqual(r[0].pts.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [[0, 0], [10, 0], [10, 3]]);
  assert.point(r[1].pts[0], [10, 7]);
});

test('prolonger : une ligne jusqu’à une frontière', () => {
  const r = extendEntity(L(0, 0, 5, 0), [4, 0], cut(L(8, -1, 8, 1), L(12, -1, 12, 1)));
  assert.point(r.p2, [8, 0], 1e-9);
  assert.point(r.p1, [0, 0]);
  const r2 = extendEntity(L(0, 0, 5, 0), [1, 0], cut(L(-3, -1, -3, 1)));
  assert.point(r2.p1, [-3, 0], 1e-9);
});

test('prolonger : un arc jusqu’à une ligne', () => {
  const a = { type: 'ARC', layer: '0', color: 256, c: [0, 0, 0], r: 5, a0: 0, a1: Math.PI / 4 };
  const r = extendEntity(a, G.polar([0, 0], Math.PI / 4, 5), cut(L(-10, 5, 10, 5)));
  assert.near(r.a1, Math.PI / 2, 1e-9);
});

test('décaler : ligne, cercle, polyligne avec arc', () => {
  const l = offsetEntity(L(0, 0, 10, 0), 2, [5, 5]);
  assert.point(l.p1, [0, 2]); assert.point(l.p2, [10, 2]);
  const c = offsetEntity({ type: 'CIRCLE', c: [0, 0, 0], r: 5 }, 1, [0, 10]);
  assert.near(c.r, 6);
  const c2 = offsetEntity({ type: 'CIRCLE', c: [0, 0, 0], r: 5 }, 1, [0, 1]);
  assert.near(c2.r, 4);
  // Rectangle fermé décalé vers l'extérieur.
  const rect = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10], [0, 10]], bulges: [0, 0, 0, 0], closed: true, z: 0 };
  const big = offsetEntity(rect, 1, [-5, 5]);
  assert.ok(big.closed);
  const xs = big.pts.map((p) => p[0]), ys = big.pts.map((p) => p[1]);
  assert.near(Math.min(...xs), -1, 1e-9); assert.near(Math.max(...xs), 11, 1e-9);
  assert.near(Math.min(...ys), -1, 1e-9); assert.near(Math.max(...ys), 11, 1e-9);
  // Polyligne avec un arc (demi-cercle) : rayon de l'arc décalé.
  const pa = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 1, 0], closed: false, z: 0 };
  const off = offsetEntity(pa, 1, [5, 2]);
  const arc = pathOf(off).curves[1];
  assert.equal(arc.k, 'arc');
  assert.near(arc.r, 4, 1e-9);
});

test('raccord : coin vif et arc de rayon 2 entre deux lignes', () => {
  const a = L(0, 0, 10, 0), b = L(12, 2, 12, 10);
  const r0 = filletLines(a, [5, 0], b, [12, 8], 0);
  assert.point(r0.l1.p2, [12, 0], 1e-9);
  assert.point(r0.l2.p2, [12, 0], 1e-9);
  const r = filletLines(a, [5, 0], b, [12, 8], 2);
  assert.point(r.l1.p2, [10, 0], 1e-9);
  assert.point(r.l2.p2, [12, 2], 1e-9);
  assert.point(r.arc.c, [10, 2], 1e-9);
  assert.near(r.arc.r, 2);
});

test('joindre : trois lignes bout à bout deviennent une polyligne', () => {
  const ents = [L(0, 0, 10, 0), L(10, 10, 10, 0), L(10, 10, 0, 10)].map((e, i) => ({ ...e, id: i + 1 }));
  const r = joinEntities(ents);
  assert.equal(r.used.length, 3);
  assert.equal(r.entity.type, 'LWPOLYLINE');
  assert.equal(r.entity.pts.length, 4);
  assert.near(nearestParam(pathOf(r.entity), [10, 5]), 1.5, 1e-9);
});

test('aire : rectangle, polyligne avec arc, cercle, polygone de points', async () => {
  const { areaOf, polygonArea } = await import('../src/core/path.js');
  const rect = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 5], [0, 5]], bulges: [0, 0, 0, 0], closed: true, z: 0 };
  assert.near(areaOf(rect).area, 50, 1e-9);
  assert.near(areaOf(rect).perimeter, 30, 1e-9);
  const half = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0]], bulges: [1, 0], closed: true, z: 0 };
  assert.near(areaOf(half).area, Math.PI * 25 / 2, 1e-9);
  // Rectangle prolongé d'un demi-cercle sur le côté droit (bulge négatif, sens horaire).
  const stadium = { type: 'LWPOLYLINE', pts: [[0, 0], [0, 10], [10, 10], [10, 0]], bulges: [0, 0, -1, 0], closed: true, z: 0 };
  assert.near(areaOf(stadium).area, 100 + Math.PI * 25 / 2, 1e-9);
  assert.near(areaOf({ type: 'CIRCLE', c: [0, 0, 0], r: 2 }).area, Math.PI * 4, 1e-12);
  assert.near(polygonArea([[0, 0], [4, 0], [4, 3]]).area, 6, 1e-12);
});

test('chanfrein : deux lignes, distances 2 et 3, et rayon trop grand refusé', async () => {
  const { cornerLines } = await import('../src/core/path.js');
  const a = L(0, 0, 10, 0), b = L(12, 2, 12, 10);
  const r = cornerLines(a, [5, 0], b, [12, 8], { d1: 2, d2: 3 });
  assert.point(r.l1.p2, [10, 0], 1e-9);
  assert.point(r.l2.p2, [12, 3], 1e-9);
  assert.equal(r.link.type, 'LINE');
  assert.point(r.link.p1, [10, 0], 1e-9);
  assert.point(r.link.p2, [12, 3], 1e-9);
  assert.equal(cornerLines(a, [5, 0], b, [12, 8], { r: 50 }).error, 'trop grand');
  assert.equal(cornerLines(a, [5, 0], L(0, 5, 10, 5), [5, 5], { r: 1 }), null);
});

test('raccord / chanfrein de polylignes : un sommet, tous les sommets, retrait des raccords', async () => {
  const { cornerPolylineSegments, cornerPolylineAll, areaOf, segmentIndexAt } = await import('../src/core/path.js');
  const rect = { type: 'LWPOLYLINE', pts: [[0, 0], [20, 0], [20, 10], [0, 10]], bulges: [0, 0, 0, 0], closed: true, z: 0 };
  // Un sommet (entre les segments 0 et 1) : arc anti-horaire de rayon 2.
  const one = cornerPolylineSegments(rect, 0, 1, { r: 2 }).entity;
  assert.equal(one.pts.length, 5);
  assert.point(one.pts[1], [18, 0], 1e-9);
  assert.point(one.pts[2], [20, 2], 1e-9);
  assert.near(one.bulges[1], Math.tan(Math.PI / 8), 1e-12);
  assert.near(areaOf(one).area, 200 - (4 - Math.PI), 1e-9);
  // Sommet 0 d'une polyligne fermée (segments 3 et 0).
  assert.equal(cornerPolylineSegments(rect, 3, 0, { r: 1 }).entity.pts.length, 5);
  assert.ok(cornerPolylineSegments(rect, 0, 2, { r: 1 }).error);
  assert.equal(segmentIndexAt(rect, [20, 5]), 1);
  // Tous les sommets.
  const all = cornerPolylineAll(rect, { r: 2 });
  assert.equal(all.done, 4);
  assert.near(areaOf(all.entity).area, 200 - 4 * (4 - Math.PI), 1e-9);
  // Nouveau rayon : les anciens raccords sont remplacés ; rayon nul : coins vifs retrouvés.
  const again = cornerPolylineAll(all.entity, { r: 3 });
  assert.equal(again.entity.pts.length, 8);
  assert.near(areaOf(again.entity).area, 200 - 4 * 9 * (1 - Math.PI / 4), 1e-9);
  const sharp = cornerPolylineAll(again.entity, { r: 0 });
  assert.equal(sharp.entity.pts.length, 4);
  assert.near(areaOf(sharp.entity).area, 200, 1e-9);
  // Rayon 6 sur des petits côtés de 10 : un coin sur deux seulement (les autres sont signalés).
  const big = cornerPolylineAll(rect, { r: 6 });
  assert.equal(big.done, 2);
  assert.equal(big.tooShort, 2);
  assert.equal(cornerPolylineAll(rect, { r: 11 }).done, 0);
  // Chanfrein 1 x 1 sur tous les sommets.
  const ch = cornerPolylineAll(rect, { d1: 1, d2: 1 });
  assert.near(areaOf(ch.entity).area, 200 - 4 * 0.5, 1e-9);
  // Polyligne ouverte : seuls les sommets intérieurs.
  const open = { ...rect, closed: false };
  assert.equal(cornerPolylineAll(open, { r: 1 }).done, 2);
});

test('RACCORD entre ligne et cercle, ligne et arc, arc et arc, et coin vif (rayon 0)', async () => {
  const { filletCurves } = await import('../src/core/path.js');
  const G = await import('../src/core/geom.js');
  const deg = (a) => (G.normAngle(a) * 180) / Math.PI;
  // Ligne y = -60 sous un cercle R 50 : raccord R 20 à droite.
  const circle = { type: 'CIRCLE', layer: '0', c: [0, 0, 0], r: 50 };
  const line = { type: 'LINE', layer: '0', p1: [-200, -60, 0], p2: [200, -60, 0] };
  let r = filletCurves(line, [150, -60], circle, [40, -30], 20);
  const cx = Math.sqrt(70 * 70 - 40 * 40);
  assert.point(r.arc.c, [cx, -40], 1e-9, 'centre du raccord');
  assert.point(r.e1.p1, [cx, -60], 1e-9, 'ligne coupée au point de tangence');
  assert.point(r.e1.p2, [200, -60], 1e-9, 'côté désigné conservé');
  assert.equal(r.e2, circle, 'cercle entier');
  assert.near(G.sweep(r.arc.a0, r.arc.a1), Math.PI / 2 + Math.atan2(40, cx), 1e-9, 'arc du raccord côté coin');
  assert.ok(G.sweep(r.arc.a0, r.arc.a1) < Math.PI, 'arc le plus court');
  // Le raccord est tangent : distance centre → ligne = 20, centre → cercle = 50 + 20.
  assert.near(G.dist(r.arc.c, [0, 0]), 70, 1e-9);
  // Ligne x = 55 et demi-cercle supérieur R 50 : l'arc est raccourci du côté du point de tangence.
  const arc = { type: 'ARC', layer: '0', c: [0, 0, 0], r: 50, a0: 0, a1: Math.PI };
  const vline = { type: 'LINE', layer: '0', p1: [55, -100, 0], p2: [55, 100, 0] };
  r = filletCurves(arc, [35, 35], vline, [55, 60], 10);
  const cy = Math.sqrt(60 * 60 - 45 * 45);
  assert.point(r.arc.c, [45, cy], 1e-9);
  assert.near(deg(r.e1.a0), deg(Math.atan2(cy, 45)), 1e-6, 'début de l’arc au point de tangence');
  assert.near(deg(r.e1.a1), 180, 1e-6, 'fin inchangée');
  assert.point(r.e2.p1, [55, cy], 1e-9);
  assert.point(r.e2.p2, [55, 100], 1e-9);
  // Deux arcs sécants, rayon 0 : chacun est ramené au point d'intersection.
  const a1 = { type: 'ARC', layer: '0', c: [0, 0, 0], r: 50, a0: -Math.PI / 2, a1: Math.PI / 2 };
  const a2 = { type: 'ARC', layer: '0', c: [60, 0, 0], r: 50, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 };
  r = filletCurves(a1, [50, 0], a2, [10, 0], 0);
  assert.equal(r.arc, null);
  const X = [30, 40];
  assert.ok([r.e1.a0, r.e1.a1].some((a) => G.dist(G.polar([0, 0], a, 50), X) < 1e-6) || [r.e1.a0, r.e1.a1].some((a) => G.dist(G.polar([0, 0], a, 50), [30, -40]) < 1e-6), 'arc 1 coupé à une intersection');
  assert.ok(G.angleOnArc(0, r.e1.a0, r.e1.a1), 'arc 1 garde le côté désigné');
  assert.ok(G.angleOnArc(Math.PI, r.e2.a0, r.e2.a1), 'arc 2 garde le côté désigné');
  // Rayon impossible.
  assert.equal(filletCurves(line, [150, -60], { ...circle, r: 5 }, [3, -3], 1).error, 'aucun');
});

test('RACCORD sur une polyligne : sommet entre un segment droit et un segment courbe', async () => {
  const { cornerPolylineVertex, pathOf } = await import('../src/core/path.js');
  const G = await import('../src/core/geom.js');
  // Droite (0,0)→(100,0) puis arc (100,0)→(100,100), bulge 0,3 : coin d'environ 57°.
  const pl = { type: 'LWPOLYLINE', layer: '0', pts: [[0, 0], [100, 0], [100, 100]], bulges: [0, 0.3, 0], closed: false, z: 0 };
  const arc = G.bulgeToArc([100, 0], [100, 100], 0.3);
  const r = cornerPolylineVertex(pl, 1, { r: 10 });
  assert.ok(r.entity, r.error);
  const e = r.entity;
  assert.equal(e.pts.length, 4, 'un sommet de plus');
  assert.near(r.center[1], 10, 1e-6, 'tangent à la droite');
  assert.near(G.dist(r.center, arc.c), arc.r - 10, 1e-6, 'tangent à l’arc (intérieur)');
  assert.point(e.pts[1], [r.center[0], 0], 1e-6, 'droite raccourcie au point de tangence');
  assert.ok(e.bulges[1] > 0 && e.bulges[2] > 0 && e.bulges[2] < 0.3, 'raccord à gauche, arc restant plus court');
  assert.point(G.bulgeToArc(e.pts[1], e.pts[2], e.bulges[1]).c, r.center, 1e-6, 'bulge du raccord cohérent');
  assert.point(G.bulgeToArc(e.pts[2], e.pts[3], e.bulges[2]).c, arc.c, 1e-6, 'arc restant sur le même cercle');
  // Continuité des courbes du chemin.
  const p = pathOf(e);
  assert.equal(p.curves.length, 3);
  // Rayon impossible.
  assert.ok(cornerPolylineVertex(pl, 1, { r: 500 }).error);
});
