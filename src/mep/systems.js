// SPDX-License-Identifier: GPL-3.0-or-later
// Systèmes MEP (conventions françaises usuelles) : chaque système a son calque, sa couleur
// (index AutoCAD) et son type de ligne. Les réseaux de retour sont en traits interrompus.
export const SYSTEMS = [
  // CVC — aéraulique
  { code: 'SOUF', label: 'Soufflage', domain: 'CVC', kind: 'duct', color: 5, ltype: 'Continuous' },
  { code: 'REP', label: 'Reprise', domain: 'CVC', kind: 'duct', color: 3, ltype: 'DASHED' },
  { code: 'AN', label: 'Air neuf', domain: 'CVC', kind: 'duct', color: 4, ltype: 'Continuous' },
  { code: 'EXT', label: 'Extraction', domain: 'CVC', kind: 'duct', color: 30, ltype: 'DASHED' },
  { code: 'REJ', label: 'Rejet', domain: 'CVC', kind: 'duct', color: 6, ltype: 'DASHED' },
  // CVC — hydraulique
  { code: 'CH-D', label: 'Chauffage départ', domain: 'CVC', kind: 'pipe', color: 1, ltype: 'Continuous' },
  { code: 'CH-R', label: 'Chauffage retour', domain: 'CVC', kind: 'pipe', color: 5, ltype: 'DASHED' },
  { code: 'EG-D', label: 'Eau glacée départ', domain: 'CVC', kind: 'pipe', color: 140, ltype: 'Continuous' },
  { code: 'EG-R', label: 'Eau glacée retour', domain: 'CVC', kind: 'pipe', color: 150, ltype: 'DASHED' },
  // Plomberie
  { code: 'EF', label: 'Eau froide', domain: 'PLB', kind: 'pipe', color: 5, ltype: 'Continuous' },
  { code: 'ECS', label: 'Eau chaude sanitaire', domain: 'PLB', kind: 'pipe', color: 1, ltype: 'Continuous' },
  { code: 'BECS', label: 'Bouclage ECS', domain: 'PLB', kind: 'pipe', color: 6, ltype: 'DASHED' },
  { code: 'EU', label: 'Eaux usées', domain: 'PLB', kind: 'pipe', color: 34, ltype: 'Continuous' },
  { code: 'EV', label: 'Eaux vannes', domain: 'PLB', kind: 'pipe', color: 24, ltype: 'Continuous' },
  { code: 'EP', label: 'Eaux pluviales', domain: 'PLB', kind: 'pipe', color: 3, ltype: 'Continuous' },
  { code: 'GAZ', label: 'Gaz', domain: 'PLB', kind: 'pipe', color: 2, ltype: 'Continuous' },
  // Électricité
  { code: 'CFO', label: 'Chemin de câbles courants forts', domain: 'ELEC', kind: 'tray', color: 30, ltype: 'Continuous' },
  { code: 'CFA', label: 'Chemin de câbles courants faibles', domain: 'ELEC', kind: 'tray', color: 4, ltype: 'Continuous' },
  // Tubes électriques (noyés en dalle ou en mur, ou apparents) : canalisations en trait simple, interrompu.
  { code: 'TUB-CFO', label: 'Tube courants forts', domain: 'ELEC', kind: 'pipe', conduit: true, color: 30, ltype: 'DASHED' },
  { code: 'TUB-CFA', label: 'Tube courants faibles', domain: 'ELEC', kind: 'pipe', conduit: true, color: 4, ltype: 'DASHED' },
  { code: 'SPR', label: 'Sprinkler', domain: 'SSI', kind: 'pipe', color: 1, ltype: 'Continuous' },
];

export const KIND_LABELS = { duct: 'Gaine', pipe: 'Canalisation', tray: 'Chemin de câbles' };

// Tubes électriques : pose et désignation (légende des plans électriques : noyé plafond, noyé au sol, faux-plancher,
// chemin de câbles, faux-plafond) ; « dalle » = noyé dans la dalle du plafond.
export const EMBED_LABELS = {
  dalle: 'noyé plafond', sol: 'noyé au sol', mur: 'noyé en mur', fauxplancher: 'dans faux-plancher',
  fauxplafond: 'dans faux-plafond', cdc: 'dans chemin de câbles', apparent: 'apparent',
};
// Type de ligne de chaque pose (comme la légende) : continu, tirets (sol), trait mixte (faux-plancher, faux-plafond).
export const EMBED_LTYPES = { dalle: 'Continuous', sol: 'DASHED', mur: 'Continuous', fauxplancher: 'DASHDOT', fauxplafond: 'DASHDOT', cdc: 'Continuous', apparent: 'Continuous' };
// Poses noyées dans la structure (pas de conflit avec les autres réseaux, pas de supports).
export const EMBEDDED = new Set(['dalle', 'sol', 'mur']);
export const conduitLtype = (embed) => EMBED_LTYPES[embed] || 'Continuous';
export const kindLabel = (m) => (m?.conduit ? 'Tube électrique' : KIND_LABELS[m?.kind] || m?.kind || 'Réseau');

