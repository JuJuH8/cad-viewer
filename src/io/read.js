// SPDX-License-Identifier: GPL-3.0-or-later
// Lecture brute d'un DWG (LibreDWG) ou d'un DXF (dxf-json) → DwgDatabase.
// Sans dépendance au DOM : utilisable dans la page comme dans un Web Worker.
import { LIBREDWG_URL, LIBREDWG_WASM_DIR, DXFJSON_URL } from './libs.js';
import { dxfToDatabase } from '../dxf-adapter.js';
import { resolveFieldInfo } from '../core/fields.js';
import { defFromNodes } from '../blocks/acad-dynamic.js';

// Une instance WebAssembly neuve par fichier : avec libredwg-web 0.7.14, après la
// lecture d'un DWG 2018 (AC1032), les lectures suivantes dans la même instance
// échouent (« null function »). Le .wasm reste en cache HTTP, seul le module est recréé.
async function openDwg(buffer) {
  const { Dwg_File_Type, LibreDwg } = await import(LIBREDWG_URL);
  const lib = await LibreDwg.create(LIBREDWG_WASM_DIR);
  const ptr = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
  if (!ptr) throw new Error('LibreDWG n’a pas pu lire ce fichier.');
  return { lib, ptr };
}

// Préchargement : module JavaScript et compilation du WebAssembly, pour que la première
// ouverture d'un gros fichier ne paie pas ce coût dans chaque worker.
export async function warmUp() {
  const { LibreDwg } = await import(LIBREDWG_URL);
  await LibreDwg.create(LIBREDWG_WASM_DIR);
}

async function readDwg(buffer) {
  const { lib, ptr } = await openDwg(buffer);
  try {
    const db = lib.convert(ptr);
    await addDwgUnderlays(lib, ptr, db);
    await addViewportClips(lib, ptr, db);
    await addDrawOrder(lib, ptr, db);
    return db;
  } finally {
    lib.dwg_free(ptr);
  }
}

// Lecture partielle pour la conversion en parallèle : chaque worker décode tout le fichier
// (rapide) mais ne convertit en objets JavaScript (lent) qu'une entité sur `parts` des listes
// d'entités des blocs. Les entités sont numérotées dans l'ordre où LibreDWG les parcourt, ce
// qui est identique dans tous les workers ; ces numéros servent ensuite à rétablir l'ordre.
export async function readDwgPart(buffer, part, parts) {
  const t0 = performance.now();
  const { lib, ptr } = await openDwg(buffer);
  const t1 = performance.now();
  const first = lib.get_first_owned_entity, next = lib.get_next_owned_entity;
  const toEntity = lib.dwg_object_to_entity;
  const seq = new Map(); // objet → numéro d'ordre
  let last = 0;
  const mark = (obj) => {
    if (obj) {
      if (!seq.has(obj)) seq.set(obj, seq.size);
      last = obj;
    }
    return obj;
  };
  const handles = [], order = [];
  // Le Proxy de LibreDwg lit d'abord les propriétés propres : ces remplacements sont prioritaires.
  lib.get_first_owned_entity = (blk) => mark(first.call(lib, blk));
  lib.get_next_owned_entity = (blk, cur) => mark(next.call(lib, blk, cur));
  lib.dwg_object_to_entity = (obj) => {
    // Seule la conversion d'une entité tout juste parcourue est filtrée (pas ses attributs, sommets…).
    if (obj && obj === last) {
      last = 0;
      const n = seq.get(obj);
      if (n % parts !== part) return 0;
      handles.push(lib.dwg_object_get_handle_object(obj).value);
      order.push(n);
    }
    return toEntity.call(lib, obj);
  };
  try {
    const db = lib.convert(ptr);
    if (part === 0) await addDwgUnderlays(lib, ptr, db);
    await addViewportClips(lib, ptr, db);
    if (part === 0) await addDrawOrder(lib, ptr, db);
    const times = { open: Math.round(t1 - t0), convert: Math.round(performance.now() - t1) };
    return { db, handles: Float64Array.from(handles, Number), order: Uint32Array.from(order), times };
  } finally {
    lib.dwg_free(ptr);
  }
}

