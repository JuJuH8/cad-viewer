// SPDX-License-Identifier: GPL-3.0-or-later
// Blocs dynamiques d'AutoCAD relus : paramètres (visibilité, linéaire, rotation, point, inversion, consultation) et
// actions (déplacer, étirer, échelle, rotation, inversion, table de consultation) convertis dans le modèle de l'appli
// (dynamic.js, évaluation : acad-eval.js), valeurs de chaque insertion, nom effectif des blocs anonymes *U.
//
// Format d'AutoCAD (relevé sur AutoCAD 2024) :
// - définition : dictionnaire d'extension de l'enregistrement de bloc → ACAD_ENHANCEDBLOCK → ACAD_EVALUATION_GRAPH,
//   dont les nœuds (360) sont les paramètres, poignées et actions ; chaque nœud a un numéro (90). Le graphe ne relie
//   que les paramètres à leurs actions : les paramètres placés dans le jeu de sélection d'une action (70 + 91) sont
//   transformés avec ses objets (71 + 330) sans déclencher leurs propres actions (« enchaîner les actions » : non).
//   BLOCKVISIBILITYPARAMETER : 1010 / 1020 position de la poignée, 301 nom, 302 description, 93 + 331 tous les
//   objets concernés, 92 nombre d'états, puis par état 303 nom, 94 + 332 objets visibles, 95 + 333 nœuds.
//   Paramètres à 2 points (linéaire, rotation, inversion) : 1010 base, 1011 extrémité, 177 base au milieu ; linéaire
//   et rotation : 305 nom, 96 jeu de valeurs (1 min 141, 2 max 142, 4 pas 143, 8 liste 175 + 144) ; rotation : 1011
//   de la sous-classe = référence de l'angle nul ; inversion : 307 / 308 noms des états. Point, consultation : 1010.
//   Actions : liaisons (nœud 92…96, nom 301…305 : XDelta, EndXDelta, BaseXDelta, AngleDelta, Scale, Flip,
//   UpdatedBaseX…), base des rotations / échelles (1011 décalage, 280 dépendante, 1012 point), déplacement
//   (140 multiplicateur, 141 angle), étirement (72 + 1011 cadre, 73 objets 331 + 74 + 94 indices des points
//   d'étirement, 75 paramètres 95 + 76 + 94), table de consultation (92 lignes, 93 colonnes, 302 valeurs, puis par
//   colonne 94 nœud, 304 liaison, 282 colonne de consultation, 281 consultation inverse).
// - insertion : dictionnaire d'extension → AcDbBlockRepresentation → AcDbRepData (340 : bloc dynamique) et
//   AppDataCache → ACAD_ENHANCEDBLOCKDATA : un XRECORD par nœud (clé = numéro) avec l'état final du paramètre :
//   points 10 / 20 / 30 (base, extrémité, normale dont la longueur suit l'échelle, référence de la rotation),
//   texte 1 (visibilité, consultation), 70 (état d'inversion, après deux entiers d'en-tête).
// - bloc anonyme *U d'une insertion modifiée : XDATA AcDbBlockRepBTag (1005 : bloc dynamique).
import { ensureKeys, evaluate, valuesKey, defaultValue, CUSTOM_ROW } from './dynamic.js';
import { evaluateAcad, measure } from './acad-eval.js';
import { fixText } from '../core/layerstates.js';
import * as G from '../core/geom.js';

const H = (h) => String(h ?? '').trim().toUpperCase();

export const PARAM_KINDS = {
  BLOCKLINEARPARAMETER: 'linear', BLOCKROTATIONPARAMETER: 'rotation', BLOCKPOINTPARAMETER: 'point', BLOCKFLIPPARAMETER: 'flip',
  BLOCKLOOKUPPARAMETER: 'lookup', BLOCKVISIBILITYPARAMETER: 'visibility', BLOCKBASEPOINTPARAMETER: 'basepoint',
};
export const ACTION_KINDS = {
  BLOCKMOVEACTION: 'move', BLOCKSTRETCHACTION: 'stretch', BLOCKSCALEACTION: 'scale', BLOCKROTATEACTION: 'rotate',
  BLOCKFLIPACTION: 'flip', BLOCKLOOKUPACTION: 'lookup',
};

