// SPDX-License-Identifier: GPL-3.0-or-later
// Tessellation : entité → « parts » affichables { layer, color, lw, segs, tris, pts, texts }.
//
// Couleurs sous forme de jetons, résolus au moment du rendu :
//   nombre 0xRRGGBB ou 'fg' (blanc/noir selon le fond), 'bg' (couleur du fond : masques), 'BYBLOCK',
//   'L:<calque>' (couleur du calque).
// Un calque '0' ou un jeton 'L:0' / 'BYBLOCK' dans un bloc hérite de l'insertion.
// Épaisseur (lw) : centièmes de mm, -1 DuCalque (calque de la part), 'L:<calque>', -2 DuBloc, -3 défaut
// (voir partLineweight dans document.js).
//
// La géométrie de chaque définition de bloc est calculée une seule fois (cache),
// puis transformée pour chaque insertion.
import { blockForInsert } from '../blocks/dynamic.js';
import { pointSymbol, pointSize } from './drawing-settings.js';
import * as G from './geom.js';
import { aciToColor } from '../colors.js';
import { arcPoints, circlePoints, ellipsePoints } from '../curves.js';
import { triangulateLoops, patternSegments } from '../hatch.js';
import { makeText, parseMText, plainText } from '../text.js';
import { insertMatrix, polylineCurves, splineWorldPoints } from './entities.js';
import { mepGeometry, labelHeight } from '../mep/geometry.js';
import { conduitLtype } from '../mep/systems.js';
import { frameLoops } from '../underlay/underlay.js';
import { fontOfText, styleOfText } from '../fonts/registry.js';
import { measure as shxMeasure, lineStrokes } from '../fonts/shx.js';
import { clipParts } from './clip.js';

const MAX_DEPTH = 16;
export const XLINE_LENGTH = 1e6;
const MTEXT_ATTACH = {
  1: ['left', 'top'], 2: ['center', 'top'], 3: ['right', 'top'],
  4: ['left', 'middle'], 5: ['center', 'middle'], 6: ['right', 'middle'],
  7: ['left', 'mtext-bottom'], 8: ['center', 'mtext-bottom'], 9: ['right', 'mtext-bottom'],
};

export function colorToken(e) {
  if (typeof e.rgb === 'number') return e.rgb;
  const c = e.color ?? 256;
  if (c === 0) return 'BYBLOCK';
  if (c >= 1 && c <= 255) return aciToColor(c);
  return `L:${e.layer || '0'}`;
}

class Parts {
  constructor() { this.map = new Map(); }
  // tag 'frame' : cadre de découpe (affiché, non tracé) ; ps : style de tracé nommé de l'objet ('' : DuCalque,
  // 'BYBLOCK' : celui de l'insertion).
  get(layer, color, lw = -1, tag = '', ps = '') {
    const key = `${layer}\u0000${color}\u0000${lw}\u0000${tag}\u0000${ps}`;
    let p = this.map.get(key);
    if (!p) {
      p = { layer, color, lw, ps, segs: [], tris: [], pts: [], texts: [] };
      if (tag === 'frame') p.noPlot = true;
      this.map.set(key, p);
    }
    return p;
  }
  list() { return [...this.map.values()]; }
}

function pushPolyline(segs, pts, closed, z = 0) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    segs.push(a[0], a[1], a[2] ?? z, b[0], b[1], b[2] ?? z);
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    segs.push(a[0], a[1], a[2] ?? z, b[0], b[1], b[2] ?? z);
  }
}

