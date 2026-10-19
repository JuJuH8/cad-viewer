// SPDX-License-Identifier: GPL-3.0-or-later
// Chemins : représentation commune des lignes, arcs, cercles et polylignes,
// sous forme d'une suite de courbes orientées. Sert à AJUSTER, PROLONGER, DECALER, RACCORD, JOINDRE.
//
//   segment : { k: 'seg', a, b }
//   arc     : { k: 'arc', c, r, s, sw }   (angle de départ s, balayage signé sw ; sw > 0 = anti-horaire)
// Paramètre le long d'un chemin : u = index de la courbe + t (t ∈ [0, 1]).
import * as G from './geom.js';
import { intersectCurves } from './entities.js';

export const PATH_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE']);

export function pathOf(e) {
  switch (e.type) {
    case 'LINE': return { curves: [{ k: 'seg', a: [e.p1[0], e.p1[1]], b: [e.p2[0], e.p2[1]] }], closed: false, z: e.p1[2] || 0 };
    case 'ARC': return { curves: [{ k: 'arc', c: [e.c[0], e.c[1]], r: e.r, s: e.a0, sw: G.sweep(e.a0, e.a1) }], closed: false, z: e.c[2] || 0 };
    case 'CIRCLE': return { curves: [{ k: 'arc', c: [e.c[0], e.c[1]], r: e.r, s: 0, sw: G.TAU }], closed: true, z: e.c[2] || 0, circle: true };
    case 'LWPOLYLINE': {
      const curves = [];
      const n = e.pts.length;
      const count = e.closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n];
        const bulge = e.bulges?.[i] || 0;
        if (Math.abs(bulge) < 1e-12) curves.push({ k: 'seg', a: [a[0], a[1]], b: [b[0], b[1]] });
        else {
          const arc = G.bulgeToArc(a, b, bulge);
          curves.push({ k: 'arc', c: arc.c, r: arc.r, s: G.angleOf(arc.c, a), sw: 4 * Math.atan(bulge) });
        }
      }
      return { curves, closed: !!e.closed, z: e.z || 0 };
    }
    default: return null;
  }
}

export function pointAt(c, t) {
  if (c.k === 'seg') return G.lerp(c.a, c.b, t);
  return G.polar(c.c, c.s + c.sw * t, c.r);
}

export const startOf = (c) => pointAt(c, 0);
export const endOf = (c) => pointAt(c, 1);

// Direction de parcours (unitaire) au paramètre t.
export function tangentAt(c, t) {
  if (c.k === 'seg') return G.norm(G.sub(c.b, c.a));
  const a = c.s + c.sw * t;
  const d = [-Math.sin(a), Math.cos(a)];
  return c.sw >= 0 ? d : [-d[0], -d[1]];
}

// Paramètre t du point p (supposé sur la courbe ou son prolongement).
export function paramOf(c, p) {
  if (c.k === 'seg') return G.projectOnLine(p, c.a, c.b).t;
  let da = G.angleOf(c.c, p) - c.s;
  if (c.sw >= 0) {
    da = G.normAngle(da);
    if (Math.abs(c.sw - G.TAU) < 1e-9 && da < 1e-12) da = 0;
  } else {
    da = -G.normAngle(-da);
  }
  return da / c.sw;
}

// Primitive au format de entities.js (arcs anti-horaires { a0, a1 }) pour les intersections.
export function toPrimitive(c, full = false) {
  if (c.k === 'seg') return { k: 'seg', a: c.a, b: c.b };
  if (full || Math.abs(Math.abs(c.sw) - G.TAU) < 1e-9) return { k: 'circle', c: c.c, r: c.r };
  return c.sw > 0 ? { k: 'arc', c: c.c, r: c.r, a0: c.s, a1: c.s + c.sw } : { k: 'arc', c: c.c, r: c.r, a0: c.s + c.sw, a1: c.s };
}

// Morceau de courbe entre t0 et t1.
export function subCurve(c, t0, t1) {
  if (c.k === 'seg') return { k: 'seg', a: pointAt(c, t0), b: pointAt(c, t1) };
  return { k: 'arc', c: c.c, r: c.r, s: c.s + c.sw * t0, sw: c.sw * (t1 - t0) };
}

// Paramètres u des intersections du chemin avec des primitives coupantes.
export function intersectionParams(path, cutters) {
  const us = [];
  path.curves.forEach((c, i) => {
    const prim = toPrimitive(c);
    for (const cut of cutters) {
      for (const p of intersectCurves(prim, cut, false)) {
        const t = paramOf(c, p);
        if (t >= -1e-9 && t <= 1 + 1e-9) us.push(i + Math.min(1, Math.max(0, t)));
      }
    }
  });
  return [...new Set(us.map((u) => Math.round(u * 1e10) / 1e10))].sort((a, b) => a - b);
}

// Paramètre u du point du chemin le plus proche de p.
export function nearestParam(path, p) {
  let best = { u: 0, d: Infinity };
  path.curves.forEach((c, i) => {
    let t = paramOf(c, p);
    t = Math.max(0, Math.min(1, t));
    const d = G.dist(p, pointAt(c, t));
    if (d < best.d) best = { u: i + t, d };
  });
  return best.u;
}

