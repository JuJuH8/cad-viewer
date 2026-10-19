// SPDX-License-Identifier: GPL-3.0-or-later
// Import : DwgDatabase (LibreDWG, ou DXF passé par dxf-adapter) → Document éditable.
import { applyAcadDynamic, dwgInsertInfo } from '../blocks/acad-dynamic.js';
import { assocFromAcad } from '../core/dimassoc.js';
import { julianToDate } from '../core/fields.js';
import { ucsFromAxes, isWorld } from '../core/ucs.js';
import { ensureKeys } from '../blocks/dynamic.js';
import { layerStatesFromObjects } from '../core/layerstates.js';
import * as G from '../core/geom.js';
import { Document, defaultLayer, defaultStyle } from '../core/document.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { curvePoints } from '../core/tessellate.js';
import { ocsAxes } from '../curves.js';
import { hatchLoops } from '../hatch.js';
import { plainText } from '../text.js';
import { dimSizes, linearDimension, arrowSolid } from '../core/dimension.js';
import { repairMepInserts } from '../mep/repair.js';
import { axesFor, UNDERLAY_DEFAULTS } from '../underlay/underlay.js';
import { clipContext, readInsertClip } from './xclip.js';

const MIRROR_X = [-1, 0, 0, 1, 0, 0];
const H_ALIGN = { 0: 'left', 1: 'center', 2: 'right', 3: 'center', 4: 'center', 5: 'center' };
const V_ANCHOR = { 0: 'baseline', 1: 'bottom', 2: 'middle', 3: 'top' };
const IGNORED = new Set(['SEQEND', 'VERTEX']);
// Résultat « rien à importer, volontairement » (pas compté parmi les objets non importés).
const SILENT = Object.freeze([]);

const P3 = (p) => [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0];

// Épaisseurs de ligne : un DWG stocke un index (0 à 31), le DXF des centièmes de mm.
const DWG_LWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
export const VALID_LWEIGHTS = new Set([-3, -2, -1, ...DWG_LWEIGHTS]);
function lineweight(v, fromDwg) {
  if (v == null) return undefined;
  if (!fromDwg) return VALID_LWEIGHTS.has(v) ? v : undefined;
  if (v >= 0 && v < DWG_LWEIGHTS.length) return DWG_LWEIGHTS[v];
  return { 29: -1, 30: -2, 31: -3 }[v] ?? -1;
}
const P2 = (p) => [p?.x ?? 0, p?.y ?? 0];

// Repère objet : 'id' (normal), 'mirror' (extrusion -Z, symétrie en X) ou 'tilted' (plan incliné).
function ocsKind(extrusion) {
  const a = ocsAxes(extrusion);
  if (!a) return { kind: 'id' };
  if (Math.abs(a[8] + 1) < 1e-9) return { kind: 'mirror' };
  return { kind: 'tilted', axes: a };
}

function toWorld3(axes, p) {
  return [
    p[0] * axes[0] + p[1] * axes[3] + (p[2] || 0) * axes[6],
    p[0] * axes[1] + p[1] * axes[4] + (p[2] || 0) * axes[7],
    p[0] * axes[2] + p[1] * axes[5] + (p[2] || 0) * axes[8],
  ];
}

// Paramètres MEP enregistrés par l'application : JSON découpé sur les applications
// CVMEP0, CVMEP1… (une seule valeur par application, voir dxf-writer.js).
export function readMepXdata(raw) {
  const parts = [];
  for (const d of raw.xdata || []) {
    const m = String(d?.appName || '').match(/^CVMEP(\d+)$/i);
    if (!m) continue;
    const first = Array.isArray(d.value) ? d.value[0] : null;
    const s = typeof first === 'string' ? first : typeof first?.value === 'string' ? first.value : null;
    if (s != null) parts[+m[1]] = s;
  }
  if (!parts.length || parts.some((p) => p == null)) return null;
  try {
    return JSON.parse(parts.join(''));
  } catch {
    return null;
  }
}

// Largeurs par segment d'une polyligne ([début, fin] au départ de chaque sommet), si elles diffèrent de la
// largeur constante (flèches dessinées en polyligne…).
function vertexWidths(v, constant = 0) {
  if (!v.some((p) => (p.startWidth || 0) !== (constant || 0) || (p.endWidth || 0) !== (constant || 0))) return {};
  if (!v.some((p) => p.startWidth > 0 || p.endWidth > 0)) return {};
  return { width: 0, widths: v.map((p) => [p.startWidth || 0, p.endWidth || 0]) };
}

// Variable d'en-tête (DWG : « DIMSCALE », DXF lu par dxf-json : « $DIMSCALE »).
const headerVar = (db, k) => db.header?.[k] ?? db.header?.[`$${k}`];

// Surcharges de style de cote d'un objet (XDATA ACAD « DSTYLE » : paires code / valeur, 40 = DIMSCALE,
// 41 = DIMASZ). Lisibles depuis dxf-json ; LibreDWG ne les décode pas (on retombe sur l'en-tête).
function dimOverrides(r) {
  const out = {};
  for (const x of r.xdata || []) {
    if (x?.appName !== 'ACAD' || !Array.isArray(x.value) || x.value[0] !== 'DSTYLE') continue;
    for (const it of x.value.slice(1)) {
      if (!Array.isArray(it) || it.length !== 2 || typeof it[0] !== 'number') continue;
      if (it[0] === 40 && +it[1] > 0) out.DIMSCALE = +it[1];
      if (it[0] === 41 && +it[1] > 0) out.DIMASZ = +it[1];
    }
  }
  return out;
}

// Couleur AcCmColor (entier 32 bits, octet de poids fort = méthode) : DuCalque, DuBloc, RVB ou index.
function cmColor(v) {
  if (typeof v !== 'number') return { color: 0 };
  const u = v >>> 0, method = u >>> 24;
  if (method === 0xc2) return { color: 256, rgb: u & 0xffffff };
  if (method === 0xc3) return { color: (u & 0xff) || 7 };
  if (method === 0xc0) return { color: 256 };
  return { color: 0 };
}

// Réglages du dessin lus de l'en-tête (précisions, points, objets courants, style de cote) ; seuls les
// réglages présents et utiles sont repris.
function drawingSettings(db) {
  const out = {};
  const num = (k) => { const v = headerVar(db, k); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  const str = (k) => { const v = headerVar(db, k); return typeof v === 'string' ? v : null; };
  if (num('LUPREC') != null) out.luprec = num('LUPREC');
  if (num('AUPREC') != null) out.auprec = num('AUPREC');
  if (num('PDMODE')) out.pdmode = num('PDMODE');
  if (num('PDSIZE')) out.pdsize = num('PDSIZE');
  if (num('TEXTSIZE') > 0) out.textsize = num('TEXTSIZE');
  if (str('TEXTSTYLE')) out.textstyle = str('TEXTSTYLE');
  if (num('CECOLOR') != null && num('CECOLOR') !== 256) out.cecolor = num('CECOLOR');
  if (str('CELTYPE') && !/^bylayer$/i.test(str('CELTYPE'))) out.celtype = str('CELTYPE');
  if (num('CELWEIGHT') != null && num('CELWEIGHT') !== -1) out.celweight = num('CELWEIGHT');
  const ds = {};
  for (const k of ['DIMTXT', 'DIMASZ', 'DIMEXE', 'DIMEXO', 'DIMGAP', 'DIMLFAC']) if (num(k) > 0) ds[k] = num(k);
  if (num('DIMDEC') != null) ds.DIMDEC = num('DIMDEC');
  const post = str('DIMPOST');
  if (post) ds.DIMPOST = post.replace('<>', '');
  const blk = (str('DIMBLK') || '').toUpperCase();
  if (num('DIMTSZ') > 0) ds.DIMBLK = 'oblique';
  else if (blk.includes('OPEN')) ds.DIMBLK = 'ouverte';
  else if (blk.includes('DOT')) ds.DIMBLK = 'point';
  if (Object.keys(ds).length) out.dimstyle = ds;
  return out;
}

// Feuille d'une présentation lue : mise en page (format du papier, marges, origine de tracé, style) si le
// fichier la donne (DXF), sinon les limites de l'espace papier (DWG) ; voir layout/sheet.js.
function layoutSheet(l) {
  if (!l) return {};
  const out = {};
  if (l.minLimit && l.maxLimit && l.maxLimit.x - l.minLimit.x > 50 && l.maxLimit.y - l.minLimit.y > 50) {
    out.limits = { min: [l.minLimit.x, l.minLimit.y], max: [l.maxLimit.x, l.maxLimit.y] };
  }
  if (l.paperWidth > 50 && l.paperHeight > 50 && (l.plotPaperUnit ?? 1) === 1) {
    const odd = (l.plotRotation || 0) % 2 === 1;
    const w = odd ? l.paperHeight : l.paperWidth, h = odd ? l.paperWidth : l.paperHeight;
    const m = [l.marginLeft || 0, l.marginBottom || 0, l.marginRight || 0, l.marginTop || 0];
    const margins = odd ? [m[1], m[2], m[3], m[0]] : m;
    const origin = [-((l.plotOriginX || 0) + margins[0]), -((l.plotOriginY || 0) + margins[1])];
    const fmt = Object.entries({ A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] })
      .find(([, [a, b]]) => (Math.abs(w - a) < 1.5 && Math.abs(h - b) < 1.5) || (Math.abs(w - b) < 1.5 && Math.abs(h - a) < 1.5));
    out.plot = { paper: fmt ? fmt[0] : 'Personnalisé', w, h, origin, margins, mono: /monochrome|grayscale|noir/i.test(l.currentStyleSheet || ''), ctb: l.currentStyleSheet || '', lineweights: true };
  }
  return out;
}

