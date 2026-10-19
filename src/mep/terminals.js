// SPDX-License-Identifier: GPL-3.0-or-later
// Terminaux aérauliques paramétriques (symboles en plan), créés comme des blocs à la demande.
import * as G from '../core/geom.js';

export const TERMINALS = {
  DIFF: { label: 'Diffuseur plafonnier carré', round: false },
  GRILLE: { label: 'Grille de reprise', round: false },
  BOUCHE: { label: 'Bouche d’extraction', round: true },
  DIFFC: { label: 'Diffuseur circulaire', round: true },
};

// Appareils sanitaires : débits de base (l/s) en eau froide et eau chaude, DTU 60.11.
export const FIXTURES = {
  LAVABO: { label: 'Lavabo', code: 'LV', ef: 0.20, ecs: 0.20 },
  LAVEMAINS: { label: 'Lave-mains', code: 'LM', ef: 0.10, ecs: 0.10 },
  EVIER: { label: 'Évier', code: 'EV', ef: 0.20, ecs: 0.20 },
  DOUCHE: { label: 'Douche', code: 'DO', ef: 0.20, ecs: 0.20 },
  BAIGNOIRE: { label: 'Baignoire', code: 'BA', ef: 0.33, ecs: 0.33 },
  BIDET: { label: 'Bidet', code: 'BI', ef: 0.20, ecs: 0.20 },
  WC: { label: 'WC à réservoir', code: 'WC', ef: 0.12, ecs: 0 },
  URINOIR: { label: 'Urinoir', code: 'UR', ef: 0.15, ecs: 0 },
  LAVELINGE: { label: 'Lave-linge', code: 'LL', ef: 0.20, ecs: 0 },
  LAVEVAISSELLE: { label: 'Lave-vaisselle', code: 'VS', ef: 0.10, ecs: 0 },
  POSTEEAU: { label: 'Poste d’eau', code: 'PE', ef: 0.33, ecs: 0 },
};
for (const [k, f] of Object.entries(FIXTURES)) TERMINALS[k] = { label: f.label, round: true, water: true, code: f.code };

// Émetteurs des réseaux de chauffage et d'eau glacée (débit déduit de la puissance et du ΔT).
export const EMITTERS = {
  RADIATEUR: { label: 'Radiateur', w: 800, h: 100, system: 'CH-D' },
  VENTILO: { label: 'Ventilo-convecteur', w: 1000, h: 400, system: 'EG-D' },
  BATTERIE: { label: 'Batterie de CTA', w: 600, h: 600, system: 'CH-D' },
};
for (const [k, f] of Object.entries(EMITTERS)) TERMINALS[k] = { label: f.label, round: false, hydro: true };

const line = (a, b) => ({ type: 'LINE', layer: '0', color: 0, p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
const rect = (w, h) => ({
  type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
  bulges: [0, 0, 0, 0], closed: true, z: 0,
});
const circle = (r) => ({ type: 'CIRCLE', layer: '0', color: 0, c: [0, 0, 0], r });

// Géométrie du symbole, centrée sur l'origine. w, h : dimensions (ou d : diamètre).
export function terminalEntities(type, { w = 600, h = 600, d = 200 } = {}) {
  switch (type) {
    case 'DIFF': {
      const out = [rect(w, h), rect(w * 0.55, h * 0.55)];
      out.push(line([-w / 2, -h / 2], [-w * 0.275, -h * 0.275]), line([w / 2, -h / 2], [w * 0.275, -h * 0.275]),
        line([w / 2, h / 2], [w * 0.275, h * 0.275]), line([-w / 2, h / 2], [-w * 0.275, h * 0.275]));
      return out;
    }
    case 'GRILLE': {
      const out = [rect(w, h)];
      const n = Math.max(3, Math.round(w / 80));
      for (let i = 1; i < n; i++) {
        const x = -w / 2 + (w * i) / n;
        out.push(line([x, -h / 2], [x, h / 2]));
      }
      return out;
    }
    case 'BOUCHE': {
      const r = d / 2;
      return [circle(r), line(G.polar([0, 0], Math.PI / 4, r), G.polar([0, 0], (5 * Math.PI) / 4, r)),
        line(G.polar([0, 0], (3 * Math.PI) / 4, r), G.polar([0, 0], -Math.PI / 4, r))];
    }
    case 'DIFFC': {
      const r = d / 2;
      const out = [circle(r), circle(r * 0.55)];
      for (let k = 0; k < 4; k++) out.push(line(G.polar([0, 0], (k * Math.PI) / 2, r * 0.55), G.polar([0, 0], (k * Math.PI) / 2, r)));
      return out;
    }
    case 'RADIATEUR': {
      const out = [rect(w, h)];
      for (let k = 1; k < 8; k++) out.push(line([-w / 2 + (w * k) / 8, -h / 2], [-w / 2 + (w * k) / 8, h / 2]));
      return out;
    }
    case 'VENTILO':
      return [rect(w, h), line([-w / 2, -h / 2], [w / 2, h / 2]), circle(Math.min(w, h) * 0.3)];
    case 'BATTERIE':
      return [rect(w, h), line([-w / 2, -h / 2], [w / 2, h / 2]), line([-w / 2, h / 2], [w / 2, -h / 2])];
    default: {
      const f = TERMINALS[type];
      if (!f?.water) return [];
      // Appareil sanitaire : cercle et code (LV, DO, WC…).
      const r = d / 2;
      return [circle(r), { type: 'TEXT', layer: '0', color: 0, p: [0, 0, 0], h: r * 0.7, rot: 0, text: f.code, align: 'center', valign: 'middle', wf: 1 }];
    }
  }
}

export function terminalSize(type, spec) {
  return TERMINALS[type]?.round ? `Ø${spec.d}` : `${spec.w}×${spec.h}`;
}

// Crée (une fois) le bloc du terminal et renvoie son nom.
export function ensureTerminalBlock(doc, type, spec) {
  const name = `CV_TERM_${type}_${terminalSize(type, spec).replace('×', 'x').replace('Ø', 'D')}`;
  if (!doc.blocks.has(name)) {
    doc.blocks.set(name, { name, base: [0, 0, 0], flags: 0, xref: false, entities: terminalEntities(type, spec) });
  }
  return name;
}