// Fonds PDF des DWG (PDFUNDERLAY), que la conversion de libredwg-web ignore : lus par les fonctions bas niveau
// de LibreDWG, rangés dans le bloc qui les contient (espace objet, présentation, bloc), avec leurs définitions.
async function addDwgUnderlays(lib, ptr, db) {
  const { Dwg_Object_Type } = await import(LIBREDWG_URL);
  const T = Dwg_Object_Type;
  if (!T?.DWG_TYPE_PDFUNDERLAY) return;
  let list = [];
  try { list = lib.dwg_getall_entity_by_type(ptr, T.DWG_TYPE_PDFUNDERLAY) || []; } catch { return; }
  if (!list.length) return;
  const val = (u, f) => { try { const r = lib.dwg_dynapi_entity_value(u, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const com = (u, f) => { try { const r = lib.dwg_dynapi_common_value(u, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const hex = (n) => (n == null ? null : Number(n).toString(16).toUpperCase());
  const heap = lib.wasmInstance?.HEAPF64;
  const defs = [];
  try {
    for (const d of lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_PDFDEFINITION) || []) {
      const obj = lib.dwg_obj_generic_to_object(d);
      defs.push({ handle: hex(lib.dwg_object_get_handle_object(obj).value), path: val(d, 'filename') || '', page: String(val(d, 'name') || '1') });
    }
  } catch { /* définitions illisibles : fonds sans fichier */ }
  db.objects = db.objects || {};
  db.objects.PDFDEFINITION = defs;
  const records = db.tables?.BLOCK_RECORD?.entries || [];
  const model = records.find((b) => isModelSpace(b.name)), paper = records.find((b) => /^\*paper_space$/i.test(b.name));
  for (const u of list) {
    const obj = lib.dwg_obj_generic_to_object(u);
    const ins = val(u, 'ins_pt') || { x: 0, y: 0, z: 0 };
    const nClip = val(u, 'num_clip_verts') || 0, clipPtr = val(u, 'clip_verts');
    const clip = [];
    if (heap && nClip > 0 && clipPtr) for (let i = 0; i < nClip; i++) clip.push([heap[clipPtr / 8 + i * 2], heap[clipPtr / 8 + i * 2 + 1]]);
    const layerRef = com(u, 'layer');
    let layer = '0';
    try { layer = layerRef ? lib.dwg_ref_get_object_name(layerRef) || '0' : '0'; } catch { /* calque 0 */ }
    const color = com(u, 'color');
    const raw = {
      type: 'PDFUNDERLAY', handle: hex(lib.dwg_object_get_handle_object(obj).value), layer,
      colorIndex: color?.index ?? 256,
      defHandle: hex(lib.dwg_ref_get_absref(val(u, 'definition_id'))),
      position: ins, scale: val(u, 'scale') || { x: 1, y: 1, z: 1 }, rotation: val(u, 'angle') || 0,
      flags: val(u, 'flag') ?? 11, contrast: val(u, 'contrast') ?? 100, fade: val(u, 'fade') ?? 0, clip,
    };
    try { raw.xdata = lib.dwg_object_entity_get_xdata(lib.dwg_object_to_entity(obj)) || []; } catch { raw.xdata = []; }
    // Bloc propriétaire : espace objet (entmode 2), présentation active (1), sinon par son propriétaire.
    const mode = com(u, 'entmode');
    let rec = mode === 2 ? model : mode === 1 ? paper : null;
    if (!rec) {
      try { const h = hex(lib.dwg_ref_get_absref(com(u, 'ownerhandle'))); rec = records.find((b) => String(b.handle).toUpperCase() === h); } catch { /* inconnu */ }
    }
    if (!rec) continue;
    rec.entities = rec.entities || [];
    if (!rec.entities.some((e) => e.handle === raw.handle)) rec.entities.unshift(raw);
    if (rec === model || rec === paper) db.entities?.unshift(raw);
  }
}

// Champs des DWG (objets FIELD, que la conversion de libredwg-web ignore) : rattachés aux textes et attributs par
// leur dictionnaire d'extension (ownerDictionaryHardId) → ACAD_FIELD → TEXT.
function addFields(lib, ptr, db, T, heap) {
  if (!T?.DWG_TYPE_FIELD || !heap) return;
  let list = [];
  try { list = lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_FIELD) || []; } catch { return; }
  if (!list.length) return;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const hexRef = (ref) => { try { return Number(lib.dwg_ref_get_absref(ref)).toString(16).toUpperCase(); } catch { return null; } };
  const refs = (o, nf, af) => {
    const n = val(o, nf) || 0, p = val(o, af), out = [];
    for (let i = 0; p && i < n; i++) { const h = hexRef(heap[(p >> 2) + i]); if (h) out.push(h); }
    return out;
  };
  const fields = new Map();
  for (const o of list) {
    const obj = lib.dwg_obj_generic_to_object(o);
    const h = Number(lib.dwg_object_get_handle_object(obj).value).toString(16).toUpperCase();
    fields.set(h, { id: val(o, 'id') || '', code: val(o, 'code') || '', childs: refs(o, 'num_childs', 'childs'), objs: refs(o, 'num_objects', 'objects') });
  }
  const dicts = new Map();
  for (const d of db.objects?.DICTIONARY || []) {
    const e = d.entries || {};
    dicts.set(String(d.handle).toUpperCase(), Array.isArray(e) ? e.map((x) => [x.name, String(x.objectSoftId ?? x.handle).toUpperCase()]) : Object.entries(e).map(([n, v]) => [n, String(v).toUpperCase()]));
  }
  const attach = (e) => {
    const xd = e.ownerDictionaryHardId;
    if (xd && xd !== '0' && /TEXT|ATTRIB|ATTDEF/.test(e.type)) {
      const info = resolveFieldInfo(xd, dicts, fields);
      if (info) e.fieldInfo = info;
    }
    for (const a of e.attribs || []) attach(a);
  };
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) for (const e of b.entities || []) attach(e);
  for (const e of db.entities || []) attach(e);
}

// Blocs dynamiques d'AutoCAD des DWG (voir blocks/acad-dynamic.js) : paramètres, actions et liens insertion → bloc
// dynamique (BLOCKREPRESENTATION), lus par les fonctions bas niveau de LibreDWG ; les structures que la conversion
// ignore (numéro de nœud, états de visibilité, liaisons, jeux de valeurs, points d'étirement) sont lues dans la
// mémoire WebAssembly aux positions données par LibreDWG. Les tables de consultation (mal décodées par LibreDWG)
// manquent : les paramètres de consultation des DWG ne sont pas convertis. Les valeurs des insertions sont relues à
// l'import (XRECORD des dictionnaires).
function addAcadDynamic(lib, ptr, db, T, heap) {
  if (!T?.DWG_TYPE_EVALUATION_GRAPH || !heap) return;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const com = (o, f) => { try { const r = lib.dwg_dynapi_common_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const off = (o, f) => { try { return lib.dwg_dynapi_entity_field_offset(o, f); } catch { return -1; } };
  const hexRef = (ref) => { try { return Number(lib.dwg_ref_get_absref(ref)).toString(16).toUpperCase(); } catch { return null; } };
  const handleOf = (o) => Number(lib.dwg_object_get_handle_object(lib.dwg_obj_generic_to_object(o)).value).toString(16).toUpperCase();
  const all = (t) => { try { return T[t] ? lib.dwg_getall_object_by_type(ptr, T[t]) || [] : []; } catch { return []; } };
  const graphs = all('DWG_TYPE_EVALUATION_GRAPH');
  if (!graphs.length) return;
  const U8 = lib.wasmInstance.HEAPU8, U16 = lib.wasmInstance.HEAPU16, F64 = lib.wasmInstance.HEAPF64;
  // Texte d'une structure : UTF-16 (DWG 2007 et suivants) ou octets (versions antérieures).
  const tstr = (p) => {
    let s = '';
    if (!p) return s;
    if (U8[p + 1] === 0 && U8[p]) { for (let i = p >> 1; U16[i] && s.length < 512; i++) s += String.fromCharCode(U16[i]); return s; }
    for (let i = p; U8[i] && s.length < 512; i++) s += String.fromCharCode(U8[i]);
    return s;
  };
  const u32 = (a) => heap[a >> 2];
  const refs = (n, p) => { const out = []; for (let i = 0; p && i < n; i++) { const h = hexRef(heap[(p >> 2) + i]); if (h) out.push(h); } return out; };
  const ints = (n, p) => { const out = []; for (let i = 0; p && i < n; i++) out.push(heap[(p >> 2) + i]); return out; };
  const P2 = (q) => (q ? [q.x || 0, q.y || 0] : [0, 0]);
  let nodeOff = 40;
  try { nodeOff = lib.dwg_dynapi_subclass_field_offset('EvalExpr', 'nodeid'); } catch { /* valeur de LibreDWG 0.7 */ }
  const nodeId = (o) => { const e = off(o, 'evalexpr'); return e >= 0 ? u32(o + e + nodeOff) : null; };
  // Graphe → enregistrement de bloc : graphe → dictionnaire d'extension → son propriétaire.
  const dictOwner = new Map((db.objects?.DICTIONARY || []).map((d) => [String(d.handle).toUpperCase(), String(d.ownerHandle ?? '').toUpperCase()]));
  const recName = new Map((db.tables?.BLOCK_RECORD?.entries || []).map((b) => [String(b.handle).toUpperCase(), b.name]));
  const graphRec = new Map();
  for (const g of graphs) {
    const rec = dictOwner.get(hexRef(com(g, 'ownerhandle')) || '');
    if (rec && recName.has(rec)) graphRec.set(handleOf(g), rec);
  }
  const nodes = new Map(); // enregistrement → nœuds
  const add = (o, n) => {
    const rec = graphRec.get(hexRef(com(o, 'ownerhandle')) || '');
    if (!rec) return;
    if (!nodes.has(rec)) nodes.set(rec, []);
    nodes.get(rec).push({ handle: handleOf(o), id: nodeId(o), label: val(o, 'name') || '', ...n });
  };
  const valueSet = (o, f) => {
    const b = off(o, f);
    if (b < 0) return null;
    const a = o + b, n = u32(a + 32), lp = u32(a + 36);
    const list = [];
    for (let i = 0; lp && i < n && i < 1000; i++) list.push(F64[(lp >> 3) + i]);
    return { flags: u32(a + 4), min: F64[(a + 8) >> 3], max: F64[(a + 16) >> 3], inc: F64[(a + 24) >> 3], list };
  };
  const conns = (o, n) => {
    const b = off(o, 'conn_pts');
    const out = [];
    for (let k = 0; b >= 0 && k < n; k++) {
      const name = tstr(u32(o + b + k * 8 + 4));
      if (name) out.push([u32(o + b + k * 8), name]);
    }
    return out;
  };
  const KINDS = { BLOCKLINEARPARAMETER: 'linear', BLOCKROTATIONPARAMETER: 'rotation', BLOCKPOINTPARAMETER: 'point', BLOCKFLIPPARAMETER: 'flip', BLOCKLOOKUPPARAMETER: 'lookup', BLOCKBASEPOINTPARAMETER: 'basepoint' };
  for (const o of all('DWG_TYPE_BLOCKVISIBILITYPARAMETER')) {
    const states = [];
    const n = val(o, 'num_states') || 0, sp = val(o, 'states');
    // État (structure de 6 mots de 32 bits) : parent, nom, nb d'objets, objets, nb de nœuds, nœuds.
    for (let k = 0; sp && k < n; k++) {
      const b = (sp >> 2) + k * 6;
      states.push({ name: tstr(heap[b + 1]), ents: refs(heap[b + 2], heap[b + 3]) });
    }
    add(o, { kind: 'visibility', param: true, type: 'BLOCKVISIBILITYPARAMETER', name: val(o, 'blockvisi_name') || 'Visibilité', desc: val(o, 'blockvisi_desc') || '', pt: P2(val(o, 'def_pt')), current: 0, all: refs(val(o, 'num_blocks') || 0, val(o, 'blocks')), states });
  }
  for (const [type, kind] of Object.entries(KINDS)) {
    for (const o of all(`DWG_TYPE_${type}`)) {
      const n = { kind, param: true, type, chain: val(o, 'chain_actions') === 1 };
      if (kind === 'linear' || kind === 'rotation' || kind === 'flip') {
        Object.assign(n, { base: P2(val(o, 'def_basept')), end: P2(val(o, 'def_endpt')), mid: val(o, 'parameter_base_location') === 1 });
        n.pt = n.base;
      } else n.pt = P2(val(o, 'def_pt'));
      if (kind === 'linear') Object.assign(n, { name: val(o, 'distance_name'), vset: valueSet(o, 'value_set') });
      if (kind === 'rotation') Object.assign(n, { name: val(o, 'angle_name'), ref: P2(val(o, 'def_base_angle_pt') || val(o, 'def_endpt')), vset: valueSet(o, 'angle_value_set') });
      if (kind === 'flip') Object.assign(n, { name: val(o, 'flip_label'), labels: [val(o, 'base_state_label') || '', val(o, 'flipped_state_label') || ''] });
      if (kind === 'point') n.name = val(o, 'position_name');
      if (kind === 'lookup') Object.assign(n, { name: val(o, 'lookup_name'), action: val(o, 'index') });
      add(o, n);
    }
  }
  const ACTIONS = { BLOCKMOVEACTION: ['move', 2], BLOCKSTRETCHACTION: ['stretch', 2], BLOCKSCALEACTION: ['scale', 5], BLOCKROTATEACTION: ['rotate', 3], BLOCKFLIPACTION: ['flip', 4] };
  for (const [type, [action, nc]] of Object.entries(ACTIONS)) {
    for (const o of all(`DWG_TYPE_${type}`)) {
      const n = {
        kind: 'action', action, type, pt: [0, 0], conns: conns(o, nc),
        params: ints(val(o, 'num_actions') || 0, u32(o + off(o, 'actions'))), sel: refs(val(o, 'num_deps') || 0, u32(o + off(o, 'deps'))),
      };
      if (action === 'rotate' || action === 'scale') Object.assign(n, { offset: P2(val(o, 'offset')), dependent: val(o, 'dependent') !== 0, basePt: P2(val(o, 'base_pt')) });
      if (action === 'move' || action === 'stretch') Object.assign(n, { mult: val(o, 'action_offset_x') ?? 1, angle: val(o, 'action_offset_y') || 0 });
      if (action === 'stretch') {
        const frame = [];
        const np = val(o, 'num_pts') || 0, pp = u32(o + off(o, 'pts'));
        for (let i = 0; pp && i < np; i++) frame.push([F64[(pp >> 3) + i * 2], F64[(pp >> 3) + i * 2 + 1]]);
        const list = (count, field, key) => {
          const out = [];
          const base = u32(o + off(o, field));
          for (let i = 0; base && i < (val(o, count) || 0); i++) {
            const b = base + i * 16;
            out.push([key(u32(b + 4)), ints(u32(b + 8), u32(b + 12))]);
          }
          return out;
        };
        Object.assign(n, { frame, verts: list('num_hdls', 'hdls', hexRef), pverts: list('num_codes', 'codes', (x) => x) });
      }
      add(o, n);
    }
  }
  // Éléments non gérés (paramètres polaires, XY, alignement, réseau, contraintes…) : bloc converti en partie.
  for (const t of Object.keys(T).filter((k) => /^DWG_TYPE_(BLOCK[A-Z]*(PARAMETER|ACTION)|ACDB_DYNAMICPROXYNODE)$/.test(k))) {
    const type = t.replace('DWG_TYPE_', '');
    if (type === 'BLOCKVISIBILITYPARAMETER' || KINDS[type] || ACTIONS[type] || type === 'BLOCKLOOKUPACTION') continue;
    for (const o of all(t)) add(o, { kind: 'other', param: /PARAMETER$/.test(type), type, pt: P2(val(o, 'def_pt') || val(o, 'def_basept')) });
  }
  const defs = new Map();
  for (const [rec, list] of nodes) defs.set(rec, defFromNodes(recName.get(rec), list));
  const repData = new Map();
  for (const o of all('DWG_TYPE_BLOCKREPRESENTATION')) repData.set(handleOf(o), hexRef(val(o, 'block')));
  if (defs.size) db.acadDyn = { defs, reps: new Map(), inserts: new Map(), repData, dwg: true };
}

// Cotes associatives des DWG (objets DIMASSOC, ignorés par la conversion) : cote, points accrochés (bits) et, pour
// chacun, type d'accrochage, objet, marqueur (segment) et paramètre, lus dans la mémoire de LibreDWG.
function addDimAssoc(lib, ptr, db, T, heap) {
  if (!T?.DWG_TYPE_DIMASSOC || !heap) return;
  let list = [];
  try { list = lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_DIMASSOC) || []; } catch { return; }
  if (!list.length) return;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const hexRef = (ref) => { try { const v = lib.dwg_ref_get_absref(ref); return v ? Number(v).toString(16).toUpperCase() : null; } catch { return null; } };
  const sub = (f, d) => { try { const v = lib.dwg_dynapi_subclass_field_offset('DIMASSOC_Ref', f); return v >= 0 ? v : d; } catch { return d; } };
  let size = 96;
  try { size = lib.dwg_dynapi_subclass_size('DIMASSOC_Ref') || 96; } catch { /* valeur de LibreDWG 0.7 */ }
  const O = { osnap: sub('osnap_type', 8), dist: sub('osnap_dist', 16), n: sub('num_xrefs', 48), objs: sub('xrefs', 52), gs: sub('main_gsmarker', 60) };
  const U8 = lib.wasmInstance.HEAPU8, F64 = lib.wasmInstance.HEAPF64;
  let refOff = -1;
  const out = new Map();
  for (const o of list) {
    const dim = hexRef(val(o, 'dimensionobj'));
    const bits = val(o, 'associativity') || 0;
    if (refOff < 0) { try { refOff = lib.dwg_dynapi_entity_field_offset(o, 'ref'); } catch { refOff = 16; } }
    const base = heap[(o + refOff) >> 2];
    if (!dim || !base) continue;
    const refs = [];
    for (let k = 0; k < 4; k++) {
      if (!(bits & (1 << k))) continue;
      const b = base + k * size;
      const n = heap[(b + O.n) >> 2], objs = heap[(b + O.objs) >> 2];
      refs.push({ bit: k, osnap: U8[b + O.osnap], obj: n && objs ? hexRef(heap[objs >> 2]) : null, gs: heap[(b + O.gs) >> 2], param: F64[(b + O.dist) >> 3] });
    }
    out.set(dim, refs);
  }
  if (out.size) db.dimAssoc = out;
}

// Styles de tracé nommés des DWG : noms (dictionnaires avec valeur par défaut : poignée → nom) et style de chaque
// calque, que la conversion de libredwg-web laisse vides. (Les styles imposés objet par objet sont mal décodés par
// LibreDWG : ils ne sont pas relus.)
function addPlotStyles(lib, ptr, db, T, heap) {
  if (!heap || !T?.DWG_TYPE_DICTIONARYWDFLT) return;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const hexRef = (ref) => { try { const v = lib.dwg_ref_get_absref(ref); return v ? Number(v).toString(16).toUpperCase() : null; } catch { return null; } };
  const U8 = lib.wasmInstance.HEAPU8, U16 = lib.wasmInstance.HEAPU16;
  const tstr = (p) => {
    let s = '';
    if (!p) return s;
    if (U8[p + 1] === 0 && U8[p]) { for (let i = p >> 1; U16[i] && s.length < 256; i++) s += String.fromCharCode(U16[i]); return s; }
    for (let i = p; U8[i] && s.length < 256; i++) s += String.fromCharCode(U8[i]);
    return s;
  };
  try {
    const names = new Map();
    for (const o of lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_DICTIONARYWDFLT) || []) {
      const n = val(o, 'numitems') || 0, tp = val(o, 'texts'), ip = val(o, 'itemhandles');
      for (let i = 0; tp && ip && i < n; i++) {
        const h = hexRef(heap[(ip >> 2) + i]);
        if (h) names.set(h, tstr(heap[(tp >> 2) + i]));
      }
    }
    const layers = new Map();
    for (const o of lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_LAYER) || []) {
      const h = hexRef(val(o, 'plotstyle'));
      if (h) layers.set(val(o, 'name'), h);
    }
    if (names.size) { db.plotStyleNames = names; db.layerPlotStyles = layers; }
  } catch { /* styles nommés non relus */ }
}

// SCU nommés des DWG (table UCS), que la conversion de libredwg-web ignore.
function addUcsTable(lib, ptr, db, T) {
  if (!T?.DWG_TYPE_UCS) return;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  let list = [];
  try { list = lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_UCS) || []; } catch { return; }
  const entries = list.map((o) => ({ name: val(o, 'name'), origin: val(o, 'ucsorg'), xAxis: val(o, 'ucsxdir') })).filter((u) => u.name);
  if (entries.length) { db.tables = db.tables || {}; db.tables.UCS = { entries }; }
}

// Ordre de tracé des DWG (tables SORTENTSTABLE : objet → poignée de tri) et cadres des masques (WIPEOUTFRAME),
// que la conversion de libredwg-web ignore : lus par les fonctions bas niveau de LibreDWG.
async function addDrawOrder(lib, ptr, db) {
  const { Dwg_Object_Type } = await import(LIBREDWG_URL);
  const T = Dwg_Object_Type;
  const val = (o, f) => { try { const r = lib.dwg_dynapi_entity_value(o, f); return r?.success ? r.data : undefined; } catch { return undefined; } };
  const hex = (ref) => { try { return Number(lib.dwg_ref_get_absref(ref)).toString(16).toUpperCase(); } catch { return null; } };
  const heap = lib.wasmInstance?.HEAPU32;
  addUcsTable(lib, ptr, db, T);
  addFields(lib, ptr, db, T, heap);
  addAcadDynamic(lib, ptr, db, T, heap);
  addDimAssoc(lib, ptr, db, T, heap);
  addPlotStyles(lib, ptr, db, T, heap);
  // Angle des cotes linéaires (dim_rotation), que la conversion de libredwg-web laisse à 0.
  if (T?.DWG_TYPE_DIMENSION_LINEAR) {
    try {
      const rot = new Map();
      for (const o of lib.dwg_getall_entity_by_type(ptr, T.DWG_TYPE_DIMENSION_LINEAR) || []) {
        const a = val(o, 'dim_rotation');
        if (a) rot.set(Number(lib.dwg_object_get_handle_object(lib.dwg_obj_generic_to_object(o)).value).toString(16).toUpperCase(), a);
      }
      if (rot.size) db.dimRotations = rot;
    } catch { /* angles laissés à 0 */ }
  }
  db.sortents = [];
  if (T?.DWG_TYPE_SORTENTSTABLE && heap) {
    let list = [];
    try { list = lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_SORTENTSTABLE) || []; } catch { list = []; }
    for (const o of list) {
      const n = val(o, 'num_ents') || 0, ents = val(o, 'ents'), sorts = val(o, 'sort_ents');
      if (!n || !ents || !sorts) continue;
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const e = hex(heap[(ents >> 2) + i]), s = hex(heap[(sorts >> 2) + i]);
        if (e && s) pairs.push([e, s]);
      }
      db.sortents.push({ owner: hex(val(o, 'block_owner')), pairs });
    }
  }
  // WIPEOUTFRAME : entrée du dictionnaire des variables → DICTIONARYVAR.
  const dicts = db.objects?.DICTIONARY || [];
  let fh = null;
  for (const d of dicts) {
    const e = d.entries || {};
    const h = Array.isArray(e) ? e.find((x) => x.name === 'WIPEOUTFRAME')?.objectSoftId : e.WIPEOUTFRAME;
    if (h != null) { fh = String(h).toUpperCase(); break; }
  }
  if (fh && T?.DWG_TYPE_DICTIONARYVAR) {
    try {
      for (const o of lib.dwg_getall_object_by_type(ptr, T.DWG_TYPE_DICTIONARYVAR) || []) {
        const obj = lib.dwg_obj_generic_to_object(o);
        if (Number(lib.dwg_object_get_handle_object(obj).value).toString(16).toUpperCase() !== fh) continue;
        const v = parseInt(val(o, 'strvalue'), 10);
        if (Number.isFinite(v)) db.wipeoutFrame = v;
      }
    } catch { /* variable illisible : cadres affichés */ }
  }
}

