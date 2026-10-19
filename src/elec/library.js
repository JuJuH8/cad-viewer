// SPDX-License-Identifier: GPL-3.0-or-later
// Bibliothèque de symboles DWG (tierce, installée par l'utilisateur) : les palettes d'outils AutoCAD (.atc) d'un dossier, lues
// par le serveur local, donnent pour chaque outil le bloc, le calque SIA et l'échelle ; les blocs sont copiés
// depuis le DWG de la bibliothèque au moment de la pose. Les appareils posés gardent le bloc d'origine et
// reçoivent les mêmes données électriques que les symboles intégrés (tableau, circuit, puissance) : ils
// entrent dans le bilan NIBT, et leurs attributs (CN_LIB_SUP, CN_LIB_INF…) sont remplis automatiquement.

import * as G from '../core/geom.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { SYMBOLS, CATEGORIES, libraryValues } from './symbols.js';
import { unitScale } from '../archi/fonds.js';
import { readSource } from '../archi/sources.js';

const STORE = 'cadviewer.biblio';
export const DEFAULT_FOLDER = ''; // à indiquer par l'utilisateur (dossier de sa bibliothèque)
// Échelle du dessin pour laquelle les blocs sont dessinés (bibliothèques courantes : textes de 12,5 cm = 2,5 mm au 1:50).
export const REFERENCE_SCALE = 50;

export function savedFolder() {
  try { return localStorage.getItem(STORE) || ''; } catch { return ''; }
}
export function saveFolder(folder) {
  try { localStorage.setItem(STORE, folder); } catch { /* stockage indisponible */ }
}

// --- classement des outils -------------------------------------------------------------

// Catégorie d'après le calque SIA de l'outil (calque exact, sinon préfixe du code CFE).
const LAYER_PREFIXES = [
  ['EVI061-3', 'COMMANDE'], ['EVI061', 'LUMIERE'], ['EVI063', 'ECL_SEC'], ['EVI012', 'TABLEAUX'], ['EVI01--2', 'STORES'],
  ['EVI01--8', 'STORES'], ['EVI0', 'FORCE'], ['ESI142', 'TT_INFO'], ['ESI131', 'TV_AUDIO'], ['ESI121', 'INTERPHONE'],
  ['ESI151', 'DI'], ['ESI152', 'SECURITE'], ['ESI163', 'ACCES'], ['ESI16', 'SURVEILLANCE'], ['E-I03', 'EQUIPOT'],
  ['ESI', 'CFA'], ['E-I56', 'CFA'],
];
export function categoryOfLayer(layer) {
  const exact = Object.entries(CATEGORIES).find(([, c]) => c.layer === layer);
  if (exact) return exact[0];
  return LAYER_PREFIXES.find(([pre]) => layer.startsWith(pre))?.[1] || null;
}

// Blocs d'annotation et de cheminement (boîtes, conduites, flèches, étiquettes, percements, signalétique) :
// posés tels quels, sans données électriques.
const PLAIN = /^(BR|BP)-|^BOITE-(RACC|PASSAGE)|^COND-|^NB-FILS|^FLECHE|^INST-|^GARDE-COFFRET|^DEPART|^ETIQ|^CONNEXION|^CH-C|^CAN-|^PERC|^CARROTAGE|^TUBE-MANCHON|^APPAREIL-(ETANCHE|EX)$|^SIGN|^BOITE-SOL/i;

