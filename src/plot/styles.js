// SPDX-License-Identifier: GPL-3.0-or-later
// Tables de styles de tracé, comme AutoCAD :
// - dépendant de la couleur (CTB) : pour chacune des 255 couleurs d'index (ACI), la couleur tracée (celle de l'objet
//   ou imposée), les niveaux de gris, la trame (%), le type de ligne et l'épaisseur (ceux de l'objet ou imposés) ;
// - nommés (STB) : une liste de styles (« Normal », « Style 1 »…) aux mêmes réglages, choisis par calque ou par objet
//   dans les dessins en styles nommés (PSTYLEMODE = 0).
// Lecture et écriture des fichiers .ctb / .stb d'AutoCAD (format PIA : en-tête, somme Adler-32, texte compressé zlib).
import { FOREGROUND, aciToColor } from '../colors.js';

// Épaisseurs proposées (mm), comme la table « custom_lineweight_table » d'AutoCAD.
export const LINEWEIGHTS = [0, 0.05, 0.09, 0.1, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.53, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.58, 2.0, 2.11];

// Types de ligne prédéfinis des styles de tracé (index 0 à 30 des fichiers CTB) : motifs en mm (+ trait, − espace,
// 0 point) pour une taille de motif de 0,5.
export const PLOT_LINETYPES = [
  ['Continu', []], ['Tiret', [6, -3]], ['Pointillé', [0, -2]], ['Tiret point', [6, -2, 0, -2]], ['Tiret court', [3, -2]],
  ['Tiret moyen', [6, -2]], ['Tiret long', [12, -3]], ['Tiret court x2', [3, -1.5, 3, -4]], ['Tiret moyen x2', [6, -1.5, 6, -4]],
  ['Tiret long x2', [12, -2, 12, -5]], ['Tiret moyen long', [6, -2, 12, -2]], ['Tiret moyen court court', [6, -2, 2, -2, 2, -2]],
  ['Tiret long court', [12, -2, 3, -2]], ['Tiret long point point', [12, -2, 0, -2, 0, -2]], ['Tiret long point', [12, -2, 0, -2]],
  ['Tiret moyen point court point', [6, -2, 0, -2, 3, -2, 0, -2]], ['Pointillé espacé', [0, -4]], ['ISO tiret', [12, -3]],
  ['ISO tiret espace', [12, -18]], ['ISO tiret long point', [24, -3, 0, -3]], ['ISO tiret long double point', [24, -3, 0, -3, 0, -3]],
  ['ISO tiret long triple point', [24, -3, 0, -3, 0, -3, 0, -3]], ['ISO point', [0, -3]], ['ISO tiret long court', [24, -3, 6, -3]],
  ['ISO tiret long double court', [24, -3, 6, -3, 6, -3]], ['ISO tiret point', [12, -3, 0, -3]], ['ISO double tiret point', [12, -3, 12, -3, 0, -3]],
  ['ISO tiret double point', [12, -3, 0, -3, 0, -3]], ['ISO double tiret double point', [12, -3, 12, -3, 0, -3, 0, -3]],
  ['ISO tiret triple point', [12, -3, 0, -3, 0, -3, 0, -3]], ['ISO double tiret triple point', [12, -3, 12, -3, 0, -3, 0, -3, 0, -3]],
];

// Style par défaut : tout comme l'objet.
export const objectStyle = () => ({ color: null, dither: true, grayscale: false, screen: 100, linetype: null, lineweight: null, description: '' });

export function emptyTable(name, description = '') {
  return { name, description, kind: 'ctb', styles: Array.from({ length: 255 }, objectStyle) };
}

// Table de styles nommés : « Normal » (comme l'objet) et les styles donnés ([nom, réglages]).
export function emptyStb(name, description = '', extra = []) {
  return { name, description, kind: 'stb', styles: [{ ...objectStyle(), name: 'Normal' }, ...extra.map(([n, st]) => ({ ...objectStyle(), ...st, name: n }))] };
}
export const isStb = (t) => t?.kind === 'stb' || /\.stb$/i.test(t?.name || '');

// --- tables intégrées --------------------------------------------------------------------------------

function make(name, description, fn) {
  const t = emptyTable(name, description);
  t.styles.forEach((s, i) => fn(s, i + 1));
  t.builtin = true;
  return t;
}

function makeStb(name, description, extra) {
  const t = emptyStb(name, description, extra);
  t.builtin = true;
  return t;
}