// Fenêtres de présentation découpées par un contour (polyligne, cercle…) : poignée du contour, lue par les fonctions
// bas niveau de LibreDWG et notée sur la fenêtre convertie (clippingBoundaryId, comme en DXF).
async function addViewportClips(lib, ptr, db) {
  const { Dwg_Object_Type } = await import(LIBREDWG_URL);
  let list = [];
  try { list = lib.dwg_getall_entity_by_type(ptr, Dwg_Object_Type.DWG_TYPE_VIEWPORT) || []; } catch { return; }
  const hex = (n) => (n == null ? null : Number(n).toString(16).toUpperCase());
  const byHandle = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) for (const e of b.entities || []) if (e.type === 'VIEWPORT') byHandle.set(String(e.handle).toUpperCase(), e);
  for (const v of list) {
    try {
      const h = hex(lib.dwg_object_get_handle_object(lib.dwg_obj_generic_to_object(v)).value);
      const raw = byHandle.get(h);
      if (!raw || !((raw.statusBitFlags || 0) & 0x10000) || raw.clippingBoundaryId) continue;
      const r = lib.dwg_dynapi_entity_value(v, 'clip_boundary');
      const ref = r?.success ? r.data : null;
      const abs = ref ? lib.dwg_ref_get_absref(ref) : null;
      if (abs) raw.clippingBoundaryId = hex(abs);
    } catch { /* fenêtre sans contour lisible : gardée rectangulaire */ }
  }
}