// Lecture dans le texte d'un DXF. → { names, defs, reps, inserts } (voir applyAcadDynamic).
export function scanAcadDynamic(text) {
  const empty = { names: new Map(), defs: new Map(), reps: new Map(), inserts: new Map() };
  if (!text || !text.includes('ACAD_ENHANCEDBLOCK')) return empty;
  const lines = text.split(/\r?\n/);
  const recs = new Map(), objs = new Map();
  const inserts = [];
  let type = null, cur = null;
  const WANT = /^(BLOCK_RECORD|INSERT|DICTIONARY|ACAD_EVALUATION_GRAPH|XRECORD|ACDB_BLOCKREPRESENTATION_DATA|BLOCK[A-Z]*(PARAMETER|ACTION|GRIP)|ACDB_DYNAMICPROXYNODE)$/;
  const close = () => {
    if (!cur?.handle) return;
    if (type === 'BLOCK_RECORD') recs.set(cur.handle, cur);
    else if (type === 'INSERT') { if (cur.xdict) inserts.push(cur); } else objs.set(cur.handle, { type, pairs: cur.pairs });
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const raw = lines[i + 1].replace(/\r$/, '');
    if (code === 0) {
      close();
      type = raw.trim();
      cur = WANT.test(type) ? { handle: null, pairs: [], xdict: null, inX: false, name: '', rep: null, app: null } : null;
      continue;
    }
    if (!cur) continue;
    const v = raw.trim();
    if (code === 5 && !cur.handle) { cur.handle = v.toUpperCase(); continue; }
    if (code === 102) { cur.inX = v === '{ACAD_XDICTIONARY'; continue; }
    if (code === 360 && cur.inX) { cur.xdict = v.toUpperCase(); continue; }
    if (type === 'BLOCK_RECORD') {
      if (code === 2 && !cur.name) cur.name = fixText(raw); // texte lu en latin1 : UTF-8 rétabli
      else if (code === 1001) cur.app = v;
      else if (code === 1005 && cur.app === 'AcDbBlockRepBTag') cur.rep = v.toUpperCase();
      continue;
    }
    if (type === 'INSERT') continue;
    cur.pairs.push([code, code === 1 || code === 3 || (code >= 300 && code < 310) ? fixText(raw) : raw]);
  }
  close();
  const dictEntries = (h) => {
    const o = objs.get(H(h));
    if (!o || o.type !== 'DICTIONARY') return [];
    const out = [];
    for (let i = 0; i < o.pairs.length; i++) {
      if (o.pairs[i][0] === 3 && o.pairs[i + 1] && (o.pairs[i + 1][0] === 350 || o.pairs[i + 1][0] === 360)) out.push([o.pairs[i][1], H(o.pairs[i + 1][1])]);
    }
    return out;
  };
  const entry = (h, name) => dictEntries(h).find(([n]) => n === name)?.[1];
  const names = new Map([...recs.values()].map((r) => [r.handle, r.name]));
  // Définitions dynamiques.
  const defs = new Map();
  for (const r of recs.values()) {
    const g = r.xdict && entry(r.xdict, 'ACAD_ENHANCEDBLOCK');
    const graph = g && objs.get(g);
    if (!graph || graph.type !== 'ACAD_EVALUATION_GRAPH') continue;
    const nodes = [];
    for (const [c, v] of graph.pairs) {
      if (c !== 360) continue;
      const o = objs.get(H(v));
      if (o) nodes.push({ handle: H(v), ...parseNode(o) });
    }
    defs.set(r.handle, defFromNodes(r.name, nodes));
  }
  // Blocs anonymes : bloc dynamique d'origine.
  const reps = new Map();
  for (const r of recs.values()) if (r.rep) reps.set(r.name, r.rep);
  // Insertions : bloc dynamique et valeurs par nœud.
  const insertInfo = new Map();
  for (const ins of inserts) {
    const br = entry(ins.xdict, 'AcDbBlockRepresentation');
    if (!br) continue;
    const rd = objs.get(entry(br, 'AcDbRepData') || '');
    const dyn = rd ? H(rd.pairs.find(([c]) => c === 340)?.[1]) : null;
    const values = new Map();
    const cache = entry(br, 'AppDataCache');
    const data = cache && entry(cache, 'ACAD_ENHANCEDBLOCKDATA');
    for (const [key, xh] of data ? dictEntries(data) : []) {
      const x = objs.get(xh);
      if (x) values.set(+key, nodeValue(x.pairs.map(([c, v]) => ({ code: c, value: v }))));
    }
    insertInfo.set(ins.handle, { dyn, values });
  }
  return { names, defs, reps, inserts: insertInfo };
}

// Définition lue (DXF ou DWG) : nœuds analysés → { name, params (visibilité), other (paramètres non visibilité),
// points (positions des paramètres), nodes (tous les nœuds) }.
export function defFromNodes(name, nodes) {
  const params = nodes.filter((n) => n.kind === 'visibility');
  const other = nodes.filter((n) => n.param && n.kind !== 'visibility' && n.kind !== 'basepoint').map((n) => ({ ...n, type: n.type }));
  const points = nodes.filter((n) => n.param).map((n) => n.pt);
  return { name, params, other, points, nodes };
}

// Valeur d'un nœud dans une insertion (XRECORD, données { code, value }) → { str, pts, nums, ints, pt, num }.
export function nodeValue(data) {
  const val = { pts: [], nums: [], ints: [] };
  let p = null;
  for (const g of data || []) {
    const c = Number(g.code ?? g.type), v = g.value;
    if (c === 1) val.str = String(v);
    else if (c === 10) {
      p = Array.isArray(v) ? [+v[0], +v[1], +(v[2] || 0)] : typeof v === 'object' && v ? [+v.x || 0, +v.y || 0, +v.z || 0] : [parseFloat(v), 0, 0];
      val.pts.push(p);
    } else if (c === 20 && p) p[1] = parseFloat(v);
    else if (c === 30 && p) p[2] = parseFloat(v);
    else if (c === 40) val.nums.push(parseFloat(v));
    else if (c === 70) val.ints.push(parseInt(v, 10));
  }
  if (val.pts.length) val.pt = val.pts[0].slice(0, 2);
  if (val.nums.length) val.num = val.nums[0];
  return val;
}

// --- nœuds (DXF) ------------------------------------------------------------------------------

// Sous-classes d'un objet (100) → listes de paires ; s'arrête aux données étendues.
function segments(pairs) {
  const out = new Map();
  let cur = null;
  for (const [c, v] of pairs) {
    if (c === 1001) break;
    if (c === 100) { cur = []; out.set(String(v).trim(), cur); continue; }
    if (cur) cur.push([c, v]);
  }
  return out;
}
const first = (seg, code) => seg?.find(([c]) => c === code)?.[1];
const num = (seg, code) => parseFloat(first(seg, code));
const int = (seg, code) => parseInt(first(seg, code), 10);
const all = (seg, code) => (seg || []).filter(([c]) => c === code).map(([, v]) => v);
const ptOf = (seg, code, k = 0) => {
  const xs = all(seg, code), ys = all(seg, code + 10);
  return xs.length > k ? [parseFloat(xs[k]) || 0, parseFloat(ys[k]) || 0] : null;
};
const valueSet = (seg) => ({ flags: int(seg, 96) || 0, min: num(seg, 141), max: num(seg, 142), inc: num(seg, 143), list: all(seg, 144).map(parseFloat) });

