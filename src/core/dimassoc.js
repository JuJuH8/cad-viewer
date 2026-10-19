// SPDX-License-Identifier: GPL-3.0-or-later
// Cotes associatives et objets DIMASSOC d'AutoCAD. Dans l'appli, un point de définition accroché est une référence
// { id, k, i } : objet, type de point d'accrochage (extrémité, milieu, centre…) et rang parmi les points de ce type
// (cote de rayon / diamètre : { id, k: 'circle' }). Dans AutoCAD (DIMASSOC = 2), le dictionnaire d'extension de la cote
// porte un objet DIMASSOC : 330 cote, 90 points accrochés (bit 0 : 1re ligne d'attache, bit 1 : 2e, ou le cercle
// d'une cote de rayon / diamètre), puis par point une référence AcDbOsnapPointRef : 72 type d'accrochage
// (1 extrémité, 2 milieu, 3 centre, 4 nodal, 5 quadrant, 7 insertion, 13 point de départ), 331 objet, 73 type de
// sous-objet (2 arête), 91 marqueur (segment d'une polyligne, à partir de 1), 40 paramètre sur la courbe,
// 10 / 20 / 30 point. Les objets accrochés ont la DIMASSOC dans leurs réacteurs.
import * as G from './geom.js';
import { snapPointsOf } from './entities.js';

export const ASSOC_KINDS = new Set(['end', 'mid', 'cen', 'qua', 'node', 'ins']);

// Référence d'accrochage du point p sur l'objet e (premier point d'accrochage de type géré à cet endroit), ou null.
export function refFor(e, p, tol = 1e-9) {
  if (!e || !p || e.type === 'BLOCKREF') return null;
  const rank = {};
  for (const s of snapPointsOf(e)) {
    const i = (rank[s.k] = (rank[s.k] ?? -1) + 1);
    if (ASSOC_KINDS.has(s.k) && G.dist(s.p, p) <= tol) return { id: e.id, k: s.k, i };
  }
  return null;
}

// Segment k (0, 1…) d'une polyligne : extrémités et renflement.
function segment(e, k) {
  const n = e.pts.length;
  const a = e.pts[k], b = e.pts[(k + 1) % n];
  return a && b ? { a, b, bulge: e.bulges?.[k] || 0 } : null;
}
const segMid = ({ a, b, bulge }) => [(a[0] + b[0]) / 2 + ((b[1] - a[1]) * bulge) / 2, (a[1] + b[1]) / 2 - ((b[0] - a[0]) * bulge) / 2];

// Référence d'AutoCAD → point sur l'objet de l'appli (null si non gérée).
export function pointOfAcadRef(e, r) {
  if (!e || !r) return null;
  const { osnap } = r;
  switch (e.type) {
    case 'LINE':
      return osnap === 13 ? e.p1 : osnap === 1 ? e.p2 : osnap === 2 ? G.mid(e.p1, e.p2) : null;
    case 'ARC':
      if (osnap === 3) return e.c;
      if (osnap === 13) return G.polar(e.c, e.a0, e.r);
      if (osnap === 1) return G.polar(e.c, e.a1, e.r);
      return osnap === 2 ? G.polar(e.c, G.arcMidAngle(e.a0, e.a1), e.r) : null;
    case 'CIRCLE':
      return osnap === 3 ? e.c : null;
    case 'LWPOLYLINE': {
      const s = segment(e, Math.max(0, (r.gs || 1) - 1));
      if (!s) return null;
      return osnap === 13 ? s.a : osnap === 1 ? s.b : osnap === 2 ? segMid(s) : null;
    }
    case 'POINT': return osnap === 4 ? e.p : null;
    case 'INSERT': case 'TEXT': case 'MTEXT': return osnap === 7 ? e.p : null;
    default: return null;
  }
}

// Référence de l'appli → référence d'AutoCAD { osnap, gs, param } (null si ce point ne s'écrit pas).
export function toAcadRef(e, ref) {
  if (!e || !ref) return null;
  if (ref.k === 'circle') return e.type === 'CIRCLE' || e.type === 'ARC' ? { osnap: 3, gs: 0, param: 0 } : null;
  switch (e.type) {
    case 'LINE': case 'ARC':
      if (ref.k === 'end') return ref.i === 0 ? { osnap: 13, gs: 0, param: 0 } : { osnap: 1, gs: 0, param: 1 };
      if (ref.k === 'mid') return { osnap: 2, gs: 0, param: 0.5 };
      return ref.k === 'cen' && e.type === 'ARC' ? { osnap: 3, gs: 0, param: 0 } : null;
    case 'CIRCLE':
      return ref.k === 'cen' ? { osnap: 3, gs: 0, param: 0 } : null;
    case 'LWPOLYLINE':
      if (ref.k === 'end') return ref.i === 0 ? { osnap: 13, gs: 1, param: 0 } : { osnap: 1, gs: ref.i, param: 1 };
      return ref.k === 'mid' ? { osnap: 2, gs: ref.i + 1, param: 0.5 } : null;
    case 'POINT': return ref.k === 'node' ? { osnap: 4, gs: 0, param: 0 } : null;
    case 'INSERT': case 'TEXT': case 'MTEXT': return ref.k === 'ins' ? { osnap: 7, gs: 0, param: 0 } : null;
    default: return null;
  }
}

