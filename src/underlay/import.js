// SPDX-License-Identifier: GPL-3.0-or-later
// PDFIMPORT : conversion d'un fond PDF en objets du dessin, comme la commande d'AutoCAD.
// Les tracés du PDF deviennent des lignes, polylignes (arcs reconnus en segments courbes), cercles et arcs ; les
// remplissages des hachures pleines ; les textes des textes. Couleurs (index AutoCAD quand elles en sont un),
// épaisseurs (les plus proches des épaisseurs normalisées), calques du PDF ou calques « PDF_… ».
import { aciToColor } from '../colors.js';
import { pageToWorld, visibleAt } from './underlay.js';

const STD_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
export const OBJECT_LAYERS = { geometry: 'PDF_Geometrie', fills: 'PDF_Remplissages', text: 'PDF_Textes' };
// Hauteur d'un texte de CAO (hauteur des capitales) par rapport à la taille de police du PDF (Arial : 0,716 ;
// vérifié sur un plan tracé par AutoCAD).
const CAP_HEIGHT = 0.716;

// Couleur d'un tracé : noir / blanc → couleur 7 ; couleur d'index exacte → index ; sinon couleur vraie.
const ACI = new Map();
for (let i = 1; i <= 255; i++) {
  const c = aciToColor(i);
  if (typeof c === 'number' && !ACI.has(c)) ACI.set(c, i);
}
export function colorProps(rgb) {
  if (rgb == null || rgb === 0x000000 || rgb === 0xffffff) return { color: 7 };
  const i = ACI.get(rgb);
  return i ? { color: i } : { color: 256, rgb };
}

export function nearestLineweight(mm) {
  const v = mm * 100;
  if (!(v > 0)) return 0;
  let best = STD_LW[0];
  for (const w of STD_LW) if (Math.abs(w - v) < Math.abs(best - v)) best = w;
  return best;
}

const bez = (a, c1, c2, b, t) => {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
    u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]];
};

function circle3(p, q, r) {
  const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx = r[0], cy = r[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-18) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [x, y], r: Math.hypot(ax - x, ay - y) };
}

// Courbe de Bézier (coordonnées du monde) assimilable à un arc de cercle à tol près ? → { c, r, bulge } ou null.
export function fitArc(a, c1, c2, b, tol) {
  const m = bez(a, c1, c2, b, 0.5);
  const circ = circle3(a, m, b);
  if (!circ || circ.r > 1e9) return null;
  for (const t of [0.15, 0.3, 0.7, 0.85]) {
    const q = bez(a, c1, c2, b, t);
    if (Math.abs(Math.hypot(q[0] - circ.c[0], q[1] - circ.c[1]) - circ.r) > tol) return null;
  }
  // Angle balayé (signé) de a à b en passant par m.
  const ang = (p) => Math.atan2(p[1] - circ.c[1], p[0] - circ.c[0]);
  const a0 = ang(a), am = ang(m), a1 = ang(b);
  const norm = (x) => { while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
  const sweep = norm(am - a0) + norm(a1 - am);
  if (Math.abs(sweep) > Math.PI * 1.01) return null; // plus d'un demi-tour : découpé par le PDF de toute façon
  return { ...circ, sweep, bulge: Math.tan(sweep / 4) };
}

function flatten(a, c1, c2, b, tol) {
  const len = Math.hypot(c1[0] - a[0], c1[1] - a[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(b[0] - c2[0], b[1] - c2[1]);
  const n = Math.max(2, Math.min(48, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-12)))));
  const out = [];
  for (let i = 1; i <= n; i++) out.push(bez(a, c1, c2, b, i / n));
  return out;
}

