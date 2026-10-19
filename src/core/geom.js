// SPDX-License-Identifier: GPL-3.0-or-later
// Géométrie 2D de base. Points : tableaux [x, y] (un z éventuel est conservé tel quel).
// Matrices affines 2D : [a, b, c, d, e, f] → x' = a·x + c·y + e ; y' = b·x + d·y + f.

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

// --- vecteurs ------------------------------------------------------------------

export const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
export const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
export const mul = (p, k) => [p[0] * k, p[1] * k];
export const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
export const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
export const len = (p) => Math.hypot(p[0], p[1]);
export const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
export const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
export const angleOf = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
export const polar = (p, a, d) => [p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d];
export const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
export const samePoint = (p, q, eps = 1e-7) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;

export function norm(p) {
  const l = len(p);
  return l < EPS ? [0, 0] : [p[0] / l, p[1] / l];
}

export const perp = (p) => [-p[1], p[0]];

// --- angles -----------------------------------------------------------------------

export function normAngle(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

// Balayage anti-horaire de a0 vers a1, dans ]0, 2π].
export function sweep(a0, a1) {
  const s = normAngle(a1 - a0);
  return s < EPS ? TAU : s;
}

// L'angle a est-il sur l'arc anti-horaire a0 → a1 ?
export function angleOnArc(a, a0, a1, eps = 1e-9) {
  const s = sweep(a0, a1);
  const t = normAngle(a - a0);
  return t <= s + eps || t >= TAU - eps;
}

// --- matrices -----------------------------------------------------------------------

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export const translation = (dx, dy) => [1, 0, 0, 1, dx, dy];

export function rotation(angle, cx = 0, cy = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

export function scaling(sx, sy = sx, cx = 0, cy = 0) {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

// Symétrie par rapport à la droite (p, q).
export function mirroring(p, q) {
  const a = angleOf(p, q);
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  const m = [c, s, s, -c, 0, 0];
  const [x, y] = apply(m, p[0], p[1]);
  m[4] = p[0] - x;
  m[5] = p[1] - y;
  return m;
}

// compose(A, B) : applique B puis A.
export function compose(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Applique à un point en conservant son z éventuel.
export function applyPt(m, p) {
  const r = apply(m, p[0], p[1]);
  if (p.length > 2) r.push(p[2]);
  return r;
}

export function applyVec(m, v) {
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}

export const det = (m) => m[0] * m[3] - m[1] * m[2];

export function invert(m) {
  const d = det(m);
  if (Math.abs(d) < 1e-300) throw new Error('matrice non inversible');
  const [a, b, c, dd, e, f] = m;
  return [dd / d, -b / d, -c / d, a / d, (c * f - dd * e) / d, (b * e - a * f) / d];
}

// Facteur d'échelle moyen (racine du déterminant).
export const scaleOf = (m) => Math.sqrt(Math.abs(det(m)));
export const rotationOf = (m) => Math.atan2(m[1], m[0]);
export const isMirror = (m) => det(m) < 0;

// --- distances --------------------------------------------------------------------

// Projection de p sur le segment [a, b] : { point, t (0..1), d }.
export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 < EPS * EPS ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { point: q, t, d: dist(p, q) };
}

// Projection sur la droite infinie (a, b).
export function projectOnLine(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS * EPS ? 0 : dot(sub(p, a), ab) / l2;
  return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t], t };
}

export function distToSegment(p, a, b) {
  return closestOnSegment(p, a, b).d;
}

// --- intersections -------------------------------------------------------------------

// Droites (a1,a2) et (b1,b2) : paramètres t, u le long de chacune (null si parallèles).
export function lineLine(a1, a2, b1, b2) {
  const r = sub(a2, a1), s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12 * (len(r) * len(s) || 1)) return null;
  const qp = sub(b1, a1);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  return { point: [a1[0] + r[0] * t, a1[1] + r[1] * t], t, u };
}

export function segSeg(a1, a2, b1, b2, eps = 1e-9) {
  const x = lineLine(a1, a2, b1, b2);
  if (!x || x.t < -eps || x.t > 1 + eps || x.u < -eps || x.u > 1 + eps) return null;
  return x;
}

// Droite (a, b) et cercle (c, r) : liste de { point, t }.
export function lineCircle(a, b, c, r) {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  if (A < EPS * EPS) return [];
  let disc = B * B - 4 * A * C;
  if (disc < -1e-12 * A * r * r) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = sq < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.map((t) => ({ point: [a[0] + d[0] * t, a[1] + d[1] * t], t }));
}

export function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = mul(sub(c2, c1), 1 / d);
  const pm = add(c1, mul(u, a));
  if (h < 1e-9) return [pm];
  return [add(pm, mul(perp(u), h)), sub(pm, mul(perp(u), h))];
}

// --- arcs ----------------------------------------------------------------------------

// Arc défini par un « bulge » (tan(angle/4)) entre p1 et p2.
export function bulgeToArc(p1, p2, bulge) {
  const chord = dist(p1, p2);
  const k = (1 - bulge * bulge) / (4 * bulge);
  const c = [(p1[0] + p2[0]) / 2 - (p2[1] - p1[1]) * k, (p1[1] + p2[1]) / 2 + (p2[0] - p1[0]) * k];
  const r = dist(c, p1);
  const a0 = angleOf(c, p1), a1 = angleOf(c, p2);
  return bulge > 0 ? { c, r, a0, a1, ccw: true, chord } : { c, r, a0: a1, a1: a0, ccw: false, chord };
}

// Bulge de l'arc passant par p1, pm (point intermédiaire) et p2.
export function bulgeFrom3Points(p1, pm, p2) {
  const arc = arcFrom3Points(p1, pm, p2);
  if (!arc) return 0;
  const s = arc.ccw ? sweep(arc.a0, arc.a1) : -sweep(arc.a0, arc.a1);
  return Math.tan(s / 4);
}

// Cercle passant par trois points ; null s'ils sont alignés.
export function circleFrom3Points(p1, p2, p3) {
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const c = [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
  return { c, r: dist(c, p1) };
}

// Arc passant par 3 points, exprimé comme arc anti-horaire { c, r, a0, a1 }
// (+ ccw : sens de parcours p1 → p3).
export function arcFrom3Points(p1, p2, p3) {
  const circ = circleFrom3Points(p1, p2, p3);
  if (!circ) return null;
  const { c, r } = circ;
  const ccw = cross(sub(p2, p1), sub(p3, p2)) > 0;
  const s = angleOf(c, p1), e = angleOf(c, p3);
  return ccw ? { c, r, a0: s, a1: e, ccw } : { c, r, a0: e, a1: s, ccw };
}

export function arcMidAngle(a0, a1) {
  return a0 + sweep(a0, a1) / 2;
}

// --- boîtes englobantes ------------------------------------------------------------

export function emptyBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBox(b, x, y) {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
  return b;
}

export const boxValid = (b) => b.minX <= b.maxX && b.minY <= b.maxY;

export function boxContainsBox(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function boxesOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Le segment [a, b] touche-t-il le rectangle ?
export function segmentHitsBox(a, b, box) {
  const inside = (p) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
  if (inside(a) || inside(b)) return true;
  const c = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
  for (let i = 0; i < 4; i++) if (segSeg(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}