export function systemByCode(code) {
  return SYSTEMS.find((s) => s.code.toUpperCase() === String(code).toUpperCase()) || null;
}

export function layerName(sys) {
  return `MEP-${sys.domain}-${sys.code}`;
}

// Crée au besoin le calque du système (et le type de ligne DASHED) ; renvoie le nom du calque.
export function ensureSystemLayer(doc, sys) {
  if (!doc.ltypes) doc.ltypes = new Map();
  if (!doc.ltypes.has('DASHED')) {
    // Motif ISO courant à l'échelle du millimètre (12 mm de tiret, 6 mm d'espace × 25 = papier au 1/25e).
    doc.ltypes.set('DASHED', { name: 'DASHED', description: 'Tirets __ __ __', dashes: [300, -150] });
  }
  if (!doc.ltypes.has('DASHDOT')) doc.ltypes.set('DASHDOT', { name: 'DASHDOT', description: 'Trait mixte __ . __ .', dashes: [300, -90, 30, -90] });
  const name = layerName(sys);
  if (!doc.layers.has(name)) doc.addLayer(name, { color: sys.color, ltype: sys.ltype });
  return name;
}

// Section affichée : « 400×200 », « Ø250 », « CDC 300 ».
export function sectionLabel(m) {
  if (m.kind === 'pipe') return m.conduit ? `M${fmtMm(m.d)}` : `Ø${fmtMm(m.d)}`;
  if (m.kind === 'tray') return `CDC ${fmtMm(m.w)}×${fmtMm(m.h || 60)}`;
  return m.shape === 'round' ? `Ø${fmtMm(m.d)}` : `${fmtMm(m.w)}×${fmtMm(m.h)}`;
}

function fmtMm(v) {
  return String(Math.round((v || 0) * 10) / 10);
}

// Réseau en pente : m.z = altitude de l'axe au premier sommet, m.z1 au dernier (absent : horizontal).
export function axisLength(e) {
  let L = 0;
  for (let k = 1; k < e.pts.length; k++) L += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]);
  return L;
}

// Pente (sans unité, positive si l'axe monte du premier au dernier sommet).
export function slopeOf(e) {
  const m = e.mep;
  if (m?.z1 == null) return 0;
  const L = axisLength(e);
  return L > 0 ? (m.z1 - (m.z || 0)) / L : 0;
}

// Altitude de l'axe à l'abscisse s, et à chaque sommet.
export const zAt = (e, s) => (e.mep.z || 0) + slopeOf(e) * s;
export function vertexZ(e) {
  const k = slopeOf(e), z0 = e.mep.z || 0;
  const out = [z0];
  let s = 0;
  for (let i = 1; i < e.pts.length; i++) {
    s += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    out.push(z0 + k * s);
  }
  return out;
}

// Montées / descentes : prolongements bout à bout (même système) raccordés à une autre altitude.
// Renvoie [{ end (0 | 1), p, n (voisin), dz (altitude du voisin − la sienne), k (extrémité du voisin) }].
export function riseDrops(e, neighbors) {
  const m = e.mep, out = [];
  const size = Math.max(planWidth(m), m.d || 0, 1);
  const tol = 0.02 * size, ztol = Math.max(1e-6, 0.01 * size);
  const vz = vertexZ(e);
  for (const end of [0, 1]) {
    const i = end === 0 ? 0 : e.pts.length - 1;
    for (const n of neighbors) {
      if (!n?.mep || n.type !== 'LWPOLYLINE' || n.id === e.id || n.mep.system !== m.system || n.mep.kind !== m.kind || n.pts.length < 2) continue;
      const k = Math.hypot(e.pts[i][0] - n.pts[0][0], e.pts[i][1] - n.pts[0][1]) <= tol ? 0
        : Math.hypot(e.pts[i][0] - n.pts[n.pts.length - 1][0], e.pts[i][1] - n.pts[n.pts.length - 1][1]) <= tol ? n.pts.length - 1 : -1;
      if (k < 0) continue;
      const dz = vertexZ(n)[k] - vz[i];
      if (Math.abs(dz) > ztol) out.push({ end, p: e.pts[i], n, dz, k });
      break;
    }
  }
  return out;
}

// Pente en % pour l'affichage (« 1,5 % »), vide si horizontal.
export function slopeText(e) {
  const p = Math.abs(slopeOf(e)) * 100;
  return p > 1e-6 ? `${String(Math.round(p * 100) / 100).replace('.', ',')} %` : '';
}

// Largeur en plan de l'objet (pour le double trait).
export function planWidth(m) {
  if (m.kind === 'pipe') return 0;
  if (m.kind === 'duct' && m.shape === 'round') return m.d;
  return m.w;
}
