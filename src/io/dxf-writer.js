// SPDX-License-Identifier: GPL-3.0-or-later
// Enregistrement au format DXF ASCII, version AutoCAD 2007 (AC1021, texte en UTF-8).
// Structure complète (tables, blocs, objets de présentation) pour être relu par AutoCAD.
import * as G from '../core/geom.js';
import { defName, pdfUnitMm, underlayScale, underlayRotation, activeClip } from '../underlay/underlay.js';
import { clipForWrite } from './xclip.js';
import { Tessellator, partsBox } from '../core/tessellate.js';
import { splineWorldPoints, transformEntity } from '../core/entities.js';
import { mepToEntities } from '../mep/geometry.js';
import { sheetOf, FORMATS } from '../layout/sheet.js';
import { pointSize, dimStyleOf, annoScaleOf, isMetric } from '../core/drawing-settings.js';
import { isDynamic, valuesKey, evaluate } from '../blocks/dynamic.js';
import { xrecordGroups } from '../core/layerstates.js';
import { inDrawOrder } from '../core/draworder.js';
import { ucsOf, ucsAxes, ucsIconOf } from '../core/ucs.js';
import { parseCode, checksum, evaluateExpr, dateToJulian } from '../core/fields.js';
import { toAcadRef, dimDefPoints } from '../core/dimassoc.js';

const H_CODE = { left: 0, center: 1, right: 2 };
const V_CODE = { baseline: 0, bottom: 1, middle: 2, top: 3 };
const deg = (r) => (r * 180) / Math.PI;
// Paramètres MEP en données étendues. LibreDWG (0.7.14) ne relit correctement que la première
// valeur de chaque application dans un DWG 2018 : le JSON est donc découpé en morceaux de
// 240 caractères, un par application CVMEP0, CVMEP1…
export const XDATA_PREFIX = 'CVMEP';
const XDATA_CHUNK = 240;
// JSON en ASCII pur (accents échappés en è) : LibreDWG décode mal certaines chaînes XDATA non ASCII
// des DWG réenregistrés par AutoCAD.
const ascii = (s) => s.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const mepPayload = (e) => ascii(e.type === 'INSERT'
  ? JSON.stringify({ v: 1, terminal: true, mep: e.mep })
  : JSON.stringify({ v: 1, mep: e.mep, pts: e.pts, bulges: e.bulges, z: e.z || 0 }));
// Fond de plan (insertion d'une base architecte) : réglages et chemin pour le recharger à la réouverture.
export function fondPayload(fond) {
  const keep = ['file', 'source', 'profile', 'table', 'unit', 'version', 'loadedAt', 'mtime', 'fade', 'scale', 'insunits', 'ifc'];
  const f = Object.fromEntries(keep.filter((k) => fond[k] != null).map((k) => [k, fond[k]]));
  if (f.source && f.source.kind !== 'path') delete f.source; // poignée de fichier : propre au navigateur
  return ascii(JSON.stringify({ v: 1, fond: f }));
}
// Appareil ou tableau électrique : symbole, tableau, circuit, puissance, réglages des circuits.
export const elecPayload = (e) => ascii(JSON.stringify({ v: 1, elec: e.elec }));
// Blocs dynamiques : chaque jeu de valeurs utilisé devient un bloc (géométrie évaluée, comme la représentation
// anonyme d'AutoCAD, que tout logiciel affiche) ; l'insertion le référence et garde en XDATA son bloc dynamique
// et ses valeurs. Les définitions dynamiques sont rangées dans un dictionnaire (XRECORD).
let DYN_REPS = new Map(); // « nom§valeurs » → nom du bloc de représentation
const dynKey = (doc, e) => {
  const b = e.type === 'INSERT' ? doc.blocks.get(e.name) : null;
  return isDynamic(b) ? `${e.name}§${valuesKey(b, e.dyn)}` : null;
};
// hidden : étiquettes des attributs cachés par l'état du bloc (écrits invisibles pour AutoCAD, rendus visibles à la relecture).
const dynRef = (e) => ({ block: e.name, values: e.dyn || {}, hidden: (e.attribs || []).filter((a) => a.dynHidden).map((a) => a.tag) });
export const dynPayload = (e) => ascii(JSON.stringify({ v: 1, dynref: dynRef(e) }));

// Réglages propres d'une fenêtre (calques : couleur, épaisseur, transparence ; transparence des hachures).
const vpSettings = (e) => (e.layerOvr || e.hatchAlpha ? { layerOvr: e.layerOvr, hatchAlpha: e.hatchAlpha } : null);
export const vpPayload = (e) => ascii(JSON.stringify({ v: 1, vp: vpSettings(e) }));
// Fond enregistré comme vraie référence externe (chemin connu) plutôt que lié.
const fondAsXref = (b) => b?.fond?.source?.kind === 'path' && !!b.fond.source.path;
const chunks = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i += XDATA_CHUNK) out.push(s.slice(i, i + XDATA_CHUNK));
  return out.length ? out : [''];
};
const LWEIGHTS = new Set([-3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211]);

function num(v) {
  if (!Number.isFinite(v)) return '0.0';
  if (Number.isInteger(v)) return `${v}.0`;
  const s = String(Math.round(v * 1e12) / 1e12);
  return s.includes('e') ? v.toExponential(12) : s;
}

// Calques et types de ligne venant d'une référence externe (« xref|nom ») : renommés comme
// lors d'une liaison AutoCAD (« xref$0$nom »), puisque la référence n'est pas conservée.
const dep = (name) => String(name).replace(/\|/g, () => '$0$');

// Les noms de blocs anonymes (*D12, *U3…) sont rendus explicites : on les écrit comme blocs nommés.
function blockName(name) {
  if (/^\*(model|paper)_space/i.test(name) || DIM_BLOCKS.has(name)) return name;
  // « * » (blocs anonymes, y compris venant d'une xref : « xref|*D15 ») et « | » sont interdits
  // dans un nom de bloc nommé : on les remplace.
  return dep(name).replace(/\*/g, 'CV_ANON_');
}

class Writer {
  constructor() {
    this.out = [];
    this.next = 0x30;
  }
  g(code, value) {
    this.out.push(String(code).padStart(3, ' '), typeof value === 'number' && !Number.isInteger(value) ? num(value) : String(value));
  }
  f(code, value) { this.out.push(String(code).padStart(3, ' '), num(value)); }
  pt(base, p, z = true) {
    this.f(base, p[0]); this.f(base + 10, p[1]);
    if (z) this.f(base + 20, p[2] || 0);
  }
  handle() { return (this.next++).toString(16).toUpperCase(); }
  text() { return `${this.out.join('\n')}\n`; }
}

const H_VP = { next: 1 };
// Poignée de chaque calque (fenêtres : calques gelés, code 331) et de chaque type de ligne (nom en majuscules).
let LAYER_HANDLES = new Map();
let LTYPE_HANDLES = new Map();
// Groupes : nom → { handle, members (poignées des entités) }.
let GROUPS = new Map();
// Styles de texte écrits (noms en majuscules) : un texte d'un style inconnu est écrit en « Standard ».
let STYLE_NAMES = new Set(['STANDARD']);
const styleName = (e) => (e.style && STYLE_NAMES.has(String(e.style).toUpperCase()) ? dep(e.style) : 'Standard');
// Fonds joints : définitions et réacteurs des images (préparés par writeDxf).
let H_UL = { defs: new Map(), reactors: [] };
// Hachures associatives : poignées réservées des objets sources (id → poignée), écrites dans la hachure.
let H_ASSOC = new Map();
let H_BG = false; // une hachure a une couleur de fond : application HATCHBACKGROUNDCOLOR déclarée
// Découpes des insertions (XCLIP) : { insert, xdict, e } notées à l'écriture, objets écrits ensuite.
let H_CLIPS = [];
// Ordre de tracé : poignée de l'enregistrement de bloc d'un espace → { xdict, table, handles (dans l'ordre écrit) }.
let SORT_OWNERS = new Map();
// Champs : textes à champs notés à l'écriture { owner, xdict, e }, poignées réservées des attributs cités
// (« id de l'insertion|ÉTIQUETTE »), poignées de tous les objets FIELD (liste ACAD_FIELDLIST).
let FIELD_TEXTS = [];
// Cotes écrites comme vraies cotes : id → { block (*Dn), def (points de définition), xdict, assoc (DIMASSOC), refs,
// dim (poignée écrite) } ; réacteurs DIMASSOC des objets accrochés (id → poignées) ; noms des blocs *Dn.
let DIM_INFO = new Map();
// Styles de tracé nommés (dessin en PSTYLEMODE = 0) : nom (minuscules) → { name, handle } de l'objet du style.
let PSTYLES = null;
let DIM_REACTORS = new Map();
let DIM_BLOCKS = new Set();
let ATT_HANDLES = new Map();
let FIELD_HANDLES = [];
let DOC = null;

