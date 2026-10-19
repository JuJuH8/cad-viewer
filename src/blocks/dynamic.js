// SPDX-License-Identifier: GPL-3.0-or-later
// Blocs dynamiques (modèle propre à l'appli, sur le principe d'AutoCAD) : la définition du bloc porte des
// paramètres (linéaire, point, rotation, inversion, visibilité) et des actions qui leur sont associées
// (étirer, déplacer, échelle, rotation, inversion) ; chaque insertion porte ses valeurs (ins.dyn). Sa
// géométrie est la définition évaluée avec ces valeurs, comme la représentation anonyme d'AutoCAD.
//
// block.dyn = { params: [...], actions: [...] }, les objets du bloc étant repérés par leur clé `k`.
//   linéaire  { id, type: 'linear', name, p1, p2, min, max, step, list }       valeur : distance
//   point     { id, type: 'point', name, p }                                    valeur : déplacement [dx, dy]
//   rotation  { id, type: 'rotation', name, c, r, a0 }                          valeur : angle (rad)
//   inversion { id, type: 'flip', name, p1, p2 }                                valeur : 0 / 1
//   visibilité{ id, type: 'visibility', name, p, states: [...], hidden: { état: [clés] } }  valeur : état
//               (plusieurs paramètres de visibilité possibles : un objet est caché si l'un d'eux le cache)
//   consultation { id, type: 'lookup', name, p, rows: [{ label, values: { paramId: valeur } }] }  valeur : ligne
//               (choisir une ligne règle d'un coup les autres paramètres, comme une table de consultation AutoCAD)
//   action    { id, type: 'stretch' | 'move' | 'scale' | 'rotate' | 'flip', param, keys: [...], frame }
// Blocs relus d'AutoCAD (dyn.acad = 2) : paramètres marqués `acad`, évalués par acad-eval.js (les actions y
// transforment aussi les paramètres) ; leurs valeurs ne sont arrondies au jeu de valeurs que lors d'une modification.
import * as G from '../core/geom.js';
import { evaluateAcad, acadGrip, acadValueFromPoint } from './acad-eval.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { stretchEntity } from '../core/path.js';

export const PARAM_TYPES = { linear: 'Linéaire', point: 'Point', rotation: 'Rotation', flip: 'Inversion', visibility: 'Visibilité', lookup: 'Consultation' };
export const ACTION_TYPES = { stretch: 'Étirer', move: 'Déplacer', scale: 'Échelle', rotate: 'Rotation', flip: 'Inversion' };
export const ACTIONS_FOR = { linear: ['stretch', 'move', 'scale'], point: ['move', 'stretch'], rotation: ['rotate'], flip: ['flip'], visibility: [], lookup: [] };
export const CUSTOM_ROW = 'Personnalisé';

export const isDynamic = (block) => !!block?.dyn?.params?.length;

// --- valeurs ----------------------------------------------------------------------------

export function defaultValue(p) {
  switch (p.type) {
    case 'linear': return G.dist(p.p1, p.p2);
    case 'point': return [0, 0];
    case 'rotation': return p.def ?? 0;
    case 'flip': return 0;
    case 'visibility': return p.def && p.states?.includes(p.def) ? p.def : p.states?.[0] ?? '';
    case 'lookup': return p.rows?.[0]?.label ?? CUSTOM_ROW;
    default: return null;
  }
}

