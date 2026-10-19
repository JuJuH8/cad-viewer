// SPDX-License-Identifier: GPL-3.0-or-later
// Fonds PDF et images (ATTACHER) : l'objet UNDERLAY, équivalent des références PDF (PDFUNDERLAY) et des
// images (IMAGE) d'AutoCAD.
//
// UNDERLAY { kind: 'pdf' | 'image', path, page, p:[x,y,z], u:[x,y], v:[x,y], native:[w,h],
//            fade, contrast, mono, adjust, whiteOff, show, clip: { pts:[[s,t]…], invert } | null, ocgOff:[noms] }
//   p : coin inférieur gauche de la page (ou de l'image) ; u, v : bord inférieur et bord gauche de la page entière
//   en unités du dessin (échelle et rotation comprises) ; native : taille propre de la page (PDF : mm du papier)
//   ou de l'image (pixels). Coordonnées (s, t) dans la page : 0 → 1 de gauche à droite et de bas en haut.
//   fade (0–80 %), contrast (0–100 %, 100 = inchangé), mono (monochrome), adjust (couleurs adaptées à un fond
//   sombre), whiteOff (blanc transparent), show (affiché), clip (découpe, inversée ou non), ocgOff (calques du PDF
//   masqués).
import * as G from '../core/geom.js';
import { isMetric } from '../core/drawing-settings.js';

export const UNDERLAY_DEFAULTS = { fade: 0, contrast: 100, mono: false, adjust: true, whiteOff: true, show: true, clip: null, ocgOff: [] };

export const PDF_EXT = /\.pdf$/i;
export const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp)$/i;
export const kindOfPath = (path) => (PDF_EXT.test(path || '') ? 'pdf' : IMAGE_EXT.test(path || '') ? 'image' : null);

// Nom de fichier d'un chemin (Windows ou URL).
export const fileName = (path) => String(path || '').split(/[\\/]/).pop();

// Nom de la définition (comme AutoCAD : « plan - 1 » pour la page 1 d'un PDF, « photo » pour une image).
export function defName(e) {
  const base = fileName(e.path).replace(/\.[^.]+$/, '') || 'fond';
  return e.kind === 'pdf' ? `${base} - ${e.page || 1}` : base;
}

// Millimètres de papier par unité d'un fond PDF dans AutoCAD : un PDF joint à l'échelle 1 mesure sa taille en mm
// (dessins métriques, MEASUREMENT = 1), en pouces sinon — quelles que soient les unités du dessin (vérifié dans
// AutoCAD 2024 : page A3 → 420,16 × 297,04 unités en mm comme en m).
export const pdfUnitMm = (doc) => (isMetric(doc) ? 1 : 25.4);

// Point du monde d'un point (s, t) de la page.
export function pageToWorld(e, s, t) {
  return [e.p[0] + e.u[0] * s + e.v[0] * t, e.p[1] + e.u[1] * s + e.v[1] * t];
}

// Point (s, t) de la page d'un point du monde (null si le fond est dégénéré).
export function worldToPage(e, x, y) {
  const det = e.u[0] * e.v[1] - e.u[1] * e.v[0];
  if (Math.abs(det) < 1e-18) return null;
  const dx = x - e.p[0], dy = y - e.p[1];
  return [(dx * e.v[1] - dy * e.v[0]) / det, (e.u[0] * dy - e.u[1] * dx) / det];
}

export const PAGE = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Découpe en vigueur (null si aucune, ou désactivée).
export const activeClip = (e) => (e.clip && !e.clip.off && e.clip.pts?.length >= 3 ? e.clip : null);

// Contour visible dans la page : la découpe (non inversée) ou la page entière.
export function visibleLoop(e) {
  const c = activeClip(e);
  return c && !c.invert ? c.pts : PAGE;
}