// Bande pleine de largeur constante le long d'une polyligne : un quadrilatère (deux triangles) par segment,
// raccords en onglet limités à 4 × la demi-largeur (comme les polylignes épaisses d'AutoCAD).
export function pushWideBand(tris, pts, closed, width, z = 0) {
  const hw = width / 2;
  const P = [];
  for (const p of pts) if (!P.length || Math.hypot(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1]) > 1e-12) P.push(p);
  if (closed && P.length > 2 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-12) P.pop();
  const m = P.length;
  if (m < 2 || !(hw > 0)) return;
  const normal = (i) => { // segment i → i + 1
    const a = P[i], b = P[(i + 1) % m];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  };
  const L = [], R = [];
  for (let i = 0; i < m; i++) {
    const prev = closed || i > 0 ? normal((i - 1 + m) % m) : null;
    const next = closed || i < m - 1 ? normal(i) : null;
    let o;
    if (!prev || !next) { const n = prev || next; o = [n[0] * hw, n[1] * hw]; } else {
      let mx = prev[0] + next[0], my = prev[1] + next[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) o = [next[0] * hw, next[1] * hw]; // demi-tour
      else {
        mx /= ml; my /= ml;
        const k = Math.min(hw / Math.max(mx * next[0] + my * next[1], 1e-9), hw * 4);
        o = [mx * k, my * k];
      }
    }
    L.push([P[i][0] + o[0], P[i][1] + o[1]]);
    R.push([P[i][0] - o[0], P[i][1] - o[1]]);
  }
  const count = closed ? m : m - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % m;
    tris.push(L[i][0], L[i][1], z, R[i][0], R[i][1], z, L[j][0], L[j][1], z,
      R[i][0], R[i][1], z, R[j][0], R[j][1], z, L[j][0], L[j][1], z);
  }
}

// Largeurs par segment (début → fin, interpolées le long des arcs) : trapèzes sans raccord, comme AutoCAD.
export function pushVariableBand(tris, e, z = 0) {
  const quad = (a, b, na, nb, wa, wb) => {
    const L1 = [a[0] + na[0] * wa, a[1] + na[1] * wa], R1 = [a[0] - na[0] * wa, a[1] - na[1] * wa];
    const L2 = [b[0] + nb[0] * wb, b[1] + nb[1] * wb], R2 = [b[0] - nb[0] * wb, b[1] - nb[1] * wb];
    tris.push(L1[0], L1[1], z, R1[0], R1[1], z, L2[0], L2[1], z, R1[0], R1[1], z, R2[0], R2[1], z, L2[0], L2[1], z);
  };
  for (const c of polylineCurves(e)) {
    const [w0, w1] = (e.widths[c.i] || [0, 0]).map((w) => w / 2);
    if (!(w0 > 0) && !(w1 > 0)) continue;
    if (c.k === 'seg') {
      const L = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
      if (L < 1e-12) continue;
      const n = [-(c.b[1] - c.a[1]) / L, (c.b[0] - c.a[0]) / L];
      quad(c.a, c.b, n, n, w0, w1);
      continue;
    }
    // Arc : parcours dans le sens de la polyligne (rev = horaire), normale radiale.
    let s = c.a1 - c.a0;
    while (s <= 0) s += Math.PI * 2;
    const k = Math.max(2, Math.ceil(s / (Math.PI / 36)));
    const ang = (t) => (c.rev ? c.a1 - s * t : c.a0 + s * t);
    for (let j = 0; j < k; j++) {
      const t0 = j / k, t1 = (j + 1) / k;
      const u0 = [Math.cos(ang(t0)), Math.sin(ang(t0))], u1 = [Math.cos(ang(t1)), Math.sin(ang(t1))];
      const p0 = [c.c[0] + u0[0] * c.r, c.c[1] + u0[1] * c.r], p1 = [c.c[0] + u1[0] * c.r, c.c[1] + u1[1] * c.r];
      quad(p0, p1, u0, u1, w0 + (w1 - w0) * t0, w0 + (w1 - w0) * t1);
    }
  }
}

const MAX_DASHES = 20000;

