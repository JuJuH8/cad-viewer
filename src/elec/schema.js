// SPDX-License-Identifier: GPL-3.0-or-later
// Schéma unifilaire d'un tableau et légende des symboles : entités en coordonnées de bloc (coin supérieur
// gauche à l'origine), à insérer comme un bloc. h : hauteur de texte dans le dessin.

import { SYMBOLS, CATEGORIES, blockNameOf, ensureSymbolBlock } from './symbols.js';
import { CIRCUIT_TYPES, fmtSection } from './nibt.js';

const num = (v, d = 1) => v.toFixed(d).replace('.', ',');
const kw = (w) => (w >= 1000 ? `${num(w / 1000, 2)} kW` : `${Math.round(w)} W`);

// Schéma unifilaire : arrivée et protection générale, jeu de barres, un départ par circuit (protection, DDR,
// câble, longueur, puissance, chute de tension cumulée). info : élément de computeInstallation().
// list : départs dessinés (tous par défaut) ; page : { n, of } pour un schéma sur plusieurs pages (arrivée sur la
// première page seulement, renvois de jeu de barres d'une page à l'autre).
export function singleLineEntities(info, { h = 2.5, list = info.circuits, page = null } = {}) {
  const out = [];
  const L = (a, b, color = 0) => out.push({ type: 'LINE', layer: '0', color, p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
  const T = (p, text, { hh = h, align = 'left', rot = 0, color = 0 } = {}) => out.push({ type: 'TEXT', layer: '0', color, p: [p[0], p[1], 0], h: hh, rot, text, align, valign: 'middle', wf: 1 });
  const breaker = (x, y) => { // contact à fermeture et croix sur le contact fixe (disjoncteur)
    L([x, y], [x, y - 2 * h]);
    L([x, y - 2 * h], [x + 1.1 * h, y - 3.8 * h]);
    L([x - 0.4 * h, y - 3.6 * h], [x + 0.4 * h, y - 4.4 * h]);
    L([x - 0.4 * h, y - 4.4 * h], [x + 0.4 * h, y - 3.6 * h]);
    return y - 4 * h;
  };
  const { board, supply, p, ik3, ik1 } = info;
  const circuits = list;
  const first = !page || page.n === 1, last = !page || page.n === page.of;
  const w = 8 * h;
  const n = circuits.length;
  const width = Math.max(w * (n + 1.2), 40 * h);
  T([0, -h], `TABLEAU ${board.elec.board}${board.elec.parent ? ` (alimenté par ${board.elec.parent})` : ''}${page && page.of > 1 ? ` — page ${page.n} / ${page.of}` : ''}`, { hh: h * 1.4 });
  if (supply && first) {
    T([0, -2.8 * h], `Alimentation : ${supply.cable} — ${supply.protection} — ${kw(p || supply.pabs)} — Ib ${num(supply.ib)} A — ΔU ${num(supply.duTotal, 2)} %`, { hh: h * 0.8 });
  }
  if (ik3) T([0, -3.9 * h], `Court-circuit au jeu de barres : Ik3 max ${num(ik3 / 1000, 2)} kA — Ik1 min ${num(ik1 / 1000, 2)} kA`, { hh: h * 0.7 });
  // Arrivée et protection générale
  const x0 = w * 0.5, yBar = -11 * h;
  if (first) {
    L([x0, -4.5 * h], [x0, -5 * h]);
    const yb = breaker(x0, -5 * h);
    L([x0, yb], [x0, yBar]);
    if (supply) T([x0 + 1.4 * h, -6.5 * h], supply.protection.replace(' + DDR 30 mA', ''), { hh: h * 0.8 });
  } else {
    T([x0, yBar + 1.2 * h], `← suite de la page ${page.n - 1}`, { hh: h * 0.7 });
  }
  if (!last) T([w * (n + 0.8), yBar + 1.2 * h], `suite page ${page.n + 1} →`, { hh: h * 0.7, align: 'right' });
  // Jeu de barres
  L([x0, yBar], [w * (n + 0.8), yBar]);
  L([x0, yBar - 0.15 * h], [w * (n + 0.8), yBar - 0.15 * h]);
  circuits.forEach((c, i) => {
    const x = w * (i + 1);
    const r = c.r;
    let y = breaker(x, yBar);
    if (r.rcd) { // DDR 30 mA
      L([x, y], [x, y - h]);
      out.push({ type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[x - 1.3 * h, y - h], [x + 1.3 * h, y - h], [x + 1.3 * h, y - 2.6 * h], [x - 1.3 * h, y - 2.6 * h]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
      T([x, y - 1.8 * h], '30 mA', { hh: h * 0.55, align: 'center' });
      y -= 2.6 * h;
    }
    const yEnd = -27 * h;
    L([x, y], [x, yEnd]);
    const label = c.def.label || (c.def.sub ? `Tableau ${c.def.sub}` : CIRCUIT_TYPES[c.def.type]?.label || c.def.type);
    T([x + 0.6 * h, y - 0.8 * h], label, { hh: h * 0.7, rot: -Math.PI / 2 });
    T([x + 1.3 * h, yBar - 2.5 * h], `${r.curve}${r.rating}`, { hh: h * 0.7 });
    const lines = [
      [c.def.id, h * 0.9, r.ok ? 0 : 1],
      [r.cable, h * 0.65, 0],
      [`${num(c.len, 0)} m`, h * 0.65, 0],
      [kw(r.pabs), h * 0.65, 0],
      [`ΔU ${num(r.duTotal, 2)} %`, h * 0.65, r.duTotal > 4 ? 1 : 0],
      ...(c.sc ? [[`Ik1 ${Math.round(c.sc.ik1)} A`, h * 0.65, c.sc.ik1 < c.sc.ia ? 1 : 0]] : []),
    ];
    lines.forEach(([text, hh, color], k) => T([x, yEnd - 1.2 * h - k * 1.3 * h], text, { hh, align: 'center', color }));
    if (!r.ok) T([x, yEnd - 1.2 * h - lines.length * 1.3 * h], '! voir bilan', { hh: h * 0.55, align: 'center', color: 1 });
  });
  const height = 27 * h + 10.5 * h;
  // Cadre
  out.push({ type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[-h, h], [width, h], [width, -height], [-h, -height]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
  return { entities: out, width, height };
}

// Étendue d'un bloc (sans ses définitions d'attributs), en coordonnées du bloc ; null s'il est vide.
function blockExtents(block) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x, y, r = 0) => {
    box.x0 = Math.min(box.x0, x - r); box.y0 = Math.min(box.y0, y - r);
    box.x1 = Math.max(box.x1, x + r); box.y1 = Math.max(box.y1, y + r);
  };
  for (const e of block?.entities || []) {
    if (e.type === 'LINE') { add(e.p1[0], e.p1[1]); add(e.p2[0], e.p2[1]); } else if (e.type === 'CIRCLE' || e.type === 'ARC') add(e.c[0], e.c[1], e.r);
    else if (e.type === 'LWPOLYLINE' || e.type === 'SOLID') for (const q of e.pts) add(q[0], q[1]);
    else if (e.type === 'HATCH') for (const l of e.loops || []) for (const q of l) add(q[0], q[1]);
    else if (e.type === 'TEXT' && e.text) add(e.p[0], e.p[1], e.h * 0.7);
  }
  return Number.isFinite(box.x0) ? box : null;
}

// Légende des symboles utilisés (par catégorie), avec leur nombre. size : taille des symboles intégrés ;
// les blocs de bibliothèque gardent l'échelle de leur première insertion, réduite s'ils débordent de la ligne.
export function legendEntities(doc, devices, { size = 250, h = 2.5 * 50 } = {}) {
  const out = [];
  const T = (p, text, hh = h, align = 'left') => out.push({ type: 'TEXT', layer: '0', color: 0, p: [p[0], p[1], 0], h: hh, rot: 0, text, align, valign: 'middle', wf: 1 });
  // Groupes : un par symbole intégré, un par bloc de bibliothèque.
  const groups = new Map();
  for (const d of devices) {
    const m = d.elec;
    const key = m.block ? `bloc:${m.block}` : m.sym;
    if (!groups.has(key)) {
      groups.set(key, {
        cat: m.block ? m.cat || SYMBOLS[m.sym]?.cat : SYMBOLS[m.sym]?.cat, n: 0, block: m.block, sym: m.sym, scale: d.sx ?? 1,
        label: m.block ? m.label || m.block : SYMBOLS[m.sym]?.label || m.sym,
      });
    }
    groups.get(key).n++;
  }
  const order = Object.keys(SYMBOLS);
  const rowH = Math.max(size * 1.6, h * 2.2);
  let y = 0;
  T([0, y], 'LÉGENDE', h * 1.4);
  y -= rowH * 1.2;
  for (const [cat, c] of Object.entries(CATEGORIES)) {
    const used = [...groups.values()].filter((g) => g.cat === cat)
      .sort((a, b) => (a.block ? 1 : 0) - (b.block ? 1 : 0) || order.indexOf(a.sym) - order.indexOf(b.sym) || a.label.localeCompare(b.label, 'fr'));
    if (!used.length) continue;
    T([0, y], c.label.toUpperCase(), h * 0.9);
    y -= rowH;
    for (const g of used) {
      const lib = g.block && doc.blocks.has(g.block);
      const name = lib ? g.block : ensureSymbolBlock(doc, g.sym);
      let sc = size, p = [size * 0.8, y];
      const ext = lib && blockExtents(doc.blocks.get(name));
      if (lib) sc = g.scale;
      if (ext) {
        // Bloc de bibliothèque centré dans la case du symbole (largeur 1,6 × size, hauteur de ligne).
        sc = Math.min(sc, (size * 1.6) / Math.max(ext.x1 - ext.x0, 1e-9), (rowH * 0.85) / Math.max(ext.y1 - ext.y0, 1e-9));
        p = [size * 0.8 - ((ext.x0 + ext.x1) / 2) * sc, y - ((ext.y0 + ext.y1) / 2) * sc];
      }
      out.push({ type: 'INSERT', name, layer: '0', color: 0, p: [p[0], p[1], 0], sx: sc, sy: sc, sz: sc, rot: 0, cols: 1, rows: 1, dc: 0, dr: 0, attribs: [] });
      T([size * 2.2, y], g.label);
      T([size * 2.2 + h * 28, y], `${g.n}`, h, 'right');
      y -= rowH;
    }
    y -= rowH * 0.3;
  }
  return { entities: out, height: -y };
}

export { blockNameOf, fmtSection };

// Feuille A3 paysage à l'échelle des textes (h = 2,5 mm de papier → 420 × 297) : schémas unifilaires répartis sur
// plusieurs pages (perPage départs au plus), chacune avec cadre et cartouche (projet, contenu, tableau, page, date,
// établi par, indice). Renvoie [{ entities, width, height }], coin supérieur gauche de chaque page à l'origine.
// paper : 'A3' (420 × 297, défaut) ou 'A4' (297 × 210), paysage.
export function singleLinePages(info, { h = 2.5, perPage = 12, project = '', date = '', author = '', paper = 'A3' } = {}) {
  const k = h / 2.5;
  const [W0, H0] = paper === 'A4' ? [297, 210] : [420, 297];
  const W = W0 * k, H = H0 * k, m = 10 * k;
  const groups = [];
  for (let i = 0; i < info.circuits.length || !groups.length; i += perPage) groups.push(info.circuits.slice(i, i + perPage));
  return groups.map((list, i) => {
    const page = { n: i + 1, of: groups.length };
    const out = [];
    const L = (a, b) => out.push({ type: 'LINE', layer: '0', color: 0, p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
    const T = (q, text, hh = 3.5 * k, align = 'left') => out.push({ type: 'TEXT', layer: '0', color: 0, p: [q[0], q[1], 0], h: hh, rot: 0, text, align, valign: 'middle', wf: 1 });
    const rect = (x0, y0, x1, y1) => out.push({ type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
    rect(0, 0, W, -H);
    rect(m, -m, W - m, -H + m);
    // Schéma (ses propres coordonnées commencent au coin supérieur gauche, cadre à −h).
    const sch = singleLineEntities(info, { h, list, page });
    const dx = m + 5 * k + h, dy = -m - 5 * k - h;
    for (const e of sch.entities) {
      if (e === sch.entities[sch.entities.length - 1] && e.type === 'LWPOLYLINE') continue; // cadre du schéma : la feuille en tient lieu
      out.push(shift(e, dx, dy));
    }
    // Cartouche en bas à droite.
    const cw = 180 * k, row = 7 * k, rows = [
      ['Projet', project], ['Contenu', 'Schéma unifilaire'], ['Tableau', `${info.board.elec.board}${info.board.elec.parent ? ` (alimenté par ${info.board.elec.parent})` : ''}`],
      ['Page', `${page.n} / ${page.of}`], ['Date', date], ['Établi par', author], ['Indice', '0'],
    ];
    const x0 = W - m - cw, y0 = -H + m + rows.length * row;
    rect(x0, y0, W - m, -H + m);
    rows.forEach(([lab, val], r) => {
      const y = y0 - r * row;
      if (r) L([x0, y], [W - m, y]);
      T([x0 + 2 * k, y - row / 2], lab, 2.5 * k);
      T([x0 + 32 * k, y - row / 2], val || '', 3 * k);
    });
    L([x0 + 30 * k, y0], [x0 + 30 * k, -H + m]);
    return { entities: out, width: W, height: H };
  });
}

// Départs par page d'un format (le schéma fait 8 h de large par départ, plus l'arrivée) : A4 12, A3 18.
export function circuitsPerPage(paper, h = 2.5) {
  const k = h / 2.5, W = (paper === 'A4' ? 297 : 420) * k;
  return Math.max(1, Math.floor((W - 10 * k - (15 * k + h) - 2 * k) / (8 * h) - 1.2));
}

function shift(e, dx, dy) {
  const P = (q) => [q[0] + dx, q[1] + dy, q[2] || 0];
  if (e.type === 'LINE') return { ...e, p1: P(e.p1), p2: P(e.p2) };
  if (e.type === 'TEXT') return { ...e, p: P(e.p) };
  if (e.type === 'LWPOLYLINE') return { ...e, pts: e.pts.map((q) => [q[0] + dx, q[1] + dy]) };
  return e;
}