// Références d'AutoCAD d'une cote ({ bit, osnap, obj, gs, param }) → meta.assoc de l'appli. get(poignée) → objet ;
// les points de définition de la cote servent de repli (cote à jour de sa géométrie).
export function assocFromAcad(meta, refs, get) {
  const radial = meta.type === 'radius' || meta.type === 'diameter';
  const out = radial ? [null] : [null, null];
  for (const r of refs || []) {
    const e = get(r.obj);
    if (!e) continue;
    if (radial) {
      if (r.bit === 1 && (e.type === 'CIRCLE' || e.type === 'ARC')) out[0] = { id: e.id, k: 'circle', i: 0 };
      continue;
    }
    if (r.bit > 1) continue;
    const def = r.bit === 0 ? meta.p1 : meta.p2;
    const tol = 1e-6 * (1 + Math.hypot(def?.[0] || 0, def?.[1] || 0));
    out[r.bit] = refFor(e, pointOfAcadRef(e, r), tol) || refFor(e, def, tol);
  }
  return out.some(Boolean) ? out : null;
}

// Objets DIMASSOC d'un DXF (lecture du texte) → Map(poignée de la cote → références).
export function scanDimAssoc(text) {
  const out = new Map();
  if (!text || !text.includes('AcDbDimAssoc')) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== 'DIMASSOC') continue;
    const pairs = [];
    let j = i + 2;
    for (; j + 1 < lines.length && lines[j].trim() !== '0'; j += 2) pairs.push([parseInt(lines[j], 10), lines[j + 1].trim()]);
    i = j - 2;
    const st = pairs.findIndex(([c, v]) => c === 100 && v === 'AcDbDimAssoc');
    if (st < 0) continue;
    const body = pairs.slice(st + 1);
    const dim = body.find(([c]) => c === 330)?.[1];
    const flags = parseInt(body.find(([c]) => c === 90)?.[1], 10) || 0;
    const bits = [0, 1, 2, 3].filter((b) => flags & (1 << b));
    const refs = [];
    let cur = null;
    for (const [c, v] of body) {
      if (c === 1) { cur = { bit: bits[refs.length] ?? refs.length }; refs.push(cur); continue; }
      if (!cur) continue;
      if (c === 72) cur.osnap = parseInt(v, 10);
      else if (c === 331 && !cur.obj) cur.obj = v.toUpperCase();
      else if (c === 91) cur.gs = parseInt(v, 10);
      else if (c === 40) cur.param = parseFloat(v);
    }
    if (dim) out.set(dim.toUpperCase(), refs);
  }
  return out;
}

// Points de définition d'une cote pour le DXF, transformés par la matrice m de la cote :
// linéaire / alignée { p13, p14, p10 (ligne de cote sur la 2e ligne d'attache), rotation } ; rayon { p10 centre,
// p15 point sur la courbe } ; diamètre { p10, p15 extrémités du diamètre }. null si la cote ne s'écrit pas ainsi.
export function dimDefPoints(meta, m = G.IDENTITY) {
  const T = (p) => G.applyPt(m, p);
  if ((meta?.type === 'linear' || meta?.type === 'aligned') && meta.p1 && meta.p2 && meta.loc) {
    const p1 = T(meta.p1), p2 = T(meta.p2), loc = T(meta.loc);
    let u;
    if (meta.type === 'aligned') u = G.norm(G.sub(p2, p1));
    else { const d = G.applyVec(m, [Math.cos(meta.rotation || 0), Math.sin(meta.rotation || 0)]); u = G.norm(d); }
    if (!u[0] && !u[1]) return null;
    const n = G.perp(u);
    const p10 = G.add(p2, G.mul(n, G.dot(G.sub(loc, p2), n)));
    return { kind: meta.type, p13: p1, p14: p2, p10, rotation: Math.atan2(u[1], u[0]) };
  }
  if ((meta?.type === 'radius' || meta?.type === 'diameter') && meta.c && meta.r > 0 && meta.loc) {
    const c = T(meta.c), loc = T(meta.loc), r = meta.r * (G.scaleOf(m) || 1);
    const dir = G.norm(G.sub(loc, c));
    if (!dir[0] && !dir[1]) return null;
    const near = G.add(c, G.mul(dir, r));
    return meta.type === 'radius'
      ? { kind: 'radius', p10: c, p15: near, measure: r }
      : { kind: 'diameter', p10: G.sub(c, G.mul(dir, r)), p15: near, measure: 2 * r };
  }
  return null;
}