export function writeDxf(doc) {
  H_VP.next = 2; // l'ID 1 est celui de la feuille de la présentation active
  const w = new Writer();
  const H = {};
  // Handles réservés pour les objets référencés avant d'être écrits.
  const reserve = (key) => (H[key] = w.handle());
  ['root', 'groupDict', 'layoutDict', 'layoutModel', 'layout1', 'brModel', 'brPaper', 'plotStyleDict', 'plotStyleNormal',
    'tVport', 'tLtype', 'tLayer', 'tStyle', 'tView', 'tUcs', 'tAppid', 'tDimstyle', 'tBlockRecord'].forEach(reserve);

  // Objets MEP : un bloc par objet (son dessin), inséré avec ses paramètres en XDATA.
  const mepNames = new Map();
  let n = 0;
  for (const e of doc.entities.values()) {
    if (e.mep && e.type === 'LWPOLYLINE') mepNames.set(e.id, `CV_MEP_${++n}`);
  }
  const mepAll = [...doc.entities.values()].filter((e) => mepNames.has(e.id));
  const mepBlocks = mepAll.map((e) => ({
    name: mepNames.get(e.id), base: [0, 0, 0], flags: 0,
    entities: mepToEntities(e, mepAll).map((x) => ({ ...x, layer: '0', color: 256, rgb: undefined, space: undefined })),
  }));
  H.mepNames = mepNames;
  // Fonds joints (PDF, images) : une définition par fichier (et page), dictionnaires d'AutoCAD.
  H.ul = { defs: new Map(), reactors: [], pdf: false, image: false };
  H_UL = H.ul;
  H_ASSOC = new Map();
  H_BG = false;
  H_CLIPS = [];
  DOC = doc;
  H.clipCount = [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.clip?.pts?.length >= 3).length;
  FIELD_TEXTS = [];
  FIELD_HANDLES = [];
  ATT_HANDLES = new Map();
  // Objets cités par des champs (fenêtres, textes, polylignes…, attributs) : poignées réservées.
  for (const e of doc.entities.values()) {
    for (const r of [...(e.field?.refs || []), ...(e.attribs || []).flatMap((a) => a.field?.refs || [])]) {
      if (!doc.get(r.id)) continue;
      if (r.tag != null) { const k = `${r.id}|${String(r.tag).toUpperCase()}`; if (!ATT_HANDLES.has(k)) ATT_HANDLES.set(k, w.handle()); } else if (!H_ASSOC.has(r.id) && !doc.get(r.id).mep) H_ASSOC.set(r.id, w.handle());
    }
  }
  for (const e of doc.entities.values()) {
    // Tableau d'extraction limité à une sélection : poignées réservées des objets choisis.
    if (e.type === 'INSERT') for (const id of e.extract?.ids || []) if (!H_ASSOC.has(id) && doc.get(id) && !doc.get(id).mep) H_ASSOC.set(id, w.handle());
    if (e.type !== 'HATCH') continue;
    if (e.bg != null && !e.solid) H_BG = true;
    for (const id of e.assoc?.ids || []) if (!H_ASSOC.has(id) && doc.get(id) && !doc.get(id).mep) H_ASSOC.set(id, w.handle());
  }
  // Styles de tracé nommés : « Normal » et ceux des calques et des objets (dictionnaire ACAD_PLOTSTYLENAME).
  PSTYLES = null;
  if (doc.header?.pstylemode === 0) {
    PSTYLES = new Map([['normal', { name: 'Normal', handle: H.plotStyleNormal }]]);
    const add = (n) => { if (n && !PSTYLES.has(String(n).toLowerCase())) PSTYLES.set(String(n).toLowerCase(), { name: String(n), handle: w.handle() }); };
    for (const l of doc.layers.values()) add(l.pstyle);
    for (const e of [...doc.entities.values(), ...[...doc.blocks.values()].flatMap((b) => b.entities)]) add(e.pstyle);
  }
  // Cotes (linéaires, alignées, rayon, diamètre) : vraies cotes d'AutoCAD, avec leurs objets accrochés (DIMASSOC).
  DIM_INFO = new Map();
  DIM_REACTORS = new Map();
  DIM_BLOCKS = new Set();
  const dimBlocks = [];
  const dimBlockUses = new Map(); // bloc d'origine → nombre de cotes écrites qui l'utilisent
  for (const e of doc.entities.values()) {
    if (e.type !== 'BLOCKREF' || e.kind !== 'DIMENSION') continue;
    const b = doc.blocks.get(e.name);
    const m = e.m || G.IDENTITY;
    const def = b && dimDefPoints(e.meta, m);
    if (!def) continue;
    let k = DIM_INFO.size + 1, name; // nom libre (les blocs *D relus d'AutoCAD restent dans le dessin)
    do name = `*D${k++}`; while (doc.blocks.has(name) || DIM_BLOCKS.has(name));
    DIM_BLOCKS.add(name);
    const ident = m.every((v, k) => Math.abs(v - G.IDENTITY[k]) < 1e-12);
    dimBlocks.push({ name, base: [0, 0, 0], flags: 1, entities: ident ? b.entities : b.entities.map((x) => transformEntity(x, m)) });
    dimBlockUses.set(e.name, (dimBlockUses.get(e.name) || 0) + 1);
    const info = { block: name, def, m };
    const radial = def.kind === 'radius' || def.kind === 'diameter';
    const refs = (e.meta.assoc || []).map((ref, k) => {
      const obj = ref && doc.get(ref.id);
      const a = obj && !obj.mep && toAcadRef(obj, ref);
      return a ? { ...a, bit: radial ? 1 : k, id: ref.id } : null;
    }).filter(Boolean);
    if (refs.length) {
      Object.assign(info, { refs, xdict: w.handle(), assoc: w.handle() });
      for (const r of refs) {
        if (!H_ASSOC.has(r.id)) H_ASSOC.set(r.id, w.handle());
        if (!DIM_REACTORS.has(r.id)) DIM_REACTORS.set(r.id, []);
        DIM_REACTORS.get(r.id).push(info.assoc);
      }
      DIM_REACTORS.set(e.id, [...(DIM_REACTORS.get(e.id) || []), info.assoc]);
    }
    DIM_INFO.set(e.id, info);
  }
  H.dimAssocCount = [...DIM_INFO.values()].filter((x) => x.assoc).length;
  // Blocs d'origine utilisés seulement par ces cotes (et par aucune insertion) : remplacés par les blocs *Dn.
  const otherUse = new Set();
  for (const e of [...doc.entities.values(), ...[...doc.blocks.values()].flatMap((b) => b.entities)]) {
    if ((e.type === 'INSERT' || e.type === 'BLOCKREF') && !DIM_INFO.has(e.id)) otherUse.add(e.name);
  }
  const dimOnly = new Set([...dimBlockUses.keys()].filter((n) => !otherUse.has(n)));
  const allEnts = [...doc.entities.values(), ...[...doc.blocks.values()].flatMap((b) => b.entities)];
  for (const e of allEnts) {
    if (e.type !== 'UNDERLAY') continue;
    const key = `${e.kind}|${String(e.path).toLowerCase()}|${e.kind === 'pdf' ? e.page || 1 : 0}`;
    if (!H.ul.defs.has(key)) H.ul.defs.set(key, { handle: w.handle(), kind: e.kind, path: e.path, page: e.page || 1, name: defName(e), native: e.native, pixel: e.pixel || 1, refs: [] });
    H.ul[e.kind] = true;
    H.ul.count = H.ul.count || { pdf: 0, image: 0 };
    H.ul.count[e.kind]++;
  }
  if (H.ul.pdf) H.ul.pdfDict = w.handle();
  if (H.ul.image) { H.ul.imageDict = w.handle(); H.ul.rasterVars = w.handle(); }
  // Noms de définition uniques.
  const ulNames = new Set();
  for (const d of H.ul.defs.values()) {
    let n = d.name, k = 2;
    while (ulNames.has(`${d.kind}|${n.toLowerCase()}`)) n = `${d.name} (${k++})`;
    ulNames.add(`${d.kind}|${n.toLowerCase()}`);
    d.name = n;
  }
  GROUPS = new Map();
  for (const e of doc.entities.values()) if (e.group && !GROUPS.has(e.group)) GROUPS.set(e.group, { handle: w.handle(), members: [] });
  // Représentations des blocs dynamiques (insertions du dessin et des blocs).
  DYN_REPS = new Map();
  const repBlocks = [];
  const scanDyn = (ents) => {
    for (const e of ents) {
      const k = dynKey(doc, e);
      if (!k || DYN_REPS.has(k)) continue;
      const b = doc.blocks.get(e.name);
      let i = DYN_REPS.size + 1, name;
      do name = `${e.name}_DYN${i++}`; while (doc.blocks.has(name));
      DYN_REPS.set(k, name);
      repBlocks.push({ name, base: b.base, flags: 0, entities: evaluate(b, e.dyn).map((x) => { const c = { ...x }; delete c.k; return c; }) });
    }
  };
  scanDyn(doc.entities.values());
  for (const b of doc.blocks.values()) scanDyn(b.entities);
  H.xdataApps = 0;
  for (const e of doc.entities.values()) {
    if (dynKey(doc, e)) H.xdataApps = Math.max(H.xdataApps, chunks(e.elec ? ascii(JSON.stringify({ v: 1, elec: e.elec, dynref: dynRef(e) })) : dynPayload(e)).length);
    if (mepNames.has(e.id) || (e.mep && e.type === 'INSERT')) H.xdataApps = Math.max(H.xdataApps, chunks(mepPayload(e)).length);
    const fb = e.type === 'INSERT' && doc.blocks.get(e.name);
    if (fb?.fond) H.xdataApps = Math.max(H.xdataApps, chunks(fondPayload(fb.fond)).length);
    if (e.type === 'INSERT' && e.elec) H.xdataApps = Math.max(H.xdataApps, chunks(elecPayload(e)).length);
    if (e.type === 'VIEWPORT' && vpSettings(e)) H.xdataApps = Math.max(H.xdataApps, chunks(vpPayload(e)).length);
    if (e.type === 'UNDERLAY') H.xdataApps = Math.max(H.xdataApps, chunks(underlayPayload(e)).length);
    if (e.type === 'HATCH' && e.assoc) H.xdataApps = Math.max(H.xdataApps, chunks(hatchPayload(e)).length);
    if (e.type === 'INSERT' && e.extract) H.xdataApps = Math.max(H.xdataApps, chunks(extractPayload(e)).length);
  }
  // Fonds de plan à chemin connu : écrits comme références externes ; leurs blocs, calques et types de ligne
  // préfixés (« fond|… ») appartiennent à la base et ne sont pas écrits.
  H.xrefPrefixes = [...doc.blocks.values()].filter(fondAsXref).map((b) => `${b.name}|`);
  const fromXref = (name) => H.xrefPrefixes.some((pre) => String(name).startsWith(pre));
  H.fromXref = fromXref;
  const blocks = [...[...doc.blocks.values()].filter((b) => !dimOnly.has(b.name)), ...mepBlocks, ...repBlocks, ...dimBlocks].filter((b) => !fromXref(b.name));
  // Définitions dynamiques (paramètres, actions, clés des objets dans l'ordre du bloc).
  H.dynDefs = [...doc.blocks.values()].filter((b) => isDynamic(b) && !fromXref(b.name)).map((b) => ({
    name: blockName(b.name), handle: w.handle(), json: ascii(JSON.stringify({ v: 1, dyn: b.dyn, keys: b.entities.map((e) => e.k ?? null) })),
  }));
  if (H.dynDefs.length) H.dynDict = w.handle();
  // Données électriques du projet (onglet « Données électriques ») : XRECORD JSON dans le dictionnaire racine.
  const elecData = doc.header?.elecData;
  H.elecData = elecData && Object.keys(elecData).length ? { handle: w.handle(), json: ascii(JSON.stringify({ v: 1, data: elecData })) } : null;
  const blockRecord = new Map(blocks.map((b) => [b.name, w.handle()]));
  const spaces = doc.spaces.filter((sp) => sp.id !== 'model');
  H.layouts = (spaces.length ? spaces : [{ id: null, label: 'Présentation1' }]).map((sp, i) => ({
    space: sp.id, label: sp.label || `Présentation${i + 1}`,
    br: i === 0 ? H.brPaper : w.handle(), layout: i === 0 ? H.layout1 : w.handle(),
    name: i === 0 ? '*Paper_Space' : `*Paper_Space${i - 1}`,
    // Feuille : mise en page de la présentation (ou ses limites, ou le format qui contient son contenu).
    sheet: sheetOf(sp.id ? sp : { id: 'x' }, sp.id ? spaceBox(doc, sp.id) : null),
  }));
  // Noms de présentation uniques (clés du dictionnaire ACAD_LAYOUT).
  const used = new Set(['model']);
  for (const l of H.layouts) {
    let n = l.label, k = 2;
    while (used.has(n.toLowerCase())) n = `${l.label} (${k++})`;
    used.add(n.toLowerCase());
    l.label = n;
  }
  H.vpId = 1;
  // Ordre de tracé : les objets sont écrits dans l'ordre de tracé (l'ordre des poignées est l'ordre par défaut
  // d'AutoCAD) ; une table de tri (SORTENTSTABLE) corrige les espaces où des poignées réservées, plus petites,
  // le rompraient.
  SORT_OWNERS = new Map();
  const needSort = (space) => [...doc.entities.values()].some((e) => e.space === space && H_ASSOC.has(e.id));
  if (needSort('model')) SORT_OWNERS.set(H.brModel, { xdict: w.handle(), table: w.handle(), handles: [] });
  for (const l of H.layouts) if (l.space && needSort(l.space)) SORT_OWNERS.set(l.br, { xdict: w.handle(), table: w.handle(), handles: [] });
  H.sortents = SORT_OWNERS;
  // Masques : classe (nombre d'objets), variables (cadres) et WIPEOUTFRAME dans le dictionnaire des variables.
  H.wipeouts = [...doc.entities.values(), ...blocks.flatMap((b) => b.entities)].filter((e) => e.type === 'WIPEOUT').length;
  if (H.wipeouts || doc.header?.wipeoutFrame != null) H.wipe = { vars: w.handle(), varDict: w.handle(), frame: w.handle() };
  // Champs : nombre d'objets FIELD (racine + une par expression) pour la classe, liste réservée.
  const fieldTexts = [...doc.entities.values(), ...blocks.flatMap((b) => b.entities)].flatMap((e) => [e, ...(e.attribs || [])]).filter((t) => t.field?.code);
  H.fieldCount = fieldTexts.reduce((n, t) => n + 1 + parseCode(t.field.code).filter((p) => p.expr).length, 0);
  if (H.fieldCount) H.fieldList = w.handle();

  // Corps du fichier (sans l'en-tête, écrit à la fin car il contient $HANDSEED).
  const body = new Writer();
  body.next = w.next;
  writeClasses(body, H);
  writeTables(body, doc, H, blocks, blockRecord);
  writeBlocks(body, doc, H, blocks, blockRecord);
  writeEntities(body, doc, H);
  writeObjects(body, doc, H);
  body.g(0, 'EOF');

  const head = new Writer();
  writeHeader(head, doc, body.next.toString(16).toUpperCase());
  return head.text() + body.text();
}

