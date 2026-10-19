// SPDX-License-Identifier: GPL-3.0-or-later
// Calculs d'installation électrique basse tension d'après la NIBT (SN 411000), alignée sur la CEI 60364 :
// courant d'emploi, protection, section (courants admissibles CEI 60364-5-52, cuivre / PVC), chute de tension,
// longueur maximale protégée contre les contacts indirects (schéma TN, méthode conventionnelle), DDR 30 mA.
// Fonctions pures : les résultats sont indicatifs et à vérifier par le projeteur (aucune garantie de conformité).
// Les tableaux numériques ci-dessous sont des valeurs techniques de la CEI 60364-5-52 (annexe B), largement publiées
// (catalogues de câbles, ouvrages) ; seules les valeurs nécessaires au calcul sont reprises, sans le texte de la norme.
// À contrôler avec l'édition en vigueur de la NIBT.

export const U0 = 230;               // tension simple (V)
export const UN = 400;               // tension composée (V)
export const RHO = 0.0225;           // résistivité du cuivre en service (Ω·mm²/m)
export const LAMBDA = 0.00008;       // réactance linéique (Ω/m)
export const DU_MAX = 4;             // chute de tension admise du point de raccordement à l'appareil (%)

export const SECTIONS = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240];
export const RATINGS = [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250];

// Modes de pose (CEI 60364-5-52, tableau B.52.1) — libellés courts.
export const METHODS = {
  A1: 'A1 — conducteurs sous conduit, paroi isolante',
  A2: 'A2 — câble sous conduit, paroi isolante',
  B1: 'B1 — conducteurs sous conduit, sur ou dans la maçonnerie',
  B2: 'B2 — câble sous conduit, sur ou dans la maçonnerie',
  C: 'C — câble fixé directement sur la paroi',
  E: 'E — câble sur chemin de câbles perforé ou à l’air libre',
};

// Courants admissibles (A), cuivre, isolation PVC, 30 °C, pour SECTIONS. Clé : nombre de conducteurs chargés.
// Source : CEI 60364-5-52, tableaux B.52.2 et B.52.4 (méthodes A1 à C), B.52.10 (méthode E).
const IZ = {
  2: {
    A1: [14.5, 19.5, 26, 34, 46, 61, 80, 99, 119, 151, 182, 210, 240, 273, 321],
    A2: [14, 18.5, 25, 32, 43, 57, 75, 92, 110, 139, 167, 192, 219, 248, 291],
    B1: [17.5, 24, 32, 41, 57, 76, 101, 125, 151, 192, 232, 269, 309, 353, 415],
    B2: [16.5, 23, 30, 38, 52, 69, 90, 111, 133, 168, 201, 232, 265, 300, 351],
    C: [19.5, 27, 36, 46, 63, 85, 112, 138, 168, 213, 258, 299, 344, 392, 461],
    E: [22, 30, 40, 51, 70, 94, 119, 148, 180, 232, 282, 328, 379, 434, 514],
  },
  3: {
    A1: [13.5, 18, 24, 31, 42, 56, 73, 89, 108, 136, 164, 188, 216, 245, 286],
    A2: [13, 17.5, 23, 29, 39, 52, 68, 83, 99, 125, 150, 172, 196, 223, 261],
    B1: [15.5, 21, 28, 36, 50, 68, 89, 110, 134, 171, 207, 239, 275, 314, 370],
    B2: [15, 20, 27, 34, 46, 62, 80, 99, 118, 149, 179, 206, 236, 268, 313],
    C: [17.5, 24, 32, 41, 57, 76, 96, 119, 144, 184, 223, 259, 299, 341, 403],
    E: [18.5, 25, 34, 43, 60, 80, 101, 126, 153, 196, 238, 276, 319, 364, 430],
  },
};

// Facteur de correction de température ambiante (PVC, tableau B.52.14).
const K_TEMP = { 10: 1.22, 15: 1.17, 20: 1.12, 25: 1.06, 30: 1, 35: 0.94, 40: 0.87, 45: 0.79, 50: 0.71, 55: 0.61, 60: 0.5 };
// Facteurs de groupement (tableau B.52.17) : câbles jointifs (modes A à C) / couche simple sur chemin perforé (E).
const K_GROUP = {
  bunched: [[1, 1], [2, 0.8], [3, 0.7], [4, 0.65], [5, 0.6], [6, 0.57], [7, 0.54], [8, 0.52], [9, 0.5], [12, 0.45], [16, 0.41], [20, 0.38]],
  tray: [[1, 1], [2, 0.88], [3, 0.82], [4, 0.77], [5, 0.75], [6, 0.73], [7, 0.73], [8, 0.72], [9, 0.72]],
};

