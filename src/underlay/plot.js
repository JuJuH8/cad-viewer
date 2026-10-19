// SPDX-License-Identifier: GPL-3.0-or-later
// Tracé des fonds (PDF, images) dans un PDF de l'appli (jsPDF) : la partie visible du fond est rendue en image
// (200 ppp du papier par défaut), découpée et réglée comme à l'écran (estompage, contraste, monochrome ; papier
// blanc : pas d'adaptation au fond sombre), puis placée sous les traits.
import { ensureSource } from './sources.js';
import { renderRegion, applyLook, lookOf, MAX_SIDE } from './raster.js';
import { pageToWorld, worldToPage, visibleBox, activeClip, PAGE } from './underlay.js';

export const PLOT_DPI = 200;

// e : fond ; toPaper(x, y) → [mm, mm] (origine en haut à gauche de la feuille) ; fromPaper : l'inverse ;
// clip : rectangle de la feuille où tracer { x0, y0, x1, y1 } (mm). Renvoie vrai si quelque chose a été tracé.
// poly (facultatif) : contour de découpe sur la feuille (fenêtre de présentation non rectangulaire).
export async function plotUnderlay(pdf, e, toPaper, fromPaper, clip, dpi = PLOT_DPI, poly = null) {
  if (e.show === false) return false;
  const src = await ensureSource(e.path);
  if (src.status !== 'ok') return false;
  // Zone de la page visible dans le rectangle de tracé.
  const corners = [[clip.x0, clip.y0], [clip.x1, clip.y0], [clip.x1, clip.y1], [clip.x0, clip.y1]]
    .map(([x, y]) => fromPaper(x, y)).map(([x, y]) => worldToPage(e, x, y)).filter(Boolean);
  if (corners.length < 4) return false;
  const vb = visibleBox(e);
  const s0 = Math.max(vb.minX, Math.min(...corners.map((c) => c[0]))), s1 = Math.min(vb.maxX, Math.max(...corners.map((c) => c[0])));
  const t0 = Math.max(vb.minY, Math.min(...corners.map((c) => c[1]))), t1 = Math.min(vb.maxY, Math.max(...corners.map((c) => c[1])));
  if (s1 <= s0 || t1 <= t0) return false;
  const P = (s, t) => toPaper(...pageToWorld(e, s, t));
  // Taille de la zone sur la feuille (mm) → pixels.
  const o = P(s0, t1), ex = P(s1, t1), ey = P(s0, t0);
  const wMm = Math.hypot(ex[0] - o[0], ex[1] - o[1]), hMm = Math.hypot(ey[0] - o[0], ey[1] - o[1]);
  const k = Math.min(1, MAX_SIDE / ((wMm / 25.4) * dpi), MAX_SIDE / ((hMm / 25.4) * dpi));
  const wpx = Math.max(1, Math.round((wMm / 25.4) * dpi * k)), hpx = Math.max(1, Math.round((hMm / 25.4) * dpi * k));
  const img = await renderRegion(src, { s0, t0, s1, t1 }, wpx, hpx, { page: e.page || 1, ocgOff: e.ocgOff });
  if (!img) return false;
  // Image posée sur la feuille (rotation comprise), dans le rectangle de tracé.
  const quad = [o, ex, P(s1, t0), ey];
  const x0 = Math.max(clip.x0, Math.min(...quad.map((q) => q[0]))), x1 = Math.min(clip.x1, Math.max(...quad.map((q) => q[0])));
  const y0 = Math.max(clip.y0, Math.min(...quad.map((q) => q[1]))), y1 = Math.min(clip.y1, Math.max(...quad.map((q) => q[1])));
  if (x1 <= x0 || y1 <= y0) return false;
  const px = dpi * k / 25.4;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.min(MAX_SIDE, Math.round((x1 - x0) * px)));
  out.height = Math.max(1, Math.min(MAX_SIDE, Math.round((y1 - y0) * px)));
  const ctx = out.getContext('2d');
  const map = ([x, y]) => [(x - x0) * px, (y - y0) * px];
  if (poly?.length >= 3) {
    ctx.beginPath();
    poly.forEach((q, i) => { const m = map(q); if (i) ctx.lineTo(m[0], m[1]); else ctx.moveTo(m[0], m[1]); });
    ctx.closePath();
    ctx.clip();
  }
  // Découpe : page ou contour (inversé : page moins le contour, règle pair-impair).
  const c = activeClip(e);
  const loops = c ? (c.invert ? [PAGE, c.pts] : [c.pts]) : [PAGE];
  ctx.beginPath();
  for (const loop of loops) {
    loop.forEach(([s, t], i) => { const q = map(P(s, t)); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
  }
  ctx.clip('evenodd');
  const mo = map(o), mx = map(ex), my = map(ey);
  ctx.setTransform((mx[0] - mo[0]) / wpx, (mx[1] - mo[1]) / wpx, (my[0] - mo[0]) / hpx, (my[1] - mo[1]) / hpx, mo[0], mo[1]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0);
  applyLook(out, lookOf(e, { dark: false, bg: 0xffffff }));
  pdf.addImage(out, 'PNG', x0, y0, x1 - x0, y1 - y0, undefined, 'FAST');
  return true;
}