// Règles nom de bloc → symbole intégré équivalent (puissance par défaut, type de circuit, légende).
// cats : la règle ne vaut que dans ces catégories.
const RULES = [
  [/^TABLEAU-/i, 'TABLEAU'],
  [/^(INT-PRISE|POUSSOIR-PRISE)/i, 'PR1'],
  [/^PR-.*(CEE|T15|T25|25A|40A)/i, 'PR_FORCE'],
  [/^PR-.*x3|^COFFRET-PRISES/i, 'PR3'],
  [/^PR-.*(x2|MULT)/i, 'PR2'],
  [/^PR-|^PRISE-FICHE-MOBILE/i, 'PR1'],
  [/^PRISE-IT|^CONNECT-FIBRE/i, 'RJ45'],
  [/^PRISE-TT|^TEL-/i, 'TEL'],
  [/WIFI/i, 'WIFI'],
  [/^PRISE-RTV/i, 'TV'],
  [/^HAUT-PARLEUR/i, 'HP'],
  [/^POUSS-STORE|^BOITIER-CDE/i, 'STORE_CMD', ['STORES']],
  [/^MOTEUR/i, 'STORE_MOT', ['STORES']],
  [/^INT-SCH-[36]/i, 'INT_VV'],
  [/^INT-SCH|^INT-A-TIRETTE|^PLATINE/i, 'INT'],
  [/^POUSSOIR/i, 'POUSSOIR'],
  [/^POTENTIOMETRE/i, 'VARIATEUR', ['COMMANDE']],
  [/^DET-PRESENCE|^DET-ULTRASON|^SONDE-LUMIERE/i, 'DETECTEUR', ['COMMANDE', 'LUMIERE']],
  [/^DET-PRESENCE|^DET-ULTRASON|^DET-BRIS|^DET-SISMIQUE/i, 'DETECT_INTRUSION'],
  [/^DET-|^DI-NUM/i, 'DF', ['DI']],
  [/^POUSS-DI/i, 'DM'],
  [/^(KLAXON|VIBREUR|FEU-FLASH|FEU-TOURNANT|SIRENE|RONFLEUR)/i, 'SIRENE', ['DI']],
  [/^CONT-/i, 'CONTACT_PORTE', ['SECURITE', 'ACCES']],
  [/^CAMERA/i, 'CAMERA'],
  [/^LECT-/i, 'LECTEUR'],
  [/^GACHE/i, 'GACHE'],
  [/^INTERPHONE/i, 'INTERPHONE'],
  [/^PANNEAU|^DRAPEAU|-DIR(-|$)/i, 'SORTIE', ['ECL_SEC']],
  [/^(SPOT|LUM|BLOC|APP-ECL|LAMPE)/i, 'LUM_SEC', ['ECL_SEC']],
  [/^ALIM-DIR|^RACC-DIR/i, 'SORTIE_CABLE'],
  [/^CUISINIERE|^PLAQUE-CHAUFF/i, 'CUISINIERE'],
  [/^CHAUFFE-EAU/i, 'CHAUFFE_EAU'],
  [/^RADIATEUR|^AEROCHAUFFEUR|^AEROTHERME|^RECHAUFFEUR/i, 'RADIATEUR_EL'],
  [/^MOTEUR|^VENTILATEUR|^CLIMATISEUR/i, 'MOTEUR'],
  [/^TERRE|^EQUIPOT|^BARRE-EQUIPOT|^PIQUET/i, 'TERRE'],
  [/SPOT/i, 'SPOT', ['LUMIERE']],
  [/-MUR/i, 'LUM_MUR', ['LUMIERE']],
  [/SUSP/i, 'LUM_SUSP', ['LUMIERE']],
  [/TUBE|FLUO|PROF|RAIL/i, 'LUM_LIN', ['LUMIERE']],
];
const DEFAULT_SYM = {
  LUMIERE: 'LUM', COMMANDE: 'INT', ECL_SEC: 'LUM_SEC', FORCE: 'APPAREIL', STORES: 'STORE_MOT', TABLEAUX: 'TABLEAU', TT_INFO: 'RJ45',
  TV_AUDIO: 'TV', INTERPHONE: 'INTERPHONE', DI: 'DF', SECURITE: 'DETECT_INTRUSION', SURVEILLANCE: 'CAMERA', ACCES: 'LECTEUR',
  EQUIPOT: 'TERRE', CFA: 'CFA_APP',
};
// Puissances indicatives (W) des récepteurs courants ; 0 pour les organes de commande et les centrales
// (à saisir par le projeteur).
const POWERS = [
  [/^FOUR-MICR/, 1500], [/^FOUR/, 3500], [/^PLAQUE-CHAUFF/, 7000], [/^MACHINE-A-LAVER|^LAVE-VAISELLE/, 2300], [/^SECHE-LINGE/, 2500],
  [/^CONGEL-REFRIG/, 300], [/^CONGELATEUR/, 200], [/^REFRIGERATEUR/, 150], [/^VENTILATEUR/, 100], [/^CLIMATISEUR/, 2500],
  [/^FRITEUSE/, 3000], [/^HUMIDIFICATEUR/, 500],
  [/^(INT-(?!PRISE)|COUP-POING|THERMOSTAT|PRESSOSTAT|HYGROSTAT|ANEMOMETRE|PLUVIOMETRE|STATION|ELECTRO-VANNE|CELLULE|INTRO|ONDUL|GENERATEUR|TRANSFORMATEUR|BATT|CENTRALE|AGREGAT|ALIM-SECOURS|CONS-ENERG)/, 0],
];