// Nœud du graphe d'un bloc dynamique → { kind, id, type, label, pt, … }.
export function parseNode(o) {
  const S = segments(o.pairs);
  const id = int(S.get('AcDbEvalExpr'), 90);
  const label = first(S.get('AcDbBlockElement'), 300) || '';
  const two = S.get('AcDbBlock2PtParameter'), one = S.get('AcDbBlock1PtParameter');
  const base = { id, type: o.type, label, pt: ptOf(two || one, 1010) || [0, 0] };
  const kind = PARAM_KINDS[o.type];
  if (kind === 'visibility') return parseVisibility(o, base);
  if (kind) {
    const n = { ...base, kind, param: true, name: label, chain: int(S.get('AcDbBlockParameter'), 281) === 1 };
    if (two) Object.assign(n, { base: ptOf(two, 1010), end: ptOf(two, 1011), mid: int(two, 177) === 1 });
    if (kind === 'linear') {
      const s = S.get('AcDbBlockLinearParameter');
      Object.assign(n, { name: first(s, 305) || label, vset: valueSet(s) });
    } else if (kind === 'rotation') {
      const s = S.get('AcDbBlockRotationParameter');
      Object.assign(n, { name: first(s, 305) || label, ref: ptOf(s, 1011) || n.end, vset: valueSet(s) });
    } else if (kind === 'flip') {
      const s = S.get('AcDbBlockFlipParameter');
      Object.assign(n, { name: first(s, 305) || label, labels: [first(s, 307) || '', first(s, 308) || ''] });
    } else if (kind === 'point') {
      Object.assign(n, { name: first(S.get('AcDbBlockPointParameter'), 303) || label });
    } else if (kind === 'lookup') {
      const s = S.get('AcDbBlockLookUpParameter');
      Object.assign(n, { name: first(s, 303) || label, action: int(s, 94) });
    }
    return n;
  }
  const akind = ACTION_KINDS[o.type];
  if (akind) {
    const A = S.get('AcDbBlockAction');
    const n = { ...base, kind: 'action', action: akind, pt: [0, 0], params: [], sel: all(A, 330).map(H), conns: [] };
    const np = int(A, 70) || 0;
    n.params = all(A, 91).slice(0, np).map((v) => parseInt(v, 10));
    const conns = (seg) => {
      for (const [nc, sc] of [[92, 301], [93, 302], [94, 303], [95, 304], [96, 305]]) {
        if (first(seg, sc) != null && first(seg, nc) != null) n.conns.push([int(seg, nc), String(first(seg, sc)).trim()]);
      }
    };
    const wb = S.get('AcDbBlockActionWithBasePt');
    if (wb) {
      conns(wb);
      n.offset = ptOf(wb, 1011) || [0, 0];
      n.dependent = int(wb, 280) !== 0;
      n.basePt = ptOf(wb, 1012) || [0, 0];
    }
    if (akind === 'rotate') conns(S.get('AcDbBlockRotationAction'));
    if (akind === 'scale') conns(S.get('AcDbBlockScaleAction'));
    if (akind === 'flip') conns(S.get('AcDbBlockFlipAction'));
    if (akind === 'move') {
      const s = S.get('AcDbBlockMoveAction');
      conns(s);
      Object.assign(n, { mult: num(s, 140), angle: num(s, 141) || 0 });
    }
    if (akind === 'stretch') Object.assign(n, parseStretch(S.get('AcDbBlockStretchAction'), n));
    if (akind === 'lookup') n.table = parseLookupTable(S.get('AcDbBlockLookupAction'));
    return n;
  }
  return { ...base, kind: /GRIP|GRIPLOCATIONCOMPONENT/.test(o.type) ? 'grip' : 'other', param: /PARAMETER$/.test(o.type) };
}

function parseVisibility(o, base) {
  const p = o.pairs;
  const start = p.findIndex(([c, v]) => c === 100 && v.trim() === 'AcDbBlockVisibilityParameter');
  const body = p.slice(start + 1);
  const vis = { kind: 'visibility', param: true, ...base, name: base.label, desc: '', current: 0, all: [], states: [] };
  let st = null;
  for (const [c, v] of body) {
    if (c === 1001) break;
    if (c === 301) vis.name = v;
    else if (c === 302) vis.desc = v;
    else if (c === 91 && !vis.states.length) vis.current = parseInt(v, 10) || 0;
    else if (c === 331) vis.all.push(H(v));
    else if (c === 303) { st = { name: v, ents: [] }; vis.states.push(st); } else if (c === 332 && st) st.ents.push(H(v));
  }
  return vis;
}

function parseStretch(seg, n) {
  const out = { mult: 1, angle: 0, frame: [], verts: [], pverts: [] };
  if (!seg) return out;
  for (const [nc, sc] of [[92, 301], [93, 302]]) if (first(seg, sc) != null) n.conns.push([int(seg, nc), String(first(seg, sc)).trim()]);
  let i = seg.findIndex(([c]) => c === 72);
  const nf = i >= 0 ? parseInt(seg[i][1], 10) : 0;
  for (let k = 0; k < nf; k++) out.frame.push(ptOf(seg, 1011, k));
  i = seg.findIndex(([c]) => c === 73);
  if (i >= 0) {
    let j = i + 1;
    for (let k = 0, ne = parseInt(seg[i][1], 10); k < ne && j < seg.length; k++) {
      const h = H(seg[j][1]), m = parseInt(seg[j + 1][1], 10);
      out.verts.push([h, seg.slice(j + 2, j + 2 + m).map(([, v]) => parseInt(v, 10))]);
      j += 2 + m;
    }
    if (seg[j]?.[0] === 75) {
      const np = parseInt(seg[j][1], 10);
      j++;
      for (let k = 0; k < np && j < seg.length; k++) {
        const node = parseInt(seg[j][1], 10), m = parseInt(seg[j + 1][1], 10);
        out.pverts.push([node, seg.slice(j + 2, j + 2 + m).map(([, v]) => parseInt(v, 10))]);
        j += 2 + m;
      }
    }
    const rest = seg.slice(j);
    out.mult = parseFloat(first(rest, 140) ?? 1);
    out.angle = parseFloat(first(rest, 141) ?? 0) || 0;
  }
  return out;
}

