// SPDX-License-Identifier: GPL-3.0-or-later
// Tableaux dans le dessin (métré, nomenclature) : lignes et textes regroupés dans un bloc, pour un livrable
// imprimable sans passer par Excel. Coin supérieur gauche au point d'insertion (0, 0 du bloc).
import { textWidth } from '../text.js';

// rows : tableau de lignes (chaînes) ; head : en-têtes ; h : hauteur de texte ; title : titre facultatif.
// numeric : indices des colonnes alignées à droite. Renvoie les entités (coordonnées du bloc).
export function tableEntities(head, rows, { h = 2.5, title = '', numeric = [] } = {}) {
  const pad = h * 0.8, rowH = h * 2;
  const all = [head, ...rows].map((r) => r.map((c) => String(c ?? '')));
  // Largeur mesurée (+ 10 % : les polices d'AutoCAD sont un peu plus larges).
  const widths = head.map((_, j) => Math.max(...all.map((r) => textWidth(r[j] || '', h))) * 1.1 + 2 * pad);
  const W = widths.reduce((a, b) => a + b, 0);
  const out = [];
  const L = (x1, y1, x2, y2) => out.push({ type: 'LINE', layer: '0', color: 0, p1: [x1, y1, 0], p2: [x2, y2, 0] });
  const T = (x, y, text, align = 'left', hh = h) => out.push({ type: 'TEXT', layer: '0', color: 0, p: [x, y, 0], h: hh, rot: 0, text, align, valign: 'middle', wf: 1 });
  let y = 0;
  if (title) {
    T(0, y + rowH * 0.6, title, 'left', h * 1.4);
  }
  const n = all.length;
  // Cadre et lignes horizontales (trait renforcé sous l'en-tête : doublé).
  for (let i = 0; i <= n; i++) L(0, y - i * rowH, W, y - i * rowH);
  L(0, y - rowH - h * 0.15, W, y - rowH - h * 0.15);
  let x = 0;
  for (let j = 0; j <= widths.length; j++) {
    L(x, y, x, y - n * rowH);
    if (j < widths.length) x += widths[j];
  }
  all.forEach((r, i) => {
    let cx = 0;
    r.forEach((c, j) => {
      const right = i > 0 && numeric.includes(j);
      T(right ? cx + widths[j] - pad : cx + pad, y - i * rowH - rowH / 2, c, right ? 'right' : 'left');
      cx += widths[j];
    });
  });
  return { entities: out, width: W, height: n * rowH };
}