const shortName = (block) => block.replace(/^cn_/i, '');

// Classement d'un outil : { plain } (bloc posé tel quel) ou { cat, sym, p, ph, label }.
export function classifyTool(tool) {
  const name = shortName(tool.block).toUpperCase();
  const label = shortName(tool.name || tool.block);
  if (PLAIN.test(name)) return { plain: true, label };
  const cat = categoryOfLayer(tool.layer || '');
  if (!cat) return { plain: true, label };
  const rule = RULES.find(([re, , cats]) => re.test(name) && (!cats || cats.includes(cat)));
  const sym = rule?.[1] || DEFAULT_SYM[cat];
  const s = SYMBOLS[sym];
  let p = s.p || 0;
  const pw = POWERS.find(([re]) => re.test(name));
  if (pw) p = pw[1];
  // Luminaires : puissance lue dans le nom (2x36W → 72 W ; 1x14-24W → 14 W).
  const lamps = /(\d+)X(\d+)(?:-\d+)*W/.exec(name) || /()(\d+)W/.exec(name);
  if (lamps && ['LUMIERE', 'ECL_SEC'].includes(s.cat)) p = (+lamps[1] || 1) * +lamps[2];
  return { cat: s.board ? 'TABLEAUX' : cat, sym, p, ph: s.ph || 1, label };
}

// --- chargement ------------------------------------------------------------------------

// Bibliothèque prête à l'emploi : palettes (outils dont le bloc existe), documents sources par nom de fichier.
export function createLibrary({ folder = '', palettes, docs }) {
  const sources = new Map(docs);
  const first = sources.values().next().value;
  const docOf = (tool) => sources.get(tool.source) || first;
  const pals = palettes
    .map((p) => ({ ...p, tools: p.tools.filter((t) => docOf(t)?.blocks.has(t.block)).map((t) => ({ ...t, info: classifyTool(t) })) }))
    .filter((p) => p.tools.length);
  return { folder, palettes: pals, docOf, count: pals.reduce((s, p) => s + p.tools.length, 0) };
}

// Lit les palettes d'un dossier (serveur local) et le ou les DWG de blocs qu'elles référencent.
export async function loadLibrary(folder, loadDocument) {
  const r = await fetch(`__palettes?dossier=${encodeURIComponent(folder)}`).catch(() => null);
  if (!r || r.status === 404) throw new Error('le serveur de l’appli ne lit pas les palettes : relancez « Lancer CAD Viewer.bat »');
  if (!r.ok) throw new Error(`${await r.text()} : ${folder}`);
  const { palettes, library } = await r.json();
  if (!palettes.length) throw new Error('aucune palette d’outils (.atc) avec des blocs dans ce dossier');
  const names = [...new Set(palettes.flatMap((p) => p.tools.map((t) => t.source)))];
  const docs = [];
  for (const name of names) {
    if (!library[name]) continue;
    const src = await readSource({ kind: 'path', path: library[name] });
    docs.push([name, await loadDocument(src.buffer, src.name)]);
  }
  if (!docs.length) throw new Error(`bibliothèque de blocs introuvable dans le dossier (${names.join(', ') || 'aucune'})`);
  return createLibrary({ folder, palettes, docs });
}

// --- pose ------------------------------------------------------------------------------

// Copie (une fois) un bloc de la bibliothèque et ses blocs imbriqués dans le dessin.
function ensureBlock(doc, src, name) {
  if (doc.blocks.has(name) || !src.blocks.has(name)) return;
  const b = structuredClone(src.blocks.get(name));
  for (const e of b.entities) delete e.handle;
  doc.blocks.set(name, { ...b, name, xref: false });
  for (const e of b.entities) if (e.name && (e.type === 'INSERT' || e.type === 'BLOCKREF')) ensureBlock(doc, src, e.name);
}

// Calque créé s'il manque, avec les propriétés de la bibliothèque (ou de la norme), dans la transaction en cours.
function ensureLayer(doc, src, name, fallbackColor = 7) {
  if (doc.layers.has(name)) return;
  const l = src.layers.get(name);
  doc.addLayer(name, l ? { color: l.color, ltype: l.ltype, lweight: l.lweight, plot: l.plot } : { color: fallbackColor });
}

