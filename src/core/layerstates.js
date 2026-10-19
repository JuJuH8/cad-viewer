// SPDX-License-Identifier: GPL-3.0-or-later
// États de calques (ETATCALQUE, comme LAYERSTATE d'AutoCAD) : instantanés nommés des propriétés des calques
// (activé, gelé, verrouillé, tracé, couleur, type et épaisseur de ligne…), restaurés selon un masque de propriétés.
//
// Formats d'AutoCAD (relevés sur AutoCAD 2024) :
// - fichier .las : « 0 LAYERSTATEDICTIONARY », puis par état « 0 LAYERSTATE 1 nom 91 masque 301 description 290 0
//   302 calque courant » et par calque « 8 nom 90 drapeaux 62 couleur 370 épaisseur 6 type de ligne 2 style de tracé
//   440 transparence [92 couleur vraie] » ; texte dans la page de codes de Windows (cp1252).
// - DXF : dictionnaire ACAD_LAYERSTATES dans le dictionnaire étendu de la table LAYER, un XRECORD par état, mêmes
//   codes mais calques et types de ligne désignés par leur poignée (330, 331) et style de tracé en code 1.
// Drapeaux d'un calque (90) : 1 désactivé, 2 gelé, 4 verrouillé, 8 tracé, 16 gelé dans les nouvelles fenêtres.

export const MASK = {
  on: 1, frozen: 2, locked: 4, plot: 8, newVp: 16, color: 32, ltype: 64, lweight: 128,
  plotStyle: 256, viewport: 512, transparency: 1024,
};
export const DEFAULT_MASK = 255; // activé … épaisseur (ce que l'appli gère), comme AutoCAD par défaut
const LAST_RESTORED = 0x10000; // marque AutoCAD du dernier état restauré (non gardée)
const FLAG = { off: 1, frozen: 2, locked: 4, plot: 8, newVp: 16 };

export const keyOf = (name) => String(name).toUpperCase();

const aciOf = (c) => (Number.isInteger(c) && c >= 1 && c <= 255 ? c : 7);

function flagsOf(l) {
  return (l.on === false ? FLAG.off : 0) | (l.frozen ? FLAG.frozen : 0) | (l.locked ? FLAG.locked : 0)
    | (l.plot === false ? 0 : FLAG.plot) | (l.newVp ? FLAG.newVp : 0);
}

function applyFlags(l, f) {
  l.on = !(f & FLAG.off);
  l.frozen = !!(f & FLAG.frozen);
  l.locked = !!(f & FLAG.locked);
  l.plot = !!(f & FLAG.plot);
  l.newVp = !!(f & FLAG.newVp);
}

const blankLayer = (name) => ({ name, on: true, frozen: false, locked: false, plot: true, newVp: false, color: 7, rgb: undefined, ltype: 'Continuous', lweight: -3, plotStyle: '', transparency: 0 });

// Propriétés d'un calque du dessin telles qu'un état les garde.
function snapshot(l) {
  return {
    name: l.name, on: l.on !== false, frozen: !!l.frozen, locked: !!l.locked, plot: l.plot !== false,
    newVp: !!l.newVpFrozen, color: aciOf(l.color), rgb: typeof l.rgb === 'number' ? l.rgb : undefined,
    ltype: l.ltype || 'Continuous', lweight: l.lweight ?? -3, plotStyle: l.plotStyle || '', transparency: l.transparency || 0,
  };
}

// Nouvel état : propriétés actuelles de tous les calques et calque courant.
export function captureState(doc, name, { desc = '', mask = DEFAULT_MASK } = {}) {
  return { name, desc, mask, current: doc.currentLayer || '0', vp: false, layers: [...doc.layers.values()].map(snapshot) };
}