// Courbes du chemin entre u0 et u1 (u1 > u0 ; pour un chemin fermé, u1 peut dépasser n).
export function subPath(path, u0, u1) {
  const n = path.curves.length;
  const out = [];
  let u = u0;
  let guard = 0;
  while (u < u1 - 1e-12 && guard++ < 4 * n + 4) {
    const i = Math.floor(u + 1e-12);
    const idx = ((i % n) + n) % n;
    const t0 = u - i;
    const t1 = Math.min(1, u1 - i);
    if (t1 - t0 > 1e-12) out.push(subCurve(path.curves[idx], t0, t1));
    u = i + 1;
  }
  return out;
}

// Courbes → entités (en gardant les propriétés de l'entité d'origine).
export function curvesToEntities(orig, curves, z = 0) {
  if (!curves.length) return [];
  const base = { ...orig };
  delete base.id;
  for (const k of ['p1', 'p2', 'c', 'r', 'a0', 'a1', 'pts', 'bulges', 'closed']) delete base[k];
  if (orig.type === 'LWPOLYLINE') {
    const pts = [[...startOf(curves[0])]];
    const bulges = [];
    for (const c of curves) {
      pts.push([...endOf(c)]);
      bulges.push(c.k === 'arc' ? Math.tan(c.sw / 4) : 0);
    }
    bulges.push(0);
    let closed = false;
    if (curves.length > 1 && G.samePoint(pts[0], pts[pts.length - 1], 1e-9)) {
      pts.pop(); bulges.pop(); closed = true;
    }
    return [{ ...base, type: 'LWPOLYLINE', pts, bulges, closed, z, width: orig.width || 0 }];
  }
  return curves.map((c) => {
    if (c.k === 'seg') return { ...base, type: 'LINE', p1: [c.a[0], c.a[1], z], p2: [c.b[0], c.b[1], z] };
    const a0 = c.sw >= 0 ? c.s : c.s + c.sw, a1 = c.sw >= 0 ? c.s + c.sw : c.s;
    if (Math.abs(Math.abs(c.sw) - G.TAU) < 1e-9) return { ...base, type: 'CIRCLE', c: [c.c[0], c.c[1], z], r: c.r };
    return { ...base, type: 'ARC', c: [c.c[0], c.c[1], z], r: c.r, a0: G.normAngle(a0), a1: G.normAngle(a1) };
  });
}

// --- AJUSTER ------------------------------------------------------------------------

// Retire le morceau de l'entité situé autour du point p, délimité par les coupants.
// Renvoie les entités résultantes (tableau vide = l'objet est effacé), ou null si rien à faire.
export function trimEntity(e, p, cutters) {
  const path = pathOf(e);
  if (!path) return null;
  const n = path.curves.length;
  const us = intersectionParams(path, cutters);
  const up = nearestParam(path, p);
  if (path.closed) {
    // Sur un chemin fermé, u = n et u = 0 sont le même point.
    const pts = [...new Set(us.map((u) => (u >= n - 1e-9 ? 0 : u)))].sort((x, y) => x - y);
    if (!pts.length) return [];          // aucun coupant : l'objet est effacé (comme AutoCAD)
    if (pts.length < 2) return null;     // un seul point de coupure : impossible d'ajuster
    // Intervalle [prev, next] contenant up, en tournant autour du chemin.
    let next = pts.find((u) => u > up), prev = [...pts].reverse().find((u) => u < up);
    if (next == null) next = pts[0] + n;
    if (prev == null) prev = pts[pts.length - 1] - n;
    return curvesToEntities(e, subPath(path, next, prev + n), path.z);
  }
  const inner = us.filter((u) => u > 1e-9 && u < n - 1e-9);
  if (!inner.length) return [];
  const prev = [...inner].reverse().find((u) => u < up) ?? 0;
  const next = inner.find((u) => u > up) ?? n;
  const out = [];
  if (prev > 1e-9) out.push(...curvesToEntities(e, subPath(path, 0, prev), path.z));
  if (next < n - 1e-9) out.push(...curvesToEntities(e, subPath(path, next, n), path.z));
  return out;
}

// --- PROLONGER ----------------------------------------------------------------------

// Prolonge l'extrémité la plus proche de p jusqu'à la première frontière rencontrée.
export function extendEntity(e, p, boundaries) {
  if (!['LINE', 'ARC', 'LWPOLYLINE'].includes(e.type) || (e.type === 'LWPOLYLINE' && e.closed)) return null;
  const path = pathOf(e);
  const n = path.curves.length;
  const atEnd = nearestParam(path, p) > n / 2;
  const c = atEnd ? path.curves[n - 1] : path.curves[0];
  // Primitive prolongée : droite infinie ou cercle complet.
  const ext = c.k === 'seg' ? { k: 'seg', a: c.a, b: c.b } : { k: 'circle', c: c.c, r: c.r };
  let best = null;
  for (const b of boundaries) {
    for (const q of intersectCurves(ext, b, true, false)) {
      const t = paramOf(c, q);
      const ahead = atEnd ? t > 1 + 1e-9 : t < -1e-9;
      if (!ahead) continue;
      if (c.k === 'arc' && Math.abs(c.sw * (atEnd ? t : 1 - t)) >= G.TAU) continue;
      const gap = atEnd ? t - 1 : -t;
      if (!best || gap < best.gap) best = { t, gap };
    }
  }
  if (!best) return null;
  const curves = path.curves.map((x) => ({ ...x }));
  const idx = atEnd ? n - 1 : 0;
  curves[idx] = atEnd ? subCurve(c, 0, best.t) : subCurve(c, best.t, 1);
  return curvesToEntities(e, curves, path.z)[0];
}

