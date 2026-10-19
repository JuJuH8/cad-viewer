// SPDX-License-Identifier: GPL-3.0-or-later
// Données électriques du projet (onglet « Données électriques » du bilan) : réseau, câbles, matériels,
// cheminement. Valeurs générales par défaut, à préciser par projet ; enregistrées dans le dessin
// (doc.header.elecData, XRECORD CV_DONNEES_ELEC du DXF). Seules les valeurs modifiées sont rangées.

export const ELEC_DEFAULTS = {
  network: {
    u0: 230,          // tension simple (V)
    un: 400,          // tension composée (V)
    earthing: 'TN-S', // schéma de liaison à la terre
    ik3: 10,          // courant de court-circuit triphasé maximal au point de raccordement (kA)
    ik1: 1,           // courant de court-circuit phase-neutre minimal au point de raccordement (kA)
    duMax: 4,         // chute de tension admise du point de raccordement à l'appareil (%)
  },
  cable: {
    material: 'Cu',   // Cu / Al
    insulation: 'PVC', // PVC / XLPE
    type: 'FE0 / TT', // désignation usuelle
    ambient: 30,      // température ambiante (°C)
  },
  equipment: {
    breakerMaker: '', // fabricant des disjoncteurs (à préciser)
    breakerCurve: 'B', // courbe par défaut des disjoncteurs de circuits
    icu: 10,          // pouvoir de coupure des disjoncteurs (kA)
    fuseType: 'gG',   // fusibles des alimentations de tableaux
    rcd: 30,          // sensibilité des DDR (mA)
    selRatio: 2,      // sélectivité : rapport minimal des calibres entre disjoncteurs amont / aval
    selRatioFuse: 1.6, // sélectivité : rapport minimal des calibres avec un fusible en amont
  },
  routing: {
    systems: 'CFO, TUB-CFO', // chemins de câbles et tubes empruntés par les circuits (codes séparés par des virgules)
    maxAccess: 15,    // distance maximale entre un appareil et le chemin de câbles (m)
    reservePct: 10,   // réserve de longueur (%)
    reserveEnd: 0.5,  // réserve de raccordement à chaque appareil et au tableau (m)
    fillMax: 50,      // remplissage maximal des chemins de câbles (% de la section utile)
    fillConduit: 33,  // remplissage maximal des tubes (% de la section intérieure)
    joinTol: 0.5,     // distance max. entre l'extrémité d'un tube et un chemin de câbles pour les relier (m)
    hBoard: 1.8,      // hauteur d'entrée des câbles dans les tableaux (m)
    hLight: 2.6,      // hauteur des luminaires (m)
    hSocket: 0.3,     // hauteur des prises (m)
    hOther: 1.1,      // hauteur des autres appareils (m)
  },
};

export const ELEC_LABELS = {
  network: ['Réseau', {
    u0: 'Tension simple U0 (V)', un: 'Tension composée Un (V)', earthing: 'Schéma de liaison à la terre',
    ik3: 'Ik3 max au raccordement (kA)', ik1: 'Ik1 min au raccordement (kA)', duMax: 'Chute de tension admise (%)',
  }],
  cable: ['Câbles', { material: 'Matériau (Cu / Al)', insulation: 'Isolation (PVC / XLPE)', type: 'Type de câble', ambient: 'Température ambiante (°C)' }],
  equipment: ['Matériels', {
    breakerMaker: 'Fabricant des disjoncteurs', breakerCurve: 'Courbe par défaut (B / C / D)', icu: 'Pouvoir de coupure (kA)',
    fuseType: 'Fusibles des alimentations', rcd: 'Sensibilité des DDR (mA)',
    selRatio: 'Sélectivité : rapport des calibres (disjoncteurs)', selRatioFuse: 'Sélectivité : rapport des calibres (fusible amont)',
  }],
  routing: ['Cheminement des câbles', {
    systems: 'Chemins et tubes empruntés (systèmes)', maxAccess: 'Distance max. appareil – chemin (m)',
    reservePct: 'Réserve de longueur (%)', reserveEnd: 'Réserve par raccordement (m)', fillMax: 'Remplissage max. des chemins (%)',
    fillConduit: 'Remplissage max. des tubes (%)', joinTol: 'Raccord tube – chemin de câbles (m)',
    hBoard: 'Hauteur d’entrée des tableaux (m)', hLight: 'Hauteur des luminaires (m)', hSocket: 'Hauteur des prises (m)', hOther: 'Hauteur des autres appareils (m)',
  }],
};

// Données du dessin complétées par les valeurs par défaut.
export function elecData(doc) {
  const saved = doc?.header?.elecData || {};
  const out = {};
  for (const [group, values] of Object.entries(ELEC_DEFAULTS)) out[group] = { ...values, ...(saved[group] || {}) };
  return out;
}

// Valeur saisie (texte) → valeur rangée : nombre pour les champs numériques ; null = valeur par défaut.
export function parseElecValue(group, key, text) {
  const def = ELEC_DEFAULTS[group]?.[key];
  if (def === undefined) return undefined;
  const t = String(text ?? '').trim();
  if (t === '') return null;
  if (typeof def === 'number') {
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return t;
}

// Nouvelles données du dessin après modification d'un champ (valeur par défaut → retirée). undefined si invalide.
export function withElecValue(doc, group, key, text) {
  const v = parseElecValue(group, key, text);
  if (v === undefined) return undefined;
  const saved = structuredClone(doc.header?.elecData || {});
  const g = { ...(saved[group] || {}) };
  if (v === null || v === ELEC_DEFAULTS[group][key]) delete g[key]; else g[key] = v;
  if (Object.keys(g).length) saved[group] = g; else delete saved[group];
  return saved;
}

export const routingSystems = (data) => String(data.routing.systems || '').split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