// Propriétés à appliquer à un calque pour un état (selon le masque), ou null si rien ne change.
function propsFor(doc, layer, s, mask) {
  const p = {};
  if (mask & MASK.on) { if ((layer.on !== false) !== s.on) p.on = s.on; }
  if (mask & MASK.frozen) { if (!!layer.frozen !== s.frozen) p.frozen = s.frozen; }
  if (mask & MASK.locked) { if (!!layer.locked !== s.locked) p.locked = s.locked; }
  if (mask & MASK.plot) { if ((layer.plot !== false) !== s.plot) p.plot = s.plot; }
  if (mask & MASK.newVp) { if (!!layer.newVpFrozen !== s.newVp) p.newVpFrozen = s.newVp; }
  if (mask & MASK.color) {
    if (layer.color !== s.color || (typeof layer.rgb === 'number' ? layer.rgb : undefined) !== s.rgb) { p.color = s.color; p.rgb = s.rgb; }
  }
  if (mask & MASK.ltype) {
    const known = /^continuous$/i.test(s.ltype) || doc.ltypes?.has(keyOf(s.ltype));
    if (known && String(layer.ltype || 'Continuous').toUpperCase() !== keyOf(s.ltype)) p.ltype = s.ltype;
  }
  if (mask & MASK.lweight) { if ((layer.lweight ?? -3) !== s.lweight) p.lweight = s.lweight; }
  if (mask & MASK.transparency) { if ((layer.transparency || 0) !== (s.transparency || 0)) p.transparency = s.transparency || 0; }
  return Object.keys(p).length ? p : null;
}

// Restaure un état (à appeler dans une transaction) : calque courant de l'état, puis propriétés retenues par le masque.
// offMissing : désactive les calques absents de l'état. → { changed, missing, current }
export function restoreState(doc, state, { mask = state.mask, offMissing = false } = {}) {
  const m = mask & 0x7ff;
  const byKey = new Map(state.layers.map((s) => [keyOf(s.name), s]));
  // Calque courant au moment de l'enregistrement (comme AutoCAD), s'il existe et ne sera pas gelé.
  const cur = state.current && [...doc.layers.keys()].find((n) => keyOf(n) === keyOf(state.current));
  if (cur && !((m & MASK.frozen) && byKey.get(keyOf(cur))?.frozen)) doc.currentLayer = cur;
  let changed = 0, missing = 0;
  for (const layer of [...doc.layers.values()]) {
    const s = byKey.get(keyOf(layer.name));
    let p;
    if (!s) {
      missing++;
      p = offMissing && layer.on !== false ? { on: false } : null;
    } else p = propsFor(doc, layer, s, m);
    if (p && p.frozen && layer.name === doc.currentLayer) delete p.frozen; // le calque courant n'est jamais gelé
    if (p && Object.keys(p).length) { doc.setLayer(layer.name, p); changed++; }
  }
  return { changed, missing, current: doc.currentLayer };
}

// L'état correspond-il aux calques actuels (colonne « Identique » d'AutoCAD) ?
export function stateMatches(doc, state) {
  const m = state.mask & 0x7ff;
  return state.layers.every((s) => {
    const layer = [...doc.layers.values()].find((l) => keyOf(l.name) === keyOf(s.name));
    return !layer || !propsFor(doc, layer, s, m & ~MASK.newVp & ~MASK.transparency);
  });
}

// Renommage d'un calque : l'état garde le calque sous son nouveau nom.
export function renameInState(state, oldName, newName) {
  if (!state.layers.some((s) => s.name === oldName) && state.current !== oldName) return null;
  return {
    ...state,
    current: state.current === oldName ? newName : state.current,
    layers: state.layers.map((s) => (s.name === oldName ? { ...s, name: newName } : s)),
  };
}

// --- groupes de codes (communs au .las et au DXF) ------------------------------------------------

// État lu dans une suite de groupes [code, valeur]. kind 'las' : 1 = nom de l'état, 8 / 6 = noms, 2 = style de tracé ;
// kind 'dxf' : 330 / 331 = poignées (résolues par `names`), 1 = style de tracé.
function stateFromGroups(groups, kind, name = '', names = {}) {
  const st = { name, desc: '', mask: DEFAULT_MASK, current: '0', vp: false, layers: [] };
  let ly = null;
  for (const [code, raw] of groups) {
    const v = String(raw ?? '');
    const n = parseInt(v, 10);
    switch (code) {
      case 1: if (kind === 'las') st.name = v; else if (ly) ly.plotStyle = v; break;
      case 91: st.mask = (n || 0) & ~LAST_RESTORED; break;
      case 301: st.desc = v; break;
      case 290: st.vp = v.trim() === '1'; break;
      case 302: st.current = v; break;
      case 8: if (kind === 'las') { ly = blankLayer(v); st.layers.push(ly); } break;
      case 330: if (kind === 'dxf') { ly = blankLayer(names.layer?.(v.trim()) ?? null); st.layers.push(ly); } break;
      case 90: if (ly) applyFlags(ly, n || 0); break;
      case 62: if (ly) ly.color = aciOf(Math.abs(n)); break;
      case 370: if (ly && Number.isFinite(n)) ly.lweight = n; break;
      case 6: if (ly) ly.ltype = v || 'Continuous'; break;
      case 331: if (ly) ly.ltype = names.ltype?.(v.trim()) || 'Continuous'; break;
      case 2: if (ly && kind === 'las') ly.plotStyle = v; break;
      case 440: if (ly) ly.transparency = n || 0; break;
      case 92: if (ly && Number.isFinite(n)) ly.rgb = n & 0xffffff; break;
    }
  }
  st.layers = st.layers.filter((s) => s.name);
  return st;
}

