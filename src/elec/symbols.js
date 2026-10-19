// SPDX-License-Identifier: GPL-3.0-or-later
// Symboles électriques en plan (d'après la CEI 60617 / cahier electrosuisse « Symboles de l'électrotechnique »),
// classés par catégorie, chacune avec ses calques (nomenclature de l'application : ELE-<domaine>-<contenu>).
// Un symbole est un bloc dessiné à la taille 1 (inséré à l'échelle de la taille voulue) avec deux attributs :
// CIRCUIT (n° d'alimentation) et INFO (puissance, type).

import * as G from '../core/geom.js';

// Catégories : calque des appareils, couleur, calque des textes, calque de la légende, type de circuit par défaut.
export const CATEGORIES = {
  LUMIERE: { label: 'Lumière', layer: 'ELE-LUMIERE-APPAREILS', color: 130, text: 'ELE-LUMIERE-TEXTES', legend: 'ELE-LUMIERE-LEGENDE', circuit: 'LUMIERE' },
  COMMANDE: { label: 'Commandes d’éclairage', layer: 'ELE-COMMANDES-APPAREILS', color: 130, text: 'ELE-LUMIERE-TEXTES', legend: 'ELE-LUMIERE-LEGENDE', circuit: null },
  ECL_SEC: { label: 'Éclairage de secours', layer: 'ELE-SECOURS-APPAREILS', color: 100, text: 'ELE-SECOURS-TEXTES', legend: 'ELE-SECOURS-LEGENDE', circuit: 'SECOURS' },
  FORCE: { label: 'Prises et force', layer: 'ELE-FORCE-APPAREILS', color: 10, text: 'ELE-FORCE-TEXTES', legend: 'ELE-FORCE-LEGENDE', circuit: 'PRISES' },
  STORES: { label: 'Stores', layer: 'ELE-STORES-APPAREILS', color: 242, text: 'ELE-STORES-TEXTES', legend: 'ELE-STORES-LEGENDE', circuit: 'STORES' },
  TABLEAUX: { label: 'Tableaux', layer: 'ELE-TABLEAUX-APPAREILS', color: 12, text: 'ELE-TABLEAUX-TEXTES', legend: 'ELE-TABLEAUX-LEGENDE', circuit: 'TABLEAU' },
  TT_INFO: { label: 'Télécommunication et informatique', layer: 'ELE-INFORMATIQUE-APPAREILS', color: 90, text: 'ELE-INFORMATIQUE-TEXTES', legend: 'ELE-INFORMATIQUE-LEGENDE', circuit: null },
  TV_AUDIO: { label: 'TV et audio', layer: 'ELE-TV-AUDIO-APPAREILS', color: 220, text: 'ELE-TV-AUDIO-TEXTES', legend: 'ELE-TV-AUDIO-LEGENDE', circuit: null },
  INTERPHONE: { label: 'Interphonie', layer: 'ELE-INTERPHONIE-APPAREILS', color: 42, text: 'ELE-INTERPHONIE-TEXTES', legend: 'ELE-INTERPHONIE-LEGENDE', circuit: null },
  DI: { label: 'Détection incendie', layer: 'ELE-DETECTION-INCENDIE-APPAREILS', color: 40, text: 'ELE-DETECTION-INCENDIE-TEXTES', legend: 'ELE-DETECTION-INCENDIE-LEGENDE', circuit: null },
  SECURITE: { label: 'Sécurité et intrusion', layer: 'ELE-INTRUSION-APPAREILS', color: 140, text: 'ELE-INTRUSION-TEXTES', legend: 'ELE-INTRUSION-LEGENDE', circuit: null },
  SURVEILLANCE: { label: 'Vidéosurveillance', layer: 'ELE-VIDEO-APPAREILS', color: 210, text: 'ELE-VIDEO-TEXTES', legend: 'ELE-VIDEO-LEGENDE', circuit: null },
  ACCES: { label: 'Contrôle d’accès', layer: 'ELE-CONTROLE-ACCES-APPAREILS', color: 150, text: 'ELE-CONTROLE-ACCES-TEXTES', legend: 'ELE-CONTROLE-ACCES-LEGENDE', circuit: null },
  EQUIPOT: { label: 'Mise à la terre et équipotentialité', layer: 'ELE-TERRE-APPAREILS', color: 210, text: 'ELE-TERRE-TEXTES', legend: 'ELE-TERRE-LEGENDE', circuit: null },
  CFA: { label: 'Courant faible divers', layer: 'ELE-CFA-APPAREILS', color: 42, text: 'ELE-CFA-TEXTES', legend: 'ELE-CFA-LEGENDE', circuit: null },
  CHEMINEMENT: { label: 'Boîtes et cheminement', layer: 'ELE-BOITES-APPAREILS', color: 7, text: 'ELE-BOITES-TEXTES', legend: 'ELE-BOITES-LEGENDE', circuit: null },
};