// Valeur admise : bornes, liste de valeurs ou pas (à partir du minimum, sinon de la valeur par défaut). edit = false :
// valeur relue telle quelle (paramètres d'AutoCAD, dont les valeurs enregistrées font foi).
export function normalize(p, v, edit = true) {
  if (p.type === 'linear') {
    let x = Number(v);
    if (!Number.isFinite(x)) x = defaultValue(p);
    if (!edit) return Math.max(1e-9, x);
    if (p.list?.length) return p.list.reduce((best, c) => (Math.abs(c - x) < Math.abs(best - x) ? c : best), p.list[0]);
    if (p.min != null) x = Math.max(p.min, x);
    if (p.max != null) x = Math.min(p.max, x);
    if (p.step > 0) {
      const from = p.min ?? defaultValue(p);
      x = from + Math.round((x - from) / p.step) * p.step;
      if (p.max != null && x > p.max + 1e-9) x -= p.step;
    }
    return Math.max(1e-9, x);
  }
  if (p.type === 'point') return Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0];
  if (p.type === 'rotation') {
    const a = Number(v) || 0;
    return edit && p.step > 0 ? Math.round(a / p.step) * p.step : a;
  }
  if (p.type === 'flip') return v ? 1 : 0;
  if (p.type === 'visibility') return p.states?.includes(v) ? v : defaultValue(p);
  if (p.type === 'lookup') return v === CUSTOM_ROW || p.rows?.some((r) => r.label === v) ? v : p.rows?.[0]?.label ?? CUSTOM_ROW;
  return v;
}

// Objets cachés pour ces valeurs : union des objets cachés par chaque paramètre de visibilité.
export function hiddenKeys(dyn, values = {}) {
  const out = new Set();
  for (const p of dyn?.params || []) {
    if (p.type !== 'visibility') continue;
    for (const k of p.hidden?.[valueOf(p, values)] || []) out.add(k);
  }
  return out;
}

export const valueOf = (p, values = {}) => normalize(p, values[p.id] ?? defaultValue(p), !p.acad);

// Valeur d'un paramètre lisible (Propriétés, liste) ; len : formatage des longueurs.
export function describeValue(p, v, len = (x) => String(Math.round(x * 100) / 100)) {
  if (p.type === 'linear') return len(v);
  if (p.type === 'point') return `${len(v[0])}, ${len(v[1])}`;
  if (p.type === 'rotation') return `${Math.round((v * 180) / Math.PI * 100) / 100}°`;
  if (p.type === 'flip') return p.labels?.[v ? 1 : 0] || (v ? 'Inversé' : 'Normal');
  return String(v);
}

// Choix proposés par un paramètre à liste (poignée triangle, Propriétés) : états ou lignes de table.
export function choicesOf(p) {
  if (p.type === 'visibility') return p.states || [];
  if (p.type === 'lookup') return p.reverse === false ? [] : (p.rows || []).map((r) => r.label);
  return [];
}

// --- évaluation -------------------------------------------------------------------------------

const mirror = (a, b) => {
  const ang = G.angleOf(a, b);
  return G.compose(G.translation(a[0], a[1]), G.compose(G.rotation(ang), G.compose(G.scaling(1, -1), G.compose(G.rotation(-ang), G.translation(-a[0], -a[1])))));
};

// Transformation (matrice) ou étirement d'une action pour la valeur v de son paramètre.
function actionEffect(a, p, v) {
  if (p.type === 'linear') {
    const d0 = G.dist(p.p1, p.p2) || 1;
    const u = G.norm(G.sub(p.p2, p.p1));
    if (a.type === 'scale') {
      const k = v / d0;
      return { m: G.compose(G.translation(p.p1[0], p.p1[1]), G.compose(G.scaling(k, k), G.translation(-p.p1[0], -p.p1[1]))) };
    }
    const dx = u[0] * (v - d0), dy = u[1] * (v - d0);
    return a.type === 'stretch' ? { stretch: [dx, dy] } : { m: G.translation(dx, dy) };
  }
  if (p.type === 'point') return a.type === 'stretch' ? { stretch: v } : { m: G.translation(v[0], v[1]) };
  if (p.type === 'rotation') return { m: G.rotation(v, p.c[0], p.c[1]) };
  if (p.type === 'flip') return v ? { m: mirror(p.p1, p.p2) } : null;
  return null;
}

const boxOf = (pts) => {
  const b = G.emptyBox();
  for (const q of pts) G.growBox(b, q[0], q[1]);
  return b;
};

