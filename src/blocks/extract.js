// SPDX-License-Identifier: GPL-3.0-or-later
// Extraction des données des blocs (EXTRACTATT, comme l'extraction de données d'AutoCAD) : insertions du dessin ou
// d'une sélection (blocs imbriqués compris si demandé), colonnes de propriétés (nom, nombre, calque, position,
// rotation, échelle, espace), d'attributs et de paramètres dynamiques ; lignes identiques regroupées avec leur nombre ;
// sortie CSV (Excel) ou tableau dans le dessin.
import * as G from '../core/geom.js';
import { insertMatrix } from '../core/entities.js';
import { plainText } from '../text.js';
import { isDynamic, valueOf, describeValue, PARAM_TYPES } from './dynamic.js';

// Colonnes de propriétés proposées (clé → libellé), dans l'ordre d'AutoCAD.
export const PROPERTY_COLUMNS = [
  ['count', 'Nombre'], ['name', 'Nom'], ['layer', 'Calque'], ['x', 'Position X'], ['y', 'Position Y'], ['z', 'Position Z'],
  ['rot', 'Rotation'], ['scale', 'Échelle'], ['space', 'Espace'],
];
const PROP_LABEL = Object.fromEntries(PROPERTY_COLUMNS);

// Bloc d'une insertion à extraire : ni présentation, ni dessin interne (cotes, tableaux de l'appli, objets MEP).
const extractable = (name) => !!name && !/^\*(model|paper)_space/i.test(name) && !/^\*D\d/i.test(name) && !/^CV_(TABLE|MEP)_/i.test(name);

const fmtNum = (v, d = 2) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? '0' : String(r);
};

// Insertions à extraire. ids : sélection (sinon tout le dessin) ; nested : blocs contenus dans les blocs.
// → [{ e, name, layer, p, rot, scale, space, attrs: { TAG: valeur }, dyn: { nom: valeur } }]
export function collectInserts(doc, { ids = null, nested = false } = {}) {
  const spaceLabel = new Map((doc.spaces || []).map((s) => [s.id, s.id === 'model' ? 'Objet' : s.label || s.id]));
  const out = [];
  const visit = (e, m, layer, space, depth) => {
    if (e.type !== 'INSERT' || !extractable(e.name)) return;
    const block = doc.blocks.get(e.name);
    const local = insertMatrix(e, block?.base || [0, 0]);
    const world = G.compose(m, local);
    const origin = G.apply(m, e.p[0], e.p[1]);
    // Calque « 0 » d'un objet de bloc : il prend le calque de l'insertion qui le contient.
    const lay = e.layer === '0' && layer ? layer : e.layer;
    const attrs = {};
    for (const a of e.attribs || []) if (a.tag) attrs[String(a.tag).toUpperCase()] = plainText(String(a.text ?? ''));
    const dyn = {};
    if (isDynamic(block)) {
      for (const p of block.dyn.params) {
        if (p.type === 'point') continue;
        dyn[p.name || PARAM_TYPES[p.type]] = describeValue(p, valueOf(p, e.dyn || {}), (x) => fmtNum(x));
      }
    }
    out.push({
      // Nom effectif : bloc dynamique d'AutoCAD resté sur sa représentation *U.
      e, name: e.effName || e.name, layer: lay, p: [origin[0], origin[1], (e.p[2] || 0)], rot: G.normAngle(G.rotationOf(world)),
      scale: Math.abs(e.sx ?? 1) * G.scaleOf(m), space: spaceLabel.get(space) || space, attrs, dyn, depth,
    });
    if (nested && block && depth < 16) for (const c of block.entities) visit(c, world, lay, space, depth + 1);
  };
  const list = ids ? ids.map((id) => doc.get(id)).filter(Boolean) : [...doc.entities.values()];
  for (const e of list) visit(e, G.IDENTITY, null, e.space || 'model', 0);
  return out;
}

