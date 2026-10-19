// SPDX-License-Identifier: GPL-3.0-or-later
// Découpe de géométrie par un polygone (DECOUPXREF / XCLIP des blocs et références, fenêtres de présentation non
// rectangulaires) : segments coupés exactement, triangles découpés exactement si le contour est convexe (sinon gardés
// selon leur centre), textes et points gardés selon leur point d'insertion. inverse : garder l'extérieur.
import { pointInLoop } from '../underlay/underlay.js';

export function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

// Morceaux d'un segment [a, b] à garder : liste de [x0, y0, x1, y1].
export function clipSegment(ax, ay, bx, by, poly, invert = false, box = null) {
  // Hors de la boîte du contour : tout dehors.
  if (box && (Math.max(ax, bx) < box.minX || Math.min(ax, bx) > box.maxX || Math.max(ay, by) < box.minY || Math.min(ay, by) > box.maxY)) {
    return invert ? [[ax, ay, bx, by]] : [];
  }
  const ts = [0, 1];
  const dx = bx - ax, dy = by - ay;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [px, py] = poly[j], [qx, qy] = poly[i];
    const ex = qx - px, ey = qy - py;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-18) continue;
    const t = ((px - ax) * ey - (py - ay) * ex) / den;
    const u = ((px - ax) * dy - (py - ay) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (t1 - t0 < 1e-12) continue;
    const m = (t0 + t1) / 2;
    if (pointInLoop(ax + dx * m, ay + dy * m, poly) !== invert) {
      const last = out[out.length - 1];
      const x0 = ax + dx * t0, y0 = ay + dy * t0;
      if (last && Math.abs(last[2] - x0) < 1e-12 && Math.abs(last[3] - y0) < 1e-12) { last[2] = ax + dx * t1; last[3] = ay + dy * t1; } else out.push([x0, y0, ax + dx * t1, ay + dy * t1]);
    }
  }
  return out;
}

// Sutherland–Hodgman : polygone (sujet) découpé par un contour convexe orienté.
function clipConvex(subject, clipPoly) {
  let out = subject;
  const orient = area(clipPoly) > 0 ? 1 : -1;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const a = clipPoly[i], b = clipPoly[(i + 1) % clipPoly.length];
    const inside = (p) => orient * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) {
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-18) {
          const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
          out.push([p[0] + dx * t, p[1] + dy * t]);
        }
      }
    }
  }
  return out;
}

function area(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]);
  return a / 2;
}

function boxOf(poly) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of poly) { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y); }
  return b;
}

// Découpe des « parts » (segs, tris, pts, texts — coordonnées du monde, z gardé).
export function clipParts(parts, poly, invert = false) {
  if (!poly || poly.length < 3) return parts;
  const box = boxOf(poly);
  const convex = isConvex(poly);
  const inside = (x, y) => pointInLoop(x, y, poly) !== invert;
  for (const p of parts) {
    const s = p.segs, ns = [];
    for (let i = 0; i + 5 < s.length; i += 6) {
      const z0 = s[i + 2], z1 = s[i + 5];
      for (const [x0, y0, x1, y1] of clipSegment(s[i], s[i + 1], s[i + 3], s[i + 4], poly, invert, box)) ns.push(x0, y0, z0, x1, y1, z1);
    }
    p.segs = ns;
    const t = p.tris, nt = [];
    for (let i = 0; i + 8 < t.length; i += 9) {
      const tri = [[t[i], t[i + 1]], [t[i + 3], t[i + 4]], [t[i + 6], t[i + 7]]];
      const z = t[i + 2];
      if (convex && !invert) {
        const c = clipConvex(tri, poly);
        for (let k = 1; k + 1 < c.length; k++) nt.push(c[0][0], c[0][1], z, c[k][0], c[k][1], z, c[k + 1][0], c[k + 1][1], z);
      } else if (inside((tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3)) {
        nt.push(t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]);
      }
    }
    p.tris = nt;
    const q = p.pts, np = [];
    for (let i = 0; i + 2 < q.length; i += 3) if (inside(q[i], q[i + 1])) np.push(q[i], q[i + 1], q[i + 2]);
    p.pts = np;
    p.texts = p.texts.filter((tx) => inside(tx.x, tx.y));
  }
  return parts;
}