function parseLookupTable(seg) {
  const rows = int(seg, 92) || 0, cols = int(seg, 93) || 0;
  const values = all(seg, 302).slice(0, rows * cols).map((v) => String(v).trim());
  const columns = [];
  let col = null;
  let i = seg.findLastIndex(([c]) => c === 302);
  for (i += 1; i < (seg || []).length; i++) {
    const [c, v] = seg[i];
    if (c === 303) { col = { node: null, conn: '', lookup: false, reverse: false, custom: '' }; columns.push(col); continue; }
    if (!col) continue;
    if (c === 94) col.node = parseInt(v, 10);
    else if (c === 304) col.conn = String(v).trim();
    else if (c === 305) col.custom = String(v).trim();
    else if (c === 282) col.lookup = parseInt(v, 10) === 1;
    else if (c === 281) col.reverse = parseInt(v, 10) === 1;
  }
  return { rows, cols, values, columns: columns.slice(0, cols) };
}

// --- conversion dans le modèle de l'appli -------------------------------------------------------

const pid = (n) => (n.kind === 'visibility' ? `acv${n.id}` : `ac${n.id}`);
const MOVE_CONN = { XDelta: 'pos', EndXDelta: 'end', BaseXDelta: 'base' };
const BASE_CONN = { UpdatedBaseX: 'base', UpdatedEndX: 'end', UpdatedX: 'pos' };

// Paramètres et actions d'une définition d'AutoCAD → block.dyn (acad = 2), ou null si le bloc contient des éléments
// non gérés (paramètres polaires, XY, alignement, réseau, contraintes…) : seule la visibilité est alors convertie.
export function buildAcadDyn(d, keysOf, shown) {
  const nodes = d.nodes || [];
  if (nodes.some((n) => n.kind === 'other' && n.param) || nodes.some((n) => n.type === 'ACDB_DYNAMICPROXYNODE')) return null;
  const actions = nodes.filter((n) => n.kind === 'action');
  if (nodes.some((n) => n.kind === 'other' && /ACTION$/.test(n.type))) return null;
  const params = [];
  const kept = new Map(); // nœud → paramètre de l'appli
  for (const n of nodes) {
    if (!n.param || n.kind === 'other') continue;
    if (n.kind === 'basepoint') {
      if (actions.some((a) => a.params.includes(n.id))) return null; // point de base déplacé : non géré
      continue;
    }
    const p = { id: pid(n), type: n.kind, name: n.name || n.label, acad: true, node: n.id };
    if (n.kind === 'visibility') {
      const vis = n.all.filter((h) => shown.has(h));
      const k = n.states.findIndex((st) => st.ents.length === vis.length && vis.every((h) => st.ents.includes(h)));
      const cur = k >= 0 ? k : n.current;
      Object.assign(p, {
        p: n.pt, desc: n.desc, states: n.states.map((st) => st.name), def: n.states[cur]?.name,
        hidden: Object.fromEntries(n.states.map((st) => {
          const set = new Set(st.ents);
          return [st.name, n.all.filter((h) => !set.has(h)).flatMap((h) => keysOf.get(h) || [])];
        })),
      });
    } else if (n.kind === 'linear') {
      Object.assign(p, { p1: n.base, p2: n.end, mid: n.mid }, valueRules(n.vset));
    } else if (n.kind === 'rotation') {
      const r = G.dist(n.base, n.end) || 1;
      Object.assign(p, { c: n.base, e: n.end, ref: n.ref, r, a0: G.angleOf(n.base, n.ref) });
      const def = Math.atan2(Math.sin(G.angleOf(n.base, n.end) - p.a0), Math.cos(G.angleOf(n.base, n.end) - p.a0));
      if (Math.abs(def) > 1e-12) p.def = def;
      if (n.vset?.flags & 4 && n.vset.inc > 0) p.step = n.vset.inc;
    } else if (n.kind === 'point') {
      p.p = n.pt;
    } else if (n.kind === 'flip') {
      Object.assign(p, { p1: n.base, p2: n.end, labels: n.labels });
    } else if (n.kind === 'lookup') {
      Object.assign(p, { p: n.pt, rows: [] });
    }
    params.push(p);
    kept.set(n.id, p);
  }
  // Actions géométriques.
  const out = [];
  for (const a of actions) {
    if (a.action === 'lookup') continue;
    const conn = (re) => a.conns.find(([, name]) => re.test(name));
    let drv = null, extra = {};
    if (a.action === 'move' || a.action === 'stretch') {
      const c = conn(/^(End|Base)?XDelta$/);
      const q = c && kept.get(c[0]);
      const which = c && MOVE_CONN[c[1]];
      if (!q || !((q.type === 'point' && which === 'pos') || (q.type === 'linear' && which !== 'pos'))) return null;
      drv = q;
      extra = { conn: which === 'base' ? 'base' : 'end', mult: Number.isFinite(a.mult) ? a.mult : 1, angle: a.angle || 0 };
    } else if (a.action === 'rotate' || a.action === 'scale') {
      const c = conn(a.action === 'rotate' ? /^AngleDelta$/ : /^Scale$/);
      drv = c && kept.get(c[0]);
      if (!drv || drv.type !== (a.action === 'rotate' ? 'rotation' : 'linear')) return null;
      // Base : point mis à jour d'un paramètre (liaison UpdatedBaseX…, absente des DWG pour les échelles : celui du
      // paramètre de l'action).
      const bc = conn(/^Updated(Base|End)?X$/);
      const bq = bc ? kept.get(bc[0]) : drv;
      if (!bq) return null;
      extra = { base: { param: bq.id, which: bc ? BASE_CONN[bc[1]] : 'base', dep: a.dependent !== false, off: a.offset, pt: a.basePt } };
    } else if (a.action === 'flip') {
      const c = conn(/^Flip$/);
      drv = c && kept.get(c[0]);
      if (!drv || drv.type !== 'flip') return null;
    } else return null;
    const keys = [...new Set(a.sel.flatMap((h) => keysOf.get(h) || []))];
    const act = {
      id: `aa${a.id}`, type: a.action, param: drv.id, node: a.id, ...extra,
      keys, params: a.params.map((id) => kept.get(id)?.id).filter(Boolean),
    };
    if (a.action === 'stretch') {
      act.verts = {};
      for (const [h, idx] of a.verts || []) for (const k of keysOf.get(h) || []) act.verts[k] = idx;
      act.keys = Object.keys(act.verts).map(Number);
      act.pverts = {};
      for (const [node, idx] of a.pverts || []) { const q = kept.get(node); if (q) act.pverts[q.id] = idx; }
      act.params = Object.keys(act.pverts);
    }
    out.push(act);
  }
  // Tables de consultation : une colonne de consultation = un paramètre de consultation de l'appli.
  for (const a of actions.filter((x) => x.action === 'lookup')) {
    const t = a.table;
    if (!t?.cols) continue;
    const inputs = t.columns.map((c, i) => ({ ...c, i })).filter((c) => !c.lookup);
    for (const [ci, col] of t.columns.entries()) {
      if (!col.lookup) continue;
      const lp = kept.get(col.node);
      if (!lp || lp.type !== 'lookup') continue;
      const rows = [];
      let ok = true;
      for (let r = 0; r < t.rows && ok; r++) {
        const values = {};
        for (const c of inputs) {
          const q = kept.get(c.node);
          const raw = t.values[r * t.cols + c.i];
          if (!q) { ok = false; break; }
          if (q.type === 'linear' && c.conn === 'UpdatedDistance') values[q.id] = parseFloat(raw);
          else if (q.type === 'visibility') values[q.id] = raw;
          else if (q.type === 'flip') values[q.id] = raw === q.labels?.[1] || raw === '1' ? 1 : 0;
          else ok = false;
        }
        if (ok) rows.push({ label: t.values[r * t.cols + ci], values });
      }
      if (ok) Object.assign(lp, { rows, reverse: col.reverse });
    }
  }
  // Paramètres de consultation sans table utilisable : retirés.
  const usable = params.filter((p) => p.type !== 'lookup' || p.rows.length);
  return { acad: 2, params: usable, actions: orderActions(out, usable) };
}

