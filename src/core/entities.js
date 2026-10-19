// SPDX-License-Identifier: GPL-3.0-or-later
// Opérations par type d'entité : transformation, primitives géométriques exactes
// (segments, arcs, cercles), poignées et points d'accrochage.
//
// Schémas (coordonnées monde, angles en radians) :
//   LINE       { p1:[x,y,z], p2:[x,y,z] }
//   CIRCLE     { c:[x,y,z], r }
//   ARC        { c:[x,y,z], r, a0, a1 }                 (anti-horaire de a0 à a1)
//   LWPOLYLINE { pts:[[x,y]...], bulges:[...], closed, z, width }
//   POLY3D     { pts:[[x,y,z]...], closed }
//   ELLIPSE    { c:[x,y,z], major:[x,y], ratio, a0, a1 }
//   SPLINE     { degree, knots, ctrl:[[x,y,z]...], weights, fit:[[x,y,z]...], closed }
//   POINT      { p:[x,y,z] }
//   SOLID      { pts:[[x,y]×4], z }
//   TEXT       { p:[x,y,z], h, rot, text, align, valign, wf, style }
//   MTEXT      { p:[x,y,z], h, rot, text, width, attach, spacing }
//   INSERT     { name, p:[x,y,z], sx, sy, sz, rot, cols, rows, dc, dr, attribs:[TEXT…] }
//   HATCH      { loops:[[[x,y]...]...], solid, pattern, lines:[{angle, base, offset, dashes}], z, fill }
//   BLOCKREF   { name, m:[a,b,c,d,e,f], kind }  (cotes, tableaux… : bloc anonyme placé par une matrice)
//   UNDERLAY   { kind, path, page, p:[x,y,z], u:[x,y], v:[x,y], native, … }  (fond PDF / image, underlay/underlay.js)
//   WIPEOUT    { pts:[[x,y]...], z }  (masque : polygone fermé de la couleur du fond)
// Tout objet peut porter `order` : clé d'ordre de tracé (sinon son id), voir core/draworder.js.
import * as G from './geom.js';
import { splinePoints, ellipsePoints } from '../curves.js';
import { frameLoops } from '../underlay/underlay.js';

// --- transformation (similitudes : déplacer, tourner, échelle uniforme, miroir) -----------

function txAngle(m, a) {
  const v = G.applyVec(m, [Math.cos(a), Math.sin(a)]);
  return Math.atan2(v[1], v[0]);
}

// Orientation lisible d'un texte après transformation (comme MIRRTEXT = 0).
function textRotation(m, rot) {
  let r = txAngle(m, rot);
  if (G.isMirror(m)) {
    r = G.normAngle(r);
    if (r > Math.PI / 2 + 1e-9 && r <= Math.PI * 1.5 + 1e-9) r -= Math.PI;
  }
  return r;
}