const isModelSpace = (name) => /^\*model_space$/i.test(name || '');
const isPaperSpace = (name) => /^\*paper_space/i.test(name || '');

// Réunit les lectures partielles en une base identique à une lecture complète.
export function mergeParts(results) {
  const base = results[0].db;
  const orderOf = new Map();
  for (const r of results) for (let i = 0; i < r.handles.length; i++) orderOf.set(r.handles[i], r.order[i]);
  const entries = base.tables.BLOCK_RECORD.entries;
  entries.forEach((blk, i) => {
    const seen = new Set();
    const all = [];
    for (const r of results) {
      const other = r.db.tables.BLOCK_RECORD.entries[i];
      if (!other || other.handle !== blk.handle) throw new Error('Lectures partielles incohérentes.');
      for (const e of other.entities) {
        // Un petit bloc peut être converti entièrement par plusieurs workers : on dédoublonne.
        if (seen.has(e.handle)) continue;
        seen.add(e.handle);
        all.push(e);
      }
    }
    const key = (e) => orderOf.get(parseInt(e.handle, 16)) ?? Infinity;
    blk.entities = all.map((e, k) => ({ e, o: key(e), k })).sort((a, b) => a.o - b.o || a.k - b.k).map((x) => x.e);
  });
  // Liste des entités des espaces objet et papier, comme dans LibreDwgConverter.convert.
  base.entities = [];
  for (const blk of entries) {
    if (!isModelSpace(blk.name) && !isPaperSpace(blk.name)) continue;
    for (const e of blk.entities) {
      base.entities.push(e);
      if (e.type === 'INSERT') for (const a of e.attribs || []) base.entities.push(a);
    }
  }
  base.entities
    .filter((e) => e.type === 'VIEWPORT')
    .sort((a, b) => parseInt(a.handle, 16) - parseInt(b.handle, 16))
    .forEach((v, i) => { v.viewportId = i + 1; });
  return base;
}

// Le paquet libredwg-web est compilé sans lecteur DXF : on utilise dxf-json.
async function readDxf(buffer) {
  const { DxfParser } = await import(DXFJSON_URL);
  const bytes = new Uint8Array(buffer);
  return dxfToDatabase(new DxfParser().parseBuffer(bytes), () => new TextDecoder('latin1').decode(bytes));
}

export function readRaw(buffer, fileName) {
  return /\.dxf$/i.test(fileName) ? readDxf(buffer) : readDwg(buffer);
}