// --- DECALER ------------------------------------------------------------------------

function offsetCurve(c, d) {
  // d > 0 : à gauche du sens de parcours.
  if (c.k === 'seg') {
    const n = G.perp(G.norm(G.sub(c.b, c.a)));
    return { k: 'seg', a: G.add(c.a, G.mul(n, d)), b: G.add(c.b, G.mul(n, d)) };
  }
  const r = c.sw > 0 ? c.r - d : c.r + d;
  if (r <= 1e-9) return null;
  return { ...c, r };
}

// Côté (+1 gauche / -1 droite) du point p par rapport au chemin.
export function sideOf(path, p) {
  const u = nearestParam(path, p);
  const i = Math.min(path.curves.length - 1, Math.floor(u));
  const c = path.curves[i];
  const t = u - i;
  const q = pointAt(c, t);
  const tan = tangentAt(c, t);
  return G.cross(tan, G.sub(p, q)) >= 0 ? 1 : -1;
}

export function offsetEntity(e, dist, sidePoint) {
  const path = pathOf(e);
  if (!path) return null;
  return offsetSigned(e, dist * sideOf(path, sidePoint));
}

// Décalage signé : d > 0 à gauche du sens de parcours, d < 0 à droite.
export function offsetSigned(e, d) {
  const path = pathOf(e);
  if (!path) return null;
  if (e.type === 'CIRCLE') {
    const r = e.r - d; // cercle parcouru dans le sens anti-horaire : la gauche est l'intérieur
    return r > 1e-9 ? { ...e, r, id: undefined } : null;
  }
  const off = path.curves.map((c) => offsetCurve(c, d));
  if (off.some((c) => !c)) return null;
  const n = off.length;
  // Raccord des courbes décalées : intersection des prolongements, la plus proche du sommet décalé.
  const joints = [];
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = off[i], b = off[(i + 1) % n];
    const naive = endOf(a);
    const pa = a.k === 'seg' ? { k: 'seg', a: a.a, b: a.b } : { k: 'circle', c: a.c, r: a.r };
    const pb = b.k === 'seg' ? { k: 'seg', a: b.a, b: b.b } : { k: 'circle', c: b.c, r: b.r };
    const xs = intersectCurves(pa, pb, true);
    let best = naive, bd = Infinity;
    for (const q of xs) {
      const dd = G.dist(q, naive);
      if (dd < bd) { bd = dd; best = q; }
    }
    joints.push(bd < Math.abs(d) * 4 + 1e-9 ? best : naive);
  }
  const pts = [];
  if (!path.closed) pts.push(startOf(off[0]));
  pts.push(...joints);
  if (!path.closed) pts.push(endOf(off[n - 1]));
  else pts.unshift(pts.pop()); // le sommet 0 est le raccord entre la dernière et la première courbe
  const curves = off.map((c, i) => {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (c.k === 'seg') return { k: 'seg', a, b };
    const s = G.angleOf(c.c, a), e2 = G.angleOf(c.c, b);
    let sw = c.sw > 0 ? G.sweep(s, e2) : -G.sweep(e2, s);
    if (Math.abs(Math.abs(sw) - G.TAU) < 1e-9 && Math.abs(c.sw) < G.TAU - 1e-6) sw = 0;
    return { k: 'arc', c: c.c, r: c.r, s, sw };
  });
  const out = curvesToEntities(e, curves, path.z);
  if (e.type === 'LWPOLYLINE') out[0].closed = path.closed;
  return out.length === 1 ? out[0] : out;
}

// --- RACCORD / CHANFREIN ----------------------------------------------------------------
// opts : { r } pour un raccord (arc tangent), { d1, d2 } pour un chanfrein (segment).