// Points de définition d'une cote d'AutoCAD (type 70 & 7 : 0 linéaire, 1 alignée, 3 diamètre, 4 rayon), pour la
// régénérer quand ses objets bougent et l'écrire comme vraie cote : linéaire / alignée { p1, p2 (13, 14), loc (10),
// rotation (50) } ; rayon { c (10), r, loc (texte 11) } ; diamètre { c, r } d'après les extrémités 10 et 15.
function dimensionDefs(r) {
  const t = (r.dimensionType ?? 0) & 7;
  const P = (q) => (q ? [q.x || 0, q.y || 0] : null);
  const text = P(r.textPoint);
  const user = (r.dimensionType ?? 0) & 128 ? { userText: true } : {}; // texte placé par l'utilisateur
  if ((t === 0 || t === 1) && r.subDefinitionPoint1 && r.subDefinitionPoint2 && r.definitionPoint) {
    return { type: t ? 'aligned' : 'linear', p1: P(r.subDefinitionPoint1), p2: P(r.subDefinitionPoint2), loc: P(r.definitionPoint), rotation: t ? null : r.rotationAngle || 0, ...(text ? { textPoint: text } : {}), ...user };
  }
  const chord = r.subDefinitionPoint || r.centerPoint; // 15 (LibreDWG le nomme centerPoint)
  if ((t === 3 || t === 4) && r.definitionPoint && chord) {
    const a = P(r.definitionPoint), b = P(chord);
    const c = t === 4 ? a : G.mid(a, b), rad = t === 4 ? G.dist(a, b) : G.dist(a, b) / 2;
    if (rad > 0) return { type: t === 4 ? 'radius' : 'diameter', c, r: rad, loc: text || b, ...user };
  }
  return {};
}

export class Importer {
  constructor(db) {
    this.db = db;
    this.doc = new Document();
    this.stats = { imported: new Map(), skipped: new Map(), missingBlocks: new Set() };
    this.blockByHandle = new Map();
    for (const b of db.tables?.BLOCK_RECORD?.entries || []) this.blockByHandle.set(b.handle, b);
    this.synthetic = 0;
    this.fromDwg = db.source !== 'dxf';
    // Définitions des fonds joints (PDF, images) : poignée → définition.
    const key = (h) => String(h ?? '').toUpperCase();
    this.pdfDefs = new Map((db.objects?.PDFDEFINITION || []).map((d) => [key(d.handle), d]));
    this.imageDefs = new Map((db.objects?.IMAGEDEF || []).map((d) => [key(d.handle), d]));
    this.clipCtx = db.objects?.SPATIAL_FILTER?.length ? clipContext(db) : null; // découpes XCLIP
  }

  count(map, type) { map.set(type, (map.get(type) || 0) + 1); }

