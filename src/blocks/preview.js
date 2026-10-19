// SPDX-License-Identifier: GPL-3.0-or-later
// Aperçu SVG d'un bloc (palettes, insertion, bibliothèques) : traits, arcs, remplissages et textes, cadré
// sur son étendue ; un bloc dynamique est montré dans son état par défaut.
import * as G from '../core/geom.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { isDynamic, evaluate } from './dynamic.js';


const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svgCache = new WeakMap();

// Aperçu d'un bloc du document src (mis en cache par définition : une redéfinition le renouvelle).
export function blockSvg(src, name, px = 40) {
  const b = src.blocks.get(name);
  if (!b) return `<svg class="sym" width="${px}" height="${px}"></svg>`;
  let cache = svgCache.get(b);
  if (!cache) svgCache.set(b, (cache = new Map()));
  const key = px;
  if (cache.has(key)) return cache.get(key);
  const parts = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x, y, r = 0) => {
    box.x0 = Math.min(box.x0, x - r); box.x1 = Math.max(box.x1, x + r);
    box.y0 = Math.min(box.y0, y - r); box.y1 = Math.max(box.y1, y + r);
  };
  const f = (v) => +v.toFixed(3);
  const draw = (entities, m, depth) => {
    for (const e0 of entities) {
      if (e0.type === 'ATTDEF') continue;
      if ((e0.type === 'INSERT' || e0.type === 'BLOCKREF') && depth < 4) {
        const b = src.blocks.get(e0.name);
        if (b) draw(b.entities, G.compose(m, e0.type === 'INSERT' ? insertMatrix(e0, b.base) : e0.m), depth + 1);
        continue;
      }
      const e = transformEntity(e0, m);
      const trame = /trame/i.test(e.layer || '') ? ' class="t"' : '';
      if (e.type === 'LINE') {
        parts.push(`<line x1="${f(e.p1[0])}" y1="${f(-e.p1[1])}" x2="${f(e.p2[0])}" y2="${f(-e.p2[1])}"/>`);
        grow(e.p1[0], e.p1[1]); grow(e.p2[0], e.p2[1]);
      } else if (e.type === 'CIRCLE') {
        parts.push(`<circle cx="${f(e.c[0])}" cy="${f(-e.c[1])}" r="${f(e.r)}"/>`);
        grow(e.c[0], e.c[1], e.r);
      } else if (e.type === 'ARC') {
        const a = G.polar(e.c, e.a0, e.r), b = G.polar(e.c, e.a1, e.r);
        parts.push(`<path d="M${f(a[0])} ${f(-a[1])}A${f(e.r)} ${f(e.r)} 0 ${G.sweep(e.a0, e.a1) > Math.PI ? 1 : 0} 0 ${f(b[0])} ${f(-b[1])}"/>`);
        grow(e.c[0], e.c[1], e.r);
      } else if (e.type === 'LWPOLYLINE' && e.pts.length) {
        const n = e.pts.length;
        let d = `M${f(e.pts[0][0])} ${f(-e.pts[0][1])}`;
        for (let i = 0; i < (e.closed ? n : n - 1); i++) {
          const a = e.pts[i], b = e.pts[(i + 1) % n], bu = e.bulges?.[i] || 0;
          if (Math.abs(bu) < 1e-9) d += `L${f(b[0])} ${f(-b[1])}`;
          else {
            const th = 4 * Math.atan(bu), r = Math.abs(G.dist(a, b) / (2 * Math.sin(th / 2)));
            d += `A${f(r)} ${f(r)} 0 ${Math.abs(th) > Math.PI ? 1 : 0} ${bu > 0 ? 0 : 1} ${f(b[0])} ${f(-b[1])}`;
          }
        }
        const wide = e.width > 0 ? ` stroke-width="${f(e.width)}"` : '';
        parts.push(`<path d="${d}${e.closed ? 'Z' : ''}"${wide}/>`);
        for (const q of e.pts) grow(q[0], q[1], (e.width || 0) / 2);
      } else if (e.type === 'SOLID') {
        const [a, b, c, dd = c] = e.pts;
        parts.push(`<polygon${trame || ' class="f"'} points="${[a, b, dd, c].map((q) => `${f(q[0])},${f(-q[1])}`).join(' ')}"/>`);
        for (const q of e.pts) grow(q[0], q[1]);
      } else if (e.type === 'HATCH') {
        for (const loop of e.loops || []) {
          if (!loop.length) continue;
          parts.push(`<polygon${trame || (e.solid ? ' class="f"' : '')} points="${loop.map((q) => `${f(q[0])},${f(-q[1])}`).join(' ')}"/>`);
          for (const q of loop) grow(q[0], q[1]);
        }
      } else if ((e.type === 'TEXT' || e.type === 'MTEXT') && e.text) {
        const anchor = e.align === 'right' ? 'end' : ['center', 'middle', 'aligned', 'fit'].includes(e.align) ? 'middle' : 'start';
        const base = e.valign === 'middle' ? 'central' : e.valign === 'top' ? 'hanging' : 'auto';
        const text = e.type === 'MTEXT' ? e.text.replace(/\\[A-Za-z][^;]*;|[{}]/g, '').replace(/\\P/g, ' ') : e.text;
        parts.push(`<text x="${f(e.p[0])}" y="${f(-e.p[1])}" font-size="${f(e.h)}" text-anchor="${anchor}" dominant-baseline="${base}"${e.rot ? ` transform="rotate(${f(-e.rot * 180 / Math.PI)} ${f(e.p[0])} ${f(-e.p[1])})"` : ''}>${esc(text)}</text>`);
        grow(e.p[0], e.p[1], e.h * 0.6);
      }
    }
  };
  draw(isDynamic(b) ? evaluate(b, {}) : b.entities, G.IDENTITY, 0);
  let svg = `<svg class="sym" width="${px}" height="${px}"></svg>`;
  if (Number.isFinite(box.x0)) {
    const w = Math.max(box.x1 - box.x0, 1e-6), h = Math.max(box.y1 - box.y0, 1e-6), size = Math.max(w, h) * 1.1;
    const cx = (box.x0 + box.x1) / 2, cy = -(box.y0 + box.y1) / 2;
    svg = `<svg class="sym lib" viewBox="${f(cx - size / 2)} ${f(cy - size / 2)} ${f(size)} ${f(size)}" width="${px}" height="${px}" style="stroke-width:${f(size / 60)}">${parts.join('')}</svg>`;
  }
  cache.set(key, svg);
  return svg;
}