// Coin entre deux lignes. Renvoie { l1, l2, link } (link : arc, ligne ou null pour un coin vif),
// null si les lignes sont parallèles, { error } si le rayon / les distances sont trop grands.
export function cornerLines(l1, p1, l2, p2, opts) {
  const a1 = [l1.p1[0], l1.p1[1]], b1 = [l1.p2[0], l1.p2[1]];
  const a2 = [l2.p1[0], l2.p1[1]], b2 = [l2.p2[0], l2.p2[1]];
  const x = G.lineLine(a1, b1, a2, b2);
  if (!x) return null;
  const X = x.point;
  // Côté conservé de chaque ligne : celui où se trouve le point de sélection.
  const keep1 = G.dot(G.sub(p1, X), G.sub(b1, a1)) >= 0 ? 1 : -1;
  const keep2 = G.dot(G.sub(p2, X), G.sub(b2, a2)) >= 0 ? 1 : -1;
  const u1 = G.mul(G.norm(G.sub(b1, a1)), keep1);
  const u2 = G.mul(G.norm(G.sub(b2, a2)), keep2);
  const far1 = G.dot(G.sub(a1, X), u1) > G.dot(G.sub(b1, X), u1) ? a1 : b1;
  const far2 = G.dot(G.sub(a2, X), u2) > G.dot(G.sub(b2, X), u2) ? a2 : b2;
  const z1 = l1.p1[2] || 0, z2 = l2.p1[2] || 0;
  const corner = cornerAt(X, u1, u2, opts);
  if (!corner) return null;
  const len1 = G.dot(G.sub(far1, X), u1), len2 = G.dot(G.sub(far2, X), u2);
  if (corner.d1 > len1 + 1e-9 || corner.d2 > len2 + 1e-9) return { error: 'trop grand' };
  const { t1, t2 } = corner;
  let link = null;
  if (corner.bulge !== 0) {
    const arc = G.bulgeToArc(t1, t2, corner.bulge);
    const s1 = G.angleOf(arc.c, t1), s2 = G.angleOf(arc.c, t2);
    const ccw = corner.bulge > 0;
    link = { type: 'ARC', layer: l1.layer, color: l1.color, c: [arc.c[0], arc.c[1], z1], r: arc.r, a0: ccw ? s1 : s2, a1: ccw ? s2 : s1 };
  } else if (G.dist(t1, t2) > 1e-12) {
    link = { type: 'LINE', layer: l1.layer, color: l1.color, p1: [t1[0], t1[1], z1], p2: [t2[0], t2[1], z1] };
  }
  return {
    l1: { ...l1, p1: [far1[0], far1[1], z1], p2: [t1[0], t1[1], z1] },
    l2: { ...l2, p1: [far2[0], far2[1], z2], p2: [t2[0], t2[1], z2] },
    link,
    arc: link?.type === 'ARC' ? link : null,
  };
}

export function filletLines(l1, p1, l2, p2, r) {
  const res = cornerLines(l1, p1, l2, p2, { r });
  return res?.error ? null : res;
}

// Raccord entre lignes, arcs et cercles (au moins un arc ou un cercle) : arc de rayon r tangent aux deux,
// ou coin vif si r = 0. Le centre est cherché aux intersections des courbes décalées de ±r ; on garde la
// solution dont les points de tangence sont les plus proches des points désignés. Lignes et arcs sont coupés
// (ou prolongés) du côté désigné ; les cercles restent entiers, comme dans AutoCAD.
// Renvoie { e1, e2, arc } ou { error: 'type' | 'aucun' }.
export function filletCurves(e1, p1, e2, p2, r = 0) {
  const prim = (e) => (e.type === 'LINE' ? { line: true, a: [e.p1[0], e.p1[1]], b: [e.p2[0], e.p2[1]] }
    : e.type === 'ARC' || e.type === 'CIRCLE' ? { line: false, c: [e.c[0], e.c[1]], r: e.r } : null);
  const A = prim(e1), B = prim(e2);
  if (!A || !B || (A.line && B.line)) return { error: 'type' };
  if (A.line && G.dist(A.a, A.b) < 1e-12) return { error: 'type' };
  if (B.line && G.dist(B.a, B.b) < 1e-12) return { error: 'type' };
  const offsets = (P) => {
    if (!(r > 0)) return [P];
    if (P.line) {
      const n = G.perp(G.norm(G.sub(P.b, P.a)));
      return [1, -1].map((k) => ({ line: true, a: G.add(P.a, G.mul(n, k * r)), b: G.add(P.b, G.mul(n, k * r)) }));
    }
    return [P.r + r, P.r - r].filter((R) => R > 1e-12).map((R) => ({ line: false, c: P.c, r: R }));
  };
  const meet = (P, Q) => {
    if (P.line && Q.line) { const x = G.lineLine(P.a, P.b, Q.a, Q.b); return x ? [x.point] : []; }
    if (P.line) return G.lineCircle(P.a, P.b, Q.c, Q.r).map((x) => x.point);
    if (Q.line) return G.lineCircle(Q.a, Q.b, P.c, P.r).map((x) => x.point);
    return G.circleCircle(P.c, P.r, Q.c, Q.r);
  };
  const touch = (P, C) => (P.line ? G.projectOnLine(C, P.a, P.b).point : G.add(P.c, G.mul(G.norm(G.sub(C, P.c)), P.r)));
  let best = null;
  for (const oa of offsets(A)) {
    for (const ob of offsets(B)) {
      for (const C of meet(oa, ob)) {
        const tA = touch(A, C), tB = touch(B, C);
        // Rayon nul : C est l'intersection elle-même.
        const score = G.dist(tA, p1) + G.dist(tB, p2);
        if (!best || score < best.score) best = { C, tA, tB, score };
      }
    }
  }
  if (!best) return { error: 'aucun' };
  const trim = (e, P, T, pick) => {
    if (e.type === 'CIRCLE') return e;
    if (P.line) {
      const d = G.sub(P.b, P.a), L2 = G.dot(d, d);
      const tT = G.dot(G.sub(T, P.a), d) / L2, tP = G.dot(G.sub(pick, P.a), d) / L2;
      const z = e.p1[2] || 0;
      return tP >= tT ? { ...e, p1: [T[0], T[1], z], p2: [P.b[0], P.b[1], e.p2[2] || 0] } : { ...e, p1: [P.a[0], P.a[1], z], p2: [T[0], T[1], e.p2[2] || 0] };
    }
    // Arc : morceau qui contient le point désigné et finit au point de tangence (le plus court s'il y en a deux).
    const at = G.angleOf(P.c, T), ap = G.angleOf(P.c, pick);
    const both = [{ a0: at, a1: e.a1, keep: e.a1 }, { a0: e.a0, a1: at, keep: e.a0 }].filter((x) => G.sweep(x.a0, x.a1) > 1e-9);
    const cands = both.filter((x) => G.angleOnArc(ap, x.a0, x.a1));
    if (!cands.length) {
      // Point désigné juste au-delà d'un bout de l'arc : on garde le bout le plus proche.
      const gap = (a) => Math.min(G.normAngle(a - ap), G.normAngle(ap - a));
      both.sort((x, y) => gap(x.keep) - gap(y.keep));
      return both.length ? { ...e, a0: both[0].a0, a1: both[0].a1 } : e;
    }
    cands.sort((x, y) => G.sweep(x.a0, x.a1) - G.sweep(y.a0, y.a1));
    return { ...e, a0: cands[0].a0, a1: cands[0].a1 };
  };
  const out = { e1: trim(e1, A, best.tA, p1), e2: trim(e2, B, best.tB, p2), arc: null, tA: best.tA, tB: best.tB, center: best.C };
  if (r > 0) {
    const s1 = G.angleOf(best.C, best.tA), s2 = G.angleOf(best.C, best.tB);
    const [a0, a1] = G.sweep(s1, s2) <= Math.PI ? [s1, s2] : [s2, s1];
    const z = (e1.type === 'LINE' ? e1.p1[2] : e1.c[2]) || 0;
    out.arc = { type: 'ARC', layer: e1.layer, color: e1.color, c: [best.C[0], best.C[1], z], r, a0, a1 };
    if (e1.ltype) out.arc.ltype = e1.ltype;
    if (e1.lweight != null) out.arc.lweight = e1.lweight;
  }
  return out;
}