  run() {
    const { db, doc } = this;
    // Tables de tri (ordre de tracé) : poignée de l'objet → poignée de tri.
    this.sortKey = new Map();
    for (const t of db.sortents || []) for (const [h, s] of t.pairs || []) this.sortKey.set(String(h).toUpperCase(), String(s).toUpperCase());
    // Styles de tracé nommés (PSTYLEMODE = 0) : poignée → nom (dictionnaire ACAD_PLOTSTYLENAME).
    const ps = db.header?.PSTYLEMODE ?? db.header?.$PSTYLEMODE;
    this.namedStyles = ps === 0 || ps === false ? new Map([...(db.plotStyleNames || [])].map(([h, n]) => [String(h).toUpperCase(), n])) : null;
    this.importLayers();
    this.importLtypes();
    this.importStyles();
    this.importLayerStates();
    const hdr = db.header || {};
    doc.header = {
      insunits: hdr.INSUNITS ?? hdr.$INSUNITS ?? 0,
      ltscale: hdr.LTSCALE ?? hdr.$LTSCALE ?? 1,
      dimscale: hdr.DIMSCALE ?? hdr.$DIMSCALE ?? 1,
      lwdisplay: !!(hdr.LWDISPLAY ?? hdr.$LWDISPLAY),
      ...(typeof headerVar(db, 'MEASUREMENT') === 'number' ? { measurement: headerVar(db, 'MEASUREMENT') } : {}),
      ...drawingSettings(db),
      ...(db.wipeoutFrame != null ? { wipeoutFrame: db.wipeoutFrame } : {}),
      ...(this.namedStyles ? { pstylemode: 0 } : {}), // dessin en styles de tracé nommés
      // Dates du dessin (champs « date d'enregistrement / de création »).
      ...(julianToDate(headerVar(db, 'TDUPDATE')) ? { saveDate: julianToDate(headerVar(db, 'TDUPDATE')).toISOString() } : {}),
      ...(julianToDate(headerVar(db, 'TDCREATE')) ? { createDate: julianToDate(headerVar(db, 'TDCREATE')).toISOString() } : {}),
    };
    this.importUcs();

    // Contours des fenêtres non rectangulaires : objets de l'espace papier repris par leur fenêtre.
    this.vpBoundaries = new Map();
    const rawByHandle = new Map();
    for (const b of db.tables?.BLOCK_RECORD?.entries || []) for (const e of b.entities || []) if (e.handle != null) rawByHandle.set(String(e.handle).toUpperCase(), e);
    for (const e of rawByHandle.values()) {
      if (e.type === 'VIEWPORT' && ((e.statusBitFlags || 0) & 0x10000) && e.clippingBoundaryId) {
        const bnd = rawByHandle.get(String(e.clippingBoundaryId).toUpperCase());
        if (bnd) this.vpBoundaries.set(String(e.clippingBoundaryId).toUpperCase(), bnd);
      }
    }
    const layouts = db.objects?.LAYOUT || [];
    const papers = [];
    for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
      if (/^\*model_space$/i.test(b.name)) continue;
      if (/^\*paper_space/i.test(b.name)) {
        if (!b.entities?.length) continue;
        const layout = layouts.find((l) => l.paperSpaceTableId === b.handle || l.handle === b.layout || (b.brHandle && l.paperSpaceTableId === b.brHandle));
        doc.spaces.push({ id: b.name, label: layout?.layoutName || b.name, order: layout?.tabOrder ?? 99, ...layoutSheet(layout) });
        this.layoutUcs?.(layout, b.name);
        if (Object.keys(this.ucsAll || {}).length) doc.header.ucs = this.ucsAll;
        papers.push(b);
        continue;
      }
      doc.blocks.set(b.name, {
        name: b.name,
        base: P3(b.basePoint),
        flags: b.flags || 0,
        xref: (b.flags & 4) !== 0,
        entities: [],
        raw: b,
      });
    }
    doc.spaces.sort((a, b) => (a.id === 'model' ? -1 : b.id === 'model' ? 1 : (a.order ?? 99) - (b.order ?? 99)));
    const dynDefNames = new Set([...(db.acadDyn?.defs?.values() || [])].map((d) => d.name));
    // DWG : liens et valeurs des insertions de blocs dynamiques (dictionnaires d'extension).
    if (db.acadDyn?.dwg) dwgInsertInfo((db.tables?.BLOCK_RECORD?.entries || []).flatMap((b) => b.entities || []), db);
    // Contenu des blocs (après création de toutes les définitions : les cotes peuvent en ajouter).
    for (const block of [...doc.blocks.values()]) {
      if (!block.raw) continue;
      this.keepHidden = dynDefNames.has(block.name);
      block.entities = this.sortByDrawOrder((block.raw.entities || []).flatMap((e) => this.convert(e, block.name, false)));
      this.keepHidden = false;
      if (block.xref && !block.entities.length) this.stats.missingBlocks.add(`${block.name} (réf. externe)`);
      delete block.raw;
    }
    // libredwg-web ne renseigne pas isInPaperSpace : db.entities mélange l'espace objet et toutes les
    // présentations. On prend donc le contenu du bloc *Model_Space (repli : le drapeau, pour les DXF).
    const msBlock = (db.tables?.BLOCK_RECORD?.entries || []).find((b) => /^\*model_space$/i.test(b.name));
    const modelRaw = msBlock?.entities?.length ? msBlock.entities : (db.entities || []).filter((e) => !e.isInPaperSpace);
    // Objets dans l'ordre de tracé : leurs ids (clés d'ordre par défaut) suivent cet ordre.
    const model = this.sortByDrawOrder(modelRaw.flatMap((e) => this.convert(e, 'model', true)));
    const spaceEntities = papers.flatMap((b) => this.sortByDrawOrder(b.entities.flatMap((e) => this.convert(e, b.name, true))));
    // Blocs de dessin des objets MEP : reconstruits à l'enregistrement, inutiles une fois relus.
    for (const name of [...doc.blocks.keys()]) if (name.startsWith('CV_MEP_')) doc.blocks.delete(name);
    this.applyGroups([...model, ...spaceEntities]);
    // Supports / accessoires aux XDATA illisibles : reconstruits depuis leur réseau.
    const insunits = headerVar(db, 'INSUNITS');
    repairMepInserts([...model, ...spaceEntities], ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 })[insunits] ?? 1);
    // Blocs dynamiques enregistrés par l'appli : définitions relues du dictionnaire, insertions rattachées à leur
    // bloc dynamique (au lieu de la représentation figée écrite pour AutoCAD), représentations devenues inutiles retirées.
    this.importDynamic([...model, ...spaceEntities]);
    // Blocs dynamiques d'AutoCAD : visibilité convertie, nom effectif, blocs anonymes devenus inutiles retirés.
    for (const n of applyAcadDynamic(doc.blocks, [...model, ...spaceEntities], db.acadDyn)) doc.blocks.delete(n);
    // Fonds de plan enregistrés par l'appli : réglages (XDATA de l'insertion) rattachés au bloc du fond.
    for (const e of model) {
      if (!e.fond) continue;
      const b = doc.blocks.get(e.name);
      if (b) b.fond = { history: [], ...e.fond, count: b.entities.length };
      delete e.fond;
    }
    doc.load([...model, ...spaceEntities]);
    // Hachures associatives : poignées des objets sources → ids du document.
    const byHandle = new Map();
    for (const e of doc.entities.values()) if (e.handle != null) byHandle.set(String(e.handle).toUpperCase(), e.id);
    // Champs : poignées des objets cités → ids (attribut : insertion + étiquette).
    const attByHandle = new Map();
    for (const e of doc.entities.values()) for (const a of e.attribs || []) if (a.handle != null) attByHandle.set(String(a.handle).toUpperCase(), { id: e.id, tag: a.tag });
    const toRefs = (objs) => objs.map((h) => attByHandle.get(h) || (byHandle.has(h) ? { id: byHandle.get(h) } : { id: null }));
    let fieldCount = 0;
    for (const e of doc.entities.values()) {
      if (e.fieldRef) { e.field = { code: e.fieldRef.code, refs: toRefs(e.fieldRef.objs) }; delete e.fieldRef; fieldCount++; }
      if (e.attribs?.some((a) => a.fieldRef)) {
        e.attribs = e.attribs.map((a) => {
          if (!a.fieldRef) return a;
          const { fieldRef, ...rest } = a;
          fieldCount++;
          return { ...rest, field: { code: fieldRef.code, refs: toRefs(fieldRef.objs) } };
        });
      }
    }
    for (const b of doc.blocks.values()) for (const e of b.entities) if (e.fieldRef) { e.field = { code: e.fieldRef.code, refs: toRefs(e.fieldRef.objs) }; delete e.fieldRef; }
    if (fieldCount) this.stats.fields = fieldCount;
    for (const e of doc.entities.values()) {
      // Tableaux d'extraction : sélection d'origine (poignées → ids), sinon tout le dessin.
      if (e.extractRef) {
        const { handles, ...x } = e.extractRef;
        const ids = (handles || []).map((h) => byHandle.get(String(h).toUpperCase())).filter((id) => id != null);
        e.extract = { ...x, ids: ids.length ? ids : null };
        delete e.extractRef;
      }
      // Cotes associatives d'AutoCAD (objets DIMASSOC) : objets accrochés → références de l'appli.
      const da = e.kind === 'DIMENSION' && e.handle != null && db.dimAssoc?.get(String(e.handle).toUpperCase());
      if (da && e.meta?.type) {
        const assoc = assocFromAcad(e.meta, da, (h) => doc.get(byHandle.get(String(h).toUpperCase())));
        if (assoc) { e.meta = { ...e.meta, assoc }; this.stats.assocDims = (this.stats.assocDims || 0) + 1; }
      }
      if (!e.assocRef) continue;
      const ids = e.assocRef.handles.map((h) => byHandle.get(String(h).toUpperCase()));
      if (ids.every((id) => id != null)) e.assoc = { mode: e.assocRef.mode || 'point', ids, seeds: e.assocRef.seeds || null, islands: e.assocRef.islands || 'normal' };
      delete e.assocRef;
    }
    doc.undoStack = [];
    return { doc, stats: this.stats };
  }

  importDynamic(entities) {
    const { doc, db } = this;
    const dicts = db.objects?.DICTIONARY || [];
    const xrecs = db.objects?.XRECORD || [];
    const entryId = (e) => e.objectSoftId ?? e.objectId ?? e.handle ?? e.value;
    // Entrées d'un dictionnaire : liste { name, objectSoftId } (DXF) ou objet nom → handle (DWG).
    const entriesOf = (d) => {
      const e = d.entries || d.items || [];
      return Array.isArray(e) ? e : Object.entries(e).map(([name, h]) => ({ name, objectSoftId: h }));
    };
    const handleOf = (o) => String(o.handle ?? '').toUpperCase();
    // Données électriques du projet (XRECORD CV_DONNEES_ELEC du dictionnaire racine).
    for (const d of dicts) {
      const ent = entriesOf(d).find((x) => x.name === 'CV_DONNEES_ELEC');
      const xr = ent && xrecs.find((x) => handleOf(x) === String(entryId(ent)).toUpperCase());
      if (!xr) continue;
      const data = xr.data || xr.items || xr.xdata || [];
      try {
        const json = JSON.parse(data.filter((g) => (g.code ?? g.type) === 1).map((g) => g.value).join(''));
        if (json?.data && typeof json.data === 'object') doc.header = { ...doc.header, elecData: json.data };
      } catch { /* données illisibles : valeurs par défaut */ }
      break;
    }
    let dynDict = null;
    for (const d of dicts) {
      const ent = entriesOf(d).find((x) => x.name === 'CV_BLOCS_DYNAMIQUES');
      if (ent) { dynDict = dicts.find((x) => handleOf(x) === String(entryId(ent)).toUpperCase()); break; }
    }
    for (const ent of dynDict ? entriesOf(dynDict) : []) {
      const xr = xrecs.find((x) => handleOf(x) === String(entryId(ent)).toUpperCase());
      const data = xr?.data || xr?.items || xr?.xdata || [];
      const text = data.filter((g) => (g.code ?? g.type) === 1).map((g) => g.value).join('');
      const block = doc.blocks.get(ent.name);
      try {
        const json = JSON.parse(text);
        if (!block || !json?.dyn || json.keys?.length !== block.entities.length) continue;
        block.entities.forEach((e, i) => { if (Number.isInteger(json.keys[i])) e.k = json.keys[i]; });
        ensureKeys(block.entities);
        block.dyn = json.dyn;
      } catch { /* définition illisible : bloc gardé figé */ }
    }
    const reps = new Set();
    const nested = [...doc.blocks.values()].flatMap((b) => b.entities);
    for (const e of [...entities, ...nested]) {
      if (!e.dynref) continue;
      const base = doc.blocks.get(e.dynref.block);
      if (base?.dyn) {
        reps.add(e.name);
        e.name = base.name;
        e.dyn = e.dynref.values || {};
        const hiddenTags = new Set(e.dynref.hidden || []);
        for (const a of e.attribs || []) if (hiddenTags.has(a.tag)) { delete a.invisible; a.dynHidden = true; }
      }
      delete e.dynref;
    }
    // Représentations encore utilisées ailleurs (insertion copiée dans AutoCAD…) : gardées.
    const used = new Set(entities.map((e) => e.name));
    for (const b of doc.blocks.values()) for (const e of b.entities) if (e.name) used.add(e.name);
    for (const name of reps) if (!used.has(name)) doc.blocks.delete(name);
  }

  // Fond PDF : la taille de la page n'est connue qu'à la lecture du PDF ; le fond est créé avec une page A3
  // provisoire (pending) et recalé dès que le fichier est lu (underlay/layer3d.js).
  pdfUnderlay(r, c) {
    const def = this.pdfDefs.get(String(r.defHandle ?? '').toUpperCase());
    if (!def?.path) return null;
    const unitMm = (headerVar(this.db, 'MEASUREMENT') ?? 1) === 0 ? 25.4 : 1;
    const flags = r.flags ?? 10;
    const scale = Math.abs(r.scale?.x || 1) || 1;
    const native = [420, 297];
    const { u, v } = axesFor(native, scale, r.rotation || 0, unitMm, 'pdf');
    const extra = readMepXdata(r)?.underlay || {};
    let clipLocal = null;
    if (r.clip?.length >= 2) {
      // Rectangle : deux coins opposés ; sinon polygone. Coordonnées du fond à l'échelle 1 (mm de la page).
      clipLocal = r.clip.length === 2
        ? [[Math.min(r.clip[0][0], r.clip[1][0]), Math.min(r.clip[0][1], r.clip[1][1])], [Math.max(r.clip[0][0], r.clip[1][0]), Math.min(r.clip[0][1], r.clip[1][1])],
          [Math.max(r.clip[0][0], r.clip[1][0]), Math.max(r.clip[0][1], r.clip[1][1])], [Math.min(r.clip[0][0], r.clip[1][0]), Math.max(r.clip[0][1], r.clip[1][1])]]
        : r.clip.map((q) => [q[0], q[1]]);
    }
    return [{
      ...c, ...UNDERLAY_DEFAULTS, type: 'UNDERLAY', kind: 'pdf', path: def.path, page: parseInt(def.page, 10) || 1,
      p: P3(r.position), u, v, native, pixel: 1, pending: { scale, unitMm, clipLocal, clipOn: !!(flags & 1), invert: !!(flags & 16) },
      fade: r.fade ?? 0, contrast: r.contrast ?? 100, mono: !!(flags & 4), adjust: !!(flags & 8), show: !!(flags & 2),
      whiteOff: extra.whiteOff !== false, ocgOff: Array.isArray(extra.ocgOff) ? extra.ocgOff : [],
    }];
  }

  // Image : vecteurs d'un pixel (U, V) et taille en pixels ; découpe en pixels (origine en haut à gauche).
  imageUnderlay(r, c) {
    const def = this.imageDefs.get(String(r.imageDefHandle ?? '').toUpperCase());
    const W = r.imageSize?.x || def?.size?.x || 1, H = r.imageSize?.y || def?.size?.y || 1;
    if (!def?.fileName) return null;
    const flags = r.flags ?? 7;
    let clip = null;
    const clipped = r.isClipped ?? !!r.clipping;
    if (clipped && r.clippingBoundaryPath?.length >= 2) {
      // libredwg-web lit ces points en 3D : les valeurs se suivent (x, y, x, y…).
      const n = r.countBoundaryPoints || r.clippingBoundaryPath.length;
      const flat = this.fromDwg ? r.clippingBoundaryPath.flatMap((q) => [q.x, q.y, q.z]) : r.clippingBoundaryPath.flatMap((q) => [q.x, q.y]);
      let pts = [];
      for (let i = 0; i < n; i++) pts.push([(flat[i * 2] + 0.5) / W, 1 - (flat[i * 2 + 1] + 0.5) / H]);
      // Contour polygonal fermé : le dernier sommet répète le premier.
      if (pts.length > 3 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
      if (pts.length === 2) {
        const [a, b] = pts;
        const s0 = Math.min(a[0], b[0]), s1 = Math.max(a[0], b[0]), t0 = Math.min(a[1], b[1]), t1 = Math.max(a[1], b[1]);
        pts = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
      }
      const full = pts.every((q) => q[0] <= 1e-6 || q[0] >= 1 - 1e-6) && pts.every((q) => q[1] <= 1e-6 || q[1] >= 1 - 1e-6);
      if (!full && pts.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) clip = { pts, invert: !!r.clipMode };
    }
    const extra = readMepXdata(r)?.underlay || {};
    const pixel = def.resolutionUnits ? (def.sizeOfOnePixel?.x || 1) : 1;
    return [{
      ...c, ...UNDERLAY_DEFAULTS, type: 'UNDERLAY', kind: 'image', path: def.fileName, page: 1,
      p: P3(r.position), u: [r.uPixel.x * W, r.uPixel.y * W], v: [r.vPixel.x * H, r.vPixel.y * H], native: [W, H], pixel,
      fade: r.fade ?? 0, contrast: Math.min(100, (r.contrast ?? 50) * 2), mono: false, adjust: extra.adjust ?? false,
      show: (flags & 1) !== 0, whiteOff: extra.whiteOff ?? false, clip,
    }];
  }

  importLayers() {
    const { doc } = this;
    for (const l of this.db.tables?.LAYER?.entries || []) {
      const aci = l.colorIndex >= 1 && l.colorIndex <= 255 ? l.colorIndex : null;
      doc.layers.set(l.name, defaultLayer(l.name, {
        color: aci ?? 7,
        rgb: aci == null && typeof l.color === 'number' && l.color !== 0xffffff ? l.color : undefined,
        on: !(l.off || l.colorIndex < 0),
        // Bits DXF : 1 gelé, 4 verrouillé (le champ « locked » de libredwg-web 0.7.14 est toujours vrai).
        frozen: typeof l.standardFlag === 'number' ? (l.standardFlag & 1) !== 0 : !!l.frozen,
        locked: typeof l.standardFlag === 'number' ? (l.standardFlag & 4) !== 0 : !!l.locked,
        // Gelé dans les nouvelles fenêtres (bit 2) : gardé pour les états de calques et le DXF.
        ...((typeof l.standardFlag === 'number' ? l.standardFlag & 2 : l.frozenInNew) ? { newVpFrozen: true } : {}),
        ltype: l.lineType || 'Continuous',
        plot: l.plotFlag == null ? true : !!l.plotFlag,
        lweight: lineweight(l.lineweight, this.fromDwg) ?? -3,
        ...(this.namedStyles ? { pstyle: this.namedStyles.get(String(l.plotStyleNameObjectId || this.db.layerPlotStyles?.get(l.name) || '').toUpperCase()) || 'Normal' } : {}),
      }));
    }
  }

  // Masque (WIPEOUT) : image d'un pixel découpée par un contour en coordonnées du pixel (centre 0, y vers le bas).
  wipeout(r, c) {
    const pos = r.position, U = r.uPixel || r.uDirection, V = r.vPixel || r.vDirection;
    if (!pos || !U || !V) return null;
    const size = r.imageSize || { x: 1, y: 1 };
    let path = r.clippingBoundaryPath || [];
    if ((r.clippingBoundaryType === 1 || path.length === 2) && path.length === 2) {
      const [a, b] = path;
      path = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    if (path.length < 3) path = [{ x: -0.5, y: size.y - 0.5 }, { x: size.x - 0.5, y: size.y - 0.5 }, { x: size.x - 0.5, y: -0.5 }, { x: -0.5, y: -0.5 }];
    const pts = path.map((q) => {
      const s = q.x + 0.5, t = (size.y || 1) - 0.5 - q.y;
      return [pos.x + s * U.x + t * V.x, pos.y + s * U.y + t * V.y];
    });
    if (pts.length > 3 && G.dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
    return [{ ...c, type: 'WIPEOUT', pts, z: pos.z || 0 }];
  }

  // Ordre de tracé lu (tables de tri) : objets rangés par poignée de tri ; sans table, l'ordre du fichier.
  sortByDrawOrder(list) {
    if (!this.sortKey.size) return list;
    let last = -Infinity;
    const keyed = list.map((e, i) => {
      const h = e.handle != null ? String(e.handle).toUpperCase() : null;
      if (h) last = parseInt(this.sortKey.get(h) || h, 16);
      return { e, k: last, i };
    });
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    return keyed.map((x) => x.e);
  }

  // SCU : nommés (table UCS), courant de l'espace objet (en-tête) et de chaque présentation (objet LAYOUT).
  importUcs() {
    const { db, doc } = this;
    for (const u of db.tables?.UCS?.entries || []) {
      if (!u?.name) continue;
      const v = ucsFromAxes(u.origin, u.xAxis || u.xAxisDirection, u.name);
      doc.ucsTable.set(u.name.toUpperCase(), { name: v.name, origin: v.origin, angle: v.angle });
    }
    const all = {};
    const org = headerVar(db, 'UCSORG'), xd = headerVar(db, 'UCSXDIR');
    if (org && xd) {
      const raw = headerVar(db, 'UCSNAME');
      const u = ucsFromAxes(org, xd, typeof raw === 'string' ? raw : '');
      // DWG : nom illisible, retrouvé parmi les SCU nommés identiques.
      if (!u.name) u.name = [...doc.ucsTable.values()].find((n) => Math.hypot(n.origin[0] - u.origin[0], n.origin[1] - u.origin[1]) < 1e-9 && Math.abs(n.angle - u.angle) < 1e-9)?.name || '';
      if (!isWorld(u) || u.name) all.model = u;
    }
    this.layoutUcs = (layout, space) => {
      if (!layout?.ucsOrigin || !layout?.ucsXAxis) return;
      const u = ucsFromAxes(layout.ucsOrigin, layout.ucsXAxis);
      if (!isWorld(u)) all[space] = u;
    };
    if (Object.keys(all).length) doc.header.ucs = all;
    this.ucsAll = all;
  }

  // États de calques (ETATCALQUE) lus dans le fichier.
  importLayerStates() {
    // DXF : relus dans le texte (dxf-adapter) ; DWG : objets convertis par LibreDWG.
    const states = this.db.layerStates || layerStatesFromObjects(this.db);
    for (const st of states) if (st?.name) this.doc.layerStates.set(st.name.toUpperCase(), st);
  }

  // Styles de texte : police (SHX ou TrueType), facteur de largeur, oblique.
  importStyles() {
    for (const s of this.db.tables?.STYLE?.entries || []) {
      if (!s.name || (s.standardFlag & 1)) continue; // forme (fichier de formes chargé), pas un style de texte
      this.doc.styles.set(s.name.toUpperCase(), defaultStyle({
        name: s.name, font: s.font || '', bigFont: s.bigFont || '', widthFactor: s.widthFactor || 1,
        oblique: s.obliqueAngle || 0, height: s.fixedTextHeight || 0,
      }));
    }
  }

  importLtypes() {
    this.doc.ltypes = new Map();
    for (const t of this.db.tables?.LTYPE?.entries || []) {
      const dashes = (t.pattern || []).map((p) => p.elementLength).filter((v) => Number.isFinite(v));
      this.doc.ltypes.set(t.name.toUpperCase(), { name: t.name, description: t.description || '', dashes });
    }
  }

  common(raw) {
    const e = {
      layer: raw.layer || '0',
      color: raw.colorIndex ?? 256,
      handle: raw.handle,
    };
    if (typeof raw.color === 'number') e.rgb = raw.color;
    if (raw.lineType && !/^bylayer$/i.test(raw.lineType)) e.ltype = raw.lineType;
    if (raw.lineTypeScale && raw.lineTypeScale !== 1) e.ltscale = raw.lineTypeScale;
    const lw = lineweight(raw.lineweight, this.fromDwg);
    if (lw != null && lw !== -1) e.lweight = lw;
    // Style de tracé nommé imposé à l'objet (sinon celui du calque).
    const ps = this.namedStyles && raw.plotStyleHardId ? this.namedStyles.get(String(raw.plotStyleHardId).toUpperCase()) : null;
    if (ps) e.pstyle = ps;
    return e;
  }

  // Applique le repère objet à une entité construite en coordonnées OCS.
  ocs(entity, extrusion) {
    const o = ocsKind(extrusion);
    if (o.kind === 'id') return [entity];
    if (o.kind === 'mirror') return [transformEntity(entity, MIRROR_X)];
    const curve = curvePoints(entity);
    if (!curve) return [entity];
    return [{ ...entity, type: 'POLY3D', pts: curve.pts.map((p) => toWorld3(o.axes, p)), closed: curve.closed }];
  }

  convert(raw, space, topLevel) {
    // Objet invisible ignoré, sauf dans une définition de bloc dynamique d'AutoCAD (objets des autres états).
    if (!raw || (raw.isVisible === false && !this.keepHidden) || IGNORED.has(raw.type)) return [];
    if (this.vpBoundaries?.has(String(raw.handle).toUpperCase())) return []; // contour d'une fenêtre : gardé dans la fenêtre
    // libredwg-web range aussi chaque attribut parmi les entités de l'espace : c'est une copie de
    // celui déjà rattaché à son insertion (INSERT.attribs), on l'ignore pour ne pas le dupliquer.
    if (topLevel && raw.type === 'ATTRIB') return [];
    if (raw.layer === '*ADSK_CONSTRAINTS') return [];
    this.curSpace = space;
    let out;
    try {
      out = this.convertUnsafe(raw);
    } catch (err) {
      console.warn(`Entité ${raw.type} (${raw.handle}) non convertie :`, err);
      out = null;
    }
    if (out === SILENT) return [];
    if (!out || !out.length) {
      this.count(this.stats.skipped, raw.type);
      return [];
    }
    this.count(this.stats.imported, raw.type);
    if (topLevel) for (const e of out) e.space = space;
    // Définition dynamique : objet invisible (autre état de visibilité) gardé et marqué.
    if (this.keepHidden && (raw.isVisible === false || raw.defHidden)) for (const e of out) e.defHidden = true;
    // Champ (FIELD) : code et objets cités (poignées), résolus une fois le dessin chargé.
    if (raw.fieldInfo && out.length === 1 && (out[0].type === 'TEXT' || out[0].type === 'MTEXT' || out[0].type === 'ATTDEF')) out[0].fieldRef = raw.fieldInfo;
    return out;
  }

  convertUnsafe(r) {
    const c = this.common(r);
    switch (r.type) {
      case 'LINE':
        return [{ ...c, type: 'LINE', p1: P3(r.startPoint), p2: P3(r.endPoint) }];
      case 'CIRCLE':
        return this.ocs({ ...c, type: 'CIRCLE', c: P3(r.center), r: r.radius }, r.extrusionDirection);
      case 'ARC':
        return this.ocs({ ...c, type: 'ARC', c: P3(r.center), r: r.radius, a0: r.startAngle, a1: r.endAngle }, r.extrusionDirection);
      case 'ELLIPSE': {
        const n = r.extrusionDirection;
        const e = { ...c, type: 'ELLIPSE', c: P3(r.center), major: P2(r.majorAxisEndPoint), ratio: r.axisRatio, a0: r.startAngle ?? 0, a1: r.endAngle ?? G.TAU };
        if (n && n.z < 0 && Math.abs(n.x) < 1e-9 && Math.abs(n.y) < 1e-9) [e.a0, e.a1] = [-e.a1, -e.a0];
        return [e];
      }
      case 'LWPOLYLINE': {
        const v = r.vertices || [];
        if (v.length < 2) return null;
        return this.ocs({
          ...c, type: 'LWPOLYLINE', pts: v.map((p) => [p.x, p.y]), bulges: v.map((p) => p.bulge || 0),
          closed: (r.flag & 512) !== 0, z: r.elevation || 0, width: r.constantWidth || 0, ...vertexWidths(v, r.constantWidth),
        }, r.extrusionDirection);
      }
      case 'POLYLINE2D': {
        const v = (r.vertices || []).filter((p) => !(p.flag & 16));
        if (v.length < 2) return null;
        return this.ocs({
          ...c, type: 'LWPOLYLINE', pts: v.map((p) => [p.x, p.y]), bulges: v.map((p) => p.bulge || 0),
          closed: (r.flag & 1) !== 0, z: r.elevation || v[0].z || 0, width: r.startWidth || 0, ...vertexWidths(v, r.startWidth),
        }, r.extrusionDirection);
      }
      case 'POLYLINE3D': {
        const v = (r.vertices || []).filter((p) => !(p.flag & 16));
        return v.length < 2 ? null : [{ ...c, type: 'POLY3D', pts: v.map(P3), closed: (r.flag & 1) !== 0 }];
      }
      case 'SPLINE':
        return [{
          ...c, type: 'SPLINE', degree: r.degree, knots: r.knots || [], ctrl: (r.controlPoints || []).map(P3),
          weights: r.weights?.length ? r.weights : null, fit: (r.fitPoints || []).map(P3), closed: (r.flag & 1) !== 0,
        }];
      case 'SOLID': {
        const pts = [r.corner1, r.corner2, r.corner3, r.corner4 || r.corner3].map(P2);
        return this.ocs({ ...c, type: 'SOLID', pts, z: r.elevation || 0 }, r.extrusionDirection);
      }
      case '3DFACE':
        return [{ ...c, type: 'POLY3D', pts: [r.corner1, r.corner2, r.corner3, r.corner4 || r.corner3].map(P3), closed: true }];
      case 'POINT':
        return [{ ...c, type: 'POINT', p: P3(r.position) }];
      case 'VIEWPORT': {
        // La première fenêtre d'une présentation est la feuille elle-même : on ne la garde pas.
        if (!/^\*paper_space/i.test(this.curSpace || '')) return SILENT; // fenêtres : seulement dans les présentations
        const owner = this.curSpace;
        this.seenVp ||= new Set();
        if (!this.seenVp.has(owner)) { this.seenVp.add(owner); return SILENT; }
        if (!(r.width > 0 && r.height > 0 && r.viewHeight > 0)) return null;
        const vp = readMepXdata(r)?.vp; // réglages propres de la fenêtre (enregistrés par l'appli)
        // Fenêtre découpée par un contour (polyligne, cercle…) : contour en coordonnées du papier.
        let clip = null;
        const bnd = ((r.statusBitFlags || 0) & 0x10000) && r.clippingBoundaryId ? this.vpBoundaries.get(String(r.clippingBoundaryId).toUpperCase()) : null;
        if (bnd) {
          const ent = this.convertUnsafe(bnd)?.[0];
          const cp = ent && curvePoints(ent);
          if (cp?.pts?.length >= 3) {
            clip = cp.pts.map((q) => [q[0], q[1]]);
            if (G.dist(clip[0], clip[clip.length - 1]) < 1e-9) clip.pop();
          }
        }
        return [{
          ...c, type: 'VIEWPORT', c: P3(r.viewportCenter), w: r.width, h: r.height,
          vc: P2(r.displayCenter), vh: r.viewHeight, twist: r.viewTwistAngle || 0, target: P2(r.targetPoint || { x: 0, y: 0 }),
          off: ((r.statusBitFlags || 0) & 0x20000) !== 0,
          ...(((r.statusBitFlags || 0) & 0x4000) ? { locked: true } : {}),
          ...(vp?.layerOvr ? { layerOvr: vp.layerOvr } : {}),
          ...(vp?.hatchAlpha ? { hatchAlpha: vp.hatchAlpha } : {}),
          ...this.frozenLayers(r),
          ...(clip ? { clip } : {}),
        }];
      }
      case 'TEXT':
        return this.text(r, c);
      case 'ATTDEF': {
        // Définition d'attribut (dans un bloc) : position et style d'un texte, étiquette, invite, valeur par défaut.
        const src = typeof r.text === 'object' ? { ...r.text } : { ...r };
        const value = src.text || '';
        const t = this.text({ ...src, text: value || r.tag || '?' }, c, r.tag)?.[0]; // text() renvoie une liste (repère OCS)
        if (!t) return SILENT;
        return [{ ...t, type: 'ATTDEF', text: value, tag: r.tag || 'ATTRIBUT', prompt: r.prompt || r.tag || '', invisible: !!(r.flags & 1) }];
      }
      case 'ATTRIB': {
        // Attribut vide (valeur à saisir plus tard, ex. un attribut fournisseur d'un bloc de bibliothèque) : conservé, il ne dessine rien.
        const src = typeof r.text === 'object' ? { ...r.text } : { ...r };
        const value = src.text || '';
        const out = value ? this.text(src, c, r.tag) : this.text({ ...src, text: r.tag || '?' }, c, r.tag)?.map((t) => ({ ...t, text: '' }));
        // Attribut invisible : conservé (valeur modifiable, réécrite à l'enregistrement) mais non dessiné.
        return r.flags & 1 ? out?.map((t) => ({ ...t, invisible: true })) : out;
      }
      case 'MTEXT': {
        const d = r.direction;
        const rot = d && (d.x || d.y) ? Math.atan2(d.y, d.x) : r.rotation || 0;
        if (!r.text) return null;
        return [{
          ...c, type: 'MTEXT', p: P3(r.insertionPoint), h: r.textHeight, rot, text: r.text,
          width: r.rectWidth || 0, attach: r.attachmentPoint || 1, spacing: r.lineSpacing || 1, style: r.styleName,
        }];
      }
      case 'INSERT':
        return this.insert(r, c);
      case 'DIMENSION':
        return this.dimension(r, c);
      case 'ACAD_TABLE': {
        const block = this.blockFor(r);
        if (!block) return null;
        const d = r.directionVector;
        const ok = d && Number.isFinite(d.x) && Number.isFinite(d.y) && Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-3;
        const p = r.startPoint || { x: 0, y: 0 };
        const m = G.compose(G.translation(p.x, p.y), G.rotation(ok ? Math.atan2(d.y, d.x) : 0));
        return [{ ...c, type: 'BLOCKREF', kind: 'TABLE', name: block.name, m }];
      }
      case 'HATCH':
        return this.hatch(r, c);
      case 'PDFUNDERLAY':
        return this.pdfUnderlay(r, c);
      case 'IMAGE':
        return this.imageUnderlay(r, c);
      case 'WIPEOUT':
        return this.wipeout(r, c);
      case 'MULTILEADER':
        return this.mleader(r, c);
      case 'XLINE':
      case 'RAY': { // droite / demi-droite de construction (DWG : firstPoint, unitDirection ; DXF : position, direction)
        const p = r.firstPoint || r.position, d = r.unitDirection || r.direction;
        const L = d ? Math.hypot(d.x, d.y) : 0;
        if (!p || !(L > 0)) return null;
        return [{ ...c, type: 'XLINE', p: P3(p), dir: [d.x / L, d.y / L], ray: r.type === 'RAY' }];
      }
      case 'LEADER':
        return this.leader(r, c);
      case 'MLINE': {
        const verts = r.vertices || [];
        const n = verts[0]?.lines?.length || 0;
        if (verts.length < 2 || !n) return null;
        const out = [];
        for (let j = 0; j < n; j++) {
          const pts = verts.map((v) => {
            const off = v.lines?.[j]?.segmentParams?.[0] || 0;
            return [v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off, v.vertex.z || 0];
          });
          out.push({ ...c, type: 'POLY3D', pts, closed: (r.flags & 2) !== 0 });
        }
        return out;
      }
      default:
        return null;
    }
  }

  text(r, c, tag) {
    const str = plainText(r.text);
    if (!str.trim() || !(r.textHeight > 0)) return null;
    const halign = r.halign || 0, valign = r.valign || 0;
    let base = (halign !== 0 || valign !== 0) && r.endPoint ? r.endPoint : r.startPoint;
    if ((halign === 3 || halign === 5) && r.endPoint) {
      base = { x: (r.startPoint.x + r.endPoint.x) / 2, y: (r.startPoint.y + r.endPoint.y) / 2 };
    }
    const e = {
      ...c, type: 'TEXT', p: [base.x, base.y, r.elevation || 0], h: r.textHeight, rot: r.rotation || 0,
      text: r.text, align: H_ALIGN[halign] || 'left', valign: halign === 4 ? 'middle' : V_ANCHOR[valign] || 'baseline',
      wf: r.xScale || 1, style: r.styleName,
    };
    if (r.obliqueAngle) e.obl = r.obliqueAngle;
    if (tag) e.tag = tag;
    return this.ocs(e, r.extrusionDirection);
  }

  insert(r, c) {
    const mep = readMepXdata(r);
    const terminal = mep?.terminal && mep.mep ? mep.mep : null;
    if (mep?.mep && Array.isArray(mep.pts)) {
      // Objet MEP de l'application : on reconstruit l'objet (en tenant compte d'un éventuel déplacement dans AutoCAD).
      const m = insertMatrix({ p: P3(r.insertionPoint), sx: r.xScale || 1, sy: r.yScale || 1, rot: r.rotation || 0 });
      const pts = mep.pts.map((p) => G.apply(m, p[0], p[1]));
      return [{
        ...c, type: 'LWPOLYLINE', pts, bulges: mep.bulges || pts.map(() => 0), closed: false,
        z: mep.z || 0, width: 0, mep: mep.mep,
      }];
    }
    if (!this.db.tables?.BLOCK_RECORD?.entries?.some((b) => b.name === r.name) && !this.doc.blocks.has(r.name)) {
      this.stats.missingBlocks.add(r.name);
    }
    const e = {
      ...c, type: 'INSERT', name: r.name, p: P3(r.insertionPoint),
      ...(mep?.fond ? { fond: mep.fond } : {}),
      ...(mep?.elec ? { elec: mep.elec } : {}),
      ...(mep?.dynref?.block ? { dynref: mep.dynref } : {}),
      ...(mep?.extract ? { extractRef: mep.extract } : {}),
      sx: r.xScale || 1, sy: r.yScale || 1, sz: r.zScale || 1, rot: r.rotation || 0,
      cols: Math.max(1, r.columnCount || 1), rows: Math.max(1, r.rowCount || 1),
      dc: r.columnSpacing || 0, dr: r.rowSpacing || 0,
      ...(terminal ? { mep: terminal } : {}),
      attribs: (r.attribs || [])
        .filter((a) => a.isVisible !== false && a.layer !== '*ADSK_CONSTRAINTS')
        .flatMap((a) => (this.convertUnsafe(a) || []).map((t) => ({ ...t, handle: t.handle ?? a.handle, ...(a.fieldInfo ? { fieldRef: a.fieldInfo } : {}) }))),
    };
    const clip = readInsertClip(r, this.clipCtx);
    if (clip) e.clip = clip;
    return this.ocs(e, r.extrusionDirection);
  }

  blockFor(r) {
    const byName = r.name && (this.doc.blocks.get(r.name) || [...this.doc.blocks.values()].find((b) => b.name.toUpperCase() === r.name.toUpperCase()));
    if (byName) return byName;
    const raw = this.blockByHandle.get(r.blockRecordHandle);
    return raw ? this.doc.blocks.get(raw.name) : null;
  }

  dimension(raw, c) {
    // DWG : angle des cotes linéaires relu à part (read.js).
    const rot = this.db.dimRotations?.get(String(raw.handle ?? '').toUpperCase());
    const r = rot ? { ...raw, rotationAngle: rot } : raw;
    const meta = { measurement: r.measurement, text: r.text, style: r.styleName, subclass: r.subclassMarker, ...dimensionDefs(r) };
    const block = this.blockFor(r);
    if (block && (block.raw?.entities?.length || block.entities.length)) {
      return [{ ...c, type: 'BLOCKREF', kind: 'DIMENSION', name: block.name, m: [...G.IDENTITY], meta }];
    }
    const ents = this.dimensionGeometry(r);
    if (!ents) return null;
    const name = `*DIMGEN${++this.synthetic}`;
    this.doc.blocks.set(name, { name, base: [0, 0, 0], flags: 1, xref: false, entities: ents });
    return [{ ...c, type: 'BLOCKREF', kind: 'DIMENSION', name, m: [...G.IDENTITY], meta }];
  }

  // Groupes (DXF : objets GROUP, noms dans le dictionnaire ACAD_GROUP) → champ `group` des membres.
  applyGroups(entities) {
    const groups = this.db.objects?.GROUP || [];
    if (!groups.length) return;
    const names = new Map();
    for (const d of this.db.objects?.DICTIONARY || []) for (const en of d.entries || []) names.set(String(en.objectSoftId ?? en.objectId ?? en.handle ?? '').toUpperCase(), en.name);
    const byHandle = new Map();
    for (const e of entities) if (e.handle != null) byHandle.set(String(e.handle).toUpperCase(), e);
    groups.forEach((g, i) => {
      const name = names.get(String(g.handle).toUpperCase()) || `GROUPE${i + 1}`;
      if (/^\*/.test(name)) return; // groupes anonymes (copies) : ignorés
      for (const h of g.entityIds || []) { const e = byHandle.get(String(h).toUpperCase()); if (e) e.group = name; }
    });
  }

  // Calques gelés d'une fenêtre : poignées des calques (DXF 331, lues par dxf-json) → noms.
  frozenLayers(r) {
    const ids = r.frozenLayerIds || r.frozenLayers || r.layerIds;
    if (!Array.isArray(ids) || !ids.length) return {};
    if (!this.layerByHandle) {
      this.layerByHandle = new Map();
      for (const l of this.db.tables?.LAYER?.entries || []) if (l.handle != null) this.layerByHandle.set(String(l.handle).toUpperCase(), l.name);
    }
    const names = ids.map((h) => this.layerByHandle.get(String(h?.handle ?? h).toUpperCase())).filter(Boolean);
    return names.length ? { frozen: names } : {};
  }

  // Repère (LEADER) : ligne et flèche (DIMASZ × DIMSCALE, variables actives du dessin puis style de cote ;
  // LibreDWG ne décode pas les surcharges DSTYLE), la ligne part du dos de la flèche comme dans AutoCAD.
  leader(r, c) {
    const v = (r.vertices || []).map((p) => [p.x, p.y]);
    if (v.length < 2) return null;
    // Priorité : surcharges de l'objet, puis style de cote nommé par l'objet, puis variables actives, puis Standard.
    const styles = this.db.tables?.DIMSTYLE?.entries || [];
    const named = r.styleName ? styles.find((st) => st.name === r.styleName) : null;
    const std = styles.find((st) => st.name === 'Standard') || {};
    const ov = dimOverrides(r);
    const asz = ov.DIMASZ ?? named?.DIMASZ ?? headerVar(this.db, 'DIMASZ') ?? std.DIMASZ ?? 0.18;
    const size = asz * ((ov.DIMSCALE || named?.DIMSCALE || headerVar(this.db, 'DIMSCALE') || std.DIMSCALE) || 1);
    const d = G.norm(G.sub(v[1], v[0]));
    const arrow = r.isArrowheadEnabled !== false && size > 0 && (d[0] || d[1]) && G.dist(v[0], v[1]) > size;
    if (!arrow) return [{ ...c, type: 'POLY3D', pts: (r.vertices || []).map(P3), closed: false }];
    const pts = [G.add(v[0], G.mul(d, size)), ...v.slice(1)];
    const name = `*LEADER${++this.synthetic}`;
    this.doc.blocks.set(name, { name, base: [0, 0, 0], flags: 1, xref: false, entities: [
      { layer: '0', color: 0, type: 'LWPOLYLINE', pts, bulges: pts.map(() => 0), closed: false, z: 0, width: 0 },
      { layer: '0', color: 0, ...arrowSolid(v[0], d, size) },
    ] });
    return [{ ...c, type: 'BLOCKREF', kind: 'LEADER', name, m: [...G.IDENTITY] }];
  }

  // Multiligne de repère (MLEADER) : lignes de repère, palier, flèches et texte, dans un bloc anonyme
  // (comme les cotes) ; DuBloc pour les éléments qui suivent la couleur de l'objet.
  mleader(r, c) {
    const ents = [];
    const line = { layer: '0', ...cmColor(r.leaderLineColor) };
    const P = (p) => [p.x, p.y];
    const visible = r.leaderLineType !== 0;
    // Flèche et palier : valeurs du style, à multiplier par l'échelle de l'objet (texte déjà à l'échelle).
    const k = r.contentScale > 0 ? r.contentScale : 1;
    const size = r.arrowheadSize > 0 ? r.arrowheadSize * k : 0;
    for (const sec of r.leaderSections || []) {
      const last = sec.lastLeaderLinePoint;
      for (const ln of sec.leaderLines || []) {
        const pts = (ln.vertices || []).map(P);
        if (last) pts.push(P(last));
        if (pts.length < 2) continue;
        const d = G.norm(G.sub(pts[1], pts[0]));
        const arrow = visible && size > 0 && (d[0] || d[1]) && G.dist(pts[0], pts[1]) > size;
        // Comme AutoCAD : la ligne part du dos de la flèche.
        const lp = arrow ? [G.add(pts[0], G.mul(d, size)), ...pts.slice(1)] : pts;
        if (visible) ents.push({ ...line, type: 'LWPOLYLINE', pts: lp, bulges: lp.map(() => 0), closed: false, z: 0, width: 0 });
        if (arrow) ents.push({ ...line, ...arrowSolid(pts[0], d, size) });
      }
      // Longueur du palier : celle de la section est déjà à l'échelle, celle du style non.
      const v = sec.doglegVector, L = sec.doglegLength != null ? sec.doglegLength : r.doglegLength * k;
      if (visible && last && r.doglegEnabled !== false && v && L > 0) {
        ents.push({ ...line, type: 'LINE', p1: [last.x, last.y, 0], p2: [last.x + v.x * L, last.y + v.y * L, 0] });
      }
    }
    if (r.hasMText !== false && r.textContent && r.textAnchor && r.textHeight > 0) {
      const d = r.textDirection;
      ents.push({
        layer: '0', ...cmColor(r.textColor), type: 'MTEXT', p: [r.textAnchor.x, r.textAnchor.y, 0], h: r.textHeight,
        rot: d && (d.x || d.y) ? Math.atan2(d.y, d.x) : r.textRotation || 0, text: r.textContent,
        width: r.textWidth || 0, attach: r.textAttachmentPoint || 1, spacing: r.textLineSpacingFactor || 1,
      });
    }
    if (!ents.length) return null;
    const name = `*MLEADER${++this.synthetic}`;
    this.doc.blocks.set(name, { name, base: [0, 0, 0], flags: 1, xref: false, entities: ents });
    return [{ ...c, type: 'BLOCKREF', kind: 'MLEADER', name, m: [...G.IDENTITY] }];
  }

  // Cote sans bloc précalculé : reconstruite (cotes alignées et linéaires) avec le style du fichier.
  dimensionGeometry(r) {
    const p1 = r.subDefinitionPoint1, p2 = r.subDefinitionPoint2, d = r.definitionPoint;
    if (!p1 || !p2 || !d) return null;
    const style = this.db.tables?.DIMSTYLE?.entries?.find((st) => st.name === r.styleName) || {};
    const pick = (k, def) => style[k] ?? headerVar(this.db, k) ?? def;
    const sizes = dimSizes(pick('DIMSCALE', 1) || 1, {
      DIMASZ: pick('DIMASZ', 0.18), DIMTXT: pick('DIMTXT', 0.18), DIMEXE: pick('DIMEXE', 0.18),
      DIMEXO: pick('DIMEXO', 0.0625), DIMGAP: pick('DIMGAP', 0.09), DIMDEC: 2,
    });
    const res = linearDimension({
      p1: P2(p1), p2: P2(p2), loc: P2(d),
      rotation: r.subclassMarker === 'AcDbRotatedDimension' ? r.rotationAngle || 0 : null,
      sizes, text: r.text ? plainText(r.text) : null, textPoint: r.textPoint ? P2(r.textPoint) : null,
    });
    if (!res) return null;
    if (r.measurement != null) {
      const t = res.entities.find((x) => x.type === 'TEXT');
      if (t && (!r.text || r.text === '<>')) t.text = String(Math.round(r.measurement * 100) / 100);
    }
    return res.entities;
  }

  hatch(r, c) {
    const loops = hatchLoops(r);
    if (!loops.length) return null;
    const lines = (r.definitionLines || []).map((d) => {
      let angle = d.angle || 0;
      if (Math.abs(angle) > G.TAU + 1e-6) angle = (angle * Math.PI) / 180;
      return { angle, base: P2(d.base), offset: P2(d.offset), dashes: d.dashLengths || [] };
    });
    const e = {
      ...c, type: 'HATCH', loops, solid: r.solidFill === 1, pattern: r.patternName || '', lines, z: 0,
      patAngle: r.patternAngle || 0, patScale: r.patternScale || 1,
    };
    if (r.gradientFlag === 1 && r.gradientColors?.length) e.fill = r.gradientColors[0].rgb & 0xffffff;
    // Couleur de fond (données étendues HATCHBACKGROUNDCOLOR d'AutoCAD : 0xC3 + couleur d'index).
    const bgx = (r.xdata || []).find((d) => d?.appName === 'HATCHBACKGROUNDCOLOR');
    if (bgx) {
      const v0 = Array.isArray(bgx.value) ? bgx.value[0] : null;
      const v = (typeof v0 === 'number' ? v0 : v0?.value) >>> 0;
      if ((v >>> 24) === 0xc3 && (v & 0xff) > 0) e.bg = v & 0xff;
    }
    // Hachure associative de l'appli : objets sources par leur poignée (rattachés après l'import).
    const hx = readMepXdata(r)?.hatch;
    if (hx?.assoc?.handles?.length) e.assocRef = hx.assoc;
    return this.ocs(e, r.extrusionDirection);
  }
}

export function importDatabase(db) {
  return new Importer(db).run();
}
