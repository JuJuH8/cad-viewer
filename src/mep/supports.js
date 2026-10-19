// SPDX-License-Identifier: GPL-3.0-or-later
// Supportage des réseaux (comme les « hangers » de CADmep) : supports posés le long de chaque gaine,
// canalisation ou chemin de câbles, à l'entraxe maximal du réseau, au plus près de chaque extrémité et de
// part et d'autre de chaque coude. Chaque support est une insertion du bloc CV_SUPPORT (traverse + tiges),
// mise à la largeur du réseau, qui garde ses paramètres MEP (système, section, type, altitude) en DXF / DWG.
import * as G from '../core/geom.js';
import { planWidth, sectionLabel, zAt } from './systems.js';
import { elbowPlan } from './geometry.js';

export const SUPPORT_BLOCK = 'CV_SUPPORT';
export const SUPPORT_LAYER = 'MEP-SUPPORTS';
const DRAIN = new Set(['EU', 'EV', 'EP']);

const isRun = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2;
export const isSupport = (e) => e?.type === 'INSERT' && e.mep?.kind === 'support';

// Entraxe maximal (m) pour une section en mm : valeurs courantes des guides de mise en œuvre (à adapter
// aux prescriptions du fabricant) — gaines 3 m (2,4 m au-delà de 1 000 mm), chemins de câbles 1,5 m,
// tubes métalliques selon le diamètre, PVC d'évacuation 10 × D.
export function supportSpacing(m) {
  if (m.kind === 'duct') return planWidth(m) > 1000 ? 2.4 : 3;
  if (m.kind === 'tray') return 1.5;
  const d = m.d || 0;
  if (DRAIN.has(m.system)) return Math.min(2, Math.max(0.5, (10 * d) / 1000));
  if (d <= 15) return 1.25;
  if (d <= 22) return 1.5;
  if (d <= 35) return 2;
  if (d <= 54) return 2.5;
  return 3;
}

export function supportType(m) {
  if (m.kind === 'tray') return 'Console';
  if (m.kind === 'duct' && m.shape !== 'round') return 'Suspente trapèze';
  return 'Collier';
}

// Extrémités raccordées bout à bout à un autre réseau du même système : [début, fin].
export function joinedEnds(e, runs) {
  const tol = Math.max(1e-6, 0.02 * Math.max(planWidth(e.mep), e.mep.d || 0, 1));
  const ends = [e.pts[0], e.pts[e.pts.length - 1]];
  return ends.map((p) => runs.some((o) => o.id !== e.id && isRun(o) && o.mep.system === e.mep.system
    && (G.dist(p, o.pts[0]) <= tol || G.dist(p, o.pts[o.pts.length - 1]) <= tol)));
}

// Positions des supports sur l'axe d'un réseau (unités du dessin) : [{ p, dir }].
// u : mm par unité du dessin ; spacingM : entraxe imposé (m), sinon celui du réseau ; joined : extrémités
// raccordées bout à bout (demi-entraxe de chaque côté de la jonction au lieu de 30 cm, sans doublon).
export function supportPositions(e, u = 1, spacingM = 0, joined = [false, false]) {
  const m = e.mep;
  const mm = (v) => v / u; // mm → unités du dessin
  const mmSec = u === 1 ? m : { ...m, w: (m.w || 0) * u, h: (m.h || 0) * u, d: (m.d || 0) * u };
  const step = mm((spacingM > 0 ? spacingM : supportSpacing(mmSec)) * 1000);
  const endGap = mm(300); // support à 30 cm d'une extrémité ou de la fin d'un coude
  const n = e.pts.length;
  // Longueur occupée par le coude au sommet k (tangente R·tan(θ/2), 0 pour un onglet).
  const plan = elbowPlan(e);
  const tangent = (k) => plan.t[k] || 0;
  const out = [];
  let acc = 0; // abscisse du début du tronçon
  for (let k = 1; k < n; k++, acc += G.dist(e.pts[k - 2], e.pts[k - 1])) {
    const a = e.pts[k - 1], b = e.pts[k];
    const L = G.dist(a, b);
    if (L < 1e-9) continue;
    const dir = G.norm(G.sub(b, a));
    const e0 = tangent(k - 1) + (k === 1 && joined[0] ? step / 2 : endGap);
    const e1 = tangent(k) + (k === n - 1 && joined[1] ? step / 2 : endGap);
    const free = L - e0 - e1;
    // Zone libre courte : un seul support (au milieu du tronçon, ou de la zone libre).
    if (free <= 0) { out.push({ p: G.lerp(a, b, 0.5), dir, s: acc + L / 2 }); continue; }
    if (free <= endGap) { out.push({ p: G.add(a, G.mul(dir, e0 + free / 2)), dir, s: acc + e0 + free / 2 }); continue; }
    const gaps = Math.max(1, Math.ceil(free / step - 1e-9));
    for (let i = 0; i <= gaps; i++) out.push({ p: G.add(a, G.mul(dir, e0 + (free * i) / gaps)), dir, s: acc + e0 + (free * i) / gaps });
  }
  return out;
}