// Jeu de valeurs d'un paramètre linéaire (96 : 1 minimum, 2 maximum, 4 pas, 8 liste).
function valueRules(vs) {
  if (!vs) return {};
  const r = {};
  if (vs.flags & 8 && vs.list?.length) r.list = vs.list;
  else {
    if (vs.flags & 1 && Number.isFinite(vs.min) && vs.min > 0) r.min = vs.min;
    if (vs.flags & 2 && Number.isFinite(vs.max) && vs.max > 0) r.max = vs.max;
    if (vs.flags & 4 && vs.inc > 0) r.step = vs.inc;
  }
  return r;
}

// Ordre d'évaluation : les actions d'un même paramètre ensemble ; le paramètre dont les actions transforment un
// autre paramètre passe avant lui (jeux de sélection emboîtés). Paramètres qui se transforment mutuellement
// (composante fortement connexe, ex. rotations droite / gauche de tout le symbole, déplacement des libellés et leur
// rotation) : d'abord les déplacements et étirements (indépendants de la position), pour que les rotations, échelles
// et inversions se fassent autour de leur point déjà déplacé comme dans AutoCAD ; puis celui dont les actions
// touchent le plus d'objets ; enfin l'ordre de création (numéro de nœud).
function orderActions(actions, params) {
  const nodeOf = new Map(params.map((p) => [p.id, p.node]));
  const groups = new Map();
  for (const a of actions) {
    if (!groups.has(a.param)) groups.set(a.param, []);
    groups.get(a.param).push(a);
  }
  const ids = [...groups.keys()];
  const next = new Map(ids.map((id) => [id, new Set()])); // id → groupes qui doivent passer après
  for (const [id, list] of groups) for (const a of list) for (const q of a.params) if (q !== id && next.has(q)) next.get(id).add(q);
  // Composantes fortement connexes (Tarjan).
  const index = new Map(), low = new Map(), stack = [], on = new Set(), comp = new Map(), comps = [];
  const visit = (v) => {
    index.set(v, index.size); low.set(v, index.get(v)); stack.push(v); on.add(v);
    for (const w of next.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.set(w, comps.length); c.push(w); } while (w !== v);
      comps.push(c);
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  const weight = (id) => new Set(groups.get(id).flatMap((a) => a.keys)).size;
  const rank = (id) => (groups.get(id).every((a) => a.type === 'move' || a.type === 'stretch') ? 0 : 1);
  for (const c of comps) c.sort((x, y) => rank(x) - rank(y) || weight(y) - weight(x) || nodeOf.get(x) - nodeOf.get(y));
  const preds = comps.map(() => new Set());
  for (const [id, set] of next) for (const q of set) if (comp.get(q) !== comp.get(id)) preds[comp.get(q)].add(comp.get(id));
  const minNode = (c) => Math.min(...c.map((id) => nodeOf.get(id)));
  const done = new Set(), order = [];
  while (done.size < comps.length) {
    const ready = comps.map((c, i) => i).filter((i) => !done.has(i) && [...preds[i]].every((j) => done.has(j)));
    const i = ready.sort((x, y) => minNode(comps[x]) - minNode(comps[y]))[0];
    done.add(i);
    order.push(...comps[i]);
  }
  return order.flatMap((id) => groups.get(id).sort((x, y) => x.node - y.node));
}

// Valeurs de l'appli d'une insertion d'après les états enregistrés par AutoCAD (info : Map(nœud → valeur)) :
// estimation directe, puis corrections jusqu'à retrouver les états finaux (rotations, distances, positions).
export function acadValues(block, info) {
  const dyn = block.dyn;
  const values = {};
  const stored = new Map();
  for (const p of dyn.params) {
    const v = info?.get(p.node);
    if (!v) continue;
    if (p.type === 'visibility') { if (p.states.includes(v.str)) values[p.id] = v.str; continue; }
    if (p.type === 'lookup') { values[p.id] = p.rows.some((r) => r.label === v.str) ? v.str : CUSTOM_ROW; continue; }
    if (p.type === 'flip') { values[p.id] = v.ints.length > 2 && v.ints[v.ints.length - 1] ? 1 : 0; continue; }
    const pts = v.pts.map((q) => q.slice(0, 2));
    if (p.type === 'linear' && pts.length >= 2) {
      const nz = Math.abs(v.pts[2]?.[2] || 1) || 1;
      values[p.id] = G.dist(pts[0], pts[1]) / nz;
      stored.set(p.id, { B: pts[0], E: pts[1] });
    } else if (p.type === 'rotation' && pts.length >= 4) {
      const sg = (v.pts[2]?.[2] ?? -1) > 0 ? -1 : 1;
      const d = G.angleOf(pts[0], pts[1]) - G.angleOf(pts[0], pts[3]);
      values[p.id] = sg * Math.atan2(Math.sin(d), Math.cos(d));
      stored.set(p.id, { B: pts[0], E: pts[1], R: pts[3] });
    } else if (p.type === 'point' && pts.length >= 1) {
      values[p.id] = G.sub(pts[0], p.p);
      stored.set(p.id, { X: pts[0] });
    }
  }
  if (!stored.size || !dyn.actions.length) return values;
  const byId = new Map(dyn.params.map((p) => [p.id, p]));
  const val = (p) => values[p.id] ?? defaultValue(p);
  const run = () => {
    const hidden = new Set(dyn.params.filter((p) => p.type === 'visibility').flatMap((p) => p.hidden?.[val(p)] || []));
    return evaluateAcad(dyn, block.entities.filter((e) => !hidden.has(e.k)), val).states;
  };
  // Écarts entre états enregistrés et états évalués (distance, angle, position).
  const ids = [...stored.keys()].filter((id) => byId.get(id));
  const residuals = (states) => ids.flatMap((id) => {
    const p = byId.get(id), s = stored.get(id), e = states.get(id);
    if (!e) return p.type === 'point' ? [0, 0] : [0];
    if (p.type === 'linear') return [G.dist(s.B, s.E) - G.dist(e.B, e.E)];
    if (p.type === 'rotation') { const r = measure(p, { ...e, B: s.B, E: s.E, R: s.R }) - measure(p, e); return [Math.atan2(Math.sin(r), Math.cos(r))]; }
    return [s.X[0] - e.X[0], s.X[1] - e.X[1]];
  });
  const norm = (r) => Math.max(0, ...r.map(Math.abs));
  // Corrections directes (cas courants : une passe suffit).
  for (let iter = 0; iter < 3; iter++) {
    const states = run();
    if (norm(residuals(states)) < 1e-10) return values;
    for (const id of ids) {
      const p = byId.get(id), s = stored.get(id), e = states.get(id);
      if (!e) continue;
      if (p.type === 'linear') values[id] = val(p) + (G.dist(s.B, s.E) - G.dist(e.B, e.E)) / (G.scaleOf(e.M) || 1);
      else if (p.type === 'rotation') {
        const r = measure(p, { ...e, B: s.B, E: s.E, R: s.R }) - measure(p, e);
        values[id] = val(p) + Math.atan2(Math.sin(r), Math.cos(r));
      } else {
        const inv = G.invert([e.M[0], e.M[1], e.M[2], e.M[3], 0, 0]);
        values[id] = G.add(val(p), G.applyVec(inv, G.sub(s.X, e.X)));
      }
    }
  }
  // Sinon (centre de rotation déplacé avec le point…) : méthode de Newton, dérivées par différences finies.
  const get = () => ids.flatMap((id) => (byId.get(id).type === 'point' ? [...val(byId.get(id))] : [val(byId.get(id))]));
  const set = (x) => {
    let k = 0;
    for (const id of ids) {
      if (byId.get(id).type === 'point') { values[id] = [x[k], x[k + 1]]; k += 2; } else values[id] = x[k++];
    }
  };
  for (let iter = 0; iter < 8; iter++) {
    const x = get();
    const r = residuals(run());
    if (norm(r) < 1e-10) break;
    const J = x.map((_, j) => {
      const h = 1e-6 * Math.max(1, Math.abs(x[j]));
      const y = [...x];
      y[j] += h;
      set(y);
      const rj = residuals(run());
      return rj.map((v, i) => (r[i] - v) / h); // dérivée de l'état évalué
    });
    const dx = solve(r.map((_, i) => x.map((__, j) => J[j][i])), r);
    if (!dx) { set(x); break; }
    set(x.map((v, j) => v + dx[j]));
  }
  return values;
}

// Système linéaire carré A x = b (pivot partiel) ; null si singulier.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// --- comparaison de géométrie ---------------------------------------------------------------------

const close2 = (a, b, tol) => !!a && !!b && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
const angleClose = (a, b, tol) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= tol;
function polyPoints(e) {
  const out = [];
  const n = e.pts.length;
  for (let i = 0; i < n; i++) {
    const p = e.pts[i];
    out.push(p);
    const b = e.bulges?.[i];
    const q = e.pts[(i + 1) % n];
    if (b && (i < n - 1 || e.closed)) out.push([(p[0] + q[0]) / 2 + (q[1] - p[1]) * b / 2, (p[1] + q[1]) / 2 - (q[0] - p[0]) * b / 2]);
  }
  return out;
}
const sameSeq = (a, b, tol) => a.length === b.length && (a.every((p, i) => close2(p, b[i], tol)) || a.every((p, i) => close2(p, b[b.length - 1 - i], tol)));
const sameSet = (a, b, tol) => a.length === b.length && a.every((p) => b.some((q) => close2(p, q, tol)));
// Tous les points numériques d'un objet (repli pour les types sans comparaison dédiée) → boîte.
function boxOfEntity(e) {
  const b = G.emptyBox();
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) {
      if (v.length >= 2 && v.length <= 3 && v.every((x) => typeof x === 'number')) G.growBox(b, v[0], v[1]);
      else v.forEach((x) => walk(x, depth + 1));
    } else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'k' && k !== 'handle') walk(x, depth + 1);
  };
  walk(e, 0);
  return b;
}
function sameEntity(a, b, tol) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'LINE': return (close2(a.p1, b.p1, tol) && close2(a.p2, b.p2, tol)) || (close2(a.p1, b.p2, tol) && close2(a.p2, b.p1, tol));
    case 'CIRCLE': return close2(a.c, b.c, tol) && Math.abs(a.r - b.r) <= tol;
    case 'ARC': {
      if (!close2(a.c, b.c, tol) || Math.abs(a.r - b.r) > tol) return false;
      const ends = (e) => [G.polar(e.c, e.a0, e.r), G.polar(e.c, e.a1, e.r), G.polar(e.c, G.arcMidAngle(e.a0, e.a1), e.r)];
      const [p, q] = [ends(a), ends(b)];
      return close2(p[2], q[2], tol) && sameSet(p.slice(0, 2), q.slice(0, 2), tol);
    }
    case 'LWPOLYLINE': case 'POLY3D': return sameSeq(polyPoints(a), polyPoints(b), tol);
    case 'SOLID': case 'WIPEOUT': return sameSet(a.pts, b.pts, tol);
    case 'TEXT': case 'ATTDEF': case 'MTEXT':
      // Position à 1 % de la hauteur près (textes inversés : cadre mesuré par AutoCAD avec sa police).
      return close2(a.p, b.p, Math.max(tol, 0.01 * (b.h || 0))) && Math.abs((a.h || 0) - (b.h || 0)) <= tol && angleClose(a.rot || 0, b.rot || 0, 1e-6) && (a.tag || '') === (b.tag || '');
    case 'INSERT':
      return a.name === b.name && close2(a.p, b.p, tol) && Math.abs(a.sx - b.sx) <= 1e-6 && Math.abs(a.sy - b.sy) <= 1e-6 && angleClose(a.rot || 0, b.rot || 0, 1e-6);
    case 'POINT': return close2(a.p, b.p, tol);
    case 'HATCH': {
      // Contours découpés en segments (arcs : découpage variable d'un enregistrement à l'autre) : boîtes comparées.
      if (a.loops.length !== b.loops.length) return false;
      const boxes = (e) => e.loops.map((l) => { const x = G.emptyBox(); l.forEach((q) => G.growBox(x, q[0], q[1])); return x; });
      const [p, q] = [boxes(a), boxes(b)];
      const near = (x, y) => {
        const t = Math.max(tol, 0.01 * Math.max(x.maxX - x.minX, x.maxY - x.minY));
        return Math.abs(x.minX - y.minX) <= t && Math.abs(x.minY - y.minY) <= t && Math.abs(x.maxX - y.maxX) <= t && Math.abs(x.maxY - y.maxY) <= t;
      };
      return p.every((x) => q.some((y) => near(x, y)));
    }
    default: {
      const p = boxOfEntity(a), q = boxOfEntity(b);
      return Math.abs(p.minX - q.minX) <= tol && Math.abs(p.minY - q.minY) <= tol && Math.abs(p.maxX - q.maxX) <= tol && Math.abs(p.maxY - q.maxY) <= tol;
    }
  }
}

