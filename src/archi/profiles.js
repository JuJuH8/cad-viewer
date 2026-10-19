// SPDX-License-Identifier: GPL-3.0-or-later
// Profils de traitement des bases architecte, enregistrables dans des fichiers .tpp (format texte, lisible
// aussi par des scripts AutoLISP).
//
// Un .tpp est une liste LISP de paires : ("CLÉ" . T), ("CLÉ") pour nil, ("CLÉ" . 4), ("CLÉ" . "texte"),
// ("CLÉ" 0.0 0.0 0.0) pour une liste, ("COUL_TABLE" (1 . 3) (256 . 8)) pour une liste de paires.

export const OPS = [
  'LIBERER', 'UNITES', 'ORIGINE', 'APLATIR',
  'PRESENTATIONS', 'TEXTES', 'PETITS', 'MASQUES', 'HACH_SOLIDES', 'SOLIDES2D', 'PROXY',
  'XREFS', 'GROUPES', 'BLOCS_VIDES', 'CALQUES_SUPPR', 'CALQUES_CACHES',
  'DUCALQUE', 'DUBLOC', 'COTES_DUBLOC', 'TL_DUCALQUE', 'EP_DUCALQUE', 'COULEURS', 'COULEUR_UNIQUE',
  'TYPESLIGNE', 'STYLES', 'MTEXT', 'COTES_CALQUE', 'HACH_CALQUE', 'HACH_ARRIERE', 'VERR_ARRIERE',
  'NEXPL', 'CONV_CALQUES', 'PURGE', 'ECHELLES', 'AUDIT',
];

export function defaults() {
  return {
    LIBERER: false, UNITES: false, UNITE: 4, PREC: 2, CONVUNITE: false, UNITE_SRC: 0,
    ORIGINE: false, ORIG_MODE: 'POINT', ORIG_PT: [0, 0, 0],
    APLATIR: true,
    PRESENTATIONS: false, TEXTES: true, PETITS: true, TOL: 0,
    MASQUES: false, HACH_SOLIDES: false, SOLIDES2D: false, PROXY: true,
    XREFS: true, XREF_MODE: 'INTROUVABLES', IMAGE_MODE: 'INTROUVABLES',
    GROUPES: true, BLOCS_VIDES: true, CALQUES_SUPPR: false, CALQUES_FILTRE: [], CALQUES_CACHES: false,
    DUCALQUE: false, DUBLOC: false, COTES_DUBLOC: false, TL_DUCALQUE: false, EP_DUCALQUE: false,
    COULEURS: false, COUL_TABLE: [], COUL_CALQUES: true, COUL_FORCEES: true, COUL_DUCALQUE: false,
    COULEUR_UNIQUE: false, COUL_UNIQUE: 8, CU_CALQUES: true, CU_ENTITES: false,
    TYPESLIGNE: false, TL_TABLE: [], TL_ECHELLE1: false, FICHIER_LIN: 'acadiso.lin',
    STYLES: false, STYLE_NOM: 'Standard', POLICE: '',
    MTEXT: false,
    COTES_CALQUE: false, NOM_COTES: 'COTES', HACH_CALQUE: false, NOM_HACH: 'HACHURES',
    HACH_ARRIERE: false, VERR_ARRIERE: false, NEXPL: false,
    CONV_CALQUES: false, TABLE_CALQUES: '',
    PURGE: true, ECHELLES: false, AUDIT: true,
    VERROUILLES: true, GELES: true, DESACTIVES: true,
  };
}

// Profils fournis (identiques à ceux du module LT).
export function builtinProfiles() {
  const express = defaults();
  const archi = { ...express, PRESENTATIONS: true, MASQUES: true, HACH_SOLIDES: true, MTEXT: true, HACH_ARRIERE: true, XREF_MODE: 'NONREF' };
  const gris = { ...archi, COULEUR_UNIQUE: true, DUCALQUE: true, DUBLOC: true, COTES_DUBLOC: true, EP_DUCALQUE: true };
  return { Express: express, 'Base architecte': archi, 'Fond de plan gris': gris };
}

// Valeurs des listes de paires : COUL_TABLE [[src, dst]…], TL_TABLE [[src, dst]…].
const PAIR_LISTS = new Set(['COUL_TABLE', 'TL_TABLE']);

// --- lecture / écriture du format LISP -------------------------------------------------

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c) || c === '﻿') { i++; continue; }
    if (c === '(' || c === ')') { out.push(c); i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const n = text[++i];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else s += text[i];
        i++;
      }
      i++;
      out.push({ str: s });
      continue;
    }
    let a = '';
    while (i < text.length && !/[\s()";]/.test(text[i])) a += text[i++];
    out.push({ atom: a });
  }
  return out;
}