// Trait discontinu le long d'une polyligne (motif continu d'un sommet à l'autre).
// Tiret > 0, espace < 0, point = 0. Si le motif est trop fin pour la longueur, trait continu.
export function strokeDashed(segs, pts, closed, { dashes, total }) {
  const list = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  let length = 0;
  for (let i = 1; i < list.length; i++) length += Math.hypot(list[i][0] - list[i - 1][0], list[i][1] - list[i - 1][1]);
  if (length / total * dashes.length > MAX_DASHES) { pushPolyline(segs, pts, closed, 0); return; }
  const dot = total * 0.002;              // un point est tracé comme un tiret minuscule…
  let k = 0;                              // élément courant du motif
  let left = Math.abs(dashes[0]);         // longueur restante de cet élément
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const za = a[2] || 0, zb = b[2] || 0;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = 0;
    while (t < segLen - 1e-12) {
      if (dashes[k] === 0) {
        // … qui ne fait pas avancer le motif.
        const f0 = t / segLen, f1 = Math.min(segLen, t + dot) / segLen;
        segs.push(a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0, za + (zb - za) * f0,
          a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1, za + (zb - za) * f1);
        k = (k + 1) % dashes.length;
        left = Math.abs(dashes[k]);
        continue;
      }
      const step = Math.min(left, segLen - t);
      if (dashes[k] >= 0) {
        const f0 = t / segLen, f1 = (t + step) / segLen;
        segs.push(a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0, za + (zb - za) * f0,
          a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1, za + (zb - za) * f1);
      }
      t += step;
      left -= step;
      if (left <= 1e-12) {
        k = (k + 1) % dashes.length;
        left = Math.abs(dashes[k]);
      }
    }
  }
}

export function polylinePoints(e) {
  const curves = polylineCurves(e);
  if (!curves.length) return e.pts.map((p) => [p[0], p[1]]);
  const out = [[e.pts[0][0], e.pts[0][1]]];
  for (const c of curves) {
    if (c.k === 'seg') out.push(c.b);
    else {
      const list = arcPoints(c.c[0], c.c[1], c.r, c.a0, c.a1);
      if (c.rev) list.reverse();
      for (let i = 1; i < list.length; i++) out.push([list[i][0], list[i][1]]);
    }
  }
  return out;
}

// Points tessellés (monde) d'une entité courbe simple ; null pour les autres types.
export function curvePoints(e) {
  switch (e.type) {
    case 'LINE': return { pts: [e.p1, e.p2], closed: false };
    case 'CIRCLE': return { pts: circlePoints(e.c[0], e.c[1], e.r, e.c[2] || 0), closed: false };
    case 'ARC': return { pts: arcPoints(e.c[0], e.c[1], e.r, e.a0, e.a1, e.c[2] || 0), closed: false };
    case 'LWPOLYLINE': return { pts: polylinePoints(e).map((p) => [p[0], p[1], e.z || 0]), closed: false };
    case 'POLY3D': return { pts: e.pts, closed: e.closed };
    case 'ELLIPSE': return {
      pts: ellipsePoints({ x: e.c[0], y: e.c[1], z: e.c[2] || 0 }, { x: e.major[0], y: e.major[1], z: 0 }, e.ratio, e.a0, e.a1),
      closed: false,
    };
    case 'SPLINE': return { pts: splineWorldPoints(e), closed: !!e.closed && !e.ctrl?.length };
    // Fenêtre de présentation : son cadre (le contenu est dessiné par le renderer).
    case 'VIEWPORT': if (e.clip?.length >= 3) return { pts: e.clip.map((q) => [q[0], q[1], 0]), closed: true }; // fenêtre découpée
      return { pts: [[e.c[0] - e.w / 2, e.c[1] - e.h / 2, 0], [e.c[0] + e.w / 2, e.c[1] - e.h / 2, 0], [e.c[0] + e.w / 2, e.c[1] + e.h / 2, 0], [e.c[0] - e.w / 2, e.c[1] + e.h / 2, 0]], closed: true };
    default: return null;
  }
}

function hatchGeometry(e, part) {
  const loops = e.loops.filter((l) => l.length >= 3);
  if (!loops.length) return;
  const z = e.z || 0;
  if (e.solid) {
    for (const t of triangulateLoops(loops)) part.tris.push(t[0], t[1], z);
    return;
  }
  const defs = (e.lines || []).map((l) => ({
    angle: l.angle, base: { x: l.base[0], y: l.base[1] }, offset: { x: l.offset[0], y: l.offset[1] }, dashLengths: l.dashes,
  }));
  const segs = defs.length ? patternSegments({ definitionLines: defs }, loops) : null;
  if (!segs) {
    for (const loop of loops) pushPolyline(part.segs, loop, true, z);
    return;
  }
  for (let i = 0; i + 1 < segs.length; i += 2) part.segs.push(segs[i][0], segs[i][1], z, segs[i + 1][0], segs[i + 1][1], z);
}

