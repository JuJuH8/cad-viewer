// SPDX-License-Identifier: GPL-3.0-or-later
// Analyse des saisies de la ligne de commande, à la manière d'AutoCAD.
//   x,y        point absolu          @dx,dy     relatif au dernier point
//   d<a        polaire absolu        @d<a       polaire relatif (angle en degrés)
//   *x,y  *d<a coordonnées générales (SCG) même si un SCU est actif ; sinon coordonnées et angles dans le SCU
//   12.5       nombre (distance directe, rayon, hauteur…)
//   mot        option de la commande (initiale en majuscule acceptée : « A » pour « Arc »)

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const RE_XY = new RegExp(`^(@|#|\\*)?\\s*(${NUM})\\s*,\\s*(${NUM})(?:\\s*,\\s*(${NUM}))?$`);
const RE_POLAR = new RegExp(`^(@|\\*)?\\s*(${NUM})\\s*<\\s*(${NUM})$`);
const RE_NUM = new RegExp(`^${NUM}$`);

export function parseNumber(text) {
  const t = text.trim();
  return RE_NUM.test(t) ? parseFloat(t) : null;
}

// Renvoie { kind: 'point', p } | { kind: 'number', value } | null. ucs : SCU courant { origin, angle } (ou null).
export function parseCoord(text, last, ucs = null) {
  const t = text.trim().replace(/\s+/g, '');
  const ang = ucs?.angle || 0, org = ucs?.origin || [0, 0];
  const rot = (v) => [v[0] * Math.cos(ang) - v[1] * Math.sin(ang), v[0] * Math.sin(ang) + v[1] * Math.cos(ang)];
  let m = t.match(RE_XY);
  if (m) {
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    if (m[1] === '@') {
      if (!last) return null;
      const d = rot([x, y]);
      return { kind: 'point', p: [last[0] + d[0], last[1] + d[1]] };
    }
    if (m[1] === '*') return { kind: 'point', p: [x, y] };
    const q = rot([x, y]);
    return { kind: 'point', p: [org[0] + q[0], org[1] + q[1]] };
  }
  m = t.match(RE_POLAR);
  if (m) {
    const d = parseFloat(m[2]), world = m[1] === '*';
    const a = (parseFloat(m[3]) * Math.PI) / 180 + (world ? 0 : ang);
    const base = m[1] === '@' ? last : world ? [0, 0] : org;
    if (!base) return null;
    return { kind: 'point', p: [base[0] + d * Math.cos(a), base[1] + d * Math.sin(a)] };
  }
  const n = parseNumber(t);
  if (n != null) return { kind: 'number', value: n };
  return null;
}

// Options « [Arc/Clore/annUler] » : on accepte le mot entier, les lettres en majuscule
// (raccourci AutoCAD) ou un préfixe non ambigu.
export function matchKeyword(text, keywords) {
  const t = text.trim().toLowerCase();
  if (!t || !keywords?.length) return null;
  for (const k of keywords) if (k.toLowerCase() === t) return k;
  for (const k of keywords) {
    const caps = k.replace(/[^A-ZÀ-Ý]/g, '').toLowerCase();
    if (caps && caps === t) return k;
  }
  const prefixed = keywords.filter((k) => k.toLowerCase().startsWith(t));
  return prefixed.length === 1 ? prefixed[0] : null;
}