// Coin au point X entre les directions u1 et u2 (unitaires, vers les parties conservées).
// Renvoie { t1, t2, bulge (de t1 vers t2), d1, d2 } ou null (directions alignées).
function cornerAt(X, u1, u2, opts) {
  const theta = Math.acos(Math.max(-1, Math.min(1, G.dot(u1, u2))));
  if (theta < 1e-9 || Math.PI - theta < 1e-9) return null;
  let d1, d2, bulge = 0;
  if (opts.r != null) {
    d1 = d2 = opts.r > 1e-12 ? opts.r / Math.tan(theta / 2) : 0;
    // Virage à gauche (de la partie 1 vers la partie 2) : arc anti-horaire.
    if (d1 > 0) bulge = Math.sign(G.cross(G.mul(u1, -1), u2)) * Math.tan((Math.PI - theta) / 4);
  } else {
    d1 = Math.max(0, opts.d1 || 0);
    d2 = Math.max(0, opts.d2 ?? opts.d1 ?? 0);
  }
  return { t1: G.add(X, G.mul(u1, d1)), t2: G.add(X, G.mul(u2, d2)), bulge, d1, d2 };
}

// Segment de polyligne le plus proche du point p.
export function segmentIndexAt(e, p) {
  const path = pathOf(e);
  return Math.min(path.curves.length - 1, Math.floor(nearestParam(path, p)));
}

// Retire les sommets en double (segments de longueur nulle).
function dedupe(verts, closed) {
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const next = i + 1 < verts.length ? verts[i + 1] : closed ? out[0] : null;
    if (next && G.dist(verts[i].p, next.p) < 1e-9) continue;
    out.push(verts[i]);
  }
  return out;
}

// Applique des coins aux sommets k (map k → coin). Renvoie la polyligne modifiée.
function applyCorners(e, corners) {
  const n = e.pts.length;
  const verts = [];
  for (let k = 0; k < n; k++) {
    const b = e.bulges?.[k] || 0;
    const c = corners.get(k);
    if (c) {
      verts.push({ p: c.t1, b: c.bulge });
      verts.push({ p: c.t2, b });
    } else verts.push({ p: [e.pts[k][0], e.pts[k][1]], b });
  }
  const out = dedupe(verts, e.closed);
  return { ...e, pts: out.map((v) => v.p), bulges: out.map((v) => v.b) };
}