function writeHeader(w, doc, handseed) {
  const box = extentsOf(doc);
  const metric = isMetric(doc);
  w.g(0, 'SECTION'); w.g(2, 'HEADER');
  const v = (name) => w.g(9, name);
  v('$ACADVER'); w.g(1, 'AC1021');
  v('$DWGCODEPAGE'); w.g(3, 'ANSI_1252');
  v('$INSBASE'); w.pt(10, [0, 0, 0]);
  v('$EXTMIN'); w.pt(10, [box.minX, box.minY, 0]);
  v('$EXTMAX'); w.pt(10, [box.maxX, box.maxY, 0]);
  v('$LIMMIN'); w.pt(10, [0, 0], false);
  v('$LIMMAX'); w.pt(10, [420, 297], false);
  v('$LTSCALE'); w.f(40, doc.header?.ltscale || 1);
  v('$CLAYER'); w.g(8, dep(doc.currentLayer || '0'));
  v('$INSUNITS'); w.g(70, doc.header?.insunits ?? 0);
  // Dates du dessin (jour julien, heure locale) : création et dernier enregistrement.
  const now = new Date();
  v('$TDCREATE'); w.f(40, dateToJulian(doc.header?.createDate ? new Date(doc.header.createDate) : now));
  v('$TDUPDATE'); w.f(40, dateToJulian(doc.header?.saveDate ? new Date(doc.header.saveDate) : now));
  // SCU courants : espace objet ($UCS…) et première présentation ($PUCS…).
  const ucsVars = (prefix, u) => {
    const ax = ucsAxes(u);
    v(`$${prefix}BASE`); w.g(2, ''); v(`$${prefix}NAME`); w.g(2, u.name || '');
    v(`$${prefix}ORG`); w.pt(10, [u.origin[0], u.origin[1], 0]); v(`$${prefix}XDIR`); w.pt(10, ax.x); v(`$${prefix}YDIR`); w.pt(10, ax.y);
  };
  ucsVars('UCS', ucsOf(doc, 'model'));
  ucsVars('PUCS', ucsOf(doc, doc.spaces?.find((sp) => sp.id !== 'model')?.id || '*none*'));
  v('$MEASUREMENT'); w.g(70, metric ? 1 : 0);
  v('$LWDISPLAY'); w.g(290, doc.header?.lwdisplay ? 1 : 0);
  // Réglages du dessin (onglet Format) : précisions, points, objets courants, style de cote.
  const hd = doc.header || {};
  v('$LUPREC'); w.g(70, hd.luprec ?? 4);
  v('$AUPREC'); w.g(70, hd.auprec ?? 0);
  v('$PDMODE'); w.g(70, hd.pdmode | 0);
  v('$PDSIZE'); w.f(40, hd.pdmode ? pointSize(doc) : hd.pdsize > 0 ? hd.pdsize : 0);
  if (hd.textsize > 0) { v('$TEXTSIZE'); w.f(40, hd.textsize); }
  if (hd.textstyle && doc.styles?.has(String(hd.textstyle).toUpperCase())) { v('$TEXTSTYLE'); w.g(7, dep(hd.textstyle)); }
  v('$CECOLOR'); w.g(62, hd.cecolor ?? 256);
  v('$CELTYPE'); w.g(6, hd.celtype || 'ByLayer');
  v('$CELWEIGHT'); w.g(370, hd.celweight ?? -1);
  v('$PSTYLEMODE'); w.g(290, hd.pstylemode === 0 ? 0 : 1); // 0 : styles de tracé nommés (STB), 1 : dépendant de la couleur (CTB)
  const ds = dimStyleOf(doc);
  v('$DIMSCALE'); w.f(40, annoScaleOf(doc));
  v('$DIMASSOC'); w.g(280, 2); // nouvelles cotes associatives dans AutoCAD
  v('$DIMTXT'); w.f(40, ds.DIMTXT); v('$DIMASZ'); w.f(40, ds.DIMASZ);
  v('$DIMEXE'); w.f(40, ds.DIMEXE); v('$DIMEXO'); w.f(40, ds.DIMEXO); v('$DIMGAP'); w.f(40, ds.DIMGAP);
  v('$DIMDEC'); w.g(70, ds.DIMDEC); v('$DIMLFAC'); w.f(40, ds.DIMLFAC);
  v('$DIMPOST'); w.g(1, ds.DIMPOST ? `<>${ds.DIMPOST}` : '');
  v('$DIMTSZ'); w.f(40, ds.DIMBLK === 'oblique' ? ds.DIMASZ : 0);
  v('$DIMBLK'); w.g(1, { ouverte: '_OPEN', point: '_DOT' }[ds.DIMBLK] || '');
  v('$HANDSEED'); w.g(5, handseed);
  w.g(0, 'ENDSEC');
}

function extentsOf(doc) {
  const b = G.emptyBox();
  const grow = (p) => p && Number.isFinite(p[0]) && G.growBox(b, p[0], p[1]);
  for (const e of doc.entities.values()) {
    if (e.space !== 'model') continue;
    for (const k of ['p1', 'p2', 'c', 'p']) grow(e[k]);
    for (const p of e.pts || []) grow(p);
  }
  return G.boxValid(b) ? b : { minX: 0, minY: 0, maxX: 420, maxY: 297 };
}