// Groupes d'un calque d'un état ; ref(l) = [code, valeur] désignant le calque, lt(l) = celui du type de ligne.
function layerGroups(s, ref, lt) {
  const aci = aciOf(s.color);
  const g = [ref(s), [90, flagsOf(s)], [62, aci], [370, s.lweight ?? -3], lt(s), [lt(s)[0] === 6 ? 2 : 1, s.plotStyle || `Color_${aci}`], [440, s.transparency || 0]];
  if (typeof s.rgb === 'number') g.push([92, (0xc2000000 | s.rgb) | 0]); // 0xC2 : couleur RVB (AcCmColor)
  return g;
}

// Groupes d'un XRECORD d'état (après « 280 1 »), calques désignés par leur poignée ; calques sans poignée omis.
export function xrecordGroups(state, layerHandle, ltypeHandle) {
  const out = [[91, state.mask & 0xffff], [301, state.desc || ''], [290, state.vp ? 1 : 0], [302, state.current || '0']];
  for (const s of state.layers) {
    const h = layerHandle(s.name);
    if (!h) continue;
    out.push(...layerGroups(s, () => [330, h], (x) => [331, ltypeHandle(x.ltype)]));
  }
  return out;
}

export function stateFromXrecord(name, groups, names) {
  return stateFromGroups(groups, 'dxf', name, names);
}

// --- fichier .las ---------------------------------------------------------------------------------

export function parseLas(text) {
  const lines = text.split(/\r?\n/);
  const states = [];
  let cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const v = lines[i + 1];
    if (code === 0) {
      if (v.trim() === 'LAYERSTATE') { cur = []; states.push(cur); } else cur = null;
      continue;
    }
    if (cur && Number.isFinite(code)) cur.push([code, v]);
  }
  return states.map((g) => stateFromGroups(g, 'las')).filter((s) => s.name);
}

export function writeLas(states) {
  const out = [];
  const g = (code, v) => out.push(String(code).padStart(3, ' '), String(v));
  g(0, 'LAYERSTATEDICTIONARY');
  for (const st of states) {
    g(0, 'LAYERSTATE');
    g(1, st.name); g(91, st.mask & 0xffff); g(301, st.desc || ''); g(290, st.vp ? 1 : 0); g(302, st.current || '0');
    for (const s of st.layers) for (const [c, v] of layerGroups(s, (x) => [8, x.name], (x) => [6, x.ltype || 'Continuous'])) g(c, v);
  }
  return `${out.join('\r\n')}\r\n`;
}

// Page de codes Windows 1252 (celle des .las d'AutoCAD en français) ; caractère hors page → \U+XXXX comme AutoCAD.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export function encodeLas(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const k = CP1252.indexOf(ch);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) bytes.push(c);
    else if (k >= 0) bytes.push(0x80 + k);
    else for (const b of `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`) bytes.push(b.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}

// Texte d'un .las : UTF-8 s'il est valide, sinon cp1252 ; séquences \U+XXXX décodées.
export function decodeLas(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  return text.replace(/^﻿/, '').replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// --- lecture dans le texte d'un DXF ---------------------------------------------------------------

// Chaîne décodée en « latin1 » (pour TextDecoder, c'est cp1252) → UTF-8 si c'en est (DXF 2007 et plus), séquences
// \U+XXXX décodées.
export function fixText(s) {
  let t = s;
  if (/[^\x00-\x7f]/.test(s)) {
    const byte = (c) => { const k = c.charCodeAt(0); return k <= 0xff ? k : 0x80 + CP1252.indexOf(c); };
    try { t = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, byte)); } catch { /* page de codes : gardé */ }
  }
  return t.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// États de calques d'un DXF (texte brut) : dictionnaire ACAD_LAYERSTATES → XRECORD, calques et types de ligne
