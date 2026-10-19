// SPDX-License-Identifier: GPL-3.0-or-later
// Construction géométrique des cotes (lignes d'attache, ligne de cote, flèches, texte).
// Utilisée à l'import (cotes sans bloc précalculé) et par les commandes de cotation.
import * as G from './geom.js';

// Tailles par défaut (comme le style ISO-25 d'AutoCAD), multipliées par l'échelle d'annotation.
export function dimSizes(scale = 1, style = {}) {
  return {
    asz: (style.DIMASZ ?? 2.5) * scale,
    txt: (style.DIMTXT ?? 2.5) * scale,
    exe: (style.DIMEXE ?? 1.25) * scale,
    exo: (style.DIMEXO ?? 0.625) * scale,
    gap: (style.DIMGAP ?? 0.625) * scale,
    dec: style.DIMDEC ?? 2,
    blk: style.DIMBLK || 'fermee', // fermee | ouverte | oblique | point
    lfac: style.DIMLFAC > 0 ? style.DIMLFAC : 1,
    post: style.DIMPOST || '',
  };
}

// Texte d'une mesure : facteur d'échelle des mesures, décimales, suffixe (« 2,50 m »…).
const label = (v, sizes) => `${formatMeasure(v * (sizes.lfac || 1), sizes.dec)}${sizes.post || ''}`;

// Extrémité de cote selon le style : flèche pleine, flèche ouverte, trait oblique (architecte) ou point.
export function arrowFor(tip, dir, sizes, base) {
  const s = sizes.asz;
  if (sizes.blk === 'oblique') {
    const d = [(dir[0] - dir[1]) * Math.SQRT1_2 * s / 2, (dir[1] + dir[0]) * Math.SQRT1_2 * s / 2];
    return [{ ...base, type: 'LINE', p1: [tip[0] - d[0], tip[1] - d[1], 0], p2: [tip[0] + d[0], tip[1] + d[1], 0] }];
  }
  if (sizes.blk === 'point') {
    const r = s / 5, n = 12, loop = [];
    for (let i = 0; i < n; i++) loop.push([tip[0] + r * Math.cos((i * 2 * Math.PI) / n), tip[1] + r * Math.sin((i * 2 * Math.PI) / n)]);
    return [{ ...base, type: 'HATCH', solid: true, pattern: 'SOLID', loops: [loop], lines: [], z: 0 }];
  }
  if (sizes.blk === 'ouverte') {
    const w = s / 6, back = [tip[0] + dir[0] * s, tip[1] + dir[1] * s];
    return [
      { ...base, type: 'LINE', p1: [tip[0], tip[1], 0], p2: [back[0] - dir[1] * w, back[1] + dir[0] * w, 0] },
      { ...base, type: 'LINE', p1: [tip[0], tip[1], 0], p2: [back[0] + dir[1] * w, back[1] - dir[0] * w, 0] },
    ];
  }
  return [{ ...base, ...arrowSolid(tip, dir, s) }];
}

export function formatMeasure(v, dec = 2) {
  const k = 10 ** dec;
  return String(Math.round(v * k) / k);
}

export function arrowSolid(tip, dir, size) {
  const w = size / 6;
  const back = [tip[0] + dir[0] * size, tip[1] + dir[1] * size];
  const a = [back[0] - dir[1] * w, back[1] + dir[0] * w];
  const b = [back[0] + dir[1] * w, back[1] - dir[0] * w];
  return { type: 'SOLID', pts: [tip, a, b, b], z: 0 };
}

function readableAngle(a) {
  let r = G.normAngle(a);
  if (r > Math.PI / 2 + 1e-6 && r <= Math.PI * 1.5 + 1e-6) r -= Math.PI;
  return r;
}

// Cote linéaire (rotation donnée : 0 = horizontale, π/2 = verticale) ou alignée (rotation null).
// p1, p2 : origines des lignes d'attache ; loc : un point de la ligne de cote.
export function linearDimension({ p1, p2, loc, rotation = null, sizes, text, textPoint }) {
  const u = rotation == null ? G.norm(G.sub(p2, p1)) : [Math.cos(rotation), Math.sin(rotation)];
  if (!u[0] && !u[1]) return null;
  const proj = (p) => {
    const t = (p[0] - loc[0]) * u[0] + (p[1] - loc[1]) * u[1];
    return [loc[0] + u[0] * t, loc[1] + u[1] * t];
  };
  const a = proj(p1), b = proj(p2);
  const base = { layer: '0', color: 0 };
  const out = [];
  const ext = (p, q) => {
    const n = G.norm(G.sub(q, p));
    if (!n[0] && !n[1]) return;
    out.push({ ...base, type: 'LINE', p1: [p[0] + n[0] * sizes.exo, p[1] + n[1] * sizes.exo, 0], p2: [q[0] + n[0] * sizes.exe, q[1] + n[1] * sizes.exe, 0] });
  };
  ext(p1, a);
  ext(p2, b);
  out.push({ ...base, type: 'LINE', p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
  const span = G.dist(a, b);
  if (span > 1e-12) {
    const v = G.norm(G.sub(b, a));
    out.push(...arrowFor(a, v, sizes, base));
    out.push(...arrowFor(b, [-v[0], -v[1]], sizes, base));
  }
  const measure = span;
  const txt = text && text !== '<>' ? text.replace('<>', label(measure, sizes)) : label(measure, sizes);
  const rot = readableAngle(Math.atan2(u[1], u[0]));
  // Texte au-dessus de la ligne de cote (côté « haut » de la direction lisible).
  const up = [-Math.sin(rot), Math.cos(rot)];
  const m = G.mid(a, b);
  const tp = textPoint || [m[0] + up[0] * (sizes.gap + sizes.txt / 2), m[1] + up[1] * (sizes.gap + sizes.txt / 2)];
  out.push({ ...base, type: 'TEXT', p: [tp[0], tp[1], 0], h: sizes.txt, rot, text: txt, align: 'center', valign: 'middle', wf: 1 });
  return { entities: out, measure };
}

// Cote de rayon / diamètre : ligne de rappel du centre vers le point indiqué, flèche sur le cercle.
export function radialDimension({ c, r, loc, diameter = false, sizes }) {
  const dir = G.norm(G.sub(loc, c));
  if (!dir[0] && !dir[1]) return null;
  const onCircle = [c[0] + dir[0] * r, c[1] + dir[1] * r];
  const base = { layer: '0', color: 0 };
  const out = [];
  const start = diameter ? [c[0] - dir[0] * r, c[1] - dir[1] * r] : c;
  out.push({ ...base, type: 'LINE', p1: [start[0], start[1], 0], p2: [loc[0], loc[1], 0] });
  out.push(...arrowFor(onCircle, [-dir[0], -dir[1]], sizes, base));
  if (diameter) out.push(...arrowFor(start, dir, sizes, base));
  const measure = diameter ? 2 * r : r;
  const txt = `${diameter ? 'Ø' : 'R'}${label(measure, sizes)}`;
  const rot = readableAngle(Math.atan2(dir[1], dir[0]));
  const up = [-Math.sin(rot), Math.cos(rot)];
  const outside = G.dist(loc, c) > r;
  const anchor = outside ? loc : G.mid(onCircle, c);
  const tp = [anchor[0] + up[0] * (sizes.gap + sizes.txt / 2), anchor[1] + up[1] * (sizes.gap + sizes.txt / 2)];
  out.push({ ...base, type: 'TEXT', p: [tp[0], tp[1], 0], h: sizes.txt, rot, text: txt, align: 'center', valign: 'middle', wf: 1 });
  return { entities: out, measure };
}
