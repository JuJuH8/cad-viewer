// SPDX-License-Identifier: GPL-3.0-or-later
// Motifs de hachures : lecture des fichiers .pat (format public d'AutoCAD), motifs intégrés écrits pour l'appli,
// motifs des fichiers de l'utilisateur (acadiso.pat d'AutoCAD, bibliothèques installées… lus sur place par le serveur, jamais copiés)
// et motifs importés (gardés dans le navigateur).
//
// Un motif : { name, desc, lines: [{ angle (degrés), x, y (origine), dx (décalage le long de la ligne), dy (écart entre
// lignes), dashes: [traits > 0, espaces < 0, points = 0] }] }, en unités du motif (mm du papier pour les motifs
// intégrés et acadiso.pat, pouces pour acad.pat).

// Motifs intégrés (définitions écrites pour l'appli, en mm du papier).
const BUILTIN_PAT = `
*LIGNES, Lignes horizontales
0, 0,0, 0,3
*ANSI31, Diagonales à 45°
45, 0,0, 0,3.175
*ANSI37, Croisillons à 45°
45, 0,0, 0,3.175
135, 0,0, 0,3.175
*GRILLE, Grille carrée
0, 0,0, 0,3
90, 0,0, 0,3
*CARRELAGE, Carrelage (carreau de 1 : échelle = taille du carreau)
0, 0,0, 0,1
90, 0,0, 0,1
*POINTS, Points
0, 0,0, 0,2, 0,-2
*GRAVIER, Gravier (points en quinconce)
0, 0,0, 2.5,2, 0,-5
*BRIQUE, Briques (appareil en panneresse)
0, 0,0, 0,3
90, 0,0, 3,-3, 3,-3
*ACIER, Acier (doubles diagonales)
45, 0,0, 0,3.175
45, 0,0.635, 0,3.175
*TERRE, Terre (traits croisés)
0, 0,0, 3.175,3.175, 3.175,-3.175
90, 0,0, 3.175,3.175, 3.175,-3.175
*ISOLATION, Isolant souple en zigzag (rang de 5 : échelle = épaisseur ÷ 5)
63.434949, 0,0, 4.472136,2.236068, 5.590170,-5.590170
-63.434949, 2.5,5, -4.472136,2.236068, 5.590170,-5.590170
*BETON, Béton (granulats : petits traits orientés au hasard et points)
30, 0,0, 3,5.2, 1,-9
120, 1.5,0.8, 4.2,3.6, 0.7,-8
165, 0.6,2.4, 5,2.8, 0.9,-10
0, 2.2,1.1, 3.4,4.6, 0,-6.8
75, 3.1,3, 2.6,5.9, 0,-7.7
`;

// Lecture d'un fichier .pat : nom (majuscules) → motif. Lignes « *NOM, description », puis une ligne par famille
// de lignes ; commentaires « ; » ignorés.
export function parsePat(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('*')) {
      const comma = line.indexOf(',');
      const name = (comma < 0 ? line.slice(1) : line.slice(1, comma)).trim();
      const desc = comma < 0 ? '' : line.slice(comma + 1).trim();
      cur = name ? { name, desc, lines: [] } : null;
      if (cur) out.set(name.toUpperCase(), cur);
      continue;
    }
    if (!cur) continue;
    const v = line.split(',').map((x) => parseFloat(x));
    if (v.length < 5 || v.slice(0, 5).some((x) => !Number.isFinite(x))) continue;
    cur.lines.push({ angle: v[0], x: v[1], y: v[2], dx: v[3], dy: v[4], dashes: v.slice(5).filter(Number.isFinite) });
  }
  for (const [k, p] of out) if (!p.lines.length) out.delete(k);
  return out;
}

export const BUILTIN = parsePat(BUILTIN_PAT);

// Lignes de définition d'une hachure (coordonnées du monde, comme dans le DXF) : motif à l'échelle, tourné de
// `angle` (radians) autour de l'origine `origin`.
export function patternLines(def, { scale = 1, angle = 0, origin = [0, 0] } = {}) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return def.lines.map((l) => {
    const a = (l.angle * Math.PI) / 180 + angle;
    const dir = [Math.cos(a), Math.sin(a)], nrm = [-Math.sin(a), Math.cos(a)];
    return {
      angle: a,
      base: [origin[0] + (l.x * ca - l.y * sa) * scale, origin[1] + (l.x * sa + l.y * ca) * scale],
      offset: [(l.dx * dir[0] + l.dy * nrm[0]) * scale, (l.dx * dir[1] + l.dy * nrm[1]) * scale],
      dashes: l.dashes.map((d) => d * scale),
    };
  });
}