export function tempFactor(ambient = 30) {
  const keys = Object.keys(K_TEMP).map(Number).sort((a, b) => a - b);
  const k = keys.find((t) => t >= ambient) ?? keys[keys.length - 1];
  return K_TEMP[k];
}

export function groupFactor(n = 1, method = 'B2') {
  const t = method === 'E' ? K_GROUP.tray : K_GROUP.bunched;
  let f = 1;
  for (const [count, k] of t) if (n >= count) f = k;
  return f;
}

// Courant admissible corrigé (A).
export function izOf(section, method = 'B2', loaded = 2, { ambient = 30, group = 1 } = {}) {
  const i = SECTIONS.indexOf(section);
  const col = IZ[loaded >= 3 ? 3 : 2][method] || IZ[2].B2;
  if (i < 0) return 0;
  return col[i] * tempFactor(ambient) * groupFactor(group, method);
}

export function ratingFor(ib, min = 6) {
  return RATINGS.find((r) => r >= Math.max(ib, min)) ?? RATINGS[RATINGS.length - 1];
}

// Chute de tension (%) : monophasé b = 2 sur U0, triphasé b = √3 sur Un.
export function voltageDrop({ ib, len, s, ph = 1, cosphi = 1 }) {
  if (!(len > 0) || !(s > 0)) return 0;
  const sin = Math.sqrt(Math.max(0, 1 - cosphi * cosphi));
  const z = (RHO / s) * cosphi + LAMBDA * sin;
  return ph === 3 ? (Math.sqrt(3) * len * ib * z * 100) / UN : (2 * len * ib * z * 100) / U0;
}

// Longueur maximale protégée (m) : coupure en ≤ 0,4 s en schéma TN, méthode conventionnelle (tension 0,8 U0,
// conducteur de protection de même section, courant de fonctionnement magnétique : B = 5 In, C = 10 In, D = 20 In).
export function maxLength({ s, rating, curve = 'B', m = 1 }) {
  const ia = rating * ({ B: 5, C: 10, D: 20 }[curve] || 5);
  return (0.8 * U0 * s) / (RHO * (1 + m) * ia);
}

// Types de circuits : facteur de puissance, protection minimale, section minimale, DDR exigé, simultanéité.
export const CIRCUIT_TYPES = {
  LUMIERE: { label: 'Lumière', cosphi: 0.95, minIn: 10, minS: 1.5, ks: () => 1 },
  PRISES: { label: 'Prises', cosphi: 0.9, minIn: 13, minS: 1.5, rcd: true, ks: (n) => (n > 0 ? Math.min(1, 0.1 + 0.9 / n) : 1) },
  FORCE: { label: 'Force (appareils fixes)', cosphi: 0.85, minIn: 10, minS: 1.5, ks: () => 1 },
  STORES: { label: 'Stores', cosphi: 0.8, minIn: 10, minS: 1.5, ks: () => 1 },
  CHAUFFAGE: { label: 'Chauffage', cosphi: 1, minIn: 10, minS: 1.5, ks: () => 1 },
  SECOURS: { label: 'Éclairage de secours', cosphi: 0.9, minIn: 10, minS: 1.5, ks: () => 1 },
  TABLEAU: { label: 'Tableau secondaire', cosphi: 0.9, minIn: 16, minS: 2.5, ks: () => 1 },
};

export const fmtSection = (s) => String(s).replace('.', ',');

// Types d'alimentation : réseau normal, secours, alimentation sans interruption. Chacun a son calque de fils et
// d'étiquettes (couleur du calque, à adapter dans le gestionnaire des calques).
export const SUPPLIES = {
  N: { label: 'Réseau normal', short: 'Normal', layer: 'ELE-FILS-NORMAL', color: 1 },
  S: { label: 'Secours', short: 'Secours', layer: 'ELE-FILS-SECOURS', color: 3 },
  ASI: { label: 'Alimentation sans interruption (ASI)', short: 'ASI', layer: 'ELE-FILS-ASI', color: 5 },
};
// Alimentation d'un circuit : la sienne, sinon celle du tableau, sinon secours pour l'éclairage de secours, sinon normal.
export function supplyOf(board, def) {
  const k = def?.supply || board?.elec?.supply || (def?.type === 'SECOURS' ? 'S' : 'N');
  return SUPPLIES[k] ? k : 'N';
}