// Mêmes objets (même nombre, même géométrie) ? Ordre identique d'abord, sinon appariement.
export function sameGeometry(a, b) {
  if (a.length !== b.length) return false;
  const box = G.emptyBox();
  for (const e of b) { const x = boxOfEntity(e); if (G.boxValid(x)) { G.growBox(box, x.minX, x.minY); G.growBox(box, x.maxX, x.maxY); } }
  const size = G.boxValid(box) ? Math.max(box.maxX - box.minX, box.maxY - box.minY, Math.abs(box.minX), Math.abs(box.minY)) : 1;
  const tol = 1e-6 * (1 + size);
  if (a.every((e, i) => sameEntity(e, b[i], tol))) return true;
  const left = [...b];
  return a.every((e) => {
    const i = left.findIndex((x) => sameEntity(e, x, tol));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

// --- application à l'import -------------------------------------------------------------------------

// Points égaux (valeur d'insertion = position par défaut d'un paramètre).
const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

// Applique aux blocs et insertions importés (avant chargement du document) ; info = { defs, reps, inserts } lu
// dans un DXF (scanAcadDynamic) ou un DWG (read.js) :
// - définitions : paramètres et actions → block.dyn (acad = 2) ; si le bloc contient des éléments non gérés, seuls
//   les paramètres de visibilité sont convertis (acad = true) ;
// - insertions du bloc dynamique ou de ses blocs anonymes : valeurs relues des états enregistrés par AutoCAD ; la
//   géométrie évaluée par l'appli est comparée à la représentation d'AutoCAD (bloc anonyme) : identique, l'insertion
//   devient une insertion du bloc dynamique (valeurs modifiables) ; sinon elle garde sa représentation, sous son nom
//   effectif (effName). Blocs ne gérant que la visibilité : seules les insertions dont les autres paramètres sont des
//   points à leur position par défaut sont rattachées.
// → noms des blocs anonymes devenus inutiles.
export function applyAcadDynamic(blocks, entities, info) {
  if (!info?.defs?.size) return [];
  const byName = new Map([...info.defs].map(([h, d]) => [d.name, { ...d, handle: h }]));
  for (const d of byName.values()) {
    const block = blocks.get(d.name);
    if (!block) continue;
    // Objets invisibles que ne gère aucun paramètre de visibilité : jamais affichés (comme hors bloc dynamique).
    const governed = new Set(d.params.flatMap((v) => v.all));
    block.entities = block.entities.filter((e) => !e.defHidden || governed.has(H(e.handle)));
    const full = (d.nodes || []).some((n) => n.kind === 'action');
    if (!d.params.length && !full) { for (const e of block.entities) delete e.defHidden; continue; }
    ensureKeys(block.entities);
    const keysOf = new Map();
    for (const e of block.entities) {
      const h = H(e.handle);
      if (!h) continue;
      if (!keysOf.has(h)) keysOf.set(h, []);
      keysOf.get(h).push(e.k);
    }
    // État courant de la définition : objets visibles (non marqués invisibles) parmi ceux du paramètre.
    const shown = new Set(block.entities.filter((e) => !e.defHidden).map((e) => H(e.handle)));
    for (const v of d.params) {
      const vis = v.all.filter((h) => shown.has(h));
      const k = v.states.findIndex((st) => st.ents.length === vis.length && vis.every((h) => st.ents.includes(h)));
      if (k >= 0) v.current = k;
    }
    for (const e of block.entities) delete e.defHidden;
    const dyn = full ? buildAcadDyn(d, keysOf, shown) : null;
    if (dyn?.params.length) { block.dyn = dyn; continue; }
    if (!d.params.length) continue;
    block.dyn = {
      params: d.params.map((v) => ({
        id: `acv${v.id}`, type: 'visibility', name: v.name, p: v.pt, desc: v.desc,
        states: v.states.map((st) => st.name), def: v.states[v.current]?.name, // état par défaut
        hidden: Object.fromEntries(v.states.map((st) => {
          const vis = new Set(st.ents);
          return [st.name, v.all.filter((h) => !vis.has(h)).flatMap((h) => keysOf.get(h) || [])];
        })),
      })),
      actions: [],
      acad: true, // relu d'AutoCAD (paramètres non gérés : `other`)
      other: d.other.map((o) => ({ type: o.type, label: o.label, pt: o.pt })),
    };
  }
  const unused = new Set();
  const nested = [...blocks.values()].flatMap((b) => b.entities);
  const checked = new Map(); // représentation + valeurs → géométrie identique ?
  for (const e of allInserts([...entities, ...nested])) {
    const ins = info.inserts.get(H(e.handle));
    const dynH = ins?.dyn || info.reps.get(e.name) || byName.get(e.name)?.handle;
    const d = dynH && info.defs.get(dynH);
    if (!d) continue;
    if (e.name !== d.name) e.effName = d.name;
    const block = blocks.get(d.name);
    if (!block?.dyn) continue;
    let dyn;
    if (block.dyn.acad === 2) {
      dyn = acadValues(block, ins?.values);
      const rep = blocks.get(e.name);
      const key = `${e.name}\u0000${valuesKey(block, dyn)}`;
      if (!checked.has(key)) checked.set(key, !!rep && sameGeometry(evaluate(block, dyn), rep.entities));
      if (!checked.get(key)) continue;
    } else {
      // Autres paramètres : seulement des points, à leur position par défaut (actions au repos).
      const values = [...(ins?.values?.values() || [])];
      // Insertion de la définition elle-même, sans valeurs propres : tous les paramètres à leur valeur par défaut.
      const plain = (e.name === d.name && !values.length) || (d.other.every((o) => o.type === 'BLOCKPOINTPARAMETER')
        && values.every((v) => v.str != null || (!v.pt || (d.points || []).some((pt) => same(pt, v.pt))) && (v.num == null || Math.abs(v.num) < 1e-9)));
      if (!plain) continue;
      dyn = {};
      for (const v of d.params) {
        // Valeur de l'insertion : par numéro de nœud, sinon la valeur texte qui est un de ses états.
        const val = ins?.values?.get(v.id)?.str ?? values.find((x) => x.str != null && v.states.some((st) => st.name === x.str))?.str;
        dyn[`acv${v.id}`] = val && v.states.some((st) => st.name === val) ? val : v.states[v.current]?.name ?? v.states[0]?.name;
      }
    }
    if (e.name !== d.name) unused.add(e.name);
    e.name = d.name;
    e.dyn = dyn;
    delete e.effName;
  }
  // Blocs anonymes encore utilisés par une insertion gardée telle quelle.
  for (const e of allInserts([...entities, ...nested])) unused.delete(e.name);
  return [...unused];
}

// DWG : liens et valeurs des insertions relus dans les dictionnaires d'extension (ownerDictionaryHardId) →
// AcDbBlockRepresentation → AcDbRepData (bloc dynamique) et AppDataCache → ACAD_ENHANCEDBLOCKDATA (XRECORD).
export function dwgInsertInfo(rawEntities, db) {
  const info = db.acadDyn;
  if (!info?.dwg) return;
  const dicts = new Map();
  for (const d of db.objects?.DICTIONARY || []) {
    const e = d.entries || {};
    dicts.set(H(d.handle), Array.isArray(e) ? e.map((x) => [x.name, H(x.objectSoftId ?? x.handle)]) : Object.entries(e).map(([n, v]) => [n, H(v)]));
  }
  const xrecs = new Map((db.objects?.XRECORD || []).map((x) => [H(x.handle), x]));
  const entry = (h, name) => dicts.get(H(h))?.find(([n]) => n === name)?.[1];
  for (const r of rawEntities) {
    if (r.type !== 'INSERT' || !r.ownerDictionaryHardId || r.ownerDictionaryHardId === '0') continue;
    const br = entry(r.ownerDictionaryHardId, 'AcDbBlockRepresentation');
    if (!br) continue;
    const dyn = info.repData.get(entry(br, 'AcDbRepData') || '');
    const values = new Map();
    const cache = entry(br, 'AppDataCache');
    const data = cache && entry(cache, 'ACAD_ENHANCEDBLOCKDATA');
    for (const [key, xh] of data ? dicts.get(H(data)) || [] : []) values.set(+key, nodeValue(xrecs.get(xh)?.data));
    info.inserts.set(H(r.handle), { dyn, values });
  }
}

function* allInserts(entities) {
  for (const e of entities) if (e.type === 'INSERT') yield e;
}

// Nom à afficher d'une insertion (bloc dynamique d'AutoCAD resté sur sa représentation anonyme).
export const effectiveName = (e) => e?.effName || e?.name;