function vertexDirs(e, k) {
  const n = e.pts.length;
  const X = [e.pts[k][0], e.pts[k][1]];
  const A = e.pts[(k - 1 + n) % n], B = e.pts[(k + 1) % n];
  return {
    X,
    u1: G.norm(G.sub([A[0], A[1]], X)), u2: G.norm(G.sub([B[0], B[1]], X)),
    len1: G.dist([A[0], A[1]], X), len2: G.dist([B[0], B[1]], X),
    straight: !(e.bulges?.[(k - 1 + n) % n]) && !(e.bulges?.[k]),
  };
}

// Coin au sommet k d'une polyligne (entre les segments k-1 et k).
// Raccord (rayon r > 0) d'un sommet de polyligne dont un segment au moins est courbe : arc tangent calculé
// comme RACCORD entre lignes et arcs, segments voisins raccourcis (bulges recalculés).
function filletPolylineArcVertex(e, k, r) {
  const n = e.pts.length;
  const ip = (k - 1 + n) % n;
  const a = e.pts[ip], v = e.pts[k], b = e.pts[(k + 1) % n];
  const bp = e.bulges?.[ip] || 0, bn = e.bulges?.[k] || 0;
  const ent = (p, q, bulge) => {
    if (!bulge) return { type: 'LINE', p1: [p[0], p[1], 0], p2: [q[0], q[1], 0] };
    const arc = G.bulgeToArc(p, q, bulge);
    return { type: 'ARC', c: [arc.c[0], arc.c[1], 0], r: arc.r, a0: arc.a0, a1: arc.a1, ccw: bulge > 0 };
  };
  const e1 = ent(a, v, bp), e2 = ent(v, b, bn);
  // Points désignés : sur chaque courbe, tout près du sommet (le raccord y est).
  const nearV = (x, other, bulge) => {
    if (!bulge) return G.lerp(v, other, 0.1);
    const s = (Math.atan(Math.abs(bulge)) * 4) * 0.1 * (x === e1 ? -1 : 1) * Math.sign(bulge);
    return G.polar([x.c[0], x.c[1]], G.angleOf(x.c, v) + s, x.r);
  };
  const res = filletCurves(e1, nearV(e1, a, bp), e2, nearV(e2, b, bn), r);
  if (res.error || !res.arc) return { error: 'trop grand' };
  const { tA, tB, center } = res;
  // Les points de tangence doivent rester sur les segments (pas au-delà de leur autre extrémité).
  const onPart = (x, p0, p1, t) => {
    if (x.type === 'LINE') { const d = G.sub(p1, p0), u = G.dot(G.sub(t, p0), d) / G.dot(d, d); return u >= -1e-9 && u <= 1 + 1e-9; }
    const s = (q) => (x.ccw ? G.normAngle(G.angleOf(x.c, q) - G.angleOf(x.c, p0)) : G.normAngle(G.angleOf(x.c, p0) - G.angleOf(x.c, q)));
    return s(t) <= s(p1) + 1e-9;
  };
  if (!onPart(e1, a, v, tA) || !onPart(e2, v, b, tB)) return { error: 'trop grand' };
  const bulgeOn = (x, p0, p1) => {
    if (x.type === 'LINE') return 0;
    const sw = x.ccw ? G.normAngle(G.angleOf(x.c, p1) - G.angleOf(x.c, p0)) : G.normAngle(G.angleOf(x.c, p0) - G.angleOf(x.c, p1));
    return Math.tan(sw / 4) * (x.ccw ? 1 : -1);
  };
  const dirAt = (x, p, p0, p1) => (x.type === 'LINE' ? G.norm(G.sub(p1, p0)) : (() => { const u = G.norm(G.sub(p, x.c)); return x.ccw ? [-u[1], u[0]] : [u[1], -u[0]]; })());
  const tIn = dirAt(e1, tA, a, v), tOut = dirAt(e2, tB, v, b);
  const turn = Math.sign(G.cross(tIn, tOut)) || 1;
  const sweep = Math.acos(Math.max(-1, Math.min(1, G.dot(tIn, tOut))));
  const bf = turn * Math.tan(sweep / 4);
  const pts = [], bulges = [];
  for (let i = 0; i < n; i++) {
    if (i === k) {
      pts.push([tA[0], tA[1]], [tB[0], tB[1]]);
      bulges.push(bf, bulgeOn(e2, tB, b));
    } else {
      pts.push([e.pts[i][0], e.pts[i][1]]);
      bulges.push(i === ip ? bulgeOn(e1, a, tA) : e.bulges?.[i] || 0);
    }
  }
  return { entity: { ...e, pts, bulges }, center };
}

export function cornerPolylineVertex(e, k, opts) {
  const d = vertexDirs(e, k);
  if (!d.straight && opts.r > 0) return filletPolylineArcVertex(e, k, opts.r);
  if (!d.straight) return { error: 'segments courbes' };
  const c = cornerAt(d.X, d.u1, d.u2, opts);
  if (!c) return { error: 'segments alignés' };
  if (c.d1 > d.len1 + 1e-9 || c.d2 > d.len2 + 1e-9) return { error: 'trop grand' };
  return { entity: applyCorners(e, new Map([[k, c]])) };
}