export function transformEntity(e, m) {
  const s = G.scaleOf(m);
  const mir = G.isMirror(m);
  // Copie superficielle : chaque champ géométrique est remplacé ci-dessous par un nouveau tableau ; le reste
  // (calque, paramètres MEP…) est partagé, les entités étant traitées comme immuables (doc.modify clone).
  const out = { ...e };
  const P = (p) => G.applyPt(m, p);
  switch (e.type) {
    case 'LINE':
      out.p1 = P(e.p1); out.p2 = P(e.p2);
      break;
    case 'CIRCLE':
      out.c = P(e.c); out.r = e.r * s;
      break;
    case 'ARC':
      out.c = P(e.c); out.r = e.r * s;
      if (mir) { out.a0 = txAngle(m, e.a1); out.a1 = txAngle(m, e.a0); } else { out.a0 = txAngle(m, e.a0); out.a1 = txAngle(m, e.a1); }
      break;
    case 'LWPOLYLINE':
      out.pts = e.pts.map(P);
      if (mir) out.bulges = e.bulges.map((b) => -b);
      if (e.width) out.width = e.width * s;
      if (e.widths) out.widths = e.widths.map(([a, b]) => [a * s, b * s]);
      break;
    case 'POLY3D':
    case 'SOLID':
    case 'WIPEOUT':
      out.pts = e.pts.map(P);
      break;
    case 'VIEWPORT':
      // Le cadre reste aligné sur les axes ; une rotation tourne la vue (comme VPROTATEASSOC).
      out.c = P(e.c); out.w = e.w * s; out.h = e.h * s;
      out.twist = (e.twist || 0) + G.rotationOf(m) * (mir ? -1 : 1);
      if (e.clip) out.clip = e.clip.map((q) => G.apply(m, q[0], q[1])); // contour d'une fenêtre découpée
      break;
    case 'ELLIPSE':
      out.c = P(e.c); out.major = G.applyVec(m, e.major);
      if (mir) { out.a0 = -e.a1; out.a1 = -e.a0; }
      break;
    case 'SPLINE':
      out.ctrl = (e.ctrl || []).map(P);
      out.fit = (e.fit || []).map(P);
      break;
    case 'POINT':
      out.p = P(e.p);
      break;
    case 'XLINE':
      out.p = P(e.p);
      out.dir = G.norm(G.applyVec(m, e.dir));
      break;
    case 'TEXT':
    case 'ATTDEF':
    case 'MTEXT':
      out.p = P(e.p); out.h = e.h * s; out.rot = textRotation(m, e.rot || 0);
      if (e.width) out.width = e.width * s;
      break;
    case 'INSERT': {
      out.p = P(e.p);
      const xc = G.applyVec(m, [Math.cos(e.rot) * e.sx, Math.sin(e.rot) * e.sx]);
      const yc = G.applyVec(m, [-Math.sin(e.rot) * e.sy, Math.cos(e.rot) * e.sy]);
      out.rot = Math.atan2(xc[1], xc[0]);
      out.sx = G.len(xc);
      out.sy = G.dot(yc, [-Math.sin(out.rot), Math.cos(out.rot)]);
      out.dc = (e.dc || 0) * s; out.dr = (e.dr || 0) * s;
      out.attribs = (e.attribs || []).map((a) => transformEntity(a, m));
      break;
    }
    case 'HATCH':
      out.loops = e.loops.map((loop) => loop.map(P));
      out.patAngle = txAngle(m, e.patAngle || 0);
      out.patScale = (e.patScale || 1) * s;
      if (e.patOrigin) out.patOrigin = G.apply(m, e.patOrigin[0], e.patOrigin[1]);
      if (e.assoc?.seeds) out.assoc = { ...e.assoc, seeds: e.assoc.seeds.map((q) => G.apply(m, q[0], q[1])) };
      out.lines = (e.lines || []).map((l) => ({
        angle: txAngle(m, l.angle),
        base: G.apply(m, l.base[0], l.base[1]),
        offset: G.applyVec(m, l.offset),
        dashes: l.dashes.map((d) => d * s),
      }));
      break;
    case 'BLOCKREF':
      out.m = G.compose(m, e.m);
      break;
    case 'UNDERLAY':
      out.p = P(e.p); out.u = G.applyVec(m, e.u); out.v = G.applyVec(m, e.v);
      break;
  }
  return out;
}

// Matrice bloc → monde d'une insertion (sans le décalage du réseau).
export function insertMatrix(e, base = [0, 0], col = 0, row = 0) {
  let m = G.translation(-base[0], -base[1]);
  m = G.compose(G.scaling(e.sx ?? 1, e.sy ?? 1), m);
  m = G.compose(G.translation(col * (e.dc || 0), row * (e.dr || 0)), m);
  m = G.compose(G.rotation(e.rot || 0), m);
  return G.compose(G.translation(e.p[0], e.p[1]), m);
}

// --- primitives exactes ---------------------------------------------------------

// Segments et arcs d'une polyligne légère ; chaque élément garde l'index du sommet de départ.
export function polylineCurves(e) {
  const out = [];
  const n = e.pts.length;
  const count = e.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = e.pts[i], b = e.pts[(i + 1) % n];
    const bulge = e.bulges?.[i] || 0;
    if (Math.abs(bulge) < 1e-12 || G.samePoint(a, b, 1e-12)) out.push({ k: 'seg', a: [a[0], a[1]], b: [b[0], b[1]], i });
    else {
      const arc = G.bulgeToArc(a, b, bulge);
      out.push({ k: 'arc', c: arc.c, r: arc.r, a0: arc.a0, a1: arc.a1, rev: !arc.ccw, i });
    }
  }
  return out;
}

function chain(pts, closed) {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push({ k: 'seg', a: pts[i - 1], b: pts[i], i: i - 1 });
  if (closed && pts.length > 2) out.push({ k: 'seg', a: pts[pts.length - 1], b: pts[0], i: pts.length - 1 });
  return out;
}