// Contours dessinés (cadre) en coordonnées du monde : page ou découpe ; une découpe inversée montre les deux.
export function frameLoops(e) {
  const loops = [];
  const c = activeClip(e);
  if (c) {
    if (c.invert) loops.push(PAGE);
    loops.push(c.pts);
  } else loops.push(PAGE);
  return loops.map((loop) => loop.map(([s, t]) => pageToWorld(e, s, t)));
}

// Boîte (s, t) de la partie visible.
export function visibleBox(e) {
  const b = G.emptyBox();
  for (const [s, t] of visibleLoop(e)) G.growBox(b, s, t);
  return { minX: Math.max(0, b.minX), minY: Math.max(0, b.minY), maxX: Math.min(1, b.maxX), maxY: Math.min(1, b.maxY) };
}

// Le point (s, t) est-il dans la partie visible du fond ?
export function visibleAt(e, s, t) {
  if (s < 0 || s > 1 || t < 0 || t > 1) return false;
  const c = activeClip(e);
  if (!c) return true;
  const inside = pointInLoop(s, t, c.pts);
  return c.invert ? !inside : inside;
}

export function pointInLoop(x, y, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Échelle et rotation, comme dans AutoCAD : échelle 1 = taille propre (PDF : unité = mm de papier ; image :
// unité = pixel × taille de pixel par défaut).
export function underlayRotation(e) {
  return Math.atan2(e.u[1], e.u[0]);
}

export function underlayScale(e, unitMm = 1) {
  const w = e.kind === 'pdf' ? e.native[0] / unitMm : e.native[0] * (e.pixel || 1);
  return w > 0 ? G.len(e.u) / w : 1;
}

// Vecteurs u, v d'un fond posé à l'échelle `scale` et à la rotation `rot` (radians).
export function axesFor(native, scale, rot, unitMm = 1, kind = 'pdf', pixel = 1) {
  const k = kind === 'pdf' ? scale / unitMm : scale * pixel;
  const w = native[0] * k, h = native[1] * k;
  const c = Math.cos(rot), s = Math.sin(rot);
  return { u: [w * c, w * s], v: [-h * s, h * c] };
}

// Nouvel objet fond.
export function makeUnderlay({ kind, path, page = 1, native, p, scale = 1, rot = 0, unitMm = 1, pixel = 1, layer = '0', ...rest }) {
  const { u, v } = axesFor(native, scale, rot, unitMm, kind, pixel);
  // Images (photos, scans) : couleurs gardées telles quelles par défaut, comme AutoCAD.
  const byKind = kind === 'image' ? { adjust: false, whiteOff: false } : {};
  return { type: 'UNDERLAY', layer, kind, path, page, native, pixel, p: [p[0], p[1], p[2] || 0], u, v, ...UNDERLAY_DEFAULTS, ...byKind, ...rest };
}

// Mise à l'échelle autour du point d'insertion (garde la rotation).
export function rescaled(e, factor) {
  return { ...e, u: [e.u[0] * factor, e.u[1] * factor], v: [e.v[0] * factor, e.v[1] * factor] };
}

// Fond relu d'un DXF / DWG (page provisoire) : vraie taille de la page une fois le PDF lu, même échelle, même
// rotation ; découpe convertie des mm de la page en coordonnées (s, t).
export function resolvePending(e, native) {
  const { scale, unitMm, clipLocal, clipOn, invert } = e.pending;
  const rot = Math.atan2(e.u[1], e.u[0]);
  const { u, v } = axesFor(native, scale, rot, unitMm, 'pdf');
  if (e.u[0] * e.v[1] - e.u[1] * e.v[0] < 0) { v[0] = -v[0]; v[1] = -v[1]; } // fond en miroir : il le reste
  const w = native[0] / unitMm, h = native[1] / unitMm;
  const clip = clipLocal ? { pts: clipLocal.map(([x, y]) => [x / w, y / h]), invert: !!invert, ...(clipOn ? {} : { off: true }) } : e.clip;
  const out = { ...e, native, u, v, clip };
  delete out.pending;
  return out;
}
