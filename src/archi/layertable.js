// SPDX-License-Identifier: GPL-3.0-or-later
// Motifs de noms à la manière de WCMATCH (AutoCAD) et table de conversion des calques (CSV),
// format : Calque source;Calque cible;Couleur;Type de ligne;Epaisseur.

const cache = new Map();

// Motif WCMATCH → expression régulière (insensible à la casse). Gère * ? # @ . ~ [..] ` et la virgule
// (plusieurs motifs).
export function wcRegex(pattern) {
  let re = cache.get(pattern);
  if (re) return re;
  const alts = [];
  let cur = '', neg = false, i = 0;
  const push = () => { alts.push({ src: cur, neg }); cur = ''; neg = false; };
  if (pattern[0] === '~') { neg = true; i = 1; }
  for (; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '`' && i + 1 < pattern.length) { cur += escapeRe(pattern[++i]); continue; }
    if (c === ',') { push(); if (pattern[i + 1] === '~') { neg = true; i++; } continue; }
    if (c === '*') cur += '.*';
    else if (c === '?') cur += '.';
    else if (c === '#') cur += '[0-9]';
    else if (c === '@') cur += '[A-Za-zÀ-ÿ]';
    else if (c === '.') cur += '[^A-Za-z0-9À-ÿ]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) { cur += '\\['; continue; }
      let body = pattern.slice(i + 1, end);
      const not = body[0] === '~';
      if (not) body = body.slice(1);
      cur += `[${not ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else cur += escapeRe(c);
  }
  push();
  const parts = alts.map((a) => ({ re: new RegExp(`^(?:${a.src})$`, 'i'), neg: a.neg }));
  re = (s) => parts.some((p) => p.re.test(s) !== p.neg);
  cache.set(pattern, re);
  return re;
}

function escapeRe(c) {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export const wcmatch = (s, pattern) => wcRegex(pattern)(s);

// Source d'une ligne de table : motif si elle contient * ou ?, sinon nom exact (casse ignorée).
export function sourceMatches(layer, src) {
  if (/[*?]/.test(src)) {
    const pat = [...src].map((c) => (c === '*' || c === '?' ? c : /[#@.~[\]`,-]/.test(c) ? `\`${c}` : c)).join('');
    return wcmatch(layer, pat);
  }
  return layer.toUpperCase() === src.toUpperCase();
}

function splitCsv(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') q = !q;
    else if (!q && c === sep) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const num = (s) => {
  const v = parseFloat(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};

// Texte CSV → lignes { source, target, color, ltype, lweight } (épaisseur en centièmes de mm).
export function parseLayerTable(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  let rows = lines.map((l) => splitCsv(l, sep));
  if (/source|calque/i.test(rows[0][0] || '')) rows = rows.slice(1);
  return rows.filter((r) => r[0]).map((r) => {
    const color = num(r[2]), lw = num(r[4]);
    return {
      source: r[0],
      target: r[1] || '',
      color: color != null && color >= 1 && color <= 255 ? Math.round(color) : null,
      ltype: r[3] || null,
      lweight: lw != null ? Math.round(lw * 100) : null,
    };
  });
}

// Table CSV des calques d'un document (colonne « Calque cible » à compléter), avec le nombre d'objets.
export function exportLayerTable(doc) {
  const counts = new Map();
  for (const e of doc.entities.values()) counts.set(e.layer, (counts.get(e.layer) || 0) + 1);
  const cell = (s) => (/[;"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = ['Calque source;Calque cible;Couleur;Type de ligne;Epaisseur;Objets'];
  for (const l of [...doc.layers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push([cell(l.name), '', Math.abs(l.color ?? 7), cell(l.ltype || 'Continuous'),
      l.lweight >= 0 ? (l.lweight / 100).toFixed(2) : '', counts.get(l.name) || 0].join(';'));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}