export const BUILTIN = [
  make('acad.ctb', 'Couleurs, types de ligne et épaisseurs des objets', () => {}),
  make('monochrome.ctb', 'Tout en noir', (s) => { s.color = 0x000000; }),
  make('grayscale.ctb', 'Couleurs converties en niveaux de gris', (s) => { s.grayscale = true; }),
  make('Screening 50%.ctb', 'Couleurs des objets tramées à 50 %', (s) => { s.screen = 50; }),
  // Usage courant des bureaux techniques : tout en noir, épaisseur selon la couleur, gris 8 et 9 tramés (fonds).
  make('CV noir - épaisseurs par couleur.ctb', 'Noir ; épaisseur selon la couleur 1 à 9 ; 8 et 9 en gris (fonds de plan)', (s, aci) => {
    s.color = 0x000000;
    const lw = { 1: 0.13, 2: 0.18, 3: 0.25, 4: 0.35, 5: 0.5, 6: 0.7, 7: 0.25, 8: 0.13, 9: 0.09 }[aci];
    if (lw != null) s.lineweight = lw;
    if (aci === 8) s.screen = 50;
    if (aci === 9 || aci >= 250) s.screen = 30;
  }),
  // Styles nommés (dessins en styles nommés), comme les tables livrées avec AutoCAD.
  makeStb('acad.stb', 'Styles comme les objets', [['Style 1', {}]]),
  makeStb('monochrome.stb', 'Tout en noir', [['Style 1', { color: 0x000000 }]]),
  makeStb('CV styles nommés.stb', 'Noir, gris tramés pour les fonds de plan, traits fins / moyens / forts', [
    ['Noir', { color: 0x000000 }], ['Gris 50%', { color: 0x000000, screen: 50 }], ['Gris 30%', { color: 0x000000, screen: 30 }],
    ['Fin', { color: 0x000000, lineweight: 0.18 }], ['Moyen', { color: 0x000000, lineweight: 0.35 }], ['Fort', { color: 0x000000, lineweight: 0.7 }],
  ]),
];
BUILTIN.find((t) => t.name === 'monochrome.stb').styles[0].color = 0x000000;

const USER_KEY = 'cadviewer.ctb';
export function userTables() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '[]').filter((t) => t?.name && Array.isArray(t.styles)); } catch { return []; }
}
function saveUserTables(list) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
}
export function saveUserTable(t) {
  const list = userTables().filter((x) => x.name.toLowerCase() !== t.name.toLowerCase());
  const { builtin, ...rest } = t;
  list.push(rest);
  saveUserTables(list);
}
export function deleteUserTable(name) {
  saveUserTables(userTables().filter((x) => x.name !== name));
}

// Toutes les tables (intégrées puis celles de l'utilisateur), par nom.
export function allTables() {
  const out = new Map();
  for (const t of BUILTIN) out.set(t.name.toLowerCase(), t);
  for (const t of userTables()) if (!out.get(t.name.toLowerCase())?.builtin) out.set(t.name.toLowerCase(), t);
  return out;
}
export const findTable = (name) => (name ? allTables().get(String(name).toLowerCase()) || null : null);

// --- application ------------------------------------------------------------------------------------

