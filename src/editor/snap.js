// SPDX-License-Identifier: GPL-3.0-or-later
// Accrochage aux objets (ACCROBJ) : cherche le point remarquable le plus proche du curseur.
import * as G from '../core/geom.js';
import { snapPointsOf, intersectCurves, perpendicularFoot, nearestOnCurve } from '../core/entities.js';

export const SNAP_LABELS = {
  end: 'Extrémité', mid: 'Milieu', cen: 'Centre', qua: 'Quadrant', int: 'Intersection',
  per: 'Perpendiculaire', nea: 'Proche', node: 'Nodal', ins: 'Insertion',
};

// Priorité : plus petit = préféré à distance comparable.
const PRIORITY = { end: 0, int: 0, cen: 1, node: 1, ins: 1, mid: 2, qua: 2, per: 3, nea: 9 };
const MAX_ENTITIES = 150;
const MAX_INT_ENTITIES = 40;

// renderer : fournit near(p, tol), curvesOf(e) ; doc : entités.
export function findSnap({ renderer, doc, p, tol, modes, base }) {
  const ids = renderer.near(p, tol).slice(0, MAX_ENTITIES);
  if (!ids.length) return null;
  const cands = [];
  const consider = (q, k) => {
    if (!q) return;
    const d = G.dist(p, q);
    if (d <= tol) cands.push({ p: [q[0], q[1]], k, d });
  };
  const curves = [];
  for (const id of ids) {
    const e = doc.get(id);
    if (!e) continue;
    for (const s of snapPointsOf(e)) if (modes.has(s.k)) consider(s.p, s.k);
    if (modes.has('end') && (e.type === 'INSERT' || e.type === 'BLOCKREF' || e.type === 'UNDERLAY')) {
      for (const q of blockEndpoints(renderer, id, p, tol)) consider(q, 'end');
    }
    // Fond PDF : milieux de ses vrais segments (pas des morceaux de courbes).
    if (modes.has('mid') && e.type === 'UNDERLAY' && renderer.underlays) {
      const s = renderer.underlays.segsNear(e, p, tol).lines;
      for (let i = 0; i + 3 < s.length; i += 4) consider([(s[i] + s[i + 2]) / 2, (s[i + 1] + s[i + 3]) / 2], 'mid');
    }
    if (modes.has('int') || modes.has('per') || modes.has('nea')) {
      const cs = renderer.curvesNear ? renderer.curvesNear(e, p, tol) : renderer.curvesOf(e);
      if (cs.length < 4000) curves.push(cs);
    }
  }
  if (modes.has('int')) {
    const list = curves.slice(0, MAX_INT_ENTITIES);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        for (const a of list[i]) {
          if (!nearCurve(a, p, tol)) continue;
          for (const b of list[j]) {
            if (!nearCurve(b, p, tol)) continue;
            for (const q of intersectCurves(a, b)) consider(q, 'int');
          }
        }
      }
    }
  }
  if (modes.has('per') && base) {
    for (const cs of curves) for (const c of cs) consider(perpendicularFoot(c, base), 'per');
  }
  if (modes.has('nea') && !cands.some((c) => c.k !== 'nea')) {
    for (const cs of curves) for (const c of cs) consider(nearestOnCurve(c, p), 'nea');
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (PRIORITY[a.k] - PRIORITY[b.k]) || (a.d - b.d));
  // Un point prioritaire n'est retenu que s'il n'est pas beaucoup plus loin que le plus proche.
  const nearest = Math.min(...cands.map((c) => c.d));
  return cands.find((c) => c.d <= nearest + tol * 0.5) || cands[0];
}