// --- primitives (taille 1, centrées sur le point d'insertion, couleur DuBloc) ---------------

const L = (a, b) => ({ type: 'LINE', layer: '0', color: 0, p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
const C = (c, r) => ({ type: 'CIRCLE', layer: '0', color: 0, c: [c[0], c[1], 0], r });
const A = (c, r, a0, a1) => ({ type: 'ARC', layer: '0', color: 0, c: [c[0], c[1], 0], r, a0, a1 });
const P = (pts, closed = true) => ({ type: 'LWPOLYLINE', layer: '0', color: 0, pts: pts.map((p) => [p[0], p[1]]), bulges: pts.map(() => 0), closed, z: 0, width: 0 });
const R = (cx, cy, w, h) => P([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]);
const T = (p, h, text) => ({ type: 'TEXT', layer: '0', color: 0, p: [p[0], p[1], 0], h, rot: 0, text, align: 'center', valign: 'middle', wf: 1 });
const F = (pts) => ({ type: 'HATCH', layer: '0', color: 0, solid: true, pattern: 'SOLID', loops: [pts.map((p) => [p[0], p[1]])], lines: [], z: 0 });
const disk = (c, r, n = 16) => F(Array.from({ length: n }, (_, i) => G.polar(c, (i * 2 * Math.PI) / n, r)));
const cross = (c, r) => [L(G.polar(c, Math.PI / 4, r), G.polar(c, (5 * Math.PI) / 4, r)), L(G.polar(c, (3 * Math.PI) / 4, r), G.polar(c, -Math.PI / 4, r))];
const lamp = (c, r) => [C(c, r), ...cross(c, r)];
const arrow = (a, b, s = 0.12) => {
  const ang = G.angleOf(a, b);
  return [L(a, b), F([b, G.polar(b, ang + Math.PI * 0.85, s), G.polar(b, ang - Math.PI * 0.85, s)])];
};
// Interrupteur : point de pivot, levier incliné, petite barre en bout (une par levier).
const lever = (ang, len = 0.55) => {
  const e = G.polar([0, 0], ang, len);
  return [L(G.polar([0, 0], ang, 0.12), e), L(e, G.polar(e, ang + Math.PI / 2, 0.15))];
};
// Boîte de dérivation encastrée / apparente : moitié droite pleine, point dans la moitié gauche (légende des plans).
const jbox = (w, h) => [R(0, 0, w, h), F([[0, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [0, h / 2]]), disk([-w / 4, 0], Math.min(w, h) * 0.07, 10)];
// Montée / descente : petit cercle, trait incliné fléché (sortant pour une montée, entrant pour une descente).
const RISE_R = 0.12, RISE_DIR = Math.atan2(0.25, 0.6);
const head = (tip, ang, s = 0.14) => F([tip, G.polar(tip, ang + Math.PI * 0.86, s), G.polar(tip, ang - Math.PI * 0.86, s)]);
const rise = () => [L(G.polar([0, 0], RISE_DIR, RISE_R), G.polar([0, 0], RISE_DIR, 0.75)), head(G.polar([0, 0], RISE_DIR, 0.75), RISE_DIR)];
const drop = () => [L(G.polar([0, 0], RISE_DIR + Math.PI, 0.75), G.polar([0, 0], RISE_DIR + Math.PI, RISE_R)), head(G.polar([0, 0], RISE_DIR + Math.PI, RISE_R), RISE_DIR)];
const socket = (r = 0.4) => [A([0, 0], r, 0, Math.PI), L([-r, 0], [r, 0]), L([0, 0], [0, -r])];

// Symboles : libellé, catégorie, dessin, puissance par défaut (W), phases, type de circuit, nombre de prises.
export const SYMBOLS = {
  LUM: { label: 'Luminaire', cat: 'LUMIERE', p: 40, draw: () => lamp([0, 0], 0.5) },
  SPOT: { label: 'Spot encastré', cat: 'LUMIERE', p: 10, draw: () => [...lamp([0, 0], 0.3), C([0, 0], 0.42)] },
  LUM_MUR: { label: 'Applique murale', cat: 'LUMIERE', p: 20, draw: () => [...lamp([0, 0.1], 0.38), L([-0.5, -0.5], [0.5, -0.5]), L([0, -0.28], [0, -0.5])] },
  LUM_LIN: { label: 'Luminaire linéaire (LED, tube)', cat: 'LUMIERE', p: 35, draw: () => [R(0, 0, 1.6, 0.36), L([-0.8, 0], [0.8, 0]), L([-0.55, -0.18], [-0.55, 0.18]), L([0.55, -0.18], [0.55, 0.18])] },
  LUM_SUSP: { label: 'Luminaire suspendu', cat: 'LUMIERE', p: 40, draw: () => [...lamp([0, 0], 0.4), L([0, 0.4], [0, 0.65]), L([-0.15, 0.65], [0.15, 0.65])] },
  LUM_SEC: { label: 'Luminaire de secours', cat: 'ECL_SEC', p: 5, draw: () => [...lamp([0, 0], 0.4), R(0, 0, 1.1, 1.1)] },
  SORTIE: { label: 'Pictogramme de sortie de secours', cat: 'ECL_SEC', p: 5, draw: () => [R(0, 0, 1.3, 0.6), ...arrow([-0.4, 0], [0.4, 0])] },
  INT: { label: 'Interrupteur', cat: 'COMMANDE', p: 0, draw: () => [C([0, 0], 0.12), ...lever(Math.PI / 3)] },
  INT_DBL: { label: 'Interrupteur double (2 allumages)', cat: 'COMMANDE', p: 0, draw: () => [C([0, 0], 0.12), ...lever(Math.PI / 4), ...lever(Math.PI / 2.2)] },
  INT_VV: { label: 'Interrupteur va-et-vient', cat: 'COMMANDE', p: 0, draw: () => [C([0, 0], 0.12), ...lever(Math.PI / 3), ...lever((4 * Math.PI) / 3)] },
  POUSSOIR: { label: 'Bouton-poussoir', cat: 'COMMANDE', p: 0, draw: () => [C([0, 0], 0.28), C([0, 0], 0.1)] },
  VARIATEUR: { label: 'Variateur', cat: 'COMMANDE', p: 0, draw: () => [C([0, 0], 0.12), ...lever(Math.PI / 3), ...arrow([-0.35, -0.3], [0.35, 0.25], 0.1)] },
  DETECTEUR: { label: 'Détecteur de présence', cat: 'COMMANDE', p: 0, draw: () => [R(0, 0, 0.75, 0.75), T([0, 0], 0.4, 'D')] },
  PR1: { label: 'Prise T13', cat: 'FORCE', p: 200, outlets: 1, draw: () => socket() },
  PR2: { label: 'Prise double T13', cat: 'FORCE', p: 300, outlets: 2, draw: () => [...socket(), T([-0.55, 0.3], 0.3, '2')] },
  PR3: { label: 'Prise triple T13', cat: 'FORCE', p: 400, outlets: 3, draw: () => [...socket(), T([-0.55, 0.3], 0.3, '3')] },
  PR_ETANCHE: { label: 'Prise étanche (IP55)', cat: 'FORCE', p: 200, outlets: 1, draw: () => [...socket(), F([[-0.4, 0], ...Array.from({ length: 9 }, (_, i) => G.polar([0, 0], (i * Math.PI) / 8, 0.4)), [0.4, 0]])] },
  PR_FORCE: { label: 'Prise force 400 V (T25 / CEE)', cat: 'FORCE', p: 5000, ph: 3, circuit: 'FORCE', draw: () => [...socket(), L([-0.12, -0.12], [0.12, -0.06]), L([-0.12, -0.22], [0.12, -0.16]), L([-0.12, -0.32], [0.12, -0.26])] },
  SORTIE_CABLE: { label: 'Sortie de câble (raccordement fixe)', cat: 'FORCE', p: 1000, circuit: 'FORCE', draw: () => [R(0, 0.1, 0.5, 0.5), L([0, -0.15], [0, -0.5]), ...cross([0, 0.1], 0.22)] },
  BOITE: { label: 'Boîte de dérivation', cat: 'FORCE', p: 0, node: true, draw: () => [disk([0, 0], 0.14), C([0, 0], 0.14)] },
  MOTEUR: { label: 'Moteur', cat: 'FORCE', p: 1500, ph: 3, circuit: 'FORCE', draw: () => [C([0, 0], 0.45), T([0, 0], 0.45, 'M')] },
  CHAUFFE_EAU: { label: 'Chauffe-eau', cat: 'FORCE', p: 3000, circuit: 'FORCE', draw: () => [C([0, 0], 0.45), T([0, 0], 0.42, 'B')] },
  CUISINIERE: { label: 'Cuisinière', cat: 'FORCE', p: 7000, ph: 3, circuit: 'FORCE', draw: () => [R(0, 0, 0.9, 0.9), C([-0.2, -0.2], 0.12), C([0.2, -0.2], 0.12), C([-0.2, 0.2], 0.12), C([0.2, 0.2], 0.12)] },
  RADIATEUR_EL: { label: 'Chauffage électrique', cat: 'FORCE', p: 1000, circuit: 'CHAUFFAGE', draw: () => [R(0, 0, 1.2, 0.32), ...[-0.4, -0.2, 0, 0.2, 0.4].map((x) => L([x, -0.16], [x, 0.16]))] },
  APPAREIL: { label: 'Appareil raccordé', cat: 'FORCE', p: 1000, circuit: 'FORCE', draw: () => [R(0, 0, 0.8, 0.8), L([-0.4, -0.4], [0.4, 0.4])] },
  STORE_CMD: { label: 'Commande de store', cat: 'STORES', p: 0, draw: () => [C([0, 0], 0.32), F([[-0.12, 0.05], [0.12, 0.05], [0, 0.22]]), F([[-0.12, -0.05], [0.12, -0.05], [0, -0.22]])] },
  STORE_MOT: { label: 'Moteur de store', cat: 'STORES', p: 150, draw: () => [C([0, 0], 0.42), T([0, 0.02], 0.36, 'M'), F([[0.48, 0.05], [0.64, 0.05], [0.56, 0.22]]), F([[0.48, -0.05], [0.64, -0.05], [0.56, -0.22]])] },
  TABLEAU: { label: 'Tableau électrique', cat: 'TABLEAUX', p: 0, board: true, draw: () => [R(0, 0, 1.6, 0.6), L([-0.8, -0.3], [0.8, 0.3]), F([[-0.8, -0.3], [0.8, -0.3], [0.8, 0.3]])] },
  RJ45: { label: 'Prise informatique (RJ45)', cat: 'TT_INFO', p: 0, draw: () => [R(0, 0.1, 0.8, 0.45), T([0, 0.1], 0.26, 'TT'), L([0, -0.12], [0, -0.45])] },
  TEL: { label: 'Prise téléphone', cat: 'TT_INFO', p: 0, draw: () => [R(0, 0.1, 0.8, 0.45), T([0, 0.1], 0.26, 'TP'), L([0, -0.12], [0, -0.45])] },
  WIFI: { label: 'Point d’accès sans fil', cat: 'TT_INFO', p: 0, draw: () => [C([0, 0], 0.12), A([0, 0], 0.28, Math.PI / 4, (3 * Math.PI) / 4), A([0, 0], 0.45, Math.PI / 4, (3 * Math.PI) / 4)] },
  TV: { label: 'Prise TV', cat: 'TV_AUDIO', p: 0, draw: () => [C([0, 0], 0.42), T([0, 0], 0.3, 'TV')] },
  HP: { label: 'Haut-parleur', cat: 'TV_AUDIO', p: 0, draw: () => [R(-0.15, 0, 0.25, 0.4), P([[-0.02, -0.2], [0.35, -0.45], [0.35, 0.45], [-0.02, 0.2]])] },
  INTERPHONE: { label: 'Poste d’interphone', cat: 'INTERPHONE', p: 0, draw: () => [R(0, 0, 0.6, 0.85), C([0, 0.18], 0.12), L([-0.15, -0.2], [0.15, -0.2])] },
  DF: { label: 'Détecteur de fumée', cat: 'DI', p: 0, draw: () => [R(0, 0, 0.8, 0.8), T([0, 0], 0.32, 'DF')] },
  DM: { label: 'Déclencheur manuel', cat: 'DI', p: 0, draw: () => [R(0, 0, 0.7, 0.7), disk([0, 0], 0.16)] },
  SIRENE: { label: 'Sirène / avertisseur', cat: 'DI', p: 0, draw: () => [A([0, -0.15], 0.42, 0, Math.PI), L([-0.42, -0.15], [0.42, -0.15]), L([-0.15, -0.15], [-0.15, -0.35]), L([0.15, -0.15], [0.15, -0.35])] },
  DETECT_INTRUSION: { label: 'Détecteur d’intrusion', cat: 'SECURITE', p: 0, draw: () => [R(0, 0, 0.75, 0.75), T([0, 0], 0.3, 'IR')] },
  CONTACT_PORTE: { label: 'Contact de porte', cat: 'SECURITE', p: 0, draw: () => [R(-0.2, 0, 0.3, 0.5), R(0.2, 0, 0.3, 0.5)] },
  CAMERA: { label: 'Caméra', cat: 'SURVEILLANCE', p: 0, draw: () => [R(-0.12, 0, 0.6, 0.38), P([[0.18, 0], [0.45, 0.2], [0.45, -0.2]])] },
  LECTEUR: { label: 'Lecteur de badge', cat: 'ACCES', p: 0, draw: () => [R(0, 0, 0.6, 0.85), T([0, 0], 0.26, 'LB')] },
  GACHE: { label: 'Gâche électrique', cat: 'ACCES', p: 0, draw: () => [R(0, 0, 0.35, 0.8), L([-0.17, 0.2], [0.17, 0.2]), L([-0.17, -0.2], [0.17, -0.2])] },
  TERRE: { label: 'Mise à la terre / liaison équipotentielle', cat: 'EQUIPOT', p: 0, draw: () => [L([0, 0.45], [0, 0]), L([-0.4, 0], [0.4, 0]), L([-0.26, -0.15], [0.26, -0.15]), L([-0.12, -0.3], [0.12, -0.3])] },
  CFA_APP: { label: 'Appareil courant faible', cat: 'CFA', p: 0, draw: () => [R(0, 0, 0.8, 0.6), T([0, 0], 0.28, 'CF')] },
  // Boîtes et cheminement : nœuds du réseau de tubes (un tube va d'une boîte, d'un appareil ou d'un tableau à un autre).
  // onTray : boîte posée sur un chemin de câbles (relie les tubes au chemin).
  BD_ENC: { label: 'Boîte de dérivation encastrée (APP / ENC)', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => jbox(0.5, 0.7) },
  BD_MUR: { label: 'Boîte de dérivation murale (APP / ENC)', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => jbox(0.6, 0.36) },
  BD_CDC: { label: 'Boîte de dérivation sur CDC', cat: 'CHEMINEMENT', p: 0, node: true, onTray: true, draw: () => [R(0, 0, 0.7, 0.7), F([[-0.35, -0.35], [0.35, 0.35], [-0.35, 0.35]]), disk([0.18, -0.18], 0.05, 10)] },
  BOITE_SOL: { label: 'Boîte de sol équipée', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [R(0, 0, 0.8, 0.8), L([0, -0.4], [0, 0.4]), L([-0.4, 0], [0.4, 0]), F([[-0.32, 0.08], [-0.08, 0.08], [-0.08, 0.32], [-0.32, 0.32]]), F([[0.08, -0.32], [0.32, -0.32], [0.32, -0.08], [0.08, -0.08]])] },
  BOITE_SOL_NE: { label: 'Boîte de sol non équipée', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [R(0, 0, 0.8, 0.8), L([0, -0.4], [0, 0.4]), L([-0.4, 0], [0.4, 0])] },
  POTELET: { label: 'Potelet', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [R(0, 0, 0.5, 0.5), ...cross([0, 0], 0.35)] },
  PERCHE: { label: 'Perche', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [R(0, 0, 0.5, 0.5), ...cross([0, 0], 0.35), C([0, 0], 0.08)] },
  MONTEE: { label: 'Montée', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [C([0, 0], RISE_R), ...rise()] },
  DESCENTE: { label: 'Descente', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [C([0, 0], RISE_R), ...drop()] },
  MONTEE_DESC: { label: 'Montée / descente', cat: 'CHEMINEMENT', p: 0, node: true, draw: () => [C([0, 0], RISE_R), ...rise(), ...drop()] },
};

// Attributs des symboles (coordonnées du bloc, taille 1) : à droite du symbole, horizontaux.
export const ATTRS = [
  { tag: 'CIRCUIT', prompt: 'Circuit', p: [0.7, 0.32], h: 0.32 },
  { tag: 'INFO', prompt: 'Puissance / type', p: [0.7, -0.32], h: 0.28 },
];

export const blockNameOf = (key) => `CV_ELEC_${key}`;

// Abscisse des attributs : juste à droite du dessin du symbole (les symboles larges les repoussent).
const offsets = new Map();
export function attrOffset(key) {
  if (offsets.has(key)) return offsets.get(key);
  let max = 0.5;
  for (const e of SYMBOLS[key]?.draw() || []) {
    if (e.type === 'LINE') max = Math.max(max, e.p1[0], e.p2[0]);
    else if (e.type === 'CIRCLE' || e.type === 'ARC') max = Math.max(max, e.c[0] + e.r);
    else if (e.type === 'LWPOLYLINE') for (const q of e.pts) max = Math.max(max, q[0]);
    else if (e.type === 'HATCH') for (const q of e.loops[0]) max = Math.max(max, q[0]);
  }
  const x = max + 0.2;
  offsets.set(key, x);
  return x;
}

// Crée (une fois) le bloc d'un symbole ; renvoie son nom.
export function ensureSymbolBlock(doc, key) {
  const name = blockNameOf(key);
  if (!doc.blocks.has(name)) {
    const s = SYMBOLS[key];
    const attdefs = ATTRS.map((a) => ({
      type: 'ATTDEF', layer: '0', color: 0, p: [attrOffset(key), a.p[1], 0], h: a.h, rot: 0, text: '', tag: a.tag, prompt: a.prompt,
      align: 'left', valign: 'middle', wf: 1, invisible: false,
    }));
    doc.blocks.set(name, { name, base: [0, 0, 0], flags: 0, xref: false, entities: [...s.draw(), ...attdefs] });
  }
  return name;
}

// Calque d'une catégorie (créé avec la couleur de la norme s'il manque, dans la transaction en cours).
export function ensureCategoryLayer(doc, cat, kind = 'layer') {
  const c = CATEGORIES[cat];
  const name = c[kind];
  if (!doc.layers.has(name)) doc.addLayer(name, { color: kind === 'layer' ? c.color : 9 });
  return name;
}

export const fmtPower = (p) => (p > 0 ? (p >= 1000 ? `${(p / 1000).toFixed(1).replace('.', ',')} kW` : `${Math.round(p)} W`) : '');

// Valeurs des attributs d'un appareil.
export function attributeValues(elec) {
  const s = SYMBOLS[elec.sym];
  if (s?.board) return { CIRCUIT: elec.board || '', INFO: elec.parent ? `← ${elec.parent}` : '' };
  return { CIRCUIT: elec.circuit ? (elec.showBoard && elec.board ? `${elec.board}.${elec.circuit}` : elec.circuit) : '', INFO: elec.desc || fmtPower(elec.p) };
}

// Attributs d'un bloc de bibliothèque (étiquettes CN_* de certaines bibliothèques du marché, reconnues pour l'interopérabilité : CN_LIB_SUP au-dessus du symbole, CN_LIB_INF
// en dessous, CN_TAB_NO dans le symbole de tableau…). tags : étiquettes présentes dans le bloc. Les
// attributs non gérés (fournisseur, position…) gardent leur valeur.
export function libraryValues(elec, tags) {
  const v = attributeValues(elec);
  const out = { CN_LIB_INF: v.INFO };
  if (SYMBOLS[elec.sym]?.board && tags.has('CN_TAB_NO')) { out.CN_TAB_NO = v.CIRCUIT; out.CN_LIB_SUP = ''; } else out.CN_LIB_SUP = v.CIRCUIT;
  if (elec.desc) out.CN_DESIGN = elec.desc;
  if (elec.p > 0) out.CN_PUISSANCE = fmtPower(elec.p);
  // Bloc sans étiquettes CN_* : attributs CIRCUIT / INFO s'il en a.
  return { CIRCUIT: v.CIRCUIT, INFO: v.INFO, ...out };
}

// Attributs (textes) d'une insertion, sur le calque des textes : toujours horizontaux et à droite du symbole,
// quelle que soit sa rotation (lisibles sur le plan).
export function attribsFor(ins, elec, textLayer) {
  const vals = attributeValues(elec);
  const s = ins.sx ?? 1;
  const x = attrOffset(elec.sym);
  return ATTRS.map((a) => ({
    type: 'TEXT', layer: textLayer, color: 256, tag: a.tag, p: [ins.p[0] + x * s, ins.p[1] + a.p[1] * s, 0], h: a.h * s, rot: 0,
    text: vals[a.tag] ?? '', align: 'left', valign: 'middle', wf: 1,
  }));
}

// Nouvelle insertion d'un symbole (objet prêt pour doc.add) avec ses données électriques.
// preview : aperçu pendant la pose (les calques ne sont pas créés : aucune opération dans l'historique).
export function symbolInsert(doc, key, p, { size = 250, rot = 0, elec = {}, preview = false } = {}) {
  const s = SYMBOLS[key];
  if (!s) throw new Error(`symbole inconnu : ${key}`);
  const name = ensureSymbolBlock(doc, key);
  const layer = preview ? CATEGORIES[s.cat].layer : ensureCategoryLayer(doc, s.cat);
  const textLayer = preview ? CATEGORIES[s.cat].text : ensureCategoryLayer(doc, s.cat, 'text');
  const data = {
    sym: key, cat: s.cat, p: s.p || 0, ph: s.ph || 1,
    ...(s.board ? { kind: 'board', board: 'TD', circuits: [] } : {}),
    ...elec,
  };
  const ins = { type: 'INSERT', name, layer, color: 256, space: doc.currentSpace || 'model', p: [p[0], p[1], 0], sx: size, sy: size, sz: size, rot, cols: 1, rows: 1, dc: 0, dr: 0 };
  ins.elec = data;
  ins.attribs = attribsFor(ins, data, textLayer);
  return ins;
}

// Attributs remis à jour après une modification des données (circuit, puissance…).
export function refreshAttribs(e) {
  const s = SYMBOLS[e.elec?.sym];
  if (!s) return e;
  if (e.elec.block) {
    const vals = libraryValues(e.elec, new Set((e.attribs || []).map((a) => a.tag)));
    e.attribs = (e.attribs || []).map((a) => (a.tag in vals ? { ...a, text: vals[a.tag] } : a));
    return e;
  }
  const textLayer = e.attribs?.[0]?.layer || CATEGORIES[s.cat].text;
  const vals = attributeValues(e.elec);
  if (e.attribs?.length === ATTRS.length) {
    e.attribs = e.attribs.map((a) => ({ ...a, text: vals[a.tag] ?? a.text }));
  } else {
    e.attribs = attribsFor(e, e.elec, textLayer);
  }
  return e;
}

// Taille des symboles dans le dessin : 5 mm sur le papier à l'échelle des annotations.
export function defaultSymbolSize(doc, annoScale, unitMm) {
  return (5 * annoScale) / unitMm;
}