// Liste de primitives { k: 'seg'|'arc'|'circle' } pour l'accrochage, l'ajustement, etc.
// `fallbackSegs(e)` fournit les segments tessellés des entités complexes (blocs, hachures…).
export function curvesOf(e, fallbackSegs) {
  switch (e.type) {
    case 'LINE': return [{ k: 'seg', a: e.p1, b: e.p2 }];
    case 'CIRCLE': return [{ k: 'circle', c: e.c, r: e.r }];
    case 'ARC': return [{ k: 'arc', c: e.c, r: e.r, a0: e.a0, a1: e.a1 }];
    case 'LWPOLYLINE': return polylineCurves(e);
    case 'POLY3D': return chain(e.pts, e.closed);
    case 'SOLID': return chain([e.pts[0], e.pts[1], e.pts[3] || e.pts[2], e.pts[2]], true);
    case 'WIPEOUT': return chain(e.pts.map((q) => [q[0], q[1], e.z || 0]), true);
    case 'VIEWPORT': if (e.clip?.length >= 3) return chain(e.clip.map((q) => [q[0], q[1], 0]), true);
      return chain([[e.c[0] - e.w / 2, e.c[1] - e.h / 2, 0], [e.c[0] + e.w / 2, e.c[1] - e.h / 2, 0], [e.c[0] + e.w / 2, e.c[1] + e.h / 2, 0], [e.c[0] - e.w / 2, e.c[1] + e.h / 2, 0]], true);
    case 'ELLIPSE': return chain(ellipsePoints({ x: e.c[0], y: e.c[1], z: e.c[2] || 0 }, { x: e.major[0], y: e.major[1], z: 0 }, e.ratio, e.a0, e.a1), false);
    case 'SPLINE': return chain(splineWorldPoints(e), false);
    case 'UNDERLAY': return frameLoops(e).flatMap((loop) => chain(loop, true));
    default: {
      const segs = fallbackSegs ? fallbackSegs(e) : null;
      if (!segs) return [];
      const out = [];
      for (let i = 0; i + 5 < segs.length; i += 6) out.push({ k: 'seg', a: [segs[i], segs[i + 1]], b: [segs[i + 3], segs[i + 4]] });
      return out;
    }
  }
}

export function splineWorldPoints(e) {
  const ctrl = (e.ctrl || []).map((p) => ({ x: p[0], y: p[1], z: p[2] || 0 }));
  const fit = (e.fit || []).map((p) => ({ x: p[0], y: p[1], z: p[2] || 0 }));
  return splinePoints(e.degree, e.knots, ctrl, e.weights, fit).map((p) => [p[0], p[1], p[2]]);
}

export function curveStart(c) {
  if (c.k === 'seg') return c.a;
  if (c.k === 'arc') return G.polar(c.c, c.rev ? c.a1 : c.a0, c.r);
  return null;
}

export function curveEnd(c) {
  if (c.k === 'seg') return c.b;
  if (c.k === 'arc') return G.polar(c.c, c.rev ? c.a0 : c.a1, c.r);
  return null;
}

export function curveMid(c) {
  if (c.k === 'seg') return G.mid(c.a, c.b);
  if (c.k === 'arc') return G.polar(c.c, G.arcMidAngle(c.a0, c.a1), c.r);
  return null;
}

export function curveLength(c) {
  if (c.k === 'seg') return G.dist(c.a, c.b);
  if (c.k === 'arc') return c.r * G.sweep(c.a0, c.a1);
  return 2 * Math.PI * c.r;
}

// Point le plus proche de p sur la primitive.
export function nearestOnCurve(c, p) {
  if (c.k === 'seg') return G.closestOnSegment(p, c.a, c.b).point;
  const a = G.angleOf(c.c, p);
  if (c.k === 'circle' || G.angleOnArc(a, c.a0, c.a1)) return G.polar(c.c, a, c.r);
  const s = G.polar(c.c, c.a0, c.r), e = G.polar(c.c, c.a1, c.r);
  return G.dist(p, s) < G.dist(p, e) ? s : e;
}

// Pied de la perpendiculaire menée de p (sur la droite / le cercle porteur, et sur la primitive).
export function perpendicularFoot(c, p) {
  if (c.k === 'seg') {
    const r = G.projectOnLine(p, c.a, c.b);
    return r.t >= -1e-9 && r.t <= 1 + 1e-9 ? r.point : null;
  }
  const a = G.angleOf(c.c, p);
  if (c.k === 'circle' || G.angleOnArc(a, c.a0, c.a1)) return G.polar(c.c, a, c.r);
  return null;
}