// Noms de blocs trouvés (avec leur nombre) et colonnes d'attributs / de paramètres présentes.
export function inventory(items) {
  const blocks = new Map(), tags = new Map(), dyn = new Map();
  for (const it of items) {
    blocks.set(it.name, (blocks.get(it.name) || 0) + 1);
    for (const t of Object.keys(it.attrs)) { if (!tags.has(t)) tags.set(t, new Set()); tags.get(t).add(it.name); }
    for (const k of Object.keys(it.dyn)) { if (!dyn.has(k)) dyn.set(k, new Set()); dyn.get(k).add(it.name); }
  }
  return { blocks, tags, dyn };
}

// Libellé d'une colonne : propriété, « att:TAG » (attribut) ou « dyn:nom » (paramètre dynamique).
export function columnLabel(key) {
  if (key.startsWith('att:')) return key.slice(4);
  if (key.startsWith('dyn:')) return key.slice(4);
  return PROP_LABEL[key] || key;
}

function cell(it, key, unit) {
  switch (key) {
    case 'name': return it.name;
    case 'layer': return it.layer;
    case 'x': return fmtNum(it.p[0] * unit);
    case 'y': return fmtNum(it.p[1] * unit);
    case 'z': return fmtNum(it.p[2] * unit);
    case 'rot': return fmtNum((it.rot * 180) / Math.PI);
    case 'scale': return fmtNum(it.scale, 4);
    case 'space': return it.space;
    default:
      if (key.startsWith('att:')) return it.attrs[key.slice(4)] ?? '';
      if (key.startsWith('dyn:')) return it.dyn[key.slice(4)] ?? '';
      return '';
  }
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

// Tableau extrait : { head, rows, numeric } (rows = tableaux de chaînes).
// blocks : noms retenus (tous si absent) ; columns : clés dans l'ordre ; combine : lignes identiques regroupées
// (colonne « Nombre » = leur nombre, sinon 1 par ligne) ; sort : [{ key, desc }] ; unit : facteur des coordonnées.
export function extractTable(items, { blocks = null, columns = ['count', 'name'], combine = true, sort = null, unit = 1 } = {}) {
  const keep = blocks ? new Set(blocks) : null;
  const chosen = items.filter((it) => !keep || keep.has(it.name));
  const valueCols = columns.filter((k) => k !== 'count');
  let rows;
  if (combine) {
    const groups = new Map();
    for (const it of chosen) {
      const vals = valueCols.map((k) => cell(it, k, unit));
      const id = JSON.stringify(vals);
      const g = groups.get(id);
      if (g) g.n++; else groups.set(id, { vals, n: 1 });
    }
    rows = [...groups.values()].map((g) => ({ vals: g.vals, n: g.n }));
  } else rows = chosen.map((it) => ({ vals: valueCols.map((k) => cell(it, k, unit)), n: 1 }));
  const full = rows.map((r) => columns.map((k) => (k === 'count' ? String(r.n) : r.vals[valueCols.indexOf(k)])));
  // Tri : clés demandées, sinon par colonnes de gauche à droite (hors nombre).
  const order = sort?.length ? sort : valueCols.map((key) => ({ key }));
  full.sort((a, b) => {
    for (const { key, desc } of order) {
      const j = columns.indexOf(key);
      if (j < 0) continue;
      const c = key === 'count' ? Number(a[j]) - Number(b[j]) : collator.compare(a[j], b[j]);
      if (c) return desc ? -c : c;
    }
    return 0;
  });
  const numeric = columns.map((k, j) => (['count', 'x', 'y', 'z', 'rot', 'scale'].includes(k) ? j : -1)).filter((j) => j >= 0);
  return { head: columns.map(columnLabel), rows: full, numeric, total: chosen.length };
}

// CSV pour Excel en français : séparateur « ; », décimales à virgule, UTF-8 avec BOM, fins de ligne CRLF.
export function toCsv(table) {
  const q = (s, j) => {
    let v = String(s ?? '');
    if (table.numeric?.includes(j) && /^-?\d+(\.\d+)?$/.test(v)) v = v.replace('.', ',');
    return /[;"\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [table.head, ...table.rows].map((r) => r.map(q).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