// Calques et types de ligne utilisés à l'intérieur du bloc.
function ensureBlockResources(doc, src, name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  for (const e of doc.blocks.get(name)?.entities || []) {
    if (e.layer && e.layer !== '0') ensureLayer(doc, src, e.layer);
    if (e.ltype && !/^(bylayer|byblock|continuous)$/i.test(e.ltype) && !doc.ltypes?.has(e.ltype) && src.ltypes?.has(e.ltype)) {
      doc.setTableEntry('ltypes', e.ltype, structuredClone(src.ltypes.get(e.ltype)));
    }
    if (e.name && (e.type === 'INSERT' || e.type === 'BLOCKREF')) ensureBlockResources(doc, src, e.name, seen);
  }
}

// Calque des textes associé au calque d'un appareil (SIA : E → T, « -appareils » → « -textes »).
export function textLayerOf(layer, cat) {
  if (cat && CATEGORIES[cat]?.layer === layer) return CATEGORIES[cat].text;
  if (layer[8] !== 'E' || layer[9] !== '-') return layer;
  return `${layer.slice(0, 8)}T${layer.slice(9)}`.replace(/-(appareils|trace|secondaires)\)$/, '-textes)');
}

// Échelle d'insertion : unités de la bibliothèque → unités du dessin, échelle des annotations du dessin
// rapportée à l'échelle de référence des blocs, échelle de l'outil et facteur choisi.
export function insertScale(doc, src, tool, { annoScale = 50, unitMm = 1, factor = 1 } = {}) {
  const units = unitScale(src.header?.insunits, doc.header?.insunits);
  return units * ((annoScale * unitMm) / REFERENCE_SCALE) * (tool.scale || 1) * factor;
}

// Texte lisible (jamais à l'envers) : rotation ramenée dans ]-90°, 90°].
const readable = (rot) => {
  const r = G.normAngle(rot);
  return r > Math.PI / 2 + 1e-9 && r <= Math.PI * 1.5 + 1e-9 ? r - Math.PI : r;
};

// Attributs d'une insertion d'après les définitions (ATTDEF) du bloc.
function blockAttribs(block, ins, values, textLayer) {
  const m = insertMatrix(ins, block.base);
  return block.entities.filter((e) => e.type === 'ATTDEF').map((d) => {
    const t = transformEntity({ ...d, type: 'TEXT' }, m);
    delete t.prompt;
    delete t.handle;
    return { ...t, layer: textLayer, color: 256, rot: readable(t.rot || 0), text: values[d.tag] ?? d.text ?? '', invisible: !!d.invisible };
  });
}

// Nouvelle insertion d'un outil de la bibliothèque (objet prêt pour doc.add).
// preview : aperçu pendant la pose (ni calque ni type de ligne créés : aucune opération dans l'historique).
export function libraryInsert(doc, lib, tool, p, { scale = 1, rot = 0, elec = {}, preview = false } = {}) {
  const src = lib.docOf(tool);
  ensureBlock(doc, src, tool.block);
  const block = doc.blocks.get(tool.block);
  const info = tool.info || classifyTool(tool);
  const layer = tool.layer || (info.cat && CATEGORIES[info.cat].layer) || doc.currentLayer;
  const textLayer = info.plain ? layer : textLayerOf(layer, info.cat);
  if (!preview) {
    ensureLayer(doc, src, layer, CATEGORIES[info.cat]?.color);
    if (textLayer !== layer) ensureLayer(doc, src, textLayer, 9);
    ensureBlockResources(doc, src, tool.block);
  }
  const ins = { type: 'INSERT', name: tool.block, layer, color: 256, space: doc.currentSpace || 'model', p: [p[0], p[1], 0], sx: scale, sy: scale, sz: scale, rot, cols: 1, rows: 1, dc: 0, dr: 0 };
  if (info.plain) {
    ins.attribs = blockAttribs(block, ins, {}, textLayer);
    return ins;
  }
  const s = SYMBOLS[info.sym];
  ins.elec = {
    sym: info.sym, cat: info.cat, p: info.p, ph: info.ph, block: tool.block, label: info.label,
    ...(s.board ? { kind: 'board', board: 'TD', circuits: [] } : {}),
    ...elec,
  };
  const tags = new Set(block.entities.filter((e) => e.type === 'ATTDEF').map((e) => e.tag));
  ins.attribs = blockAttribs(block, ins, libraryValues(ins.elec, tags), textLayer);
  return ins;
}

// Aperçu SVG d'un bloc : module commun des blocs.
export { blockSvg } from '../blocks/preview.js';