// Classes des objets non natifs du DXF : fonds PDF et images (mêmes déclarations qu'AutoCAD).
const UNDERLAY_CLASSES = {
  pdf: [['PDFDEFINITION', 'AcDbPdfDefinition', 'ObjectDBX Classes', 1153, 0], ['PDFUNDERLAY', 'AcDbPdfReference', 'ObjectDBX Classes', 4095, 1]],
  image: [['IMAGEDEF', 'AcDbRasterImageDef', 'ISM', 0, 0], ['IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 'ISM', 1, 0],
    ['RASTERVARIABLES', 'AcDbRasterVariables', 'ISM', 0, 0], ['IMAGE', 'AcDbRasterImage', 'ISM', 2175, 1]],
};
function writeClasses(w, H = {}) {
  w.g(0, 'SECTION'); w.g(2, 'CLASSES');
  const cls = (name, cpp, app, proxy, n, entity) => { w.g(0, 'CLASS'); w.g(1, name); w.g(2, cpp); w.g(3, app); w.g(90, proxy); w.g(91, n); w.g(280, 0); w.g(281, entity); };
  if (H.wipeouts) cls('WIPEOUT', 'AcDbWipeout', 'WipeOut|Product Desc: Object Enabler for WipeOut entity | Company: Autodesk, Inc. | WEB Address: www.autodesk.com', 2175, H.wipeouts, 1);
  if (H.wipe) {
    cls('WIPEOUTVARIABLES', 'AcDbWipeoutVariables', '"WipeOut|Product Desc:     WipeOut Dbx Application|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com"', 0, 1, 0);
    cls('DICTIONARYVAR', 'AcDbDictionaryVar', 'ObjectDBX Classes', 0, 1, 0);
  }
  if (H.sortents?.size) cls('SORTENTSTABLE', 'AcDbSortentsTable', 'ObjectDBX Classes', 0, H.sortents.size, 0);
  if (H.dimAssocCount) cls('DIMASSOC', 'AcDbDimAssoc', '"AcDbDimAssoc|Product Desc:     AcDim ARX App For Dimension|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com"', 0, H.dimAssocCount, 0);
  if (H.fieldCount) { cls('FIELD', 'AcDbField', 'ObjectDBX Classes', 1152, H.fieldCount, 0); cls('FIELDLIST', 'AcDbFieldList', 'ObjectDBX Classes', 1152, 1, 0); }
  if (H.clipCount) { w.g(0, 'CLASS'); w.g(1, 'SPATIAL_FILTER'); w.g(2, 'AcDbSpatialFilter'); w.g(3, 'ObjectDBX Classes'); w.g(90, 0); w.g(91, H.clipCount); w.g(280, 0); w.g(281, 0); }
  for (const kind of ['pdf', 'image']) {
    if (!H.ul?.[kind]) continue;
    // Nombre d'objets de chaque classe : indispensable (à 0, AutoCAD garde les images comme objets proxy).
    const defs = [...H.ul.defs.values()].filter((d) => d.kind === kind).length;
    const n = H.ul.count?.[kind] || 0;
    const counts = kind === 'pdf' ? { PDFDEFINITION: defs, PDFUNDERLAY: n } : { IMAGEDEF: defs, IMAGEDEF_REACTOR: n, RASTERVARIABLES: 1, IMAGE: n };
    for (const [name, cls, app, proxy, entity] of UNDERLAY_CLASSES[kind]) {
      w.g(0, 'CLASS'); w.g(1, name); w.g(2, cls); w.g(3, app); w.g(90, proxy); w.g(91, counts[name] || 0); w.g(280, 0); w.g(281, entity);
    }
  }
  w.g(0, 'ENDSEC');
}

// Réglages des fonds propres à l'appli (blanc transparent, calques du PDF masqués, fond sombre des images).
function underlayPayload(e) {
  return ascii(JSON.stringify({ v: 1, underlay: { whiteOff: e.whiteOff !== false, ocgOff: e.ocgOff?.length ? e.ocgOff : undefined, adjust: e.kind === 'image' ? e.adjust !== false : undefined } }));
}

// Fond PDF (PDFUNDERLAY) ou image (IMAGE), relié à sa définition.
function writeUnderlay(w, e, owner, paper, doc) {
  const def = H_UL.defs.get(`${e.kind}|${String(e.path).toLowerCase()}|${e.kind === 'pdf' ? e.page || 1 : 0}`);
  if (!def) return;
  const clip = e.clip?.pts?.length >= 3 ? e.clip : null;
  if (e.kind === 'pdf') {
    const unitMm = e.pending?.unitMm ?? pdfUnitMm(doc);
    const scale = e.pending?.scale ?? underlayScale(e, unitMm);
    const h = common(w, e, 'PDFUNDERLAY', owner, paper); w.g(100, 'AcDbUnderlayReference');
    def.refs.push(h);
    w.g(340, def.handle); w.pt(10, e.p);
    w.f(41, scale); w.f(42, scale); w.f(43, scale); w.f(50, deg(G.normAngle(underlayRotation(e))));
    w.pt(210, [0, 0, 1]);
    const local = e.pending?.clipLocal || (clip ? clip.pts.map(([x, y]) => [(x * e.native[0]) / unitMm, (y * e.native[1]) / unitMm]) : null);
    const on = e.pending ? e.pending.clipOn : !!activeClip(e);
    const inv = e.pending ? e.pending.invert : !!clip?.invert;
    w.g(280, (local && on ? 1 : 0) | (e.show !== false ? 2 : 0) | (e.mono ? 4 : 0) | (e.adjust !== false ? 8 : 0) | (local && inv ? 16 : 0));
    w.g(281, Math.round(e.contrast ?? 100)); w.g(282, Math.round(e.fade || 0));
    for (const [x, y] of local || []) { w.f(11, x); w.f(21, y); }
  } else {
    const [W, Hh] = e.native;
    const h = common(w, e, 'IMAGE', owner, paper); w.g(100, 'AcDbRasterImage'); w.g(90, 0);
    const reactor = w.handle();
    def.refs.push(reactor);
    H_UL.reactors.push({ handle: reactor, image: h });
    w.pt(10, e.p); w.pt(11, [e.u[0] / W, e.u[1] / W, 0]); w.pt(12, [e.v[0] / Hh, e.v[1] / Hh, 0]);
    w.f(13, W); w.f(23, Hh);
    w.g(340, def.handle);
    w.g(70, (e.show !== false ? 1 : 0) | 2 | 4);
    w.g(280, activeClip(e) ? 1 : 0); w.g(281, 50); w.g(282, Math.round((e.contrast ?? 100) / 2)); w.g(283, Math.round(e.fade || 0));
    w.g(290, clip?.invert ? 1 : 0);
    w.g(360, reactor);
    // Découpe en pixels (origine au centre du pixel en haut à gauche, y vers le bas), comme AutoCAD.
    const px = ([s0, t0]) => [s0 * W - 0.5, (1 - t0) * Hh - 0.5];
    let pts = clip ? clip.pts.map(px) : [[-0.5, -0.5], [W - 0.5, Hh - 0.5]];
    // Rectangle aligné sur l'image : deux coins (comme AutoCAD) ; sinon polygone fermé.
    if (pts.length === 4) {
      const xs = [...new Set(pts.map((q) => +q[0].toFixed(6)))], ys = [...new Set(pts.map((q) => +q[1].toFixed(6)))];
      if (xs.length === 2 && ys.length === 2) pts = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    }
    const poly = pts.length > 2;
    if (poly) pts.push(pts[0]);
    w.g(71, poly ? 2 : 1); w.g(91, pts.length);
    for (const [x, y] of pts) { w.f(14, x); w.f(24, y); }
  }
  chunks(underlayPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
}

function tableStart(w, name, handle, count, extra, xdict = null) {
  w.g(0, 'TABLE'); w.g(2, name); w.g(5, handle);
  if (xdict) { w.g(102, '{ACAD_XDICTIONARY'); w.g(360, xdict); w.g(102, '}'); }
  w.g(330, 0);
  w.g(100, 'AcDbSymbolTable'); w.g(70, count);
  if (extra) extra();
}

function record(w, type, owner, sub, handleCode = 5) {
  const h = w.handle();
  w.g(0, type); w.g(handleCode, h); w.g(330, owner);
  w.g(100, 'AcDbSymbolTableRecord'); w.g(100, sub);
  return h;
}

function writeTables(w, doc, H, blocks, blockRecord) {
  w.g(0, 'SECTION'); w.g(2, 'TABLES');

  // VPORT
  tableStart(w, 'VPORT', H.tVport, 1);
  const box = extentsOf(doc);
  record(w, 'VPORT', H.tVport, 'AcDbViewportTableRecord');
  w.g(2, '*Active'); w.g(70, 0);
  w.pt(10, [0, 0], false); w.pt(11, [1, 1], false);
  w.pt(12, [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], false);
  w.pt(13, [0, 0], false); w.pt(14, [10, 10], false); w.pt(15, [10, 10], false);
  w.pt(16, [0, 0, 1]); w.pt(17, [0, 0, 0]);
  w.f(40, Math.max(box.maxY - box.minY, 1) * 1.1); w.f(41, 1.6); w.f(42, 50); w.f(43, 0); w.f(44, 0);
  const icon = ucsIconOf(doc); // icône du SCU : 1 affichée, 2 à l'origine
  w.f(50, 0); w.f(51, 0); w.g(71, 0); w.g(72, 1000); w.g(73, 1); w.g(74, (icon.on ? 1 : 0) | (icon.origin ? 2 : 0)); w.g(75, 0); w.g(76, 0);
  w.g(77, 0); w.g(78, 0); w.g(281, 0); w.g(65, 1);
  w.pt(110, [0, 0, 0]); w.pt(111, [1, 0, 0]); w.pt(112, [0, 1, 0]); w.g(79, 0); w.f(146, 0);
  w.g(0, 'ENDTAB');

  // LTYPE
  const ltypes = [...(doc.ltypes?.values() || [])].filter((t) => !/^(byblock|bylayer|continuous)$/i.test(t.name) && !H.fromXref(t.name));
  // Calorifuge des réseaux MEP : dessiné en DASHED dans leurs blocs, même si le dessin ne le définit pas.
  if (!ltypes.some((t) => /^dashed$/i.test(t.name)) && [...doc.entities.values()].some((e) => e.mep?.ins > 0)) {
    ltypes.push({ name: 'DASHED', description: 'Tirets __ __ __', dashes: [300, -150] });
  }
  tableStart(w, 'LTYPE', H.tLtype, 3 + ltypes.length);
  LTYPE_HANDLES = new Map();
  for (const [name, desc] of [['ByBlock', ''], ['ByLayer', ''], ['Continuous', 'Solid line']]) {
    LTYPE_HANDLES.set(name.toUpperCase(), record(w, 'LTYPE', H.tLtype, 'AcDbLinetypeTableRecord'));
    w.g(2, name); w.g(70, 0); w.g(3, desc); w.g(72, 65); w.g(73, 0); w.f(40, 0);
  }
  for (const t of ltypes) {
    LTYPE_HANDLES.set(t.name.toUpperCase(), record(w, 'LTYPE', H.tLtype, 'AcDbLinetypeTableRecord'));
    w.g(2, dep(t.name)); w.g(70, 0); w.g(3, t.description || ''); w.g(72, 65); w.g(73, t.dashes.length);
    w.f(40, t.dashes.reduce((s, d) => s + Math.abs(d), 0));
    for (const d of t.dashes) { w.f(49, d); w.g(74, 0); }
  }
  w.g(0, 'ENDTAB');

  // LAYER
  const layers = [...doc.layers.values()].filter((l) => !H.fromXref(l.name));
  // États de calques : dictionnaire étendu de la table (ACAD_LAYERSTATES), écrit avec les objets.
  H.layerXdict = doc.layerStates?.size ? w.handle() : null;
  tableStart(w, 'LAYER', H.tLayer, layers.length, null, H.layerXdict);
  LAYER_HANDLES = new Map();
  for (const l of layers) {
    LAYER_HANDLES.set(l.name, record(w, 'LAYER', H.tLayer, 'AcDbLayerTableRecord'));
    w.g(2, dep(l.name));
    w.g(70, (l.frozen ? 1 : 0) | (l.newVpFrozen ? 2 : 0) | (l.locked ? 4 : 0));
    const aci = l.color >= 1 && l.color <= 255 ? l.color : 7;
    w.g(62, l.on ? aci : -aci);
    if (typeof l.rgb === 'number') w.g(420, l.rgb);
    const lt = l.ltype && (/^continuous$/i.test(l.ltype) || doc.ltypes?.has(l.ltype.toUpperCase())) ? l.ltype : 'Continuous';
    w.g(6, dep(lt));
    // Le calque des points de définition des cotes ne doit jamais être tracé (exigé par AutoCAD).
    w.g(290, /^(defpoints|pointsdef)$/i.test(l.name) || l.plot === false ? 0 : 1);
    w.g(370, LWEIGHTS.has(l.lweight) ? l.lweight : -3);
    w.g(390, (PSTYLES && PSTYLES.get(String(l.pstyle || 'Normal').toLowerCase())?.handle) || H.plotStyleNormal); // style de tracé du calque (« Normal » par défaut, exigé par AutoCAD)
  }
  w.g(0, 'ENDTAB');

  // STYLE : styles de texte du dessin (police SHX ou TrueType, largeur, oblique), « Standard » compris.
  const styles = [...(doc.styles?.values() || [])].filter((st) => st?.name && !H.fromXref(st.name));
  if (!styles.some((st) => /^standard$/i.test(st.name))) styles.unshift({ name: 'Standard', font: 'arial.ttf', bigFont: '', widthFactor: 1, oblique: 0, height: 0 });
  STYLE_NAMES = new Set(styles.map((st) => st.name.toUpperCase()));
  tableStart(w, 'STYLE', H.tStyle, styles.length);
  for (const st of styles) {
    record(w, 'STYLE', H.tStyle, 'AcDbTextStyleTableRecord');
    w.g(2, dep(st.name)); w.g(70, 0); w.f(40, st.height || 0); w.f(41, st.widthFactor || 1); w.f(50, deg(st.oblique || 0));
    w.g(71, 0); w.f(42, 2.5); w.g(3, st.font || 'arial.ttf'); w.g(4, st.bigFont || '');
  }
  w.g(0, 'ENDTAB');

  tableStart(w, 'VIEW', H.tView, 0); w.g(0, 'ENDTAB');
  // UCS : SCU nommés.
  const ucsList = [...(doc.ucsTable?.values() || [])].filter((u) => u?.name);
  tableStart(w, 'UCS', H.tUcs, ucsList.length);
  for (const u of ucsList) {
    const ax = ucsAxes(u);
    record(w, 'UCS', H.tUcs, 'AcDbUCSTableRecord');
    w.g(2, dep(u.name)); w.g(70, 0); w.pt(10, [u.origin[0], u.origin[1], 0]); w.pt(11, ax.x); w.pt(12, ax.y); w.g(79, 0); w.f(146, 0);
  }
  w.g(0, 'ENDTAB');

  tableStart(w, 'APPID', H.tAppid, 1 + H.xdataApps + (H_BG ? 1 : 0));
  record(w, 'APPID', H.tAppid, 'AcDbRegAppTableRecord');
  w.g(2, 'ACAD'); w.g(70, 0);
  if (H_BG) { record(w, 'APPID', H.tAppid, 'AcDbRegAppTableRecord'); w.g(2, 'HATCHBACKGROUNDCOLOR'); w.g(70, 0); }
  for (let i = 0; i < H.xdataApps; i++) {
    record(w, 'APPID', H.tAppid, 'AcDbRegAppTableRecord');
    w.g(2, `${XDATA_PREFIX}${i}`); w.g(70, 0);
  }
  w.g(0, 'ENDTAB');

  tableStart(w, 'DIMSTYLE', H.tDimstyle, 1, () => { w.g(100, 'AcDbDimStyleTable'); w.g(71, 0); });
  record(w, 'DIMSTYLE', H.tDimstyle, 'AcDbDimStyleTableRecord', 105);
  w.g(2, 'Standard'); w.g(70, 0);
  {
    // Valeurs de l'appli (comme ISO-25 : texte au-dessus de la ligne de cote, aligné, point décimal, zéros de fin
    // supprimés) : AutoCAD redessine les cotes associatives avec ce style quand leurs objets bougent.
    const ds = dimStyleOf(doc);
    if (ds.DIMPOST) w.g(3, `<>${ds.DIMPOST}`);
    w.f(40, annoScaleOf(doc)); w.f(41, ds.DIMASZ); w.f(42, ds.DIMEXO); w.f(43, ds.DIMTXT * 1.5); w.f(44, ds.DIMEXE);
    w.f(140, ds.DIMTXT); w.f(142, ds.DIMBLK === 'oblique' ? ds.DIMASZ : 0); w.f(144, ds.DIMLFAC); w.f(147, ds.DIMGAP);
    w.g(73, 0); w.g(74, 0); w.g(77, 1); w.g(78, 8); w.g(271, ds.DIMDEC); w.g(278, 46);
  }
  w.g(0, 'ENDTAB');

  // BLOCK_RECORD
  tableStart(w, 'BLOCK_RECORD', H.tBlockRecord, 1 + H.layouts.length + blocks.length);
  const br = (handle, name, layout) => {
    w.g(0, 'BLOCK_RECORD'); w.g(5, handle);
    const so = H.sortents?.get(handle);
    if (so) { w.g(102, '{ACAD_XDICTIONARY'); w.g(360, so.xdict); w.g(102, '}'); }
    w.g(330, H.tBlockRecord);
    w.g(100, 'AcDbSymbolTableRecord'); w.g(100, 'AcDbBlockTableRecord');
    w.g(2, name); w.g(340, layout); w.g(70, 0); w.g(280, 1); w.g(281, 0);
  };
  br(H.brModel, '*Model_Space', H.layoutModel);
  for (const l of H.layouts) br(l.br, l.name, l.layout);
  for (const b of blocks) br(blockRecord.get(b.name), blockName(b.name), 0);
  w.g(0, 'ENDTAB');

  w.g(0, 'ENDSEC');
  H.blockRecord = blockRecord;
}

function writeBlocks(w, doc, H, blocks, blockRecord) {
  w.g(0, 'SECTION'); w.g(2, 'BLOCKS');
  const block = (owner, name, base, flags, entities, paper = false, path = '') => {
    w.g(0, 'BLOCK'); w.g(5, w.handle()); w.g(330, owner); w.g(100, 'AcDbEntity');
    if (paper) w.g(67, 1);
    w.g(8, '0'); w.g(100, 'AcDbBlockBegin'); w.g(2, name); w.g(70, flags);
    w.pt(10, base); w.g(3, name); w.g(1, path);
    for (const e of entities) writeEntity(w, e, owner, doc, paper);
    w.g(0, 'ENDBLK'); w.g(5, w.handle()); w.g(330, owner); w.g(100, 'AcDbEntity');
    if (paper) w.g(67, 1);
    w.g(8, '0'); w.g(100, 'AcDbBlockEnd');
  };
  block(H.brModel, '*Model_Space', [0, 0, 0], 0, []);
  H.layouts.forEach((l, i) => {
    if (i === 0) { block(l.br, l.name, [0, 0, 0], 0, [], true); return; }
    block(l.br, l.name, [0, 0, 0], 0, layoutEntities(doc, l, H), true);
  });
  for (const b of blocks) {
    if (fondAsXref(b)) { block(blockRecord.get(b.name), blockName(b.name), [0, 0, 0], 4, [], false, b.fond.source.path); continue; }
    // Le drapeau 1 (anonyme) est retiré puisque le nom devient explicite ; 4 (réf. externe) n'est pas conservé.
    const attFlag = b.entities.some((e) => e.type === 'ATTDEF') ? 2 : 0;
    const anon = DIM_BLOCKS.has(b.name) ? 1 : 0; // bloc d'une cote (*Dn) : reste anonyme
    block(blockRecord.get(b.name), blockName(b.name), b.base || [0, 0, 0], ((b.flags || 0) & ~(1 | 2 | 4 | 8 | 16 | 32)) | attFlag | anon, b.entities);
  }
  w.g(0, 'ENDSEC');
}

// Emprise des objets d'un espace (points caractéristiques), null s'il est vide.
function spaceBox(doc, space) {
  const b = G.emptyBox();
  for (const e of doc.entities.values()) {
    if (e.space !== space) continue;
    if (e.type === 'VIEWPORT') { G.growBox(b, e.c[0] - e.w / 2, e.c[1] - e.h / 2); G.growBox(b, e.c[0] + e.w / 2, e.c[1] + e.h / 2); continue; }
    for (const k of ['p1', 'p2', 'c', 'p']) if (e[k]) G.growBox(b, e[k][0], e[k][1]);
    for (const q of e.pts || []) G.growBox(b, q[0], q[1]);
  }
  return G.boxValid(b) ? b : null;
}

// Contenu d'une présentation précédé de sa fenêtre « feuille » (ID 1 pour l'active), indispensable :
// AutoCAD prend la première fenêtre d'une présentation pour la feuille elle-même (vue sur la feuille entière).
function layoutEntities(doc, l, H) {
  const ents = l.space ? inDrawOrder([...doc.entities.values()].filter((e) => e.space === l.space)) : [];
  const sh = l.sheet;
  const w = sh.w * 1.1, h = sh.h * 1.1;
  const c = [sh.origin[0] + sh.w / 2, sh.origin[1] + sh.h / 2, 0];
  const sheet = { type: 'VIEWPORT', layer: '0', color: 256, c, w, h, vc: [c[0], c[1]], vh: h, twist: 0, target: [0, 0], sheet: true };
  return [sheet, ...ents];
}

function writeEntities(w, doc, H) {
  w.g(0, 'SECTION'); w.g(2, 'ENTITIES');
  for (const e of inDrawOrder([...doc.entities.values()].filter((x) => x.space === 'model'))) {
    if (H.mepNames.has(e.id)) writeMep(w, e, H.brModel, false, H.mepNames.get(e.id));
    else writeEntity(w, e, H.brModel, doc, false);
  }
  // Présentation active : dans la section ENTITIES, marquée espace papier.
  const first = H.layouts[0];
  const ents = layoutEntities(doc, first, H);
  ents[0].vpId = 1;
  for (const e of ents) {
    if (H.mepNames.has(e.id)) writeMep(w, e, first.br, true, H.mepNames.get(e.id));
    else writeEntity(w, e, first.br, doc, true);
  }
  w.g(0, 'ENDSEC');
}

// Insertion du bloc dessiné de l'objet MEP + paramètres (JSON) en données étendues.
function writeMep(w, e, owner, paper, blockName) {
  common(w, { ...e, ltype: undefined }, 'INSERT', owner, paper); w.g(100, 'AcDbBlockReference');
  w.g(2, blockName); w.pt(10, [0, 0, 0]);
  w.f(41, 1); w.f(42, 1); w.f(43, 1); w.f(50, 0);
  writeXdata(w, e);
}

function writeXdata(w, e) {
  chunks(mepPayload(e)).forEach((chunk, i) => {
    w.g(1001, `${XDATA_PREFIX}${i}`);
    w.g(1000, chunk);
  });
}

function common(w, e, type, owner, paper, xdict = null, forced = null) {
  let h = forced;
  // Poignée réservée (hachure associative, tableau d'extraction) : pour l'objet lui-même, pas pour son SEQEND.
  if (e.id != null && type !== 'SEQEND' && H_ASSOC.has(e.id) && !String(H_ASSOC.get(e.id)).startsWith('*')) { h = H_ASSOC.get(e.id); H_ASSOC.set(e.id, `*${h}`); }
  if (!forced && (!h || String(h).startsWith('*'))) h = w.handle();
  if (type !== 'SEQEND') SORT_OWNERS.get(owner)?.handles.push(h); // ordre écrit (table de tri)
  w.g(0, type); w.g(5, h);
  if (xdict) { w.g(102, '{ACAD_XDICTIONARY'); w.g(360, xdict); w.g(102, '}'); }
  const grp = e.group && GROUPS.get(e.group);
  const reactors = [...(grp ? [grp.handle] : []), ...(type !== 'SEQEND' && e.id != null ? DIM_REACTORS.get(e.id) || [] : [])];
  if (reactors.length) { w.g(102, '{ACAD_REACTORS'); for (const r of reactors) w.g(330, r); w.g(102, '}'); }
  if (grp) grp.members.push(h);
  w.g(330, owner); w.g(100, 'AcDbEntity');
  if (paper) w.g(67, 1);
  w.g(8, dep(e.layer || '0'));
  if (e.ltype) w.g(6, dep(e.ltype));
  if (e.color != null && e.color !== 256) w.g(62, e.color);
  if (typeof e.rgb === 'number') w.g(420, e.rgb);
  if (e.lweight != null && e.lweight !== -1 && LWEIGHTS.has(e.lweight)) w.g(370, e.lweight);
  if (e.ltscale && e.ltscale !== 1) w.f(48, e.ltscale);
  const ps = PSTYLES && e.pstyle && type !== 'SEQEND' && PSTYLES.get(String(e.pstyle).toLowerCase());
  if (ps) w.g(390, ps.handle); // style de tracé nommé imposé à l'objet
  return h;
}

function writeEntity(w, e, owner, doc, paper) {
  switch (e.type) {
    case 'LINE':
      common(w, e, 'LINE', owner, paper); w.g(100, 'AcDbLine');
      w.pt(10, e.p1); w.pt(11, e.p2);
      break;
    case 'CIRCLE':
      common(w, e, 'CIRCLE', owner, paper); w.g(100, 'AcDbCircle');
      w.pt(10, e.c); w.f(40, e.r);
      break;
    case 'ARC':
      common(w, e, 'ARC', owner, paper); w.g(100, 'AcDbCircle');
      w.pt(10, e.c); w.f(40, e.r); w.g(100, 'AcDbArc');
      w.f(50, deg(G.normAngle(e.a0))); w.f(51, deg(G.normAngle(e.a1)));
      break;
    case 'LWPOLYLINE':
      if (e.mep) {
        // Objet MEP : écrit sous sa forme dessinée (double trait, étiquette).
        for (const x of mepToEntities(e)) writeEntity(w, x, owner, doc, paper);
        break;
      }
      common(w, e, 'LWPOLYLINE', owner, paper); w.g(100, 'AcDbPolyline');
      w.g(90, e.pts.length); w.g(70, e.closed ? 1 : 0);
      if (!e.widths) w.f(43, e.width || 0); // largeur constante : AutoCAD ignore les largeurs par sommet si 43 est présent
      if (e.z) w.f(38, e.z);
      e.pts.forEach((p, i) => {
        w.f(10, p[0]); w.f(20, p[1]);
        const wd = e.widths?.[i];
        if (wd && (wd[0] || wd[1])) { w.f(40, wd[0] || 0); w.f(41, wd[1] || 0); }
        if (e.bulges?.[i]) w.f(42, e.bulges[i]);
      });
      break;
    case 'POLY3D': {
      if (e.pts.every((p) => !p[2])) {
        writeEntity(w, { ...e, type: 'LWPOLYLINE', bulges: e.pts.map(() => 0), z: 0, width: 0 }, owner, doc, paper);
        break;
      }
      const h = common(w, e, 'POLYLINE', owner, paper);
      w.g(100, 'AcDb3dPolyline'); w.g(66, 1); w.pt(10, [0, 0, 0]); w.g(70, 8 | (e.closed ? 1 : 0));
      for (const p of e.pts) {
        common(w, e, 'VERTEX', h, paper); w.g(100, 'AcDbVertex'); w.g(100, 'AcDb3dPolylineVertex');
        w.pt(10, p); w.g(70, 32);
      }
      common(w, e, 'SEQEND', h, paper);
      break;
    }
    case 'ELLIPSE':
      common(w, e, 'ELLIPSE', owner, paper); w.g(100, 'AcDbEllipse');
      w.pt(10, e.c); w.pt(11, [e.major[0], e.major[1], 0]); w.pt(210, [0, 0, 1]);
      w.f(40, e.ratio); w.f(41, e.a0 ?? 0); w.f(42, e.a1 ?? G.TAU);
      break;
    case 'SPLINE': {
      const ctrl = e.ctrl || [], fit = e.fit || [];
      if (ctrl.length < 2 && fit.length >= 2) {
        // Spline définie seulement par ses points de lissage : écrite telle quelle (AutoCAD recalcule).
        common(w, e, 'SPLINE', owner, paper); w.g(100, 'AcDbSpline');
        w.pt(210, [0, 0, 1]);
        w.g(70, 8 | (e.closed ? 1 : 0)); w.g(71, e.degree || 3);
        w.g(72, 0); w.g(73, 0); w.g(74, fit.length);
        w.f(42, 1e-10); w.f(43, 1e-10); w.f(44, 1e-10);
        for (const p of fit) w.pt(11, p);
        break;
      }
      if (ctrl.length < 2 || (e.knots || []).length !== ctrl.length + e.degree + 1) {
        // Spline incomplète : on écrit sa forme tessellée.
        writeEntity(w, { ...e, type: 'POLY3D', pts: splineWorldPoints(e), closed: false }, owner, doc, paper);
        break;
      }
      common(w, e, 'SPLINE', owner, paper); w.g(100, 'AcDbSpline');
      w.pt(210, [0, 0, 1]);
      w.g(70, 8 | (e.closed ? 1 : 0) | (e.weights ? 4 : 0)); w.g(71, e.degree);
      w.g(72, e.knots.length); w.g(73, ctrl.length); w.g(74, fit.length);
      w.f(42, 1e-10); w.f(43, 1e-10);
      for (const k of e.knots) w.f(40, k);
      if (e.weights) for (const k of e.weights) w.f(41, k);
      for (const p of ctrl) w.pt(10, p);
      for (const p of fit) w.pt(11, p);
      break;
    }
    case 'POINT':
      common(w, e, 'POINT', owner, paper); w.g(100, 'AcDbPoint'); w.pt(10, e.p);
      break;
    case 'XLINE':
      common(w, e, e.ray ? 'RAY' : 'XLINE', owner, paper); w.g(100, e.ray ? 'AcDbRay' : 'AcDbXline');
      w.pt(10, e.p); w.f(11, e.dir[0]); w.f(21, e.dir[1]); w.f(31, 0);
      break;
    case 'SOLID':
      common(w, e, 'SOLID', owner, paper); w.g(100, 'AcDbTrace');
      e.pts.forEach((p, i) => w.pt(10 + i, [p[0], p[1], e.z || 0]));
      break;
    case 'ATTDEF':
      writeText(w, e, owner, paper, 'ATTDEF');
      break;
    case 'WIPEOUT': {
      // Comme AutoCAD : image d'un pixel (carré de l'emprise), contour en coordonnées du pixel (centre 0, y vers le bas).
      if (!(e.pts?.length >= 3)) break;
      const b = G.emptyBox();
      for (const q of e.pts) G.growBox(b, q[0], q[1]);
      const side = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 1, z = e.z || 0;
      common(w, e, 'WIPEOUT', owner, paper); w.g(100, 'AcDbWipeout'); w.g(90, 0);
      w.pt(10, [b.minX, b.minY, z]); w.pt(11, [side, 0, 0]); w.pt(12, [0, side, 0]); w.f(13, 1); w.f(23, 1);
      w.g(340, 0); w.g(70, 7); w.g(280, 1); w.g(281, 50); w.g(282, 50); w.g(283, 0); w.g(290, 0); w.g(360, 0);
      w.g(71, 2); w.g(91, e.pts.length + 1);
      for (const q of [...e.pts, e.pts[0]]) { w.f(14, (q[0] - b.minX) / side - 0.5); w.f(24, 0.5 - (q[1] - b.minY) / side); }
      break;
    }
    case 'TEXT':
      writeText(w, e, owner, paper, 'TEXT');
      break;
    case 'MTEXT': {
      const fx = e.field?.code ? w.handle() : null;
      const mh = common(w, e, 'MTEXT', owner, paper, fx); w.g(100, 'AcDbMText');
      if (fx) FIELD_TEXTS.push({ owner: mh, xdict: fx, e, mtext: true });
      w.pt(10, e.p); w.f(40, e.h); w.f(41, e.width || 0); w.g(71, e.attach || 1); w.g(72, 1);
      const chunks = e.text.match(/[\s\S]{1,250}/g) || [''];
      for (let i = 0; i < chunks.length - 1; i++) w.g(3, chunks[i]);
      w.g(1, chunks[chunks.length - 1]);
      w.g(7, styleName(e)); w.f(50, deg(e.rot || 0)); w.f(44, e.spacing || 1);
      break;
    }
    case 'INSERT': {
      const attribs = e.attribs || [];
      const clipped = e.clip?.pts?.length >= 3 && doc.blocks.has(e.name);
      const xdict = clipped ? w.handle() : null; // découpe : dictionnaire d'extension → ACAD_FILTER → SPATIAL
      const h = common(w, e, 'INSERT', owner, paper, xdict); w.g(100, 'AcDbBlockReference');
      if (clipped) H_CLIPS.push({ insert: h, xdict, e });
      if (attribs.length) w.g(66, 1);
      const dk = dynKey(doc, e);
      w.g(2, blockName(dk ? DYN_REPS.get(dk) : e.name)); w.pt(10, e.p);
      w.f(41, e.sx ?? 1); w.f(42, e.sy ?? 1); w.f(43, e.sz ?? 1); w.f(50, deg(e.rot || 0));
      if ((e.cols || 1) > 1 || (e.rows || 1) > 1) { w.g(70, e.cols || 1); w.g(71, e.rows || 1); w.f(44, e.dc || 0); w.f(45, e.dr || 0); }
      if (e.mep) writeXdata(w, e);
      else if (dk) chunks(e.elec ? ascii(JSON.stringify({ v: 1, elec: e.elec, dynref: dynRef(e) })) : dynPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
      else if (e.elec) chunks(elecPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
      else if (doc.blocks.get(e.name)?.fond) {
        chunks(fondPayload(doc.blocks.get(e.name).fond)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
      } else if (e.extract) chunks(extractPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
      if (attribs.length) {
        for (const a of attribs) writeText(w, a.dynHidden ? { ...a, invisible: true } : a, h, paper, 'ATTRIB', ATT_HANDLES.get(`${e.id}|${String(a.tag).toUpperCase()}`) || null);
        common(w, e, 'SEQEND', h, paper);
      }
      break;
    }
    case 'BLOCKREF': {
      if (e.kind === 'DIMENSION' && DIM_INFO.has(e.id)) { writeDimension(w, e, owner, paper); break; }
      // Cote d'un autre type ou tableau : sa géométrie (bloc anonyme) est écrite comme une insertion de bloc.
      const m = e.m;
      const sx = Math.hypot(m[0], m[1]) || 1;
      const sy = G.det(m) / sx;
      writeEntity(w, {
        ...e, type: 'INSERT', p: [m[4], m[5], 0], sx, sy, sz: 1, rot: Math.atan2(m[1], m[0]), attribs: [],
      }, owner, doc, paper);
      break;
    }
    case 'VIEWPORT': {
      if (!paper) break;
      // Fenêtre découpée : polyligne de contour (espace papier, réacteur vers la fenêtre), écrite juste avant.
      const clipped = e.clip?.length >= 3 && !e.sheet;
      const vh = clipped ? w.handle() : null, bh = clipped ? w.handle() : null;
      if (clipped) {
        w.g(0, 'LWPOLYLINE'); w.g(5, bh); w.g(102, '{ACAD_REACTORS'); w.g(330, vh); w.g(102, '}'); w.g(330, owner);
        w.g(100, 'AcDbEntity'); w.g(67, 1); w.g(8, dep(e.layer || '0')); w.g(100, 'AcDbPolyline');
        w.g(90, e.clip.length); w.g(70, 1); w.f(43, 0);
        for (const q of e.clip) { w.f(10, q[0]); w.f(20, q[1]); }
      }
      common(w, { ...e, ltype: e.ltype || 'ByLayer' }, 'VIEWPORT', owner, paper, null, vh); w.g(100, 'AcDbViewport');
      w.pt(10, [e.c[0], e.c[1], 0]); w.f(40, e.w); w.f(41, e.h);
      w.g(68, e.sheet ? 1 : 2); w.g(69, e.vpId ?? H_VP.next++);
      w.pt(12, e.vc, false); w.pt(13, [0, 0], false); w.pt(14, [10, 10], false); w.pt(15, [10, 10], false);
      w.pt(16, [0, 0, 1]); w.pt(17, [e.target?.[0] || 0, e.target?.[1] || 0, 0]);
      w.f(42, 50); w.f(43, 0); w.f(44, 0); w.f(45, e.vh); w.f(50, 0); w.f(51, ((e.twist || 0) * 180) / Math.PI); // angles DXF en degrés
      w.g(72, 1000);
      for (const name of e.frozen || []) { const lh = LAYER_HANDLES.get(name); if (lh) w.g(331, lh); } // calques gelés dans la fenêtre
      w.g(90, (e.off ? 0x20000 : 0) | (e.locked ? 0x4000 : 0) | (clipped ? 0x10000 : 0) | 0x8060);
      if (clipped) w.g(340, bh);
      w.g(1, ''); w.g(281, 0); w.g(71, 1); w.g(74, 0);
      w.pt(110, [0, 0, 0]); w.pt(111, [1, 0, 0]); w.pt(112, [0, 1, 0]); w.g(79, 0); w.f(146, 0);
      w.g(170, 0); w.g(61, 5); w.g(292, 1); w.g(282, 1); w.f(141, 0); w.f(142, 0); w.g(63, 250);
      if (vpSettings(e)) chunks(vpPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
      break;
    }
    case 'HATCH':
      writeHatch(w, e, owner, paper);
      break;
    case 'UNDERLAY':
      writeUnderlay(w, e, owner, paper, doc);
      break;
  }
}

// Vraie cote d'AutoCAD (DIMENSION) : points de définition, bloc de sa géométrie (*Dn), mesure, texte imposé, style.
// Avec ses objets accrochés : dictionnaire d'extension → DIMASSOC (écrits avec les objets du fichier).
function writeDimension(w, e, owner, paper) {
  const info = DIM_INFO.get(e.id);
  const d = info.def, meta = e.meta || {};
  const h = common(w, e, 'DIMENSION', owner, paper, info.xdict);
  info.dim = h;
  const blk = DOC.blocks.get(e.name);
  const t = blk?.entities.find((x) => x.type === 'TEXT' || x.type === 'MTEXT');
  const text = meta.textPoint ? G.applyPt(info.m, meta.textPoint) : t ? G.applyPt(info.m, t.p) : d.p15 || G.mid(d.p13, d.p14);
  let measure = d.measure;
  if (measure == null) {
    const u = [Math.cos(d.rotation), Math.sin(d.rotation)];
    measure = d.kind === 'aligned' ? G.dist(d.p13, d.p14) : Math.abs(G.dot(G.sub(d.p14, d.p13), u));
  }
  w.g(100, 'AcDbDimension'); w.g(2, info.block); // pas de 280 (version) : refusé par AutoCAD dans un DXF 2007
  w.pt(10, d.p10); w.pt(11, text);
  w.g(70, { linear: 0, aligned: 1, diameter: 3, radius: 4 }[d.kind] | 32 | (meta.userText ? 128 : 0));
  w.g(71, 5); w.f(42, measure);
  if (meta.text && meta.text !== '<>') w.g(1, meta.text);
  w.g(3, 'Standard');
  if (d.kind === 'linear' || d.kind === 'aligned') {
    w.g(100, 'AcDbAlignedDimension'); w.pt(13, d.p13); w.pt(14, d.p14);
    if (d.kind === 'linear') { w.f(50, deg(d.rotation)); w.g(100, 'AcDbRotatedDimension'); }
  } else {
    w.g(100, d.kind === 'radius' ? 'AcDbRadialDimension' : 'AcDbDiametricDimension'); w.pt(15, d.p15); w.f(40, 0);
  }
}

// Objets accrochés des cotes (DIMASSOC dans le dictionnaire d'extension de chaque cote).
function writeDimAssocObjects(w) {
  for (const info of DIM_INFO.values()) {
    if (!info.assoc || !info.dim) continue;
    const refs = info.refs.map((r) => ({ ...r, handle: String(H_ASSOC.get(r.id) || '') })).filter((r) => r.handle.startsWith('*'));
    w.g(0, 'DICTIONARY'); w.g(5, info.xdict); w.g(330, info.dim); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
    w.g(3, 'ACAD_DIMASSOC'); w.g(360, info.assoc);
    w.g(0, 'DIMASSOC'); w.g(5, info.assoc); w.g(102, '{ACAD_REACTORS'); w.g(330, info.xdict); w.g(102, '}'); w.g(330, info.xdict);
    w.g(100, 'AcDbDimAssoc'); w.g(330, info.dim); w.g(90, refs.reduce((b, r) => b | (1 << r.bit), 0)); w.g(70, 0); w.g(71, 0);
    for (const r of refs.sort((a, b) => a.bit - b.bit)) {
      w.g(1, 'AcDbOsnapPointRef'); w.g(72, r.osnap); w.g(331, r.handle.slice(1)); w.g(73, 2); w.g(91, r.gs); w.f(40, r.param);
      w.f(10, 0); w.f(20, 0); w.f(30, r.osnap === 1 || r.osnap === 13 ? 2e50 : 0); w.g(75, 0);
    }
  }
}

function writeText(w, e, owner, paper, type, forced = null) {
  const xdict = e.field?.code ? w.handle() : null; // champ : dictionnaire d'extension → ACAD_FIELD
  const h = common(w, e, type, owner, paper, xdict, forced); w.g(100, 'AcDbText');
  if (xdict) FIELD_TEXTS.push({ owner: h, xdict, e, mtext: false });
  w.pt(10, e.p); w.f(40, e.h); w.g(1, e.text ?? ''); w.f(50, deg(e.rot || 0));
  if (e.wf && e.wf !== 1) w.f(41, e.wf);
  if (e.obl) w.f(51, deg(e.obl));
  w.g(7, styleName(e));
  const hc = H_CODE[e.align] ?? 0, vc = V_CODE[e.valign] ?? 0;
  if (hc || vc) { w.g(72, hc); w.pt(11, e.p); }
  if (type === 'ATTRIB') {
    w.g(100, 'AcDbAttribute'); w.g(280, 0); w.g(2, e.tag || 'ATTRIBUT'); w.g(70, e.invisible ? 1 : 0);
    if (vc) w.g(74, vc);
  } else if (type === 'ATTDEF') {
    w.g(100, 'AcDbAttributeDefinition'); w.g(280, 0); w.g(3, e.prompt || ''); w.g(2, e.tag || 'ATTRIBUT'); w.g(70, e.invisible ? 1 : 0);
    if (vc) w.g(74, vc);
  } else {
    w.g(100, 'AcDbText');
    if (vc) w.g(73, vc);
  }
}

// Données étendues d'une hachure associative : objets sources (poignées), points intérieurs, mode.
// Tableau d'extraction (EXTRACTATT) : réglages, sélection d'origine en poignées.
function extractPayload(e) {
  const { ids, ...x } = e.extract;
  const handles = (ids || []).map((id) => String(H_ASSOC.get(id) || '').replace('*', '')).filter(Boolean);
  return ascii(JSON.stringify({ v: 1, extract: { ...x, handles } }));
}

function hatchPayload(e) {
  const a = e.assoc || {};
  const handles = (a.ids || []).map((id) => String(H_ASSOC.get(id) || '').replace('*', '')).filter(Boolean);
  return ascii(JSON.stringify({ v: 1, hatch: { assoc: { mode: a.mode, handles, seeds: a.seeds, islands: a.islands } } }));
}
// Type de motif (76) : 1 = motif d'AutoCAD (acad.pat / acadiso.pat), 2 = motif d'un autre fichier, 0 = utilisateur.
const ACAD_PATTERNS = new Set(['ANSI31', 'ANSI37']);
function patternType(e) {
  if (/^(acad|acadiso)\.pat$/i.test(e.patSource || '') || ACAD_PATTERNS.has(String(e.pattern).toUpperCase())) return 1;
  return e.pattern && !/^user$/i.test(e.pattern) ? 2 : 0;
}

function writeHatch(w, e, owner, paper) {
  common(w, e, 'HATCH', owner, paper); w.g(100, 'AcDbHatch');
  w.pt(10, [0, 0, e.z || 0]); w.pt(210, [0, 0, 1]);
  const solid = !!e.solid || !(e.lines || []).length;
  w.g(2, solid ? 'SOLID' : (e.pattern || 'USER'));
  w.g(70, solid ? 1 : 0); w.g(71, 0);
  const loops = e.loops.filter((l) => l.length >= 3);
  w.g(91, loops.length);
  for (const loop of loops) {
    w.g(92, 2); w.g(72, 0); w.g(73, 1); w.g(93, loop.length);
    for (const p of loop) { w.f(10, p[0]); w.f(20, p[1]); }
    w.g(97, 0);
  }
  w.g(75, e.assoc?.islands === 'ignorer' ? 2 : 0); w.g(76, solid ? 1 : patternType(e));
  if (!solid) {
    w.f(52, deg(e.patAngle || 0)); w.f(41, e.patScale || 1); w.g(77, 0);
    w.g(78, e.lines.length);
    for (const l of e.lines) {
      w.f(53, deg(l.angle)); w.f(43, l.base[0]); w.f(44, l.base[1]); w.f(45, l.offset[0]); w.f(46, l.offset[1]);
      w.g(79, l.dashes.length);
      for (const d of l.dashes) w.f(49, d);
    }
  }
  // Points intérieurs (ceux du contour d'origine, sinon aucun).
  const seeds = e.assoc?.seeds || [];
  w.g(98, seeds.length);
  for (const q of seeds) { w.f(10, q[0]); w.f(20, q[1]); }
  if (e.bg != null && !solid) { w.g(1001, 'HATCHBACKGROUNDCOLOR'); w.g(1071, (0xc3000000 | (e.bg & 0xff)) | 0); }
  if (e.assoc) chunks(hatchPayload(e)).forEach((chunk, i) => { w.g(1001, `${XDATA_PREFIX}${i}`); w.g(1000, chunk); });
}

function writeObjects(w, doc, H) {
  w.g(0, 'SECTION'); w.g(2, 'OBJECTS');
  w.g(0, 'DICTIONARY'); w.g(5, H.root); w.g(330, 0); w.g(100, 'AcDbDictionary'); w.g(281, 1);
  w.g(3, 'ACAD_GROUP'); w.g(350, H.groupDict);
  w.g(3, 'ACAD_LAYOUT'); w.g(350, H.layoutDict);
  w.g(3, 'ACAD_PLOTSTYLENAME'); w.g(350, H.plotStyleDict);
  if (H.dynDict) { w.g(3, 'CV_BLOCS_DYNAMIQUES'); w.g(350, H.dynDict); }
  if (H.elecData) { w.g(3, 'CV_DONNEES_ELEC'); w.g(350, H.elecData.handle); }
  if (H.ul.imageDict) { w.g(3, 'ACAD_IMAGE_DICT'); w.g(350, H.ul.imageDict); w.g(3, 'ACAD_IMAGE_VARS'); w.g(350, H.ul.rasterVars); }
  if (H.ul.pdfDict) { w.g(3, 'ACAD_PDFDEFINITIONS'); w.g(350, H.ul.pdfDict); }
  if (H.wipe) { w.g(3, 'ACAD_WIPEOUT_VARS'); w.g(350, H.wipe.vars); w.g(3, 'AcDbVariableDictionary'); w.g(350, H.wipe.varDict); }
  if (H.fieldList) { w.g(3, 'ACAD_FIELDLIST'); w.g(350, H.fieldList); }
  writeUnderlayObjects(w, H);
  writeFieldObjects(w, doc, H);
  writeDimAssocObjects(w);
  writeDrawOrderObjects(w, doc, H);
  writeClipObjects(w);
  writeLayerStates(w, doc, H);
  w.g(0, 'DICTIONARY'); w.g(5, H.groupDict); w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1);
  for (const [name, g] of GROUPS) if (g.members.length) { w.g(3, dep(name)); w.g(350, g.handle); }
  for (const [name, g] of GROUPS) {
    if (!g.members.length) continue;
    w.g(0, 'GROUP'); w.g(5, g.handle);
    w.g(102, '{ACAD_REACTORS'); w.g(330, H.groupDict); w.g(102, '}');
    w.g(330, H.groupDict); w.g(100, 'AcDbGroup'); w.g(300, ''); w.g(70, 0); w.g(71, 1);
    for (const m of g.members) w.g(340, m);
  }
  if (H.elecData) {
    w.g(0, 'XRECORD'); w.g(5, H.elecData.handle);
    w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}');
    w.g(330, H.root); w.g(100, 'AcDbXrecord'); w.g(280, 1);
    for (const c of chunks(H.elecData.json)) w.g(1, c);
  }
  if (H.dynDict) {
    w.g(0, 'DICTIONARY'); w.g(5, H.dynDict); w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1);
    for (const d of H.dynDefs) { w.g(3, d.name); w.g(350, d.handle); }
    for (const d of H.dynDefs) {
      w.g(0, 'XRECORD'); w.g(5, d.handle);
      w.g(102, '{ACAD_REACTORS'); w.g(330, H.dynDict); w.g(102, '}');
      w.g(330, H.dynDict); w.g(100, 'AcDbXrecord'); w.g(280, 1);
      for (const c of chunks(d.json)) w.g(1, c);
    }
  }
  w.g(0, 'DICTIONARY'); w.g(5, H.layoutDict); w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1);
  for (const l of H.layouts) { w.g(3, l.label); w.g(350, l.layout); }
  w.g(3, 'Model'); w.g(350, H.layoutModel);
  w.g(0, 'ACDBDICTIONARYWDFLT'); w.g(5, H.plotStyleDict); w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1);
  const styles = PSTYLES ? [...PSTYLES.values()] : [{ name: 'Normal', handle: H.plotStyleNormal }];
  for (const st of styles) { w.g(3, st.name); w.g(350, st.handle); }
  w.g(100, 'AcDbDictionaryWithDefault'); w.g(340, H.plotStyleNormal);
  for (const st of styles.slice(1)) {
    w.g(0, 'ACDBPLACEHOLDER'); w.g(5, st.handle);
    w.g(102, '{ACAD_REACTORS'); w.g(330, H.plotStyleDict); w.g(102, '}'); w.g(330, H.plotStyleDict);
  }
  w.g(0, 'ACDBPLACEHOLDER'); w.g(5, H.plotStyleNormal);
  w.g(102, '{ACAD_REACTORS'); w.g(330, H.plotStyleDict); w.g(102, '}'); w.g(330, H.plotStyleDict);
  const box = extentsOf(doc);
  // Mise en page : périphérique « Aucun » avec le format de la feuille (AutoCAD affiche alors cette feuille),
  // marges, origine de tracé (le coin de la feuille garde ses coordonnées), échelle 1:1, style monochrome.
  const layout = (handle, name, flags, tab, brHandle, sh, space = 'model') => {
    w.g(0, 'LAYOUT'); w.g(5, handle);
    w.g(102, '{ACAD_REACTORS'); w.g(330, H.layoutDict); w.g(102, '}');
    w.g(330, H.layoutDict);
    w.g(100, 'AcDbPlotSettings');
    const m = sh?.margins || [0, 0, 0, 0];
    const paperName = sh ? `${FORMATS[sh.paper] ? `ISO_full_bleed_${sh.paper}` : 'Personnalise'}_(${sh.w.toFixed(2)}_x_${sh.h.toFixed(2)}_MM)` : '';
    w.g(1, ''); w.g(2, 'none_device'); w.g(4, paperName); w.g(6, '');
    w.f(40, m[0]); w.f(41, m[1]); w.f(42, m[2]); w.f(43, m[3]);
    w.f(44, sh ? sh.w : 0); w.f(45, sh ? sh.h : 0);
    w.f(46, sh ? -(sh.origin[0] + m[0]) : 0); w.f(47, sh ? -(sh.origin[1] + m[1]) : 0);
    for (const c of [48, 49, 140, 141]) w.f(c, 0);
    w.f(142, 1); w.f(143, 1);
    w.g(70, 688); w.g(72, 1); w.g(73, 0); w.g(74, 5); w.g(7, sh ? (sh.ctb !== undefined ? sh.ctb : sh.mono !== false ? (doc.header?.pstylemode === 0 ? 'monochrome.stb' : 'monochrome.ctb') : '') : (doc.header?.plotModel?.ctb || '')); w.g(75, 16); w.f(147, 1);
    w.g(76, 0); w.g(77, 2); w.g(78, 300); w.f(148, 0); w.f(149, 0);
    w.g(100, 'AcDbLayout');
    w.g(1, name); w.g(70, flags); w.g(71, tab);
    if (sh) { w.pt(10, sh.origin, false); w.pt(11, [sh.origin[0] + sh.w, sh.origin[1] + sh.h], false); } else { w.pt(10, [0, 0], false); w.pt(11, [420, 297], false); }
    w.pt(12, [0, 0, 0]);
    w.pt(14, [box.minX, box.minY, 0]); w.pt(15, [box.maxX, box.maxY, 0]);
    // SCU de la présentation (origine, axes X et Y).
    const u = ucsOf(doc, space), ax = ucsAxes(u);
    w.f(146, 0); w.pt(13, [u.origin[0], u.origin[1], 0]); w.pt(16, ax.x); w.pt(17, ax.y);
    w.g(76, 0); w.g(330, brHandle);
  };
  layout(H.layoutModel, 'Model', 1, 0, H.brModel, null);
  H.layouts.forEach((l, i) => layout(l.layout, l.label, 1, i + 1, l.br, l.sheet, l.space || '*none*'));
  w.g(0, 'ENDSEC');
}

// Champs, comme AutoCAD : dictionnaire d'extension du texte → ACAD_FIELD → TEXT → champ racine « _text » (texte
// avec %<\_FldIdx n>%) → un champ enfant par expression (AcVar, AcObjProp et ses objets cités) ; valeurs en cache
// et somme de contrôle du texte ; liste de tous les champs (FIELDLIST).
function writeFieldObjects(w, doc, H) {
  if (!FIELD_TEXTS.length) return;
  const value = (v, fmt, formatted) => {
    w.g(7, 'ACFD_FIELD_VALUE'); w.g(93, 4);
    if (typeof v === 'number') { w.g(90, 2); w.f(140, v); } else if (v instanceof Date) {
      // SYSTEMTIME (année, mois, jour de la semaine, jour, heure, minute, seconde, ms) en octets petit-boutistes.
      const parts = [v.getFullYear(), v.getMonth() + 1, v.getDay(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), 0];
      w.g(90, 8); w.g(92, 16); w.g(310, parts.map((n) => [(n & 255), (n >> 8) & 255].map((b) => b.toString(16).padStart(2, '0')).join('')).join('').toUpperCase());
    } else { w.g(90, 4); w.g(1, String(v ?? '')); }
    w.g(94, 0); w.g(300, fmt || ''); w.g(302, formatted); w.g(304, 'ACVALUE_END');
    w.g(301, formatted); w.g(98, formatted.length);
  };
  for (const { owner, xdict, e, mtext } of FIELD_TEXTS) {
    const d2 = w.handle(), root = w.handle();
    const parts = parseCode(e.field.code);
    const exprs = parts.filter((p) => p.expr).map((p) => ({ ...p.expr, handle: w.handle() }));
    let k = 0;
    const template = parts.map((p) => (p.text != null ? p.text : `%<\\_FldIdx ${k++}>%`)).join('');
    FIELD_HANDLES.push(root, ...exprs.map((x) => x.handle));
    w.g(0, 'DICTIONARY'); w.g(5, xdict); w.g(330, owner); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
    w.g(3, 'ACAD_FIELD'); w.g(360, d2);
    w.g(0, 'DICTIONARY'); w.g(5, d2); w.g(102, '{ACAD_REACTORS'); w.g(330, xdict); w.g(102, '}');
    w.g(330, xdict); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1); w.g(3, 'TEXT'); w.g(360, root);
    w.g(0, 'FIELD'); w.g(5, root); w.g(102, '{ACAD_REACTORS'); w.g(330, d2); w.g(102, '}'); w.g(330, d2);
    w.g(100, 'AcDbField'); w.g(1, '_text'); w.g(2, template); w.g(90, exprs.length);
    for (const x of exprs) w.g(360, x.handle);
    w.g(97, 0); w.g(91, 63); w.g(92, 0); w.g(94, mtext ? 13 : 9); w.g(95, 2); w.g(96, 0); w.g(300, '');
    w.g(93, 1); w.g(6, 'ACFD_FIELDTEXT_CHECKSUM'); w.g(93, 2); w.g(90, 2); w.f(140, checksum(String(e.text ?? '')));
    w.g(94, 0); w.g(300, ''); w.g(302, ''); w.g(304, 'ACVALUE_END');
    w.g(7, 'ACFD_FIELD_VALUE'); w.g(93, 3); w.g(90, 0); w.g(94, 0); w.g(300, ''); w.g(302, ''); w.g(304, 'ACVALUE_END');
    w.g(301, ''); w.g(98, 0);
    for (const x of exprs) {
      const formatted = evaluateExpr(doc, e, x, {});
      w.g(0, 'FIELD'); w.g(5, x.handle); w.g(330, root); w.g(100, 'AcDbField');
      if (x.kind === 'var') {
        w.g(1, 'AcVar'); w.g(2, x.raw); w.g(90, 0); w.g(97, 0); w.g(91, /^date$/i.test(x.name) ? 32 : 63); w.g(92, 0); w.g(94, 59); w.g(95, 2); w.g(96, 0); w.g(300, '');
        w.g(93, 1); w.g(6, 'Variable'); w.g(93, 2); w.g(90, 4); w.g(1, x.name); w.g(94, 0); w.g(300, ''); w.g(302, ''); w.g(304, 'ACVALUE_END');
        const n = x.name.toLowerCase();
        const date = n === 'date' ? new Date() : n === 'savedate' ? (doc.header?.saveDate ? new Date(doc.header.saveDate) : new Date()) : n === 'plotdate' && doc.header?.plotDate ? new Date(doc.header.plotDate) : null;
        value(date || (n === 'filename' ? (doc.fileName || formatted) : formatted), x.format, formatted);
      } else if (x.kind === 'prop') {
        const ref = e.field.refs?.[x.idx];
        const target = ref && doc.get(ref.id);
        const handle = !target ? '0' : ref.tag != null ? ATT_HANDLES.get(`${ref.id}|${String(ref.tag).toUpperCase()}`) : String(H_ASSOC.get(ref.id) || '').replace('*', '');
        const raw = x.raw.replace(/%<\\_ObjIdx\s+\d+>%/, '%<\\_ObjIdx 0>%');
        w.g(1, 'AcObjProp'); w.g(2, raw); w.g(90, 0); w.g(97, 1); w.g(331, handle || '0');
        w.g(91, 63); w.g(92, 0); w.g(94, 59); w.g(95, 2); w.g(96, 0); w.g(300, '');
        w.g(93, 2); w.g(6, 'ObjectPropertyId'); w.g(93, 2); w.g(90, 64); w.g(330, handle || '0'); w.g(94, 0); w.g(300, ''); w.g(302, ''); w.g(304, 'ACVALUE_END');
        w.g(6, 'ObjectPropertyName'); w.g(93, 2); w.g(90, 4); w.g(1, x.prop); w.g(94, 0); w.g(300, ''); w.g(302, ''); w.g(304, 'ACVALUE_END');
        const p = x.prop.toLowerCase();
        const num = p === 'customscale' && target?.vh > 0 ? target.h / target.vh : null;
        value(num ?? formatted, x.format, formatted);
      } else {
        w.g(1, ''); w.g(2, x.raw); w.g(90, 0); w.g(97, 0); w.g(91, 63); w.g(92, 0); w.g(94, 59); w.g(95, 2); w.g(96, 0); w.g(300, ''); w.g(93, 0);
        value(formatted, x.format, formatted);
      }
    }
  }
  w.g(0, 'FIELDLIST'); w.g(5, H.fieldList); w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}'); w.g(330, H.root);
  w.g(100, 'AcDbIdSet'); w.g(90, FIELD_HANDLES.length);
  for (const h of FIELD_HANDLES) w.g(330, h);
  w.g(100, 'AcDbFieldList');
}

