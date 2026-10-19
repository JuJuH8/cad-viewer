// SPDX-License-Identifier: GPL-3.0-or-later
// Accessoires en ligne (comme les pièces en ligne de CADmep) : registres, clapets coupe-feu et silencieux sur
// les gaines, vannes sur les canalisations. Chaque accessoire est une insertion d'un bloc unitaire mis à la
// section du réseau (longueur le long de l'axe, largeur en travers), avec ses paramètres MEP (type, système,
// section) conservés en DXF / DWG et comptés au métré.
import * as G from '../core/geom.js';
import { planWidth, sectionLabel } from './systems.js';

export const ACCESSORY_LAYER = 'MEP-ACCESSOIRES';
// Longueur le long du réseau (mm) et libellé.
export const ACCESSORIES = {
  registre: { label: 'Registre', len: 200, kinds: ['duct'] },
  ccf: { label: 'Clapet coupe-feu', len: 300, kinds: ['duct'] },
  silencieux: { label: 'Silencieux', len: 900, kinds: ['duct'] },
  vanne: { label: 'Vanne', len: 0, kinds: ['pipe'] },
};

export const isAccessory = (e) => e?.type === 'INSERT' && e.mep?.kind === 'accessory';

// Blocs unitaires : x le long du réseau, y en travers (de -0,5 à 0,5).
function blockEntities(type) {
  const L = (x1, y1, x2, y2) => ({ type: 'LINE', layer: '0', color: 0, p1: [x1, y1, 0], p2: [x2, y2, 0] });
  const box = [L(-0.5, -0.5, 0.5, -0.5), L(0.5, -0.5, 0.5, 0.5), L(0.5, 0.5, -0.5, 0.5), L(-0.5, 0.5, -0.5, -0.5)];
  if (type === 'registre') return [...box, L(-0.35, -0.45, 0.35, 0.45)]; // volet
  if (type === 'ccf') return [...box, L(-0.5, -0.5, 0.5, 0.5), L(-0.5, 0.5, 0.5, -0.5)];
  if (type === 'silencieux') return [...box, L(-0.4, -0.3, 0.4, -0.3), L(-0.4, 0.3, 0.4, 0.3), L(-0.4, -0.3, -0.4, 0.3), L(0.4, -0.3, 0.4, 0.3)];
  // Vanne : deux triangles opposés par la pointe.
  return [L(-0.5, -0.5, 0.5, 0.5), L(0.5, 0.5, 0.5, -0.5), L(0.5, -0.5, -0.5, 0.5), L(-0.5, 0.5, -0.5, -0.5)];
}

export function ensureAccessoryBlock(doc, type) {
  const name = `CV_ACC_${type.toUpperCase()}`;
  if (!doc.blocks.has(name)) doc.blocks.set(name, { name, base: [0, 0, 0], flags: 0, xref: false, entities: blockEntities(type) });
  if (!doc.layers.has(ACCESSORY_LAYER)) doc.addLayer(ACCESSORY_LAYER, { color: 6 });
  return name;
}

// Accessoire de type `type` sur le réseau `run`, au point de l'axe le plus proche de p (u : mm par unité).
export function accessoryOn(run, p, type, u = 1) {
  const m = run.mep;
  let best = null;
  for (let i = 1; i < run.pts.length; i++) {
    const r = G.closestOnSegment(p, run.pts[i - 1], run.pts[i]);
    if (!best || r.d < best.d) best = { ...r, a: run.pts[i - 1], b: run.pts[i] };
  }
  if (!best || G.dist(best.a, best.b) < 1e-12) return null;
  const spec = ACCESSORIES[type];
  const across = (m.kind === 'pipe' ? (m.d || 0) * 2.5 : planWidth(m) + 40 / u);
  const along = spec.len ? spec.len / u : across;
  return {
    type: 'INSERT', name: `CV_ACC_${type.toUpperCase()}`, layer: ACCESSORY_LAYER, color: 256,
    p: [best.point[0], best.point[1], 0], sx: along, sy: across, sz: 1, rot: G.angleOf(best.a, best.b), attribs: [],
    mep: { kind: 'accessory', type, label: spec.label, system: m.system, section: sectionLabel(m), z: m.z || 0,
      h: m.kind === 'pipe' || m.shape === 'round' ? m.d || 0 : m.h || 0 },
  };
}