// e : fond PDF ; data : extractPage ; opts : { layers: 'pdf' | 'objet' | 'courant', currentLayer, zone (boîte du
// monde ou null), lineweights (vrai par défaut), fills (vrai), texts (vrai), arcTol (mm du papier, 0,05) }.
// Renvoie { entities, layers: Set des calques à créer, counts }.
export function importPdfVectors(e, data, opts = {}) {
  const k = Math.hypot(e.u[0], e.u[1]) / e.native[0]; // unités du dessin par mm de la page
  const rot = Math.atan2(e.u[1], e.u[0]);
  const tol = (opts.arcTol ?? 0.05) * k;
  const hidden = new Set(e.ocgOff || []);
  const W = (p) => pageToWorld(e, p[0], p[1]);
  const zone = opts.zone || null;
  const inside = (pts) => pts.some(([s, t]) => {
    if (!visibleAt(e, s, t)) return false;
    if (!zone) return true;
    const [x, y] = W([s, t]);
    return x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY;
  });
  const layerOf = (ocg, kind) => {
    if (opts.layers === 'courant') return opts.currentLayer || '0';
    if (opts.layers === 'objet' || !ocg) return OBJECT_LAYERS[kind];
    return ocg;
  };
  const out = [];
  const layers = new Set();
  const counts = { lines: 0, polylines: 0, arcs: 0, circles: 0, hatches: 0, texts: 0 };
  const add = (x) => { out.push(x); layers.add(x.layer); };

  for (const path of data.paths) {
    if (path.ocg && hidden.has(path.ocg)) continue;
    const stroke = path.stroke != null;
    const fill = path.fill != null && opts.fills !== false;
    if (!stroke && !fill) continue;
    if (!inside(path.subs.flatMap((s) => s.pts))) continue;
    // Remplissage (sans trait) : hachure pleine.
    if (fill && !stroke) {
      const loops = path.subs.map((s) => {
        const pts = [W(s.pts[0])];
        for (let i = 0; i < s.kinds.length; i++) {
          if (s.kinds[i] === 'C') pts.push(...flatten(W(s.pts[i]), W(s.ctrl[i][0]), W(s.ctrl[i][1]), W(s.pts[i + 1]), tol));
          else pts.push(W(s.pts[i + 1]));
        }
        return pts;
      }).filter((l) => l.length >= 3);
      if (!loops.length) continue;
      add({ type: 'HATCH', layer: layerOf(path.ocg, 'fills'), ...colorProps(path.fill), loops, solid: true, pattern: 'SOLID', lines: [], z: 0 });
      counts.hatches++;
      continue;
    }
    const style = { ...colorProps(path.stroke) };
    if (opts.lineweights !== false) {
      const lw = nearestLineweight(path.width);
      if (lw > 0) style.lweight = lw;
    }
    const layer = layerOf(path.ocg, 'geometry');
    for (const s of path.subs) {
      const n = s.pts.length;
      const pw = s.pts.map(W);
      // Cercle : quatre (ou plus) courbes fermées sur un même cercle.
      if (s.closed && s.kinds.length >= 2 && s.kinds.every((x) => x === 'C')) {
        const arcs = s.kinds.map((_, i) => fitArc(pw[i], W(s.ctrl[i][0]), W(s.ctrl[i][1]), pw[(i + 1) % n], tol));
        const c0 = arcs[0];
        if (c0 && arcs.every((a) => a && Math.hypot(a.c[0] - c0.c[0], a.c[1] - c0.c[1]) < tol && Math.abs(a.r - c0.r) < tol)
          && Math.abs(arcs.reduce((sum, a) => sum + a.sweep, 0)) > Math.PI * 1.99) {
          add({ type: 'CIRCLE', layer, ...style, c: [c0.c[0], c0.c[1], 0], r: c0.r });
          counts.circles++;
          continue;
        }
      }
      // Arc isolé : une seule courbe ouverte.
      if (!s.closed && n === 2 && s.kinds[0] === 'C') {
        const a = fitArc(pw[0], W(s.ctrl[0][0]), W(s.ctrl[0][1]), pw[1], tol);
        if (a) {
          const ang = (p) => Math.atan2(p[1] - a.c[1], p[0] - a.c[0]);
          const [a0, a1] = a.sweep > 0 ? [ang(pw[0]), ang(pw[1])] : [ang(pw[1]), ang(pw[0])];
          add({ type: 'ARC', layer, ...style, c: [a.c[0], a.c[1], 0], r: a.r, a0, a1 });
          counts.arcs++;
          continue;
        }
      }
      // Ligne simple.
      if (n === 2 && s.kinds[0] !== 'C' && !s.closed) {
        add({ type: 'LINE', layer, ...style, p1: [pw[0][0], pw[0][1], 0], p2: [pw[1][0], pw[1][1], 0] });
        counts.lines++;
        continue;
      }
      // Polyligne : segments droits et arcs (courbes non circulaires découpées).
      const pts = [pw[0]], bulges = [];
      for (let i = 0; i < s.kinds.length; i++) {
        const b = pw[i + 1];
        if (s.kinds[i] === 'C') {
          const a = fitArc(pw[i], W(s.ctrl[i][0]), W(s.ctrl[i][1]), b, tol);
          if (a) { bulges.push(a.bulge); pts.push(b); continue; }
          for (const q of flatten(pw[i], W(s.ctrl[i][0]), W(s.ctrl[i][1]), b, tol)) { bulges.push(0); pts.push(q); }
          continue;
        }
        bulges.push(0);
        pts.push(b);
      }
      // Fermeture : le dernier point répète souvent le premier.
      let closed = s.closed;
      if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < tol * 0.01) {
        pts.pop();
        closed = true;
      }
      bulges.push(0);
      if (pts.length < 2) continue;
      add({ type: 'LWPOLYLINE', layer, ...style, pts: pts.map((q) => [q[0], q[1]]), bulges: bulges.slice(0, pts.length), closed, z: 0, width: 0 });
      counts.polylines++;
    }
  }
  if (opts.texts !== false) {
    for (const t of data.texts) {
      if (t.ocg && hidden.has(t.ocg)) continue;
      if (!inside([t.p])) continue;
      const [x, y] = W(t.p);
      add({ type: 'TEXT', layer: layerOf(t.ocg, 'text'), color: 7, p: [x, y, 0], h: t.h * k * CAP_HEIGHT, rot: t.rot + rot, text: t.text, align: 'left', valign: 'baseline' });
      counts.texts++;
    }
  }
  return { entities: out, layers, counts };
}