// Variables des masques (cadres : WIPEOUTFRAME, 0 cachés, 1 affichés et tracés, 2 affichés non tracés) et tables
// de tri des espaces (ordre écrit → poignées triées attribuées dans cet ordre, seules les différences écrites).
function writeDrawOrderObjects(w, doc, H) {
  if (H.wipe) {
    const frame = doc.header?.wipeoutFrame ?? 1;
    w.g(0, 'WIPEOUTVARIABLES'); w.g(5, H.wipe.vars); w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}');
    // AutoCAD ne relit WIPEOUTFRAME (2 : affichés non tracés) que dans un DXF 2018 : pour ce DXF 2007, il prend ce
    // drapeau ; « affichés non tracés » y est écrit « cachés » (jamais tracés), l'appli relit la variable.
    w.g(330, H.root); w.g(100, 'AcDbWipeoutVariables'); w.g(70, frame === 1 ? 1 : 0);
    w.g(0, 'DICTIONARY'); w.g(5, H.wipe.varDict); w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}');
    w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1); w.g(3, 'WIPEOUTFRAME'); w.g(350, H.wipe.frame);
    w.g(0, 'DICTIONARYVAR'); w.g(5, H.wipe.frame); w.g(102, '{ACAD_REACTORS'); w.g(330, H.wipe.varDict); w.g(102, '}');
    w.g(330, H.wipe.varDict); w.g(100, 'DictionaryVariables'); w.g(280, 0); w.g(1, String(frame));
  }
  for (const [br, so] of H.sortents || []) {
    const sorted = [...so.handles].sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    w.g(0, 'DICTIONARY'); w.g(5, so.xdict); w.g(330, br); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
    w.g(3, 'ACAD_SORTENTS'); w.g(360, so.table);
    w.g(0, 'SORTENTSTABLE'); w.g(5, so.table); w.g(102, '{ACAD_REACTORS'); w.g(330, so.xdict); w.g(102, '}');
    w.g(330, so.xdict); w.g(100, 'AcDbSortentsTable'); w.g(330, br);
    so.handles.forEach((h, i) => { if (h !== sorted[i]) { w.g(331, h); w.g(5, sorted[i]); } });
  }
}