// Couleurs d'index : RVB → ACI exact, sinon le plus proche (couleurs vraies), comme le fait AutoCAD.
let ACI_RGB = null;
export function aciOf(color) {
  if (color === FOREGROUND) return 7;
  if (typeof color !== 'number') return 7;
  if (!ACI_RGB) {
    ACI_RGB = new Map();
    for (let i = 255; i >= 1; i--) { const c = aciToColor(i); if (typeof c === 'number') ACI_RGB.set(c, i); }
  }
  const exact = ACI_RGB.get(color);
  if (exact) return exact;
  let best = 7, bd = Infinity;
  for (const [c, i] of ACI_RGB) {
    const d = (((c >> 16) & 255) - ((color >> 16) & 255)) ** 2 + (((c >> 8) & 255) - ((color >> 8) & 255)) ** 2 + ((c & 255) - (color & 255)) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export const styleFor = (table, color) => table?.styles[aciOf(color) - 1] || null;

// Nom de style comparable (AutoCAD écrit « Style_1 » dans les tables et « Style 1 » dans les dessins).
export const styleKey = (n) => String(n ?? '').trim().toLowerCase().replace(/_/g, ' ');
// Style nommé d'une table STB (inconnu : comme l'objet, sans réglage).
export function stbStyle(table, name) {
  const k = styleKey(name || 'Normal');
  return table?.styles.find((s) => styleKey(s.name) === k || (s.label && styleKey(s.label) === k)) || null;
}
// Noms de styles proposés dans un dessin en styles nommés : ceux des tables STB de ses réglages de tracé (espace
// objet, présentations ; sinon acad.stb), puis ceux déjà utilisés par ses calques et ses objets ; « Normal » d'abord.
export function plotStyleNames(doc) {
  const out = new Map([['normal', 'Normal']]);
  const add = (n) => { if (n && !out.has(styleKey(n))) out.set(styleKey(n), String(n)); };
  const tables = [doc?.header?.plotModel?.ctb, ...(doc?.spaces || []).map((sp) => sp.plot?.ctb)].filter((n) => n && /\.stb$/i.test(n));
  for (const name of tables.length ? tables : ['acad.stb']) for (const s of findTable(name)?.styles || []) add(s.name);
  for (const l of doc?.layers?.values() || []) add(l.pstyle);
  for (const e of doc?.entities?.values() || []) add(e.pstyle);
  return [...out.values()];
}

// Style d'un morceau tracé : par sa couleur (CTB) ou par son style nommé, celui de l'objet sinon celui de son calque.
export function styleOf(table, color, part, doc) {
  if (!table) return null;
  if (!isStb(table)) return styleFor(table, color);
  const own = part?.ps && part.ps !== 'BYBLOCK' ? part.ps : null;
  return stbStyle(table, own || doc?.layers.get(part?.layer)?.pstyle || 'Normal');
}

// Couleur tracée (RVB) d'un objet de couleur `color` (FOREGROUND = noir sur le papier).
export function plotColor(style, color) {
  let c = style?.color ?? (color === FOREGROUND ? 0x000000 : color);
  if (style?.grayscale) {
    const g = Math.round(0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255));
    c = (g << 16) | (g << 8) | g;
  }
  const s = style ? Math.max(0, Math.min(100, style.screen ?? 100)) : 100;
  if (s < 100) {
    const k = s / 100;
    const ch = (sh) => Math.round(255 - (255 - ((c >> sh) & 255)) * k);
    c = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  }
  return c;
}

// --- fichiers .ctb d'AutoCAD ------------------------------------------------------------------------

const HEADER_CTB = 'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec';

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
// Texte des fichiers PIA : codage Windows (cp1252, apostrophes et guillemets typographiques compris).
const latin1 = (bytes) => new TextDecoder('windows-1252').decode(bytes);
const CP1252 = new Map(Object.entries({ 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' }).map(([k, v]) => [v, +k]));
const fromLatin1 = (s) => Uint8Array.from(s, (c) => { const n = c.charCodeAt(0); return n < 256 ? n : CP1252.get(c) ?? 63; });

// Texte PIA (clé=valeur, blocs « nom{ … } ») → objet.
function parsePia(text) {
  const root = {};
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const top = stack[stack.length - 1];
    if (line === '}') { stack.pop(); continue; }
    const open = /^([^=]+)\{$/.exec(line);
    if (open) { const o = {}; top[open[1].trim()] = o; stack.push(o); continue; }
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1);
    if (v.startsWith('"')) v = v.slice(1).replace(/"$/, '');
    top[line.slice(0, i).trim()] = v;
  }
  return root;
}

// Fichier .ctb ou .stb → table.
export async function parseCtb(buffer, name = 'table.ctb') {
  const bytes = new Uint8Array(buffer);
  const head = latin1(bytes.subarray(0, 48));
  if (!head.startsWith('PIAFILEVERSION')) throw new Error('fichier de styles de tracé non reconnu');
  const stb = head.includes('STBVER');
  const text = latin1(await inflate(bytes.subarray(60)));
  const pia = parsePia(text);
  const lws = Object.keys(pia.custom_lineweight_table || {}).sort((a, b) => a - b).map((k) => parseFloat(pia.custom_lineweight_table[k]));
  const t = stb ? { name: /\.stb$/i.test(name) ? name : `${name}.stb`, description: pia.description || '', kind: 'stb', styles: [] } : emptyTable(name, pia.description || '');
  // Styles dans « plot_style » (le bloc « aci_table » associe chaque couleur au nom de son style).
  const block = pia.plot_style && typeof pia.plot_style === 'object' ? pia.plot_style : pia.aci_table || {};
  for (const [k, s] of Object.entries(block).sort((a, b) => +a[0] - +b[0])) {
    const i = +k;
    if (!(i >= 0 && (stb || i < 255)) || typeof s !== 'object') continue;
    const st = objectStyle();
    const color = parseInt(s.color, 10);
    const policy0 = parseInt(s.color_policy, 10) || 0;
    // Couleur imposée : bit 4 de color_policy (sinon couleur de l'objet).
    if (Number.isFinite(color) && color !== -1 && (policy0 & 4 || !stb)) {
      const u = color >>> 0;
      st.color = (u >>> 24) === 0xc3 ? (aciToColor(u & 255) === FOREGROUND ? 0x000000 : aciToColor(u & 255)) : u & 0xffffff;
    }
    const policy = parseInt(s.color_policy, 10) || 0;
    st.dither = (policy & 1) !== 0;
    st.grayscale = (policy & 2) !== 0;
    st.screen = Math.max(0, Math.min(100, parseInt(s.screen, 10) || 100));
    const lt = parseInt(s.linetype, 10);
    st.linetype = Number.isFinite(lt) && lt !== 31 && lt >= 0 && lt < PLOT_LINETYPES.length ? lt : null;
    const lw = parseInt(s.lineweight, 10);
    st.lineweight = lw > 0 && lws[lw - 1] != null ? lws[lw - 1] : null;
    st.description = s.description || '';
    if (stb) { st.name = String(s.localized_name || s.name || `Style ${i}`).replace(/_/g, ' '); t.styles.push(st); } else t.styles[i] = st;
  }
  if (stb && !t.styles.some((x) => styleKey(x.name) === 'normal')) t.styles.unshift({ ...objectStyle(), name: 'Normal' });
  return t;
}

// Table → fichier .ctb ou .stb lisible par AutoCAD.
export async function writeCtb(t) {
  const stb = isStb(t);
  const lwIndex = (mm) => {
    let best = 0, bd = Infinity;
    LINEWEIGHTS.forEach((v, i) => { if (Math.abs(v - mm) < bd) { bd = Math.abs(v - mm); best = i; } });
    return best + 1;
  };
  const lines = [`description="${t.description || ''}`, `aci_table_available=${stb ? 'FALSE' : 'TRUE'}`, 'scale_factor=1.0', 'apply_factor=FALSE', 'custom_lineweight_display_units=0'];
  if (!stb) {
    lines.push('aci_table{');
    t.styles.forEach((s, i) => lines.push(` ${i}="Color_${i + 1}`));
    lines.push('}');
  }
  lines.push('plot_style{');
  t.styles.forEach((s, i) => {
    const color = s.color == null ? -1 : ((0xff000000 | s.color) | 0);
    const policy = (s.dither !== false ? 1 : 0) | (s.grayscale ? 2 : 0) | (s.color != null ? 4 : 0);
    const name = stb ? String(s.name || `Style ${i}`) : `Color_${i + 1}`;
    lines.push(` ${i}{`, `  name="${stb ? name.replace(/ /g, '_') : name}`, `  localized_name="${name}`, `  description="${s.description || ''}`,
      `  color=${color}`, `  color_policy=${policy}`, '  physical_pen_number=0', '  virtual_pen_number=0', `  screen=${Math.round(s.screen ?? 100)}`,
      '  linepattern_size=0.5', `  linetype=${s.linetype == null ? 31 : s.linetype}`, '  adaptive_linetype=TRUE',
      `  lineweight=${s.lineweight == null ? 0 : lwIndex(s.lineweight)}`, '  fill_style=73', '  end_style=4', '  join_style=5', ' }');
  });
  lines.push('}', 'custom_lineweight_table{', ...LINEWEIGHTS.map((v, i) => ` ${i}=${String(v).includes('.') ? String(v) : v.toFixed(1)}`), '}', '');
  const raw = fromLatin1(lines.join('\n'));
  const comp = await deflate(raw);
  const out = new Uint8Array(60 + comp.length);
  out.set(fromLatin1(stb ? HEADER_CTB.replace('CTBVER1', 'STBVER1') : HEADER_CTB), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(48, adler32(comp), true);
  dv.setUint32(52, raw.length, true);
  dv.setUint32(56, comp.length, true);
  out.set(comp, 60);
  return out;
}