// Dimensionne un circuit. Entrée : { type, p (W installés), n (prises), ph (1 ou 3), len (m), method, ambient,
// group, ks, rating (A), curve, s (mm²), upstream (% de chute en amont), duMax }. Les valeurs données sont imposées ;
// les autres sont choisies : protection (In ≥ Ib), section (Iz ≥ In, chute de tension, longueur protégée).
export function sizeCircuit(c) {
  const t = CIRCUIT_TYPES[c.type] || CIRCUIT_TYPES.FORCE;
  const ph = c.ph === 3 ? 3 : 1;
  const ks = c.ks ?? t.ks(c.n || 0);
  const pabs = (c.p || 0) * ks;
  const cosphi = c.cosphi ?? t.cosphi;
  const ib = ph === 3 ? pabs / (Math.sqrt(3) * UN * cosphi) : pabs / (U0 * cosphi);
  const rating = c.rating ?? ratingFor(ib, Math.max(t.minIn, c.minIn || 0)); // minIn : sélectivité avec l'aval
  const curve = c.curve || 'B';
  const method = c.method || 'B2';
  const loaded = ph === 3 ? 3 : 2;
  const opt = { ambient: c.ambient ?? 30, group: c.group ?? 1 };
  const len = c.len || 0;
  const upstream = c.upstream || 0;
  const duMax = c.duMax ?? DU_MAX;
  let s = c.s;
  if (s == null) {
    s = SECTIONS.find((x) => x >= t.minS && izOf(x, method, loaded, opt) >= rating) ?? SECTIONS[SECTIONS.length - 1];
    // Section augmentée pour la chute de tension, puis pour la longueur protégée.
    while (upstream + voltageDrop({ ib, len, s, ph, cosphi }) > duMax && s < SECTIONS[SECTIONS.length - 1]) s = SECTIONS[SECTIONS.indexOf(s) + 1];
    while (len > maxLength({ s, rating, curve }) && s < SECTIONS[SECTIONS.length - 1]) s = SECTIONS[SECTIONS.indexOf(s) + 1];
  }
  const iz = izOf(s, method, loaded, opt);
  const du = voltageDrop({ ib, len, s, ph, cosphi });
  const lmax = maxLength({ s, rating, curve });
  const warnings = [];
  if (ib > rating + 1e-9) warnings.push(`courant d’emploi ${ib.toFixed(1)} A supérieur à la protection ${rating} A`);
  if (iz + 1e-9 < rating) warnings.push(`section ${fmtSection(s)} mm² insuffisante : Iz ${iz.toFixed(1)} A < In ${rating} A`);
  if (upstream + du > duMax + 1e-9) warnings.push(`chute de tension ${(upstream + du).toFixed(2)} % > ${duMax} %`);
  if (len > lmax) warnings.push(`longueur ${len.toFixed(0)} m > longueur protégée ${lmax.toFixed(0)} m (courbe ${curve})`);
  return {
    type: c.type, ks, pabs, cosphi, ib, rating, curve, s, iz, method, ph, len,
    du, duTotal: upstream + du, lmax, rcd: !!t.rcd || !!c.rcd,
    cable: `${ph === 3 ? 5 : 3}×${fmtSection(s)} mm²`,
    protection: `${curve === 'gG' ? 'gG ' : curve}${rating} A${t.rcd || c.rcd ? ' + DDR 30 mA' : ''}`,
    warnings, ok: !warnings.length,
  };
}

// Alimentation d'un tableau : puissance des circuits (après simultanéité), facteur du tableau, protection et câble.
export function sizeBoard(results, { ks = 0.8, ph = 3, len = 0, method = 'C', upstream = 0, curve = 'C', duMax = DU_MAX, minIn = 0 } = {}) {
  const p = results.reduce((s, r) => s + r.pabs, 0);
  return { p, ...sizeCircuit({ type: 'TABLEAU', p, ks, ph, len, method, upstream, curve, duMax, minIn }) };
}