// Motif (unités du motif) d'une hachure existante, retrouvé depuis ses lignes, son échelle et son angle : permet de
// changer l'échelle ou l'angle d'une hachure lue dans un fichier.
export function defFromHatch(e) {
  if (e.patDef) return e.patDef;
  const s = e.patScale || 1, A = e.patAngle || 0;
  const o = e.patOrigin || [0, 0];
  const ca = Math.cos(-A), sa = Math.sin(-A);
  return {
    name: e.pattern || 'USER', desc: '',
    lines: (e.lines || []).map((l) => {
      const bx = l.base[0] - o[0], by = l.base[1] - o[1];
      const dir = [Math.cos(l.angle), Math.sin(l.angle)], nrm = [-Math.sin(l.angle), Math.cos(l.angle)];
      return {
        angle: ((l.angle - A) * 180) / Math.PI,
        x: (bx * ca - by * sa) / s, y: (bx * sa + by * ca) / s,
        dx: (l.offset[0] * dir[0] + l.offset[1] * dir[1]) / s, dy: (l.offset[0] * nrm[0] + l.offset[1] * nrm[1]) / s,
        dashes: l.dashes.map((d) => d / s),
      };
    }),
  };
}

// Période approximative d'un motif (pour les aperçus et l'échelle proposée).
export function patternPeriod(def) {
  let p = 0;
  for (const l of def.lines) p = Math.max(p, Math.abs(l.dy), l.dashes.reduce((s, d) => s + Math.abs(d), 0));
  return p || 1;
}

// --- fichiers de motifs de l'utilisateur ----------------------------------------------------

const files = new Map(); // nom du fichier → Map des motifs
const USER_KEY = 'cadviewer.motifs';

export function decodePat(bytes) {
  const u8 = new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
}

// Fichiers .pat trouvés par le serveur (dossiers de support d'AutoCAD, applications…).
export async function listPatFiles(folder = null) {
  const r = await fetch(`/__motifs${folder ? `?dossier=${encodeURIComponent(folder)}` : ''}`).catch(() => null);
  return r?.ok ? r.json() : [];
}

export async function loadPatFile(name, folder = null) {
  const key = name.toLowerCase();
  if (files.has(key)) return files.get(key);
  const r = await fetch(`/__motif?nom=${encodeURIComponent(name)}${folder ? `&dossier=${encodeURIComponent(folder)}` : ''}`).catch(() => null);
  const pats = r?.ok ? parsePat(decodePat(await r.arrayBuffer())) : new Map();
  files.set(key, pats);
  return pats;
}

export function loadedPatFiles() { return files; }

// Motifs importés par l'utilisateur (fichier .pat choisi) : gardés dans le navigateur.
export function userPatterns() {
  try { return parsePat(localStorage.getItem(USER_KEY) || ''); } catch { return new Map(); }
}

export function addUserPatterns(text) {
  const pats = parsePat(text);
  if (!pats.size) return 0;
  const cur = userPatterns();
  for (const [k, p] of pats) cur.set(k, p);
  const out = [...cur.values()].map((p) => `*${p.name}, ${p.desc}\n${p.lines.map((l) => [l.angle, l.x, l.y, l.dx, l.dy, ...l.dashes].join(', ')).join('\n')}`).join('\n');
  try { localStorage.setItem(USER_KEY, out); } catch { /* stockage indisponible */ }
  return pats.size;
}

// Motif par son nom : importés, intégrés, puis fichiers chargés (acadiso.pat d'abord en métrique).
export function findPattern(name, { metric = true } = {}) {
  const k = String(name || '').toUpperCase();
  const u = userPatterns().get(k);
  if (u) return { def: u, source: 'importé' };
  if (BUILTIN.has(k)) return { def: BUILTIN.get(k), source: 'intégré' };
  const order = [...files.keys()].sort((a, b) => (a === (metric ? 'acadiso.pat' : 'acad.pat') ? -1 : b === (metric ? 'acadiso.pat' : 'acad.pat') ? 1 : 0));
  for (const f of order) if (files.get(f).has(k)) return { def: files.get(f).get(k), source: f };
  return null;
}