// Coin entre deux segments adjacents (indices i puis j, dans l'ordre de sélection) d'une même polyligne.
export function cornerPolylineSegments(e, i, j, opts) {
  const n = e.pts.length;
  const segs = e.closed ? n : n - 1;
  let k = null;
  if (j === i + 1) k = j;
  else if (i === j + 1) k = i;
  else if (e.closed && segs > 2 && ((i === 0 && j === segs - 1) || (j === 0 && i === segs - 1))) k = 0;
  if (k === null) return { error: 'segments non adjacents' };
  // Au sommet k, la partie 1 est le segment k-1 : on remet les distances de chanfrein dans l'ordre de sélection.
  const firstIsPrev = i === (k - 1 + n) % n;
  const o = opts.r == null && !firstIsPrev ? { d1: opts.d2 ?? opts.d1, d2: opts.d1 } : opts;
  return cornerPolylineVertex(e, k, o);
}

// Supprime les arcs de raccord existants (arc tangent entre deux segments droits) pour retrouver
// le coin vif, comme AutoCAD avant de raccorder de nouveau une polyligne entière.
function removeFillets(e) {
  const path = pathOf(e);
  const n = e.pts.length;
  const segs = path.curves.length;
  const collapse = new Map(); // indice de l'arc → point du coin
  for (let i = 0; i < segs; i++) {
    const c = path.curves[i];
    if (c.k !== 'arc') continue;
    if (!e.closed && (i - 1 < 0 || i + 1 >= segs)) continue;
    const prev = path.curves[(i - 1 + segs) % segs], next = path.curves[(i + 1) % segs];
    if (prev.k !== 'seg' || next.k !== 'seg' || collapse.has((i - 1 + segs) % segs)) continue;
    const tIn = G.norm(G.sub(prev.b, prev.a)), tOut = G.norm(G.sub(next.b, next.a));
    const ok = (a, b) => Math.abs(G.cross(a, b)) < 1e-6 && G.dot(a, b) > 0;
    if (!ok(tIn, tangentAt(c, 0)) || !ok(tOut, tangentAt(c, 1))) continue;
    const x = G.lineLine(prev.a, prev.b, next.a, next.b);
    if (x) collapse.set(i, x.point);
  }
  if (!collapse.size) return e;
  const skip = new Set([...collapse.keys()].map((i) => (i + 1) % n));
  const verts = [];
  for (let k = 0; k < n; k++) {
    if (collapse.has(k)) verts.push({ p: collapse.get(k), b: e.bulges?.[(k + 1) % n] || 0 });
    else if (!skip.has(k)) verts.push({ p: [e.pts[k][0], e.pts[k][1]], b: e.bulges?.[k] || 0 });
  }
  return { ...e, pts: verts.map((v) => v.p), bulges: verts.map((v) => v.b) };
}

// Raccord / chanfrein de tous les sommets d'une polyligne (option « Polyligne »).
// Renvoie { entity, done, tooShort, changed }.
export function cornerPolylineAll(e0, opts) {
  const e = removeFillets(e0);
  const n = e.pts.length;
  const corners = new Map();
  let tooShort = 0;
  const used = new Map(); // longueur prise au début du segment k par le coin du sommet k
  for (let k = e.closed ? 0 : 1; k < (e.closed ? n : n - 1); k++) {
    const d = vertexDirs(e, k);
    if (!d.straight) continue;
    const c = cornerAt(d.X, d.u1, d.u2, opts);
    if (!c || (c.d1 < 1e-12 && c.d2 < 1e-12)) continue;
    const before = used.get((k - 1 + n) % n) || 0;
    if (c.d1 + before > d.len1 + 1e-9 || c.d2 > d.len2 + 1e-9) { tooShort++; continue; }
    used.set(k, c.d2);
    corners.set(k, c);
  }
  // Polyligne fermée : les coins des sommets 0 et n-1 se partagent le dernier segment.
  if (e.closed && corners.has(0) && corners.has(n - 1)) {
    if (corners.get(0).d1 + corners.get(n - 1).d2 > vertexDirs(e, 0).len1 + 1e-9) { corners.delete(0); tooShort++; }
  }
  return { entity: applyCorners(e, corners), done: corners.size, tooShort, changed: corners.size > 0 || e !== e0 };
}

// --- JOINDRE -----------------------------------------------------------------------

// Assemble des lignes, arcs et polylignes ouvertes qui se touchent bout à bout en une polyligne.
export function joinEntities(entities, tol = 1e-6) {
  const pieces = entities.map((e) => ({ e, curves: pathOf(e)?.curves || [] })).filter((x) => x.curves.length && !pathOf(x.e).closed);
  if (!pieces.length) return null;
  const reverseCurves = (cs) => cs.slice().reverse().map((c) => (c.k === 'seg' ? { k: 'seg', a: c.b, b: c.a } : { ...c, s: c.s + c.sw, sw: -c.sw }));
  const chainCurves = [...pieces[0].curves];
  const used = new Set([0]);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < pieces.length; i++) {
      if (used.has(i)) continue;
      const cs = pieces[i].curves;
      const head = startOf(chainCurves[0]), tail = endOf(chainCurves[chainCurves.length - 1]);
      const s = startOf(cs[0]), f = endOf(cs[cs.length - 1]);
      if (G.dist(tail, s) <= tol) chainCurves.push(...cs);
      else if (G.dist(tail, f) <= tol) chainCurves.push(...reverseCurves(cs));
      else if (G.dist(head, f) <= tol) chainCurves.unshift(...cs);
      else if (G.dist(head, s) <= tol) chainCurves.unshift(...reverseCurves(cs));
      else continue;
      used.add(i);
      grew = true;
    }
  }
  const first = pieces[0].e;
  const poly = curvesToEntities({ ...first, type: 'LWPOLYLINE' }, chainCurves, pathOf(first).z)[0];
  return { entity: poly, used: [...used].map((i) => pieces[i].e.id) };
}