// Intersections entre deux primitives ; ext1 / ext2 : prolonger la première / la seconde
// (droite infinie, cercle complet).
export function intersectCurves(c1, c2, ext1 = false, ext2 = ext1) {
  const onCurve = (c, p) => {
    if ((c === c1 ? ext1 : ext2) || c.k === 'circle') return true;
    if (c.k === 'arc') return G.angleOnArc(G.angleOf(c.c, p), c.a0, c.a1, 1e-9);
    const r = G.projectOnLine(p, c.a, c.b);
    return r.t >= -1e-9 && r.t <= 1 + 1e-9;
  };
  let pts = [];
  if (c1.k === 'seg' && c2.k === 'seg') {
    const x = G.lineLine(c1.a, c1.b, c2.a, c2.b);
    if (x) pts = [x.point];
  } else if (c1.k === 'seg') {
    pts = G.lineCircle(c1.a, c1.b, c2.c, c2.r).map((r) => r.point);
  } else if (c2.k === 'seg') {
    pts = G.lineCircle(c2.a, c2.b, c1.c, c1.r).map((r) => r.point);
  } else {
    pts = G.circleCircle(c1.c, c1.r, c2.c, c2.r);
  }
  return pts.filter((p) => onCurve(c1, p) && onCurve(c2, p));
}

// Distance du point p à l'entité (pour la sélection).
export function distanceToCurves(curves, p) {
  let best = Infinity;
  for (const c of curves) {
    const q = nearestOnCurve(c, p);
    const d = G.dist(p, q);
    if (d < best) best = d;
  }
  return best;
}

// --- poignées ----------------------------------------------------------------------

export function gripsOf(e) {
  switch (e.type) {
    case 'LINE': return [{ p: e.p1, k: 'p1' }, { p: G.mid(e.p1, e.p2), k: 'mid' }, { p: e.p2, k: 'p2' }];
    case 'CIRCLE': return [{ p: e.c, k: 'c' }, ...[0, 1, 2, 3].map((i) => ({ p: G.polar(e.c, (i * Math.PI) / 2, e.r), k: 'r' }))];
    case 'ARC': return [
      { p: G.polar(e.c, e.a0, e.r), k: 'a0' },
      { p: G.polar(e.c, G.arcMidAngle(e.a0, e.a1), e.r), k: 'amid' },
      { p: G.polar(e.c, e.a1, e.r), k: 'a1' },
      { p: e.c, k: 'c' },
    ];
    case 'LWPOLYLINE': return e.pts.map((p, i) => ({ p, k: 'v', i }));
    case 'POLY3D': return e.pts.map((p, i) => ({ p, k: 'v', i }));
    case 'WIPEOUT': return e.pts.map((p, i) => ({ p, k: 'v', i }));
    case 'POINT': return [{ p: e.p, k: 'move' }];
    case 'XLINE': return [{ p: e.p, k: 'move' }];
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'ATTDEF': return [{ p: e.p, k: 'move' }];
    case 'ELLIPSE': return [{ p: e.c, k: 'move' }];
    case 'VIEWPORT': if (e.clip) return [{ p: e.c, k: 'move' }]; return [{ p: e.c, k: 'move' }, ...[[-1, -1], [1, -1], [1, 1], [-1, 1]]
      .map(([sx, sy], i) => ({ p: [e.c[0] + (sx * e.w) / 2, e.c[1] + (sy * e.h) / 2], k: 'vpc', i }))];
    case 'SPLINE': return (e.ctrl?.length ? e.ctrl : e.fit || []).map((p, i) => ({ p, k: e.ctrl?.length ? 'ctrl' : 'fit', i }));
    case 'BLOCKREF': return [{ p: [e.m[4], e.m[5]], k: 'move' }];
    case 'UNDERLAY': return [{ p: e.p, k: 'move' }];
    default: return [];
  }
}