// retrouvés par leur poignée dans les tables.
export function scanLayerStates(text) {
  if (!text || !text.includes('ACAD_LAYERSTATES')) return [];
  const lines = text.split(/\r?\n/);
  const layers = new Map(), ltypes = new Map(), dicts = new Map(), xrecs = new Map();
  let type = null, cur = null, section = null;
  const close = () => {
    if (!cur?.handle) return;
    if (type === 'LAYER' || type === 'LTYPE') {
      const name = cur.pairs.find(([c]) => c === 2)?.[1];
      if (name != null) (type === 'LAYER' ? layers : ltypes).set(cur.handle, fixText(name));
    } else (type === 'DICTIONARY' ? dicts : xrecs).set(cur.handle, cur.pairs);
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const value = lines[i + 1].replace(/\s+$/, '');
    if (code === 0) {
      close();
      type = value.trim();
      const wanted = section === 'TABLES' ? type === 'LAYER' || type === 'LTYPE' : section === 'OBJECTS' && (type === 'DICTIONARY' || type === 'XRECORD');
      cur = wanted ? { handle: null, pairs: [] } : null;
      continue;
    }
    if (code === 2 && lines[i - 1]?.trim() === 'SECTION') { section = value.trim(); continue; }
    if (!cur) continue;
    if (code === 5 && cur.handle == null) cur.handle = value.trim().toUpperCase();
    else cur.pairs.push([code, value]);
  }
  close();
  const entries = (pairs) => {
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i][0] === 3 && pairs[i + 1] && (pairs[i + 1][0] === 350 || pairs[i + 1][0] === 360)) out.push([fixText(pairs[i][1]), pairs[i + 1][1].trim().toUpperCase()]);
    }
    return out;
  };
  let lsDict = null;
  for (const pairs of dicts.values()) {
    const hit = entries(pairs).find(([n]) => n === 'ACAD_LAYERSTATES');
    if (hit) { lsDict = dicts.get(hit[1]); break; }
  }
  if (!lsDict) return [];
  const names = { layer: (h) => layers.get(h.toUpperCase()), ltype: (h) => ltypes.get(h.toUpperCase()) };
  const states = [];
  for (const [name, h] of entries(lsDict)) {
    const pairs = xrecs.get(h);
    if (!pairs) continue;
    const start = pairs.findIndex(([c, v]) => c === 100 && v.trim() === 'AcDbXrecord');
    const body = pairs.slice(start + 1).filter(([c]) => c !== 280 && c !== 102).map(([c, v]) => [c, c === 301 || c === 302 || c === 1 ? fixText(v) : v]);
    states.push(stateFromXrecord(name, body, names));
  }
  return states;
}

// États de calques d'un DWG (objets convertis par LibreDWG : DICTIONARY, XRECORD, tables LAYER et LTYPE).
export function layerStatesFromObjects(db) {
  const dicts = db.objects?.DICTIONARY || [], xrecs = db.objects?.XRECORD || [];
  const H = (h) => String(h ?? '').toUpperCase();
  const entriesOf = (d) => {
    const e = d.entries || d.items || [];
    return Array.isArray(e) ? e.map((x) => [x.name, H(x.objectSoftId ?? x.objectId ?? x.handle ?? x.value)]) : Object.entries(e).map(([n, h]) => [n, H(h)]);
  };
  let ls = null;
  for (const d of dicts) {
    const hit = entriesOf(d).find(([n]) => n === 'ACAD_LAYERSTATES');
    if (hit) { ls = dicts.find((x) => H(x.handle) === hit[1]); break; }
  }
  if (!ls) return [];
  const table = (t) => new Map((db.tables?.[t]?.entries || []).map((r) => [H(r.handle), r.name]));
  const layers = table('LAYER'), ltypes = table('LTYPE');
  const names = { layer: (h) => layers.get(H(h)), ltype: (h) => ltypes.get(H(h)) };
  const out = [];
  for (const [name, h] of entriesOf(ls)) {
    const xr = xrecs.find((x) => H(x.handle) === h);
    const data = xr?.data || xr?.items || [];
    if (!data.length) continue;
    out.push(stateFromXrecord(name, data.map((g) => [g.code ?? g.type, g.value]).filter(([c]) => c !== 280 && c !== 102), names));
  }
  return out;
}