// Texte mis en page ; avec une police SHX (style du texte), aussi ses traits (segs) : le texte est alors dessiné
// comme de la géométrie, comme dans AutoCAD, et l'élément texte (t.shx) ne sert qu'à la sélection et à l'emprise.
function textItem(e, color, layer, doc = null, segs = null) {
  const font = doc ? fontOfText(doc, e) : null;
  const st = font ? styleOfText(doc, e) : null;
  const measure = font ? (s) => shxMeasure(font, s) : null;
  let t;
  if (e.type === 'TEXT') {
    const str = plainText(e.text);
    if (!str.trim() || !(e.h > 0)) return null;
    t = makeText({
      pos: e.p, rot: e.rot || 0, h: e.h, widthFactor: e.wf || 1, lines: [str],
      align: e.align || 'left', vAnchor: e.valign || 'baseline', color, layer, measure,
    });
  } else {
    const lines = parseMText(e.text);
    if (!lines.some((l) => l.trim()) || !(e.h > 0)) return null;
    const [align, vAnchor] = MTEXT_ATTACH[e.attach] || MTEXT_ATTACH[1];
    t = makeText({
      pos: e.p, rot: e.rot || 0, h: e.h, widthFactor: e.type === 'MTEXT' ? st?.widthFactor || 1 : 1, lines, align, vAnchor,
      lineSpacing: e.spacing || 1, wrapWidth: e.width, color, layer, measure,
    });
  }
  if (font && segs) {
    t.shx = true;
    const oblique = e.obl ?? st?.oblique ?? 0;
    const c = Math.cos(t.rot), s = Math.sin(t.rot), z = t.z || 0;
    t.lines.forEach((line, i) => {
      const w = measure(line) * t.h * t.widthFactor;
      const x0 = t.align === 'right' ? -w : t.align === 'center' || t.align === 'middle' ? -w / 2 : 0;
      const y0 = -(t.first + i * t.pitch);
      for (const pl of lineStrokes(font, line, { widthFactor: t.widthFactor, oblique })) {
        for (let k = 1; k < pl.length; k++) {
          const ax = x0 + pl[k - 1][0] * t.h, ay = y0 + pl[k - 1][1] * t.h, bx = x0 + pl[k][0] * t.h, by = y0 + pl[k][1] * t.h;
          segs.push(t.x + ax * c - ay * s, t.y + ax * s + ay * c, z, t.x + bx * c - by * s, t.y + bx * s + by * c, z);
        }
      }
    });
  }
  if (e.field?.code) t.field = true; // champ : fond gris à l'écran (comme FIELDDISPLAY = 1)
  return t;
}

export class Tessellator {
  constructor(doc, { linetypes = true, widths = true, shx = true } = {}) {
    this.doc = doc;
    this.linetypes = linetypes;
    this.shx = shx; // textes en police SHX dessinés en traits (faux : élément texte seul, pour les comparaisons)
    this.widths = widths; // polylignes épaisses dessinées en bande pleine
    this.blockCache = new Map();
    this.cacheVersion = doc.blockVersion;
    this.missingBlocks = new Set();
  }