// Nouvelle entité après déplacement d'une poignée vers le point q.
export function applyGrip(e, grip, q) {
  const out = structuredClone(e);
  const z = (p) => (p.length > 2 ? [q[0], q[1], p[2]] : [q[0], q[1]]);
  switch (grip.k) {
    case 'p1': out.p1 = z(e.p1); return out;
    case 'p2': out.p2 = z(e.p2); return out;
    case 'c': if (e.type === 'CIRCLE' || e.type === 'ARC') out.c = z(e.c); return out;
    case 'r': out.r = G.dist(e.c, q); return out;
    case 'a0': case 'a1': {
      // Extrémité d'arc : l'arc passe par l'autre extrémité, le milieu actuel et le nouveau point.
      const other = G.polar(e.c, grip.k === 'a0' ? e.a1 : e.a0, e.r);
      const m = G.polar(e.c, G.arcMidAngle(e.a0, e.a1), e.r);
      const arc = grip.k === 'a0' ? G.arcFrom3Points(q, m, other) : G.arcFrom3Points(other, m, q);
      if (arc) Object.assign(out, { c: [arc.c[0], arc.c[1], e.c[2] || 0], r: arc.r, a0: arc.a0, a1: arc.a1 });
      return out;
    }
    case 'amid': {
      const s = G.polar(e.c, e.a0, e.r), f = G.polar(e.c, e.a1, e.r);
      const arc = G.arcFrom3Points(s, q, f);
      if (arc) Object.assign(out, { c: [arc.c[0], arc.c[1], e.c[2] || 0], r: arc.r, a0: arc.a0, a1: arc.a1 });
      return out;
    }
    case 'v': out.pts[grip.i] = z(e.pts[grip.i]); return out;
    case 'ctrl': out.ctrl[grip.i] = [q[0], q[1], e.ctrl[grip.i][2] || 0]; return out;
    case 'fit': out.fit[grip.i] = [q[0], q[1], e.fit[grip.i][2] || 0]; return out;
    case 'vpc': {
      // Coin de fenêtre : le coin opposé reste fixe ; échelle et position du contenu sur la feuille conservées.
      const opp = [e.c[0] * 2 - grip.p[0], e.c[1] * 2 - grip.p[1]];
      const w = Math.abs(q[0] - opp[0]), h = Math.abs(q[1] - opp[1]);
      if (!(w > 0 && h > 0)) return out;
      const k = e.h / e.vh;
      const c = [(q[0] + opp[0]) / 2, (q[1] + opp[1]) / 2, e.c[2] || 0];
      Object.assign(out, { c, w, h, vh: h / k, vc: [e.vc[0] + (c[0] - e.c[0]) / k, e.vc[1] + (c[1] - e.c[1]) / k] });
      return out;
    }
    case 'mid':
    case 'move': {
      return transformEntity(e, G.translation(q[0] - grip.p[0], q[1] - grip.p[1]));
    }
  }
  return out;
}

// --- points d'accrochage ------------------------------------------------------------

export function snapPointsOf(e) {
  const out = [];
  const push = (p, k) => out.push({ p, k });
  switch (e.type) {
    case 'LINE': push(e.p1, 'end'); push(e.p2, 'end'); push(G.mid(e.p1, e.p2), 'mid'); break;
    case 'CIRCLE': push(e.c, 'cen'); for (let i = 0; i < 4; i++) push(G.polar(e.c, (i * Math.PI) / 2, e.r), 'qua'); break;
    case 'ARC': {
      push(G.polar(e.c, e.a0, e.r), 'end'); push(G.polar(e.c, e.a1, e.r), 'end');
      push(G.polar(e.c, G.arcMidAngle(e.a0, e.a1), e.r), 'mid'); push(e.c, 'cen');
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        if (G.angleOnArc(a, e.a0, e.a1)) push(G.polar(e.c, a, e.r), 'qua');
      }
      break;
    }
    case 'LWPOLYLINE':
      e.pts.forEach((p) => push(p, 'end'));
      for (const c of polylineCurves(e)) {
        push(curveMid(c), 'mid');
        if (c.k === 'arc') push(c.c, 'cen');
      }
      break;
    case 'POLY3D': case 'SOLID': case 'WIPEOUT':
      e.pts.forEach((p) => push(p, 'end'));
      break;
    case 'POINT': push(e.p, 'node'); break;
    case 'XLINE': push(e.p, 'end'); break;
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'ATTDEF': push(e.p, 'ins'); break;
    case 'ELLIPSE': push(e.c, 'cen'); break;
    case 'UNDERLAY': push(e.p, 'ins'); for (const loop of frameLoops(e)) for (const q of loop) push(q, 'end'); break;
    case 'SPLINE': {
      const pts = splineWorldPoints(e);
      if (pts.length) { push(pts[0], 'end'); push(pts[pts.length - 1], 'end'); }
      break;
    }
  }
  return out;
}