// Bloc unitaire : traverse transversale (y de -0,5 à 0,5) et deux tiges (traits courts le long du réseau).
export function ensureSupportBlock(doc) {
  if (!doc.blocks.has(SUPPORT_BLOCK)) {
    const L = (x1, y1, x2, y2) => ({ type: 'LINE', layer: '0', color: 0, p1: [x1, y1, 0], p2: [x2, y2, 0] });
    doc.blocks.set(SUPPORT_BLOCK, {
      name: SUPPORT_BLOCK, base: [0, 0, 0], flags: 0, xref: false,
      entities: [L(0, -0.5, 0, 0.5), L(-0.5, -0.5, 0.5, -0.5), L(-0.5, 0.5, 0.5, 0.5)],
    });
  }
  if (!doc.layers.has(SUPPORT_LAYER)) doc.addLayer(SUPPORT_LAYER, { color: 8 });
  return SUPPORT_BLOCK;
}

// Insertions des supports d'un réseau (runs : réseaux voisins, pour les jonctions bout à bout).
export function supportEntities(e, u = 1, spacingM = 0, runs = []) {
  const m = e.mep;
  const across = (m.kind === 'pipe' ? m.d || 0 : planWidth(m)) + 2 * (m.ins || 0) + 2 * ((m.kind === 'pipe' ? 30 : 50) / u);
  const along = 80 / u;
  const mmSec = u === 1 ? m : { ...m, w: (m.w || 0) * u, h: (m.h || 0) * u, d: (m.d || 0) * u };
  const spacing = spacingM > 0 ? spacingM : supportSpacing(mmSec);
  return supportPositions(e, u, spacingM, joinedEnds(e, runs)).map(({ p, dir, s }) => ({
    type: 'INSERT', name: SUPPORT_BLOCK, layer: SUPPORT_LAYER, color: 256,
    p: [p[0], p[1], 0], sx: along, sy: across, sz: 1, rot: Math.atan2(dir[1], dir[0]), attribs: [],
    mep: { kind: 'support', system: m.system, type: supportType(m), section: sectionLabel(m), z: m.z1 != null ? zAt(e, s) : m.z || 0, spacing,
      h: (m.kind === 'pipe' || m.shape === 'round' ? m.d || 0 : m.h || (m.kind === 'tray' ? 60 : 0)) + 2 * (m.ins || 0), tray: m.kind === 'tray' },
  }));
}

// Supports existants posés sur l'un des réseaux (pour les remplacer quand on relance la commande).
export function supportsOn(entities, runs) {
  const list = runs.filter(isRun);
  return entities.filter((s) => isSupport(s) && list.some((e) => {
    if (e.mep.system !== s.mep.system) return false;
    const tol = (e.mep.kind === 'pipe' ? e.mep.d || 0 : planWidth(e.mep)) / 2 + 1e-6;
    for (let k = 1; k < e.pts.length; k++) if (G.closestOnSegment(s.p, e.pts[k - 1], e.pts[k]).d <= tol) return true;
    return false;
  }));
}

// Récapitulatif : [{ system, type, section, spacing, count }].
export function supportSummary(entities) {
  const map = new Map();
  for (const s of entities) {
    if (!isSupport(s)) continue;
    const key = `${s.mep.system}|${s.mep.type}|${s.mep.section}`;
    const r = map.get(key) || { system: s.mep.system, type: s.mep.type, section: s.mep.section, spacing: s.mep.spacing, count: 0 };
    r.count++;
    map.set(key, r);
  }
  return [...map.values()].sort((a, b) => a.system.localeCompare(b.system) || a.section.localeCompare(b.section, 'fr', { numeric: true }));
}