// --- COUPURE ------------------------------------------------------------------------

// Retire la partie comprise entre p1 et p2 (si p1 = p2 : scission en deux objets).
export function breakEntity(e, p1, p2) {
  const path = pathOf(e);
  if (!path) return null;
  const n = path.curves.length;
  let u1 = nearestParam(path, p1), u2 = nearestParam(path, p2);
  if (path.closed) {
    if (Math.abs(u1 - u2) < 1e-9) return null; // on ne scinde pas un contour fermé en un seul point
    // Cercle / contour fermé : on retire le morceau parcouru de p1 vers p2 (sens du contour).
    if (u2 < u1) u2 += n;
    return curvesToEntities(e, subPath(path, u2, u1 + n), path.z);
  }
  if (u2 < u1) [u1, u2] = [u2, u1];
  const out = [];
  if (u1 > 1e-9) out.push(...curvesToEntities(e, subPath(path, 0, u1), path.z));
  if (u2 < n - 1e-9) out.push(...curvesToEntities(e, subPath(path, u2, n), path.z));
  return out;
}

// --- ETIRER -------------------------------------------------------------------------

const inBox = (p, b) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;

// Déplace de (dx, dy) les points de définition situés dans la fenêtre ; null si rien ne bouge.
export function stretchEntity(e, box, dx, dy) {
  const mv = (p) => (inBox(p, box) ? (p.length > 2 ? [p[0] + dx, p[1] + dy, p[2]] : [p[0] + dx, p[1] + dy]) : p);
  const out = structuredClone(e);
  switch (e.type) {
    case 'LINE': out.p1 = mv(e.p1); out.p2 = mv(e.p2); break;
    case 'LWPOLYLINE': case 'POLY3D': out.pts = e.pts.map(mv); break;
    case 'CIRCLE': case 'ARC': case 'ELLIPSE': out.c = mv(e.c); break;
    case 'POINT': case 'TEXT': case 'MTEXT': case 'INSERT': case 'ATTDEF': out.p = mv(e.p); if (e.attribs && inBox(e.p, box)) out.attribs = e.attribs.map((a) => ({ ...a, p: [a.p[0] + dx, a.p[1] + dy, a.p[2] || 0] })); break;
    case 'SOLID': case 'WIPEOUT': out.pts = e.pts.map(mv); break;
    case 'BLOCKREF': if (inBox([e.m[4], e.m[5]], box)) { out.m = [...e.m]; out.m[4] += dx; out.m[5] += dy; } break;
    case 'HATCH': if (e.loops.every((l) => l.every((p) => inBox(p, box)))) out.loops = e.loops.map((l) => l.map(mv)); break;
    default: return null;
  }
  return JSON.stringify(out) === JSON.stringify(e) ? null : out;
}

// --- AIRE ----------------------------------------------------------------------------

// Aire (positive) et périmètre d'une entité fermée : polyligne (arcs compris), cercle, ellipse complète.
export function areaOf(e) {
  if (e.type === 'CIRCLE') return { area: Math.PI * e.r * e.r, perimeter: 2 * Math.PI * e.r };
  const path = pathOf(e.type === 'POLY3D' ? { ...e, type: 'LWPOLYLINE', pts: e.pts.map((p) => [p[0], p[1]]), bulges: e.pts.map(() => 0) } : e);
  if (!path) return null;
  let a = 0, per = 0;
  for (const c of path.curves) {
    const s = startOf(c), f = endOf(c);
    a += s[0] * f[1] - f[0] * s[1];               // corde (formule du lacet)
    if (c.k === 'arc') {
      a += c.r * c.r * (c.sw - Math.sin(c.sw));   // segment circulaire entre la corde et l'arc (signé)
      per += Math.abs(c.sw) * c.r;
    } else per += G.dist(c.a, c.b);
  }
  if (!path.closed && path.curves.length) {
    const s = startOf(path.curves[0]), f = endOf(path.curves[path.curves.length - 1]);
    a += f[0] * s[1] - s[0] * f[1];               // fermeture implicite (comme AutoCAD)
  }
  return { area: Math.abs(a) / 2, perimeter: per };
}

export function polygonArea(pts) {
  let a = 0, per = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
    per += G.dist(p, q);
  }
  return { area: Math.abs(a) / 2, perimeter: per };
}