// Liste LISP → tableau ; paire pointée (a . b) → { car, cdr }.
function parseExpr(tokens, pos) {
  const t = tokens[pos];
  if (t === '(') {
    const items = [];
    let p = pos + 1, dotted = null;
    while (p < tokens.length && tokens[p] !== ')') {
      if (tokens[p].atom === '.') {
        const [v, np] = parseExpr(tokens, p + 1);
        dotted = { value: v };
        p = np;
        continue;
      }
      const [v, np] = parseExpr(tokens, p);
      items.push(v);
      p = np;
    }
    if (p >= tokens.length) throw new Error('parenthèse non fermée');
    return [dotted ? { car: items, cdr: dotted.value } : items, p + 1];
  }
  if (t === ')') throw new Error('parenthèse fermante en trop');
  if (t.str != null) return [t.str, pos + 1];
  const a = t.atom;
  if (/^t$/i.test(a)) return [true, pos + 1];
  if (/^nil$/i.test(a)) return [null, pos + 1];
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(a)) return [Number(a), pos + 1];
  return [a, pos + 1];
}

function pairOf(v) {
  if (v && v.car) return [v.car[0], v.cdr];
  return Array.isArray(v) ? v : [v, null];
}

// Texte d'un .tpp → profil (complété par les valeurs par défaut).
export function parseTpp(text) {
  const tokens = tokenize(text);
  if (!tokens.length) throw new Error('profil vide');
  const [list] = parseExpr(tokens, 0);
  if (!Array.isArray(list)) throw new Error('profil illisible');
  const cfg = defaults();
  for (const entry of list) {
    let key, value;
    if (entry && entry.car) { key = entry.car[0]; value = entry.car.length > 1 ? [...entry.car.slice(1), entry.cdr] : entry.cdr; }
    else if (Array.isArray(entry)) { key = entry[0]; value = entry.length > 1 ? entry.slice(1) : null; }
    if (typeof key !== 'string') continue;
    if (PAIR_LISTS.has(key)) value = (Array.isArray(value) ? value : []).map(pairOf);
    else if (value === null && typeof cfg[key] !== 'boolean' && Array.isArray(cfg[key])) value = [];
    else if (value === null) value = false;
    cfg[key] = value;
  }
  return cfg;
}

function lispAtom(v) {
  if (v === true) return 'T';
  if (v === false || v == null) return 'nil';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).includes('e') ? v.toExponential() : String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function lispEntry(key, value, isReal) {
  const k = lispAtom(key);
  if (PAIR_LISTS.has(key)) {
    if (!value?.length) return `(${k})`;
    return `(${k} ${value.map(([a, b]) => `(${lispAtom(a)} . ${lispAtom(b)})`).join(' ')})`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `(${k})`;
    return `(${k} ${value.map((x) => (isReal && typeof x === 'number' ? realAtom(x) : lispAtom(x))).join(' ')})`;
  }
  if (value === false || value == null) return `(${k})`;
  return `(${k} . ${isReal && typeof value === 'number' ? realAtom(value) : lispAtom(value)})`;
}

const realAtom = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

// Clés numériques réelles côté LISP (les entiers restent entiers : UNITE, PREC, couleurs…).
const REALS = new Set(['TOL', 'ORIG_PT']);

export function serializeTpp(cfg) {
  const lines = [';; Profil « Traitement de plans » (CAD Viewer, commande FOND)', '('];
  for (const [k, v] of Object.entries({ ...defaults(), ...cfg })) lines.push(` ${lispEntry(k, v, REALS.has(k))}`);
  lines.push(')');
  return lines.join('\r\n') + '\r\n';
}

// --- profils de l'utilisateur (navigateur) ---------------------------------------------

const STORE = 'cadviewer.profils';

export function loadProfiles() {
  let mine = {};
  try { mine = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* stockage indisponible */ }
  const all = builtinProfiles();
  for (const [name, cfg] of Object.entries(mine)) all[name] = { ...defaults(), ...cfg };
  return all;
}

export function saveProfile(name, cfg) {
  try {
    const mine = JSON.parse(localStorage.getItem(STORE) || '{}');
    mine[name] = cfg;
    localStorage.setItem(STORE, JSON.stringify(mine));
    return true;
  } catch { return false; }
}

export function deleteProfile(name) {
  try {
    const mine = JSON.parse(localStorage.getItem(STORE) || '{}');
    delete mine[name];
    localStorage.setItem(STORE, JSON.stringify(mine));
  } catch { /* stockage indisponible */ }
}