  // Parts d'une entité, en coordonnées monde (ou coordonnées du bloc si l'entité est dans un bloc).
  entity(e, depth = 0, stack = []) {
    const parts = new Parts();
    const color = colorToken(e);
    const layer = e.layer || '0';
    const lw = e.lweight ?? -1;
    const ps = e.pstyle || '';
    const part = () => parts.get(layer, color, lw, '', ps);
    if (e.mep && e.type === 'LWPOLYLINE') {
      this.mep(e, part());
      return parts.list();
    }
    if (e.type === 'XLINE') {
      // Droite (ou demi-droite) de construction : segment très long (l'emprise du dessin l'ignore).
      const L = XLINE_LENGTH, d = e.dir;
      const a = e.ray ? [e.p[0], e.p[1]] : [e.p[0] - d[0] * L, e.p[1] - d[1] * L];
      pushPolyline(part().segs, [a, [e.p[0] + d[0] * L, e.p[1] + d[1] * L]], false, 0);
      return parts.list();
    }
    const curve = curvePoints(e);
    if (curve) {
      const pattern = this.dashPattern(e);
      if (pattern) strokeDashed(part().segs, curve.pts, curve.closed, pattern);
      else pushPolyline(part().segs, curve.pts, curve.closed, 0);
      // Polyligne épaisse : bande pleine (l'axe reste pour la sélection et l'accrochage).
      if (this.widths && e.type === 'LWPOLYLINE' && e.width > 0) pushWideBand(part().tris, curve.pts, curve.closed || e.closed, e.width);
      else if (this.widths && e.type === 'LWPOLYLINE' && e.widths) pushVariableBand(part().tris, e);
      return parts.list();
    }
    switch (e.type) {
      case 'POINT': {
        // Style de point du dessin (PDMODE) : point, plus, croix, trait, cercle, carré…
        const mode = this.doc.header?.pdmode | 0;
        if ((mode & 7) === 0) part().pts.push(e.p[0], e.p[1], e.p[2] || 0);
        if (mode) for (const pl of pointSymbol(e.p, mode, pointSize(this.doc))) pushPolyline(part().segs, pl, false, e.p[2] || 0);
        break;
      }
      case 'SOLID': {
        const [a, b, c, d = c] = e.pts;
        const z = e.z || 0;
        part().tris.push(a[0], a[1], z, b[0], b[1], z, c[0], c[1], z, b[0], b[1], z, d[0], d[1], z, c[0], c[1], z);
        break;
      }
      case 'ATTDEF': {
        if (depth > 0) break;
        const t = textItem({ ...e, type: 'TEXT', text: e.tag }, color, layer, this.doc, this.shx ? part().segs : null);
        if (t) part().texts.push(t);
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        const t = textItem(e, color, layer, this.doc, this.shx ? part().segs : null);
        if (t) part().texts.push(t);
        break;
      }
      case 'HATCH':
        // Couleur de fond (sous le motif) : remplissage plein de la couleur choisie.
        if (e.bg != null && !e.solid) {
          const loops = e.loops.filter((l) => l.length >= 3);
          const bg = parts.get(layer, e.bg === 7 ? 'fg' : aciToColor(e.bg), lw, '', ps);
          for (const t of triangulateLoops(loops)) bg.tris.push(t[0], t[1], e.z || 0);
        }
        hatchGeometry(e, parts.get(layer, typeof e.fill === 'number' ? e.fill : color, lw, '', ps));
        break;
      case 'INSERT': {
        const block = blockForInsert(this.doc, e); // bloc dynamique : définition évaluée avec les valeurs de l'insertion
        if (!block) { this.missingBlocks.add(e.name); break; }
        const cols = Math.max(1, e.cols || 1), rows = Math.max(1, e.rows || 1);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            this.instance(parts, block, insertMatrix(e, block.base, c, r), e.p[2] || 0, layer, color, depth, stack, lw, ps);
          }
        }
        // Découpe (DECOUPXREF / XCLIP) : géométrie du bloc découpée par le contour ; cadre affiché, non tracé.
        if (e.clip?.pts?.length >= 3 && !e.clip.off && block.entities?.length) { // référence non chargée : rien à découper
          const m = insertMatrix(e, block.base);
          const poly = e.clip.pts.map((q) => G.apply(m, q[0], q[1]));
          clipParts(parts.list(), poly, !!e.clip.invert);
          pushPolyline(parts.get(layer, color, lw, 'frame', ps).segs, poly, true, e.p[2] || 0);
        }
        for (const a of e.attribs || []) {
          if (a.invisible || a.dynHidden) continue; // attribut invisible, ou caché par l'état du bloc dynamique
          for (const p of this.entity(a, depth + 1, stack)) mergeInto(parts, p);
        }
        break;
      }
      case 'WIPEOUT': {
        // Masque : polygone plein de la couleur du fond (cache ce qui est dessous dans l'ordre de tracé) ; cadre
        // selon WIPEOUTFRAME (0 caché, 1 affiché et tracé, 2 affiché non tracé).
        const pts = e.pts || [];
        if (pts.length < 3) break;
        const z = e.z || 0;
        const fill = parts.get(layer, 'bg', lw, '', ps);
        for (const t of triangulateLoops([pts])) fill.tris.push(t[0], t[1], z);
        const frame = this.doc?.header?.wipeoutFrame ?? 1;
        if (frame) pushPolyline(parts.get(layer, color, lw, frame === 2 ? 'frame' : '', ps).segs, pts, true, z);
        break;
      }
      case 'UNDERLAY':
        // Fond PDF / image : son cadre (l'image elle-même est affichée par underlay/layer3d.js).
        for (const loop of frameLoops(e)) pushPolyline(part().segs, loop, true, e.p[2] || 0);
        break;
      case 'BLOCKREF': {
        const block = this.doc.blocks.get(e.name);
        if (!block) { this.missingBlocks.add(e.name); break; }
        this.instance(parts, block, e.m, 0, layer, color, depth, stack, lw, ps);
        break;
      }
    }
    return parts.list();
  }

  // Objet MEP : double trait, extrémités et étiquette générés depuis l'axe.
  mep(e, part) {
    const g = mepGeometry(e, this.neighborsOf ? this.neighborsOf(e) : []);
    // Tube sans type de ligne propre (dessins antérieurs) : celui de sa pose, comme la légende.
    const pattern = this.dashPattern(e.mep.conduit && (!e.ltype || /^bylayer$/i.test(e.ltype)) ? { ...e, ltype: conduitLtype(e.mep.embed) } : e);
    const z = e.z || 0;
    const h = labelHeight(e);
    const insPattern = { dashes: [h * 0.6, -h * 0.3], total: h * 0.9 };
    for (const l of g.lines) {
      const pts = l.entity ? polylinePoints(l.entity).map((p) => [p[0], p[1], z]) : l.pts.map((p) => [p[0], p[1], z]);
      if (l.ins) strokeDashed(part.segs, pts, false, insPattern); // calorifuge en tirets
      else if (pattern) strokeDashed(part.segs, pts, false, pattern);
      else pushPolyline(part.segs, pts, false, z);
    }
    for (const t of g.labels) {
      const item = makeText({ pos: t.p, rot: t.rot, h: t.h, lines: [t.text], align: t.align, vAnchor: t.valign, color: part.color, layer: part.layer });
      part.texts.push(item);
    }
  }

  // Motif de type de ligne effectif (tirets mis à l'échelle), ou null pour un trait continu.
  dashPattern(e) {
    if (!this.linetypes) return null;
    let name = e.ltype;
    if (!name || /^bylayer$/i.test(name)) name = this.doc.layers.get(e.layer || '0')?.ltype;
    if (!name || /^(continuous|byblock|bylayer)$/i.test(name)) return null;
    const t = this.doc.ltypes?.get(name.toUpperCase());
    if (!t || !t.dashes.length || !t.dashes.some((d) => d < 0)) return null;
    const scale = (this.doc.header?.ltscale || 1) * (e.ltscale || 1);
    const dashes = t.dashes.map((d) => d * scale);
    const total = dashes.reduce((sum, d) => sum + Math.abs(d), 0);
    return total > 1e-12 ? { dashes, total } : null;
  }

  instance(parts, block, m, dz, layer, color, depth, stack, lw = -1, ps = '') {
    if (depth >= MAX_DEPTH || stack.includes(block.name)) return;
    const src = this.blockParts(block, depth, stack);
    const s = G.scaleOf(m);
    for (const p of src) {
      const pl = p.layer === '0' ? layer : p.layer;
      const pc = p.color === 'BYBLOCK' ? color : p.color === 'L:0' ? `L:${layer}` : p.color;
      // DuBloc : épaisseur de l'insertion (la sienne, ou celle de son calque).
      // « L:0 » (DuCalque sur le calque 0 d'un bloc imbriqué) prend le calque de l'insertion, comme la couleur.
      const plw = p.lw === -2 ? (lw === -1 ? `L:${layer}` : lw) : p.lw === 'L:0' ? `L:${layer}` : p.lw;
      const out = parts.get(pl, pc, plw, p.noPlot ? 'frame' : '', p.ps === 'BYBLOCK' ? ps : p.ps || '');
      transformCoords(p.segs, out.segs, m, dz);
      transformCoords(p.tris, out.tris, m, dz);
      transformCoords(p.pts, out.pts, m, dz);
      for (const t of p.texts) out.texts.push(transformText(t, m, s, dz, pl, pc));
    }
  }

  blockParts(block, depth = 0, stack = []) {
    if (this.cacheVersion !== this.doc.blockVersion) {
      this.blockCache.clear();
      this.cacheVersion = this.doc.blockVersion;
    }
    let cached = this.blockCache.get(block.name);
    if (cached) return cached;
    const parts = new Parts();
    const inner = [...stack, block.name];
    for (const e of block.entities) {
      if (e.visible === false) continue;
      for (const p of this.entity(e, depth + 1, inner)) mergeInto(parts, p);
    }
    cached = parts.list();
    this.blockCache.set(block.name, cached);
    return cached;
  }
}