// États de calques, comme AutoCAD : dictionnaire étendu de la table LAYER → ACAD_LAYERSTATES → un XRECORD par état
// (calques et types de ligne désignés par leur poignée).
function writeLayerStates(w, doc, H) {
  if (!H.layerXdict) return;
  const dict = w.handle();
  const states = [...doc.layerStates.values()].map((st) => ({ st, handle: w.handle() }));
  w.g(0, 'DICTIONARY'); w.g(5, H.layerXdict); w.g(330, H.tLayer); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
  w.g(3, 'ACAD_LAYERSTATES'); w.g(360, dict);
  w.g(0, 'DICTIONARY'); w.g(5, dict); w.g(102, '{ACAD_REACTORS'); w.g(330, H.layerXdict); w.g(102, '}');
  w.g(330, H.layerXdict); w.g(100, 'AcDbDictionary'); w.g(281, 1);
  for (const { st, handle } of states) { w.g(3, dep(st.name)); w.g(350, handle); }
  const layerHandle = (name) => LAYER_HANDLES.get(name) || [...LAYER_HANDLES].find(([n]) => n.toUpperCase() === name.toUpperCase())?.[1];
  const ltypeHandle = (name) => LTYPE_HANDLES.get(String(name || 'Continuous').toUpperCase()) || LTYPE_HANDLES.get('CONTINUOUS');
  for (const { st, handle } of states) {
    w.g(0, 'XRECORD'); w.g(5, handle); w.g(102, '{ACAD_REACTORS'); w.g(330, dict); w.g(102, '}');
    w.g(330, dict); w.g(100, 'AcDbXrecord'); w.g(280, 1);
    const current = layerHandle(st.current || '0') ? st.current : '0';
    for (const [code, value] of xrecordGroups({ ...st, current }, layerHandle, ltypeHandle)) {
      w.g(code, code === 302 ? dep(String(value)) : value);
    }
  }
}

