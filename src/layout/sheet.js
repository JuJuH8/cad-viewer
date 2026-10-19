// SPDX-License-Identifier: GPL-3.0-or-later
// Mise en page des présentations, comme la mise en page d'AutoCAD : la feuille (format, orientation,
// position dans l'espace papier), la zone non imprimable, le style de tracé. Enregistrée dans la
// présentation (doc.spaces[i].plot) ; une présentation lue d'un DWG / DXF prend la feuille de ses limites.

// Formats ISO en paysage (mm).
export const FORMATS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
// Échelles normalisées 1:N (fenêtres, plans).
export const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500, 1000, 1250, 2000, 2500, 5000, 10000];
export const CUSTOM = 'Personnalisé';

const near = (a, b) => Math.abs(a - b) < 1.5;

// Formats ajoutés par l'utilisateur (réglages du dessin → Formats), conservés dans le navigateur :
// { nom: [largeur, hauteur] } en paysage.
const USER_KEY = 'cadviewer.formats';
export function userFormats() {
  try {
    const list = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
    return Object.fromEntries(list.filter((f) => f?.name && f.w > 10 && f.h > 10).map((f) => [f.name, [Math.max(f.w, f.h), Math.min(f.w, f.h)]]));
  } catch { return {}; }
}
export function saveUserFormats(list) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
}
export const allFormats = () => ({ ...FORMATS, ...userFormats() });

// Format connu d'une feuille de w × h mm (dans un sens ou dans l'autre), sinon « Personnalisé ».
export function formatOf(w, h) {
  for (const [k, [a, b]] of Object.entries(allFormats())) if ((near(w, a) && near(h, b)) || (near(w, b) && near(h, a))) return k;
  return CUSTOM;
}

// Nouvelle mise en page : format, orientation, feuille posée à l'origine de l'espace papier.
export function makePlot(paper = 'A3', landscape = true, extra = {}) {
  const all = allFormats();
  const [a, b] = all[paper] || FORMATS.A3;
  const [w, h] = landscape ? [a, b] : [b, a];
  return { paper: all[paper] ? paper : 'A3', w, h, origin: [0, 0], margins: [0, 0, 0, 0], mono: true, lineweights: true, ...extra };
}

export const isLandscape = (p) => p.w >= p.h;

// Feuille d'une présentation : sa mise en page, sinon ses limites (fichier AutoCAD), sinon le plus petit format
// qui contient son contenu (extents : emprise de l'espace papier). null pour l'espace objet.
export function sheetOf(sp, extents = null) {
  if (!sp || sp.id === 'model') return null;
  if (sp.plot) return sp.plot;
  const base = { margins: [0, 0, 0, 0], mono: true, lineweights: true, derived: true };
  if (sp.limits) {
    const [x0, y0] = sp.limits.min, [x1, y1] = sp.limits.max;
    const w = x1 - x0, h = y1 - y0;
    if (w > 50 && h > 50) return { ...base, paper: formatOf(w, h), w, h, origin: [x0, y0] };
  }
  if (extents && extents.maxX > extents.minX && extents.maxY > extents.minY) {
    const ew = extents.maxX - extents.minX + 20, eh = extents.maxY - extents.minY + 20;
    const landscape = ew >= eh;
    const paper = Object.keys(FORMATS).find((k) => {
      const [a, b] = FORMATS[k];
      return landscape ? a >= ew && b >= eh : b >= ew && a >= eh;
    }) || 'A0';
    const p = makePlot(paper, landscape);
    const cx = (extents.minX + extents.maxX) / 2, cy = (extents.minY + extents.maxY) / 2;
    return { ...p, ...base, origin: [cx - p.w / 2, cy - p.h / 2] };
  }
  return { ...makePlot('A3'), ...base };
}

export const sheetRect = (p) => ({ minX: p.origin[0], minY: p.origin[1], maxX: p.origin[0] + p.w, maxY: p.origin[1] + p.h });

// Zone imprimable (feuille moins les marges gauche, bas, droite, haut).
export function printableRect(p) {
  const [l, b, r, t] = p.margins || [0, 0, 0, 0];
  const s = sheetRect(p);
  return { minX: s.minX + l, minY: s.minY + b, maxX: s.maxX - r, maxY: s.maxY - t };
}

export function describePlot(p) {
  const size = `${Math.round(p.w)} × ${Math.round(p.h)} mm`;
  return `${p.paper === CUSTOM ? size : `${p.paper} ${isLandscape(p) ? 'paysage' : 'portrait'}`}${p.paper === CUSTOM ? '' : ` (${size})`}`;
}

// Plus grande échelle normalisée 1:N à laquelle une zone de l'espace objet (largeur × hauteur, unités du dessin)
// tient dans une fenêtre de w × h mm.
export function fittingScale(modelW, modelH, w, h, unitMm = 1) {
  return SCALES.find((n) => (modelW * unitMm) / n <= w && (modelH * unitMm) / n <= h) || SCALES[SCALES.length - 1];
}

// Échelle d'une fenêtre (hauteur papier / hauteur de vue) lue comme « 1:N » si elle est normalisée.
export function scaleLabel(k, unitMm = 1) {
  const n = unitMm / k;
  const std = SCALES.find((s) => Math.abs(s - n) / s < 1e-6);
  if (std) return `1:${std}`;
  return n >= 1 ? `1:${+n.toFixed(2)}` : `${+(1 / n).toFixed(2)}:1`;
}