function mergeInto(parts, p) {
  const out = parts.get(p.layer, p.color, p.lw, p.noPlot ? 'frame' : '', p.ps || '');
  for (const k of ['segs', 'tris', 'pts', 'texts']) {
    const src = p[k], dst = out[k];
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
  }
}

function transformCoords(src, dst, m, dz) {
  const [a, b, c, d, e, f] = m;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1];
    dst.push(a * x + c * y + e, b * x + d * y + f, src[i + 2] + dz);
  }
}

function transformText(t, m, s, dz, layer, color) {
  const [x, y] = G.apply(m, t.x, t.y);
  const v = G.applyVec(m, [Math.cos(t.rot), Math.sin(t.rot)]);
  let rot = Math.atan2(v[1], v[0]);
  if (G.isMirror(m)) {
    rot = G.normAngle(rot);
    if (rot > Math.PI / 2 + 1e-9 && rot <= Math.PI * 1.5 + 1e-9) rot -= Math.PI;
  }
  return {
    ...t, x, y, z: t.z + dz, rot,
    h: t.h * s, em: t.em * s, first: t.first * s, pitch: t.pitch * s, radius: t.radius * s, w: t.w * s, total: t.total * s,
    layer, color,
  };
}

// Boîte englobante (XY) d'une liste de parts.
export function partsBox(parts) {
  const b = G.emptyBox();
  for (const p of parts) {
    for (const arr of [p.segs, p.tris, p.pts]) {
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1];
        if (Number.isFinite(x) && Number.isFinite(y)) G.growBox(b, x, y);
      }
    }
    for (const t of p.texts) {
      if (!(t.w >= 0 && t.total >= 0 && t.h > 0)) {
        G.growBox(b, t.x - t.radius, t.y - t.radius);
        G.growBox(b, t.x + t.radius, t.y + t.radius);
        continue;
      }
      // Rectangle du texte, tourné : largeur exacte selon l'alignement, hauteur prise large (lignes, ascendantes).
      const x0 = t.align === 'right' ? -t.w : t.align === 'center' || t.align === 'middle' ? -t.w / 2 : t.align === 'left' || !t.align ? 0 : -t.w;
      const x1 = t.align === 'left' || !t.align ? t.w : t.align === 'center' || t.align === 'middle' ? t.w / 2 : t.align === 'right' ? 0 : t.w;
      const mx = t.h * 0.5, my = t.total + t.h + Math.abs(t.first || 0);
      const c = Math.cos(t.rot || 0), sn = Math.sin(t.rot || 0);
      for (const lx of [x0 - mx, x1 + mx]) for (const ly of [-my, my]) G.growBox(b, t.x + lx * c - ly * sn, t.y + lx * sn + ly * c);
    }
  }
  return b;
}