// Découpes des insertions : dictionnaires (ACAD_FILTER → SPATIAL), filtre spatial (contour dans le monde, matrice
// inverse de l'insertion), et pour une découpe inversée le contour d'origine (ACAD_XREC_ROUNDTRIP), comme AutoCAD.
function writeClipObjects(w) {
  for (const c of H_CLIPS) {
    // Emprise du bloc (monde) pour le contour extérieur d'une découpe inversée.
    let extent = null;
    if (c.e.clip.invert) {
      const b = partsBox(new Tessellator(DOC).entity({ ...c.e, clip: null, attribs: [] }));
      if (Number.isFinite(b.minX)) extent = b;
    }
    const { world, inverse, filterPts } = clipForWrite(DOC, c.e, extent);
    const d2 = w.handle(), f = w.handle();
    const fd = c.e.clip.invert ? w.handle() : null, xr = c.e.clip.invert ? w.handle() : null;
    w.g(0, 'DICTIONARY'); w.g(5, c.xdict); w.g(330, c.insert); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
    w.g(3, 'ACAD_FILTER'); w.g(360, d2);
    w.g(0, 'DICTIONARY'); w.g(5, d2); w.g(102, '{ACAD_REACTORS'); w.g(330, c.xdict); w.g(102, '}');
    w.g(330, c.xdict); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1); w.g(3, 'SPATIAL'); w.g(360, f);
    w.g(0, 'SPATIAL_FILTER'); w.g(5, f);
    if (fd) { w.g(102, '{ACAD_XDICTIONARY'); w.g(360, fd); w.g(102, '}'); }
    w.g(102, '{ACAD_REACTORS'); w.g(330, d2); w.g(102, '}'); w.g(330, d2);
    w.g(100, 'AcDbFilter'); w.g(100, 'AcDbSpatialFilter');
    w.g(70, filterPts.length);
    for (const q of filterPts) { w.f(10, q[0]); w.f(20, q[1]); }
    w.pt(210, [0, 0, 1]); w.pt(11, [0, 0, 0]);
    w.g(71, c.e.clip.off ? 0 : 1); w.g(72, 0); w.g(73, 0);
    for (const v of inverse) w.f(40, v);
    for (const v of [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) w.f(40, v);
    if (fd) {
      w.g(0, 'DICTIONARY'); w.g(5, fd); w.g(330, f); w.g(100, 'AcDbDictionary'); w.g(280, 1); w.g(281, 1);
      w.g(3, 'ACAD_XREC_ROUNDTRIP'); w.g(360, xr);
      w.g(0, 'XRECORD'); w.g(5, xr); w.g(102, '{ACAD_REACTORS'); w.g(330, fd); w.g(102, '}'); w.g(330, fd);
      w.g(100, 'AcDbXrecord'); w.g(280, 1);
      w.g(102, 'ACAD_INVERTEDCLIP_ROUNDTRIP');
      for (const q of world) w.pt(10, [q[0], q[1], 0]);
      w.g(102, 'ACAD_INVERTEDCLIP_ROUNDTRIP_COMPARE');
      for (const q of filterPts) w.pt(10, [q[0], q[1], 0]);
    }
  }
}

