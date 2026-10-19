// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages du dessin (en-tête, comme les variables d'AutoCAD) : précision d'affichage, style de point,
// style de cote, épaisseur par défaut, types de ligne standard. Lus par le rendu, les commandes et le DXF.

// Dessin métrique (MEASUREMENT = 1) : lu dans le fichier, sinon déduit des unités (pouces, pieds… : impérial ;
// mm, cm, m ou sans unité : métrique).
export function isMetric(doc) {
  const h = doc?.header || {};
  if (h.measurement === 0 || h.measurement === 1) return h.measurement === 1;
  return ![1, 2, 3, 8, 9, 10].includes(h.insunits);
}

// Échelle des annotations (1:N) : réglée, ou déduite (dessin en mm : 1:50).
export function annoScaleOf(doc) {
  const h = doc?.header || {};
  if (h.annoScale) return h.annoScale;
  if (h.dimscale > 1) return h.dimscale;
  return h.insunits === 4 ? 50 : 1;
}

// --- points (PDMODE / PDSIZE) ---------------------------------------------------------

// Styles : 0 point, 1 rien, 2 plus, 3 croix, 4 trait ; + 32 cercle, + 64 carré.
export const POINT_MODES = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 64, 65, 66, 67, 68, 96, 97, 98, 99, 100];

// Taille d'un symbole de point dans le dessin : PDSIZE > 0 absolu ; sinon mm sur le papier (défaut 2,5)
// multipliés par l'échelle des annotations.
export function pointSize(doc) {
  const s = doc?.header?.pdsize ?? 0;
  return s > 0 ? s : (s < 0 ? -s : 2.5) * annoScaleOf(doc);
}

// Segments (paires de points) du symbole de point de style `mode`, centré en p, de taille `size`.
export function pointSymbol(p, mode, size) {
  const [x, y] = p, r = size / 2;
  const out = [];
  const base = mode & 7;
  if (base === 2) out.push([[x - r, y], [x + r, y]], [[x, y - r], [x, y + r]]);
  if (base === 3) out.push([[x - r, y - r], [x + r, y + r]], [[x - r, y + r], [x + r, y - r]]);
  if (base === 4) out.push([[x, y], [x, y + r]]);
  if (mode & 32) {
    const n = 24, ring = [];
    for (let i = 0; i <= n; i++) ring.push([x + r * Math.cos((i * 2 * Math.PI) / n), y + r * Math.sin((i * 2 * Math.PI) / n)]);
    out.push(ring);
  }
  if (mode & 64) out.push([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r]]);
  return out;
}

// --- cotes ------------------------------------------------------------------------------

// Style de cote du dessin (valeurs en mm sur le papier, comme ISO-25), avec les valeurs par défaut.
export const DIM_DEFAULTS = { DIMTXT: 2.5, DIMASZ: 2.5, DIMEXE: 1.25, DIMEXO: 0.625, DIMGAP: 0.625, DIMDEC: 2, DIMBLK: 'fermee', DIMLFAC: 1, DIMPOST: '' };
export const ARROWS = { fermee: 'Flèche pleine', ouverte: 'Flèche ouverte', oblique: 'Trait oblique (architecte)', point: 'Point' };
export const dimStyleOf = (doc) => ({ ...DIM_DEFAULTS, ...(doc?.header?.dimstyle || {}) });

// --- épaisseurs ---------------------------------------------------------------------------

// Épaisseur « Défaut » en mm (LWDEFAULT) : 0,18 mm sauf réglage.
export const lwDefaultMm = (doc) => (doc?.header?.lwdefault > 0 ? doc.header.lwdefault / 100 : 0.18);

// --- types de ligne standard -------------------------------------------------------------------

// Types de ligne proposés : noms usuels du dessin technique, motifs et descriptions propres à l'application ;
// tirets en mm (+ trait, − espace, 0 point).
export const STANDARD_LTYPES = [
  { name: 'CACHE', description: 'Arêtes cachées, tirets moyens', dashes: [6, -3] },
  { name: 'CACHE2', description: 'Arêtes cachées, tirets courts', dashes: [3, -1.5] },
  { name: 'CACHEX2', description: 'Arêtes cachées, tirets longs', dashes: [12, -6] },
  { name: 'INTERROMPU', description: 'Trait interrompu', dashes: [12, -3] },
  { name: 'INTERROMPUX2', description: 'Trait interrompu, grand motif', dashes: [24, -6] },
  { name: 'AXES', description: 'Trait d’axe (long, court)', dashes: [24, -3, 3, -3] },
  { name: 'AXES2', description: 'Trait d’axe, petit motif', dashes: [12, -1.5, 1.5, -1.5] },
  { name: 'POINTILLE', description: 'Points espacés', dashes: [0, -3] },
  { name: 'POINTILLE2', description: 'Points serrés', dashes: [0, -1.5] },
  { name: 'MIXTE', description: 'Trait mixte (tiret, point)', dashes: [12, -3, 0, -3] },
  { name: 'FANTOME', description: 'Trait long, deux tirets courts', dashes: [24, -3, 3, -3, 3, -3] },
  { name: 'LIMITE', description: 'Limite (tiret, deux points)', dashes: [12, -3, 0, -3, 0, -3] },
];

// Aperçu SVG d'un motif de tirets sur une largeur donnée (px).
export function dashSvg(dashes, width = 120, height = 10) {
  if (!dashes?.length) return `<svg width="${width}" height="${height}"><line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="currentColor"/></svg>`;
  const total = dashes.reduce((s, d) => s + Math.abs(d), 0) || 1;
  const k = Math.min(4, 60 / total);
  let x = 0, i = 0, parts = '';
  while (x < width && i < 500) {
    const d = dashes[i % dashes.length];
    const len = Math.abs(d) * k;
    if (d > 0) parts += `<line x1="${x}" y1="${height / 2}" x2="${Math.min(width, x + len)}" y2="${height / 2}"/>`;
    else if (d === 0) parts += `<circle cx="${x}" cy="${height / 2}" r="0.9" fill="currentColor"/>`;
    x += d === 0 ? 0 : len;
    i++;
  }
  return `<svg width="${width}" height="${height}" stroke="currentColor" stroke-width="1.2">${parts}</svg>`;
}