// Objets du bloc pour ces valeurs (coordonnées du bloc) : visibilité, puis actions dans l'ordre.
export function evaluate(block, values = {}) {
  const dyn = block.dyn;
  let ents = block.entities;
  if (!dyn) return ents;
  const params = new Map(dyn.params.map((p) => [p.id, p]));
  const hidden = hiddenKeys(dyn, values);
  if (hidden.size) ents = ents.filter((e) => !hidden.has(e.k));
  if (dyn.acad === 2) return evaluateAcad(dyn, ents, (p) => valueOf(p, values)).entities;
  const out = new Map(ents.map((e) => [e.k, e]));
  const order = ents.map((e) => e.k);
  for (const a of dyn.actions || []) {
    const p = params.get(a.param);
    if (!p) continue;
    const fx = actionEffect(a, p, valueOf(p, values));
    if (!fx) continue;
    const frame = a.frame?.length ? boxOf(a.frame) : null;
    for (const k of a.keys || []) {
      const e = out.get(k);
      if (!e) continue;
      if (fx.stretch) {
        if (!frame) continue;
        const s = stretchEntity(e, frame, fx.stretch[0], fx.stretch[1]);
        if (s) out.set(k, s);
      } else out.set(k, { ...transformEntity(e, fx.m), k });
    }
  }
  return order.map((k) => out.get(k));
}

// États des paramètres d'un bloc d'AutoCAD pour ces valeurs (poignées).
function acadStates(block, values = {}) {
  const hidden = hiddenKeys(block.dyn, values);
  return evaluateAcad(block.dyn, block.entities.filter((x) => !hidden.has(x.k)), (p) => valueOf(p, values));
}