// Définitions des fonds (PDFDEFINITION, IMAGEDEF), leurs dictionnaires, réacteurs des images, variables raster.
function writeUnderlayObjects(w, H) {
  const ul = H.ul;
  const defs = [...ul.defs.values()];
  const dict = (handle, kind) => {
    w.g(0, 'DICTIONARY'); w.g(5, handle); w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}');
    w.g(330, H.root); w.g(100, 'AcDbDictionary'); w.g(281, 1);
    for (const d of defs.filter((x) => x.kind === kind)) { w.g(3, d.name); w.g(350, d.handle); }
  };
  if (ul.pdfDict) {
    dict(ul.pdfDict, 'pdf');
    for (const d of defs.filter((x) => x.kind === 'pdf')) {
      w.g(0, 'PDFDEFINITION'); w.g(5, d.handle);
      w.g(102, '{ACAD_REACTORS'); w.g(330, ul.pdfDict); for (const r of d.refs) w.g(330, r); w.g(102, '}');
      w.g(330, ul.pdfDict); w.g(100, 'AcDbUnderlayDefinition'); w.g(1, d.path); w.g(2, String(d.page));
    }
  }
  if (ul.imageDict) {
    dict(ul.imageDict, 'image');
    w.g(0, 'RASTERVARIABLES'); w.g(5, ul.rasterVars); w.g(102, '{ACAD_REACTORS'); w.g(330, H.root); w.g(102, '}');
    w.g(330, H.root); w.g(100, 'AcDbRasterVariables'); w.g(90, 0); w.g(70, 1); w.g(71, 1); w.g(72, 1);
    for (const d of defs.filter((x) => x.kind === 'image')) {
      w.g(0, 'IMAGEDEF'); w.g(5, d.handle);
      w.g(102, '{ACAD_REACTORS'); w.g(330, ul.imageDict); for (const r of d.refs) w.g(330, r); w.g(102, '}');
      w.g(330, ul.imageDict); w.g(100, 'AcDbRasterImageDef'); w.g(90, 0); w.g(1, d.path);
      w.f(10, d.native?.[0] || 1); w.f(20, d.native?.[1] || 1);
      w.f(11, d.pixel || 1); w.f(21, d.pixel || 1); w.g(280, 1); w.g(281, d.pixel && d.pixel !== 1 ? 2 : 0);
    }
    for (const r of ul.reactors) {
      w.g(0, 'IMAGEDEF_REACTOR'); w.g(5, r.handle); w.g(330, r.image); w.g(100, 'AcDbRasterImageDefReactor'); w.g(90, 2); w.g(330, r.image);
    }
  }
}

// Nom de fichier suggéré pour l'enregistrement.
export function dxfFileName(name) {
  return `${(name || 'dessin').replace(/\.(dwg|dxf)$/i, '')}.dxf`;
}
