// SPDX-License-Identifier: GPL-3.0-or-later
import { test, assert } from './harness.js';
import * as G from '../src/core/geom.js';

test('geom : rotation de 90° autour d’un point', () => {
  const m = G.rotation(Math.PI / 2, 10, 10);
  assert.point(G.apply(m, 20, 10), [10, 20]);
  assert.point(G.apply(m, 10, 10), [10, 10]);
});

test('geom : symétrie par rapport à une droite oblique', () => {
  const m = G.mirroring([0, 0], [1, 1]);
  assert.point(G.apply(m, 5, 0), [0, 5]);
  assert.ok(G.isMirror(m));
  const m2 = G.mirroring([0, 2], [10, 2]); // droite horizontale y = 2
  assert.point(G.apply(m2, 3, 5), [3, -1]);
});

test('geom : composition et inversion', () => {
  const a = G.compose(G.translation(5, -3), G.compose(G.rotation(0.7), G.scaling(2)));
  const p = G.apply(a, 1.5, -2);
  const back = G.apply(G.invert(a), p[0], p[1]);
  assert.point(back, [1.5, -2], 1e-12);
  assert.near(G.scaleOf(a), 2, 1e-12);
  assert.near(G.rotationOf(a), 0.7, 1e-12);
});

test('geom : intersection de segments et parallèles', () => {
  const x = G.segSeg([0, 0], [10, 10], [0, 10], [10, 0]);
  assert.point(x.point, [5, 5]);
  assert.equal(G.segSeg([0, 0], [10, 0], [0, 1], [10, 1]), null);
  assert.equal(G.segSeg([0, 0], [4, 4], [6, 0], [10, -4]), null);
});

test('geom : droite / cercle et cercle / cercle', () => {
  const pts = G.lineCircle([-10, 0], [10, 0], [0, 0], 5).map((r) => r.point);
  assert.equal(pts.length, 2);
  assert.point(pts[0], [-5, 0]);
  assert.point(pts[1], [5, 0]);
  const cc = G.circleCircle([0, 0], 5, [8, 0], 5);
  assert.equal(cc.length, 2);
  assert.near(cc[0][0], 4);
  assert.near(Math.abs(cc[0][1]), 3);
  assert.equal(G.circleCircle([0, 0], 1, [10, 0], 1).length, 0);
});

test('geom : arcs par bulge et par 3 points', () => {
  const a = G.bulgeToArc([0, 0], [10, 0], 1); // demi-cercle au-dessous (sens anti-horaire)
  assert.point(a.c, [5, 0]);
  assert.near(a.r, 5);
  const b = G.bulgeFrom3Points([0, 0], [5, -5], [10, 0]);
  assert.near(b, 1, 1e-12);
  const arc = G.arcFrom3Points([10, 0], [0, 10], [-10, 0]);
  assert.point(arc.c, [0, 0], 1e-12);
  assert.near(arc.r, 10, 1e-12);
  assert.ok(arc.ccw);
  assert.ok(G.angleOnArc(Math.PI / 2, arc.a0, arc.a1));
  assert.ok(!G.angleOnArc(-Math.PI / 2, arc.a0, arc.a1));
});

test('geom : projection sur segment', () => {
  const r = G.closestOnSegment([5, 5], [0, 0], [10, 0]);
  assert.point(r.point, [5, 0]);
  assert.near(r.d, 5);
  assert.near(G.closestOnSegment([20, 3], [0, 0], [10, 0]).t, 1);
});

test('geom : segment et rectangle', () => {
  const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.ok(G.segmentHitsBox([-5, 5], [15, 5], box));
  assert.ok(!G.segmentHitsBox([-5, -5], [-1, 20], box));
  assert.ok(G.segmentHitsBox([2, 2], [3, 3], box));
});

test('spline par points de lissage : la courbe passe par les points et reste lisse', async () => {
  const { splinePoints, interpolateFit } = await import('../src/curves.js');
  const fit = [[0, 0], [50, 50], [100, 0], [150, 50], [200, 0]].map(([x, y]) => ({ x, y, z: 0 }));
  const pts = splinePoints(3, [], [], null, fit);
  assert.ok(pts.length > 40, `${pts.length} points`);
  for (const q of fit) {
    const d = Math.min(...pts.map((p) => Math.hypot(p[0] - q.x, p[1] - q.y)));
    assert.ok(d < 1, `passe près de (${q.x}, ${q.y}) : écart ${d.toFixed(3)}`);
  }
  assert.point(pts[0], [0, 0], 1e-9);
  assert.point(pts[pts.length - 1], [200, 0], 1e-9);
  const sp = interpolateFit(fit);
  assert.equal(sp.ctrl.length, 5);
  assert.equal(sp.knots.length, 9);
  // Trois points : degré 2 ; deux points : segment.
  assert.equal(interpolateFit(fit.slice(0, 3)).degree, 2);
  assert.equal(splinePoints(3, [], [], null, fit.slice(0, 2)).length, 2);
});