// Extrémités et coins de la géométrie d'un bloc près du curseur. Les sommets intermédiaires des arcs
// tessellés (faible changement de direction) sont ignorés : seuls restent les vrais coins et bouts.
function blockEndpoints(renderer, id, p, tol) {
  // Segments proches du curseur seulement (une grosse référence, comme un fond de plan, est indexée).
  const s = renderer.segsNear(id, p, tol);
  const key = (x, y) => `${Math.round(x / (tol * 0.01))},${Math.round(y / (tol * 0.01))}`;
  const nodes = new Map();
  for (let i = 0; i + 3 < s.length; i += 4) {
    const a = [s[i], s[i + 1]], b = [s[i + 2], s[i + 3]];
    for (const [q, r] of [[a, b], [b, a]]) {
      if (Math.abs(q[0] - p[0]) > tol || Math.abs(q[1] - p[1]) > tol) continue;
      const k = key(q[0], q[1]);
      let n = nodes.get(k);
      if (!n) { n = { p: q, dirs: [] }; nodes.set(k, n); }
      n.dirs.push(G.norm(G.sub(r, q)));
    }
  }
  const out = [];
  for (const n of nodes.values()) {
    if (n.dirs.length !== 2) { out.push(n.p); continue; }
    const cos = -G.dot(n.dirs[0], n.dirs[1]); // 1 = alignés (point de passage)
    if (cos < Math.cos((10 * Math.PI) / 180)) out.push(n.p);
  }
  return out;
}

function nearCurve(c, p, tol) {
  if (c.k === 'seg') return G.distToSegment(p, c.a, c.b) <= tol;
  return Math.abs(G.dist(p, c.c) - c.r) <= tol;
}

// ORTHO : contraint le point à l'horizontale ou à la verticale de la base (axes du SCU d'angle `angle`).
export function orthoPoint(base, p, angle = 0) {
  if (!angle) {
    const dx = p[0] - base[0], dy = p[1] - base[1];
    return Math.abs(dx) >= Math.abs(dy) ? [p[0], base[1]] : [base[0], p[1]];
  }
  const ux = [Math.cos(angle), Math.sin(angle)], uy = [-ux[1], ux[0]];
  const d = G.sub(p, base), dx = G.dot(d, ux), dy = G.dot(d, uy);
  return Math.abs(dx) >= Math.abs(dy) ? G.add(base, G.mul(ux, dx)) : G.add(base, G.mul(uy, dy));
}

// POLAIRE : accroche l'angle au multiple d'incrément le plus proche (à ±tolDeg près), compté depuis l'axe X du SCU.
export function polarPoint(base, p, incDeg = 45, tolDeg = 4, angle = 0) {
  const a = Math.atan2(p[1] - base[1], p[0] - base[0]) - angle;
  const inc = (incDeg * Math.PI) / 180;
  const k = Math.round(a / inc);
  if (Math.abs(a - k * inc) > (tolDeg * Math.PI) / 180) return null;
  const d = G.dist(base, p);
  return { p: G.polar(base, k * inc + angle, d), angle: k * inc + angle };
}

// Repérage d'accrochage (comme OTRACK d'AutoCAD) : alignements passant par les points acquis, aux angles
// multiples de incDeg (90° par défaut). Renvoie { p, lines } — le pied sur l'alignement le plus proche du
// curseur, ou l'intersection de deux alignements proches — ou null.
export function trackPoint(points, raw, tol, incDeg = 90, angle = 0) {
  const step = (incDeg * Math.PI) / 180;
  const near = [];
  for (const t of points) {
    for (let a = 0; a < Math.PI - 1e-9; a += step) {
      const d = [Math.cos(a + angle), Math.sin(a + angle)]; // alignements comptés depuis l'axe X du SCU
      const s = G.dot(G.sub(raw, t), d);
      const foot = G.add(t, G.mul(d, s));
      const dist = G.dist(raw, foot);
      if (dist <= tol && G.dist(foot, t) > tol) near.push({ t, d, foot, dist });
    }
  }
  if (!near.length) return null;
  near.sort((a, b) => a.dist - b.dist);
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const A = near[i], B = near[j];
      if (Math.abs(G.cross(A.d, B.d)) < 1e-9) continue;
      const x = G.lineLine(A.t, G.add(A.t, A.d), B.t, G.add(B.t, B.d));
      if (x && G.dist(x.point, raw) <= tol * 1.5) return { p: x.point, lines: [A, B] };
    }
  }
  return { p: near[0].foot, lines: [near[0]] };
}