// Valeur d'un paramètre point d'AutoCAD qui l'amène à la position q (coordonnées du bloc) : méthode de Newton (la
// position finale peut dépendre de la valeur autrement que par une translation : libellés tournant autour d'un point
// qu'ils déplacent).
function solvePoint(block, values, p, q) {
  let v = valueOf(p, values);
  const X = (w) => acadStates(block, { ...values, [p.id]: w }).states.get(p.id)?.X;
  for (let i = 0; i < 8; i++) {
    const x0 = X(v);
    if (!x0) break;
    const r = [q[0] - x0[0], q[1] - x0[1]];
    if (Math.hypot(r[0], r[1]) < 1e-9) break;
    const h = 1e-6 * Math.max(1, Math.hypot(v[0], v[1]));
    const xa = X([v[0] + h, v[1]]), xb = X([v[0], v[1] + h]);
    const a = (xa[0] - x0[0]) / h, b = (xa[1] - x0[1]) / h, c = (xb[0] - x0[0]) / h, d = (xb[1] - x0[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    v = [v[0] + (d * r[0] - c * r[1]) / det, v[1] + (-b * r[0] + a * r[1]) / det];
  }
  return v;
}

// Paramètre point d'AutoCAD : position dans le bloc (comme ses propriétés « Position X / Y » dans AutoCAD), et valeur
// qui l'amène à une position donnée.
export function pointPosition(doc, e, p) {
  const block = doc.blocks.get(e.name);
  return (p.acad && acadStates(block, e.dyn).states.get(p.id)?.X) || G.add(p.p || [0, 0], valueOf(p, e.dyn));
}
export function pointValueAt(doc, e, p, q) {
  return p.acad ? solvePoint(doc.blocks.get(e.name), e.dyn, p, q) : G.sub(q, p.p || [0, 0]);
}

// Clé des valeurs d'une insertion (cache de géométrie, blocs anonymes à l'export).
export function valuesKey(block, values = {}) {
  return JSON.stringify(block.dyn.params.filter((p) => p.type !== 'lookup').map((p) => valueOf(p, values)));
}

// Définition évaluée pour une insertion (mise en cache par définition et par jeu de valeurs) : le rendu,
// la décomposition et les contours l'utilisent à la place de la définition.
const evalCache = new WeakMap();
export function blockForInsert(doc, e) {
  const block = doc.blocks.get(e.name);
  if (!isDynamic(block)) return block;
  let cache = evalCache.get(block);
  if (!cache) evalCache.set(block, (cache = new Map()));
  const key = valuesKey(block, e.dyn);
  let b = cache.get(key);
  if (!b) {
    b = { ...block, name: `${block.name}§${key}`, entities: evaluate(block, e.dyn), dynOf: block.name };
    if (cache.size > 200) cache.clear();
    cache.set(key, b);
  }
  return b;
}

// --- poignées ----------------------------------------------------------------------------------

// Poignées dynamiques d'une insertion (coordonnées du dessin) : { p, k: 'dyn', param, shape }.
export function dynGrips(doc, e) {
  const block = doc.blocks.get(e.name);
  if (!isDynamic(block) || e.type !== 'INSERT') return [];
  const m = insertMatrix(e, block.base);
  const W = (q) => G.apply(m, q[0], q[1]);
  const out = [];
  if (block.dyn.acad === 2) {
    const { states } = acadStates(block, e.dyn);
    for (const p of block.dyn.params) {
      const g = acadGrip(p, states.get(p.id));
      if (g) out.push({ ...g, p: W(g.p), k: 'dyn', param: p.id, ...(g.dir != null ? { dir: G.angleOf([0, 0], G.applyVec(m, [Math.cos(g.dir), Math.sin(g.dir)])) } : {}) });
    }
    return out;
  }
  for (const p of block.dyn.params) {
    const v = valueOf(p, e.dyn);
    if (p.type === 'linear') {
      const u = G.norm(G.sub(p.p2, p.p1));
      out.push({ p: W(G.add(p.p1, G.mul(u, v))), k: 'dyn', param: p.id, shape: 'arrow', dir: G.angleOf([0, 0], G.applyVec(m, u)) });
    } else if (p.type === 'point') out.push({ p: W(G.add(p.p, v)), k: 'dyn', param: p.id, shape: 'square' });
    else if (p.type === 'rotation') out.push({ p: W(G.polar(p.c, (p.a0 || 0) + v, p.r || 1)), k: 'dyn', param: p.id, shape: 'circle' });
    else if (p.type === 'flip') out.push({ p: W(G.mid(p.p1, p.p2)), k: 'dyn', param: p.id, shape: 'flip', click: true, dir: G.angleOf([0, 0], G.applyVec(m, G.sub(p.p2, p.p1))) });
    else if (p.type === 'visibility' || p.type === 'lookup') out.push({ p: W(p.p || [0, 0]), k: 'dyn', param: p.id, shape: 'menu', click: true });
  }
  return out;
}

// Ligne d'une table de consultation qui correspond aux valeurs (sinon « Personnalisé »).
export function matchingRow(dyn, p, values) {
  const byId = new Map(dyn.params.map((x) => [x.id, x]));
  const same = (q, a, b) => (q.type === 'point' ? Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6
    : typeof a === 'number' ? Math.abs(a - b) < 1e-6 : a === b);
  const row = (p.rows || []).find((r) => Object.entries(r.values || {}).every(([id, v]) => {
    const q = byId.get(id);
    return !q || same(q, valueOf(q, values), normalize(q, v));
  }));
  return row ? row.label : CUSTOM_ROW;
}

// Nouvelle insertion avec la valeur d'un paramètre (attributs suivant les actions qui les déplacent). Une ligne de
// table de consultation règle ses paramètres ; les tables suivent ensuite les valeurs (ligne correspondante).
export function withValue(doc, e, paramId, value) {
  const block = doc.blocks.get(e.name);
  const p = block?.dyn?.params.find((x) => x.id === paramId);
  if (!p) return e;
  const dyn = { ...(e.dyn || {}), [paramId]: normalize(p, value) };
  if (p.type === 'lookup') {
    const row = p.rows?.find((r) => r.label === dyn[paramId]);
    for (const [id, v] of Object.entries(row?.values || {})) {
      const q = block.dyn.params.find((x) => x.id === id);
      if (q && q.type !== 'lookup') dyn[id] = normalize(q, v);
    }
  }
  for (const q of block.dyn.params) if (q.type === 'lookup') dyn[q.id] = matchingRow(block.dyn, q, dyn);
  return syncAttribs(doc, { ...structuredClone(e), dyn });
}

// Valeur d'un paramètre pour une poignée amenée au point q (coordonnées du dessin).
export function valueFromPoint(doc, e, paramId, q) {
  const block = doc.blocks.get(e.name);
  const p = block?.dyn?.params.find((x) => x.id === paramId);
  if (!p) return null;
  const inv = G.invert(insertMatrix(e, block.base));
  const b = G.apply(inv, q[0], q[1]);
  if (p.acad) {
    if (p.type === 'point') return normalize(p, solvePoint(block, e.dyn, p, b));
    const v = acadValueFromPoint(p, acadStates(block, e.dyn).states.get(p.id), b, valueOf(p, e.dyn));
    return v == null ? null : normalize(p, v);
  }
  if (p.type === 'linear') {
    const u = G.norm(G.sub(p.p2, p.p1));
    return normalize(p, G.dot(G.sub(b, p.p1), u));
  }
  if (p.type === 'point') return normalize(p, G.sub(b, p.p));
  if (p.type === 'rotation') return normalize(p, G.angleOf(p.c, b) - (p.a0 || 0));
  return null;
}

// Attributs d'une insertion dynamique recalés sur les définitions d'attribut évaluées (les actions peuvent
// déplacer une étiquette) et cachés avec elles (états de visibilité : dynHidden) ; les valeurs sont gardées.
export function syncAttribs(doc, e) {
  const block = doc.blocks.get(e.name);
  if (!isDynamic(block) || !e.attribs?.length) return e;
  const moved = new Set((block.dyn.actions || []).flatMap((a) => a.keys || []));
  const hidden = hiddenKeys(block.dyn, e.dyn);
  const hiddenTags = new Set(block.entities.filter((x) => x.type === 'ATTDEF' && hidden.has(x.k)).map((x) => x.tag));
  const defs = new Map(evaluate(block, e.dyn).filter((x) => x.type === 'ATTDEF' && moved.has(x.k)).map((x) => [x.tag, x]));
  const m = insertMatrix(e, block.base);
  e.attribs = e.attribs.map((a) => {
    let out = a;
    const d = defs.get(a.tag);
    if (d) {
      const t = transformEntity({ ...d, type: 'TEXT' }, m);
      out = { ...out, p: t.p, rot: t.rot };
    }
    if (hiddenTags.has(a.tag)) out = { ...out, dynHidden: true };
    else if (out.dynHidden) { out = { ...out }; delete out.dynHidden; }
    return out;
  });
  return e;
}

// --- édition de la définition --------------------------------------------------------------------

// Clés stables des objets d'une définition (objets sans clé numérotés à la suite).
export function ensureKeys(entities) {
  let next = Math.max(0, ...entities.map((e) => (Number.isInteger(e.k) ? e.k : 0))) + 1;
  for (const e of entities) if (!Number.isInteger(e.k)) e.k = next++;
  return entities;
}

export function newId(dyn, prefix) {
  const used = new Set([...(dyn?.params || []), ...(dyn?.actions || [])].map((x) => x.id));
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// Nom libre pour un paramètre (« Distance1 »…).
export function freeName(dyn, base) {
  const used = new Set((dyn?.params || []).map((p) => p.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

// Nettoyage après modification des objets : actions sans objets ou sans paramètre retirées, clés disparues
// oubliées dans les actions et la visibilité.
export function cleanDyn(dyn, entities) {
  if (!dyn) return null;
  const keys = new Set(entities.map((e) => e.k));
  const params = dyn.params.map((p) => (p.type === 'visibility'
    ? { ...p, hidden: Object.fromEntries(Object.entries(p.hidden || {}).map(([s, ks]) => [s, ks.filter((k) => keys.has(k))])) }
    : p));
  const ids = new Set(params.map((p) => p.id));
  // Actions des blocs d'AutoCAD : points d'étirement et paramètres transformés nettoyés aussi.
  const actions = (dyn.actions || []).map((a) => ({
    ...a, keys: (a.keys || []).filter((k) => keys.has(k)),
    ...(a.verts ? { verts: Object.fromEntries(Object.entries(a.verts).filter(([k]) => keys.has(Number(k)))) } : {}),
    ...(a.params ? { params: a.params.filter((id) => ids.has(id)) } : {}),
  })).filter((a) => ids.has(a.param) && (a.keys.length || a.params?.length));
  return params.length ? { ...dyn, params, actions } : null;
}
