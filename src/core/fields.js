// SPDX-License-Identifier: GPL-3.0-or-later
// Champs (CHAMP / FIELD, comme AutoCAD) : textes dont une partie est calculée — nom du fichier, dates, nom de la
// présentation, échelle d'une fenêtre, valeur d'un attribut, aire ou longueur d'un objet — et mise à jour à
// l'ouverture, à l'enregistrement, au tracé, sur demande (MAJCHAMP) et quand l'objet référencé change.
//
// Un texte (TEXT, MTEXT, attribut) porte `field = { code, refs }` ; `text` garde la dernière valeur calculée.
// code : syntaxe d'AutoCAD, p. ex. « Plan %<\AcVar Filename \f "%fn2">% » ou
// « %<\AcObjProp Object(%<\_ObjIdx 0>%).TextString>% » ; refs[k] = { id } (objet) ou { id, tag } (attribut
// d'une insertion).
import * as G from './geom.js';
import { plainText } from '../text.js';
import { fixText } from './layerstates.js';

// --- analyse ---------------------------------------------------------------------------------------

// Fin du champ commençant à `i` (« %< » … « >% », champs imbriqués compris), ou -1.
function fieldEnd(code, i) {
  let depth = 0;
  for (let j = i; j < code.length - 1;) {
    if (code[j] === '%' && code[j + 1] === '<') { depth++; j += 2; continue; }
    if (code[j] === '>' && code[j + 1] === '%') { depth--; j += 2; if (depth === 0) return j; continue; }
    j++;
  }
  return -1;
}

// Expression d'un champ (sans « %< >% ») → { kind, name, prop, idx, format }.
export function parseExpr(raw) {
  const fmt = /\\f\s+"([^"]*)"/.exec(raw)?.[1] ?? '';
  let m = /^\\AcVar(?:\.[\d.]+)?\s+([^\s\\]+)/.exec(raw);
  if (m) return { kind: 'var', name: m[1], format: fmt, raw };
  m = /^\\AcObjProp(?:\.[\d.]+)?\s+Object\(%<\\_ObjIdx\s+(\d+)>%\)\.([\w.]+)/.exec(raw);
  if (m) return { kind: 'prop', idx: +m[1], prop: m[2], format: fmt, raw };
  return { kind: 'other', format: fmt, raw };
}

// Code → morceaux [{ text } | { expr }].
export function parseCode(code) {
  const out = [];
  let pos = 0;
  while (pos < code.length) {
    const i = code.indexOf('%<', pos);
    if (i < 0) { out.push({ text: code.slice(pos) }); break; }
    const end = fieldEnd(code, i);
    if (end < 0) { out.push({ text: code.slice(pos) }); break; }
    if (i > pos) out.push({ text: code.slice(pos, i) });
    out.push({ expr: parseExpr(code.slice(i + 2, end - 2)) });
    pos = end;
  }
  return out;
}

// --- formats --------------------------------------------------------------------------------------

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const pad = (n, k = 2) => String(n).padStart(k, '0');

// Date au format Windows d'AutoCAD (« dd.MM.yyyy », « d MMMM yyyy », « HH:mm »…), noms français.
export function formatDate(d, fmt) {
  if (!(d instanceof Date) || Number.isNaN(+d)) return '####';
  const f = fmt || 'dd.MM.yyyy';
  return f.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|'[^']*'/g, (t) => {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'yy': return pad(d.getFullYear() % 100);
      case 'MMMM': return MONTHS[d.getMonth()];
      case 'MMM': return `${MONTHS[d.getMonth()].slice(0, 4).replace(/\.$/, '')}.`;
      case 'MM': return pad(d.getMonth() + 1);
      case 'M': return String(d.getMonth() + 1);
      case 'dddd': return DAYS[d.getDay()];
      case 'ddd': return `${DAYS[d.getDay()].slice(0, 3)}.`;
      case 'dd': return pad(d.getDate());
      case 'd': return String(d.getDate());
      case 'HH': return pad(d.getHours());
      case 'H': return String(d.getHours());
      case 'hh': return pad(((d.getHours() + 11) % 12) + 1);
      case 'h': return String(((d.getHours() + 11) % 12) + 1);
      case 'mm': return pad(d.getMinutes());
      case 'm': return String(d.getMinutes());
      case 'ss': return pad(d.getSeconds());
      case 's': return String(d.getSeconds());
      case 'tt': return d.getHours() < 12 ? 'AM' : 'PM';
      default: return t.slice(1, -1);
    }
  });
}

// Nom de fichier : %fn1 dossier, %fn2 nom sans extension, %fn3 chemin sans extension, %fn4 extension, %fn6 nom
// avec extension, %fn7 (ou rien) chemin complet ; %tc1 majuscules, %tc2 minuscules.
export function formatFileName(path, fmt) {
  const full = path || '';
  const slash = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  const dir = slash >= 0 ? full.slice(0, slash) : '';
  const name = full.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const k = /%fn(\d)/.exec(fmt || '')?.[1];
  let s = { 1: dir, 2: stem, 3: dir ? `${dir}\\${stem}` : stem, 4: ext, 6: name, 7: full }[k] ?? full;
  if (/%tc1/.test(fmt || '')) s = s.toUpperCase();
  else if (/%tc2/.test(fmt || '')) s = s.toLowerCase();
  return s;
}

// Nombre, comme AutoCAD : %lu2 décimal, %prN décimales (6 sans précision), %ct1 inverse, %ct8[k] facteur de
// conversion, %ps[avant,après] préfixe / suffixe, %ds44 virgule décimale. Échelle « 1:N » : %ps[1:,]%lu2%ct1%pr0.
export function formatNumber(v, fmt) {
  if (!Number.isFinite(v)) return '####';
  const f = fmt || '';
  let x = v;
  if (/%ct1(?![0-9])/.test(f)) x = x !== 0 ? 1 / x : x;
  const conv = /%ct8\[([^\]]+)\]/.exec(f);
  if (conv) x *= parseFloat(conv[1]);
  const ps = /%ps\[([^,\]]*),([^\]]*)\]/.exec(f);
  const pr = /%pr(\d+)/.exec(f);
  let s = x.toFixed(pr ? +pr[1] : 6);
  if (/%ds44/.test(f)) s = s.replace('.', ',');
  return `${ps ? ps[1] : ''}${s}${ps ? ps[2] : ''}`;
}

// --- évaluation -----------------------------------------------------------------------------------

// Somme de contrôle du texte d'un champ (ACFD_FIELDTEXT_CHECKSUM d'AutoCAD) : Σ rang × code du caractère.
export function checksum(text) {
  let s = 0;
  for (let i = 0; i < text.length; i++) s += (i + 1) * text.charCodeAt(i);
  return s;
}

// Aire et longueur d'un objet (polyligne, cercle, hachure, ligne, arc).
function areaOf(e) {
  if (e.type === 'CIRCLE') return Math.PI * e.r * e.r;
  const loopArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  if (e.type === 'LWPOLYLINE' && e.closed) {
    let a = loopArea(e.pts);
    // Segments en arc : segment circulaire ajouté (signé par le renflement).
    e.pts.forEach((p, i) => {
      const b = e.bulges?.[i] || 0;
      if (!b) return;
      const q = e.pts[(i + 1) % e.pts.length], c = G.dist(p, q), th = 4 * Math.atan(b), r = c / (2 * Math.sin(th / 2));
      a += (r * r * (th - Math.sin(th))) / 2;
    });
    return Math.abs(a);
  }
  if (e.type === 'HATCH') {
    const loops = (e.loops || []).map((l) => loopArea(l));
    const outer = loops.reduce((m, a) => (Math.abs(a) > Math.abs(m) ? a : m), 0);
    return Math.abs(outer) - loops.filter((a) => a !== outer).reduce((s, a) => s + Math.abs(a), 0);
  }
  return NaN;
}
function lengthOf(e) {
  if (e.type === 'LINE') return G.dist(e.p1, e.p2);
  if (e.type === 'ARC') return e.r * G.sweep(e.a0, e.a1);
  if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
  if (e.type === 'LWPOLYLINE') {
    let L = 0;
    const n = e.closed ? e.pts.length : e.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = e.pts[i], q = e.pts[(i + 1) % e.pts.length], c = G.dist(p, q), b = e.bulges?.[i] || 0;
      L += b ? (c * 2 * Math.atan(Math.abs(b)) * (1 + b * b)) / (2 * Math.abs(b)) : c;
    }
    return L;
  }
  return NaN;
}

const spaceLabel = (doc, id) => (!id || id === 'model' ? 'Model' : doc.spaces?.find((s) => s.id === id)?.label || id);

// Valeur d'une expression pour le texte `e` (ctx : { fileName, saveDate, plotDate, now }).
export function evaluateExpr(doc, e, expr, ctx = {}) {
  if (expr.kind === 'var') {
    const n = expr.name.toLowerCase();
    if (n === 'filename') return formatFileName(ctx.fileName ?? doc.fileName ?? '', expr.format);
    if (n === 'date') return formatDate(ctx.now || new Date(), expr.format);
    if (n === 'savedate') return formatDate(ctx.saveDate || (doc.header?.saveDate ? new Date(doc.header.saveDate) : null), expr.format);
    if (n === 'plotdate') return formatDate(ctx.plotDate || (doc.header?.plotDate ? new Date(doc.header.plotDate) : null), expr.format);
    if (n === 'createdate') return formatDate(doc.header?.createDate ? new Date(doc.header.createDate) : null, expr.format);
    if (n === 'ctab') return spaceLabel(doc, e.space);
    const prop = doc.header?.props?.[expr.name]; // propriétés du dessin (auteur, titre…)
    return prop != null ? String(prop) : '####';
  }
  if (expr.kind === 'prop') {
    const ref = e.field?.refs?.[expr.idx];
    const target = ref && doc.get(ref.id);
    if (!target) return '####';
    const p = expr.prop.toLowerCase();
    if (ref.tag != null) {
      const a = (target.attribs || []).find((x) => String(x.tag).toUpperCase() === String(ref.tag).toUpperCase());
      return a ? plainText(String(a.text ?? '')) : '####';
    }
    if (p === 'textstring') return plainText(String(target.text ?? ''));
    if (p === 'customscale' || p === 'standardscale') {
      if (target.type !== 'VIEWPORT' || !(target.vh > 0)) return '####';
      return formatNumber(target.h / target.vh, expr.format || '%ps[1:,]%lu2%ct1%pr0');
    }
    if (p === 'area') return formatNumber(areaOf(target), expr.format || '%lu2%pr2');
    if (p === 'length') return formatNumber(lengthOf(target), expr.format || '%lu2%pr2');
    if (p === 'layer') return target.layer || '0';
    return '####';
  }
  return '####';
}

export function evaluateField(doc, e, ctx = {}) {
  if (!e.field?.code) return e.text ?? '';
  return parseCode(e.field.code).map((p) => (p.text != null ? p.text : evaluateExpr(doc, e, p.expr, ctx))).join('');
}

// Objets portant des champs : textes et insertions dont un attribut en a un.
export const hasField = (e) => !!e?.field?.code || !!e?.attribs?.some((a) => a.field?.code);

// Recalcule les champs (tous, ou ceux des ids donnés) ; quiet : sans historique (ouverture, enregistrement,
// tracé), sinon dans la transaction courante. → nombre de textes changés.
export function updateFields(doc, ctx = {}, { ids = null, quiet = false } = {}) {
  let n = 0;
  const list = ids ? ids.map((id) => doc.get(id)).filter(Boolean) : [...doc.entities.values()];
  for (const e of list) {
    if (!hasField(e)) continue;
    let next = null;
    if (e.field?.code) {
      const t = evaluateField(doc, e, ctx);
      if (t !== e.text) next = { ...e, text: t };
    }
    if (e.attribs?.some((a) => a.field?.code)) {
      let changed = false;
      const attribs = e.attribs.map((a) => {
        if (!a.field?.code) return a;
        const t = evaluateField(doc, { ...a, space: e.space }, ctx);
        if (t === a.text) return a;
        changed = true;
        return { ...a, text: t };
      });
      if (changed) next = { ...(next || e), attribs };
    }
    if (!next) continue;
    if (quiet) doc.updateQuiet(next); else doc.update(next);
    n++;
  }
  return n;
}

// Champs dépendants : quand un objet référencé change (attribut, fenêtre, polyligne…), les textes qui le citent
// sont recalculés dans la même étape d'annulation.
export function installFieldHooks(doc) {
  if (doc.fieldHook) return;
  doc.fieldHook = (change) => {
    const touched = new Set([...change.modified, ...change.added, ...change.removed]);
    if (!touched.size) return;
    const deps = [];
    for (const e of doc.entities.values()) {
      const refs = [...(e.field?.refs || []), ...(e.attribs || []).flatMap((a) => a.field?.refs || [])];
      if (refs.some((r) => touched.has(r.id)) && !touched.has(e.id)) deps.push(e.id);
    }
    if (deps.length) updateFields(doc, {}, { ids: deps });
  };
  doc.commitHooks.push(doc.fieldHook);
}

// --- catalogue (boîte CHAMP) ----------------------------------------------------------------------

export const FIELD_KINDS = [
  { key: 'filename', label: 'Nom du fichier', formats: [['%fn2', 'Nom sans extension'], ['%fn6', 'Nom avec extension'], ['%tc1%fn2', 'NOM EN MAJUSCULES'], ['', 'Chemin complet']], code: (f) => `\\AcVar Filename${f ? ` \\f "${f}"` : ''}` },
  { key: 'date', label: 'Date du jour', formats: DATE_FORMATS(), code: (f) => `\\AcVar Date \\f "${f}"` },
  { key: 'savedate', label: 'Date d’enregistrement', formats: DATE_FORMATS(), code: (f) => `\\AcVar SaveDate \\f "${f}"` },
  { key: 'plotdate', label: 'Date de tracé', formats: DATE_FORMATS(), code: (f) => `\\AcVar PlotDate \\f "${f}"` },
  { key: 'ctab', label: 'Nom de la présentation', formats: [['', 'Tel quel']], code: () => '\\AcVar ctab' },
  { key: 'scale', label: 'Échelle d’une fenêtre', pick: 'VIEWPORT', formats: [['%ps[1:,]%lu2%ct1%pr0', '1:N'], ['%lu2%pr4', 'Facteur (0.01)']], code: (f) => `\\AcObjProp Object(%<\\_ObjIdx 0>%).CustomScale \\f "${f}"` },
  { key: 'attrib', label: 'Attribut d’un bloc', pick: 'ATTRIB', formats: [['', 'Tel quel']], code: () => '\\AcObjProp Object(%<\\_ObjIdx 0>%).TextString' },
  { key: 'text', label: 'Contenu d’un texte', pick: 'TEXT', formats: [['', 'Tel quel']], code: () => '\\AcObjProp Object(%<\\_ObjIdx 0>%).TextString' },
  { key: 'area', label: 'Aire d’un objet', pick: 'AREA', formats: [['%lu2%pr2%ct8[1e-06]%ps[, m²]', 'm² (dessin en mm)'], ['%lu2%pr2%ps[, m²]', 'm² (dessin en m)'], ['%lu2%pr2', 'Unités du dessin']], code: (f) => `\\AcObjProp Object(%<\\_ObjIdx 0>%).Area \\f "${f}"` },
  { key: 'length', label: 'Longueur d’un objet', pick: 'LENGTH', formats: [['%lu2%pr2%ct8[0.001]%ps[, m]', 'm (dessin en mm)'], ['%lu2%pr2', 'Unités du dessin']], code: (f) => `\\AcObjProp Object(%<\\_ObjIdx 0>%).Length \\f "${f}"` },
];
function DATE_FORMATS() {
  return [['dd.MM.yyyy', '16.10.2026'], ['d MMMM yyyy', '16 octobre 2026'], ['dd/MM/yyyy', '16/10/2026'], ['yyyy-MM-dd', '2026-10-16'], ['dd.MM.yyyy HH:mm', '16.10.2026 14:30']];
}

// Code complet d'un champ (« %<…>% ») d'un type et d'un format.
export const fieldCode = (kind, format) => `%<${FIELD_KINDS.find((k) => k.key === kind).code(format)}>%`;

// --- fichiers ---------------------------------------------------------------------------------------

// Dates du dessin ($TDCREATE, $TDUPDATE) : jour julien en heure locale ↔ Date.
export function julianToDate(jd) {
  if (!Number.isFinite(jd) || jd <= 0) return null;
  const ms = (jd - 2440587.5) * 86400000;
  return new Date(ms + new Date(ms).getTimezoneOffset() * 60000);
}
export const dateToJulian = (d) => (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 2440587.5;

// Champs d'un texte lus dans un fichier : dictionnaire étendu → ACAD_FIELD → TEXT → champ racine (_text) et ses
// enfants. dicts : poignée → [[nom, poignée]…] ; fields : poignée → { id, code, childs, objs }.
// → { code (syntaxe de l'appli, objets numérotés globalement), objs (poignées des objets cités) } ou null.
export function resolveFieldInfo(xdict, dicts, fields) {
  const H = (h) => String(h ?? '').toUpperCase();
  const find = (dh, name) => dicts.get(H(dh))?.find(([n]) => n === name)?.[1];
  const fd = find(xdict, 'ACAD_FIELD');
  const rootH = fd && find(fd, 'TEXT');
  const root = rootH && fields.get(H(rootH));
  if (!root?.code) return null;
  const objs = [];
  const childCode = (h) => {
    const f = fields.get(H(h));
    if (!f) return '';
    const base = objs.length;
    objs.push(...(f.objs || []).map(H));
    const code = f.code.replace(/%<\\_ObjIdx\s+(\d+)>%/g, (_, i) => `%<\\_ObjIdx ${base + +i}>%`);
    // Champ composé (enfants imbriqués) : ses propres %<\_FldIdx>% remplacés aussi.
    return (f.childs || []).reduce((s, ch, k) => s.replace(`%<\\_FldIdx ${k}>%`, `%<${childCode(ch)}>%`), code);
  };
  let code = root.code;
  (root.childs || []).forEach((ch, k) => { code = code.split(`%<\\_FldIdx ${k}>%`).join(`%<${childCode(ch)}>%`); });
  if (!/%</.test(code)) return null;
  return { code, objs };
}

// Champs d'un DXF (texte brut) : poignée du texte → { code, objs }.
export function scanFields(text) {
  if (!text || !text.includes('AcDbField')) return new Map();
  const lines = text.split(/\r?\n/);
  const xdicts = new Map(), dicts = new Map(), fields = new Map();
  let type = null, cur = null;
  const TEXTS = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF']);
  const close = () => {
    if (!cur?.handle) return;
    if (TEXTS.has(type)) { if (cur.xdict) xdicts.set(cur.handle, cur.xdict); } else if (type === 'DICTIONARY') dicts.set(cur.handle, cur.entries);
    else if (type === 'FIELD') fields.set(cur.handle, cur);
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const v = lines[i + 1].replace(/\r$/, '');
    if (code === 0) {
      close();
      type = v.trim();
      cur = TEXTS.has(type) ? { handle: null, xdict: null, inX: false } : type === 'DICTIONARY' ? { handle: null, entries: [], name: null } : type === 'FIELD' ? { handle: null, id: '', code: '', childs: [], objs: [], body: false, n: 0 } : null;
      continue;
    }
    if (!cur) continue;
    const t = v.trim();
    if (code === 5 && !cur.handle) { cur.handle = t.toUpperCase(); continue; }
    if (TEXTS.has(type)) {
      if (code === 102) cur.inX = t === '{ACAD_XDICTIONARY';
      else if (code === 360 && cur.inX) cur.xdict = t.toUpperCase();
    } else if (type === 'DICTIONARY') {
      if (code === 3) cur.name = v;
      else if ((code === 350 || code === 360) && cur.name != null) { cur.entries.push([cur.name, t.toUpperCase()]); cur.name = null; }
    } else if (type === 'FIELD') {
      if (code === 100 && t === 'AcDbField') cur.body = true;
      else if (!cur.body) continue;
      else if (code === 1 && !cur.id && !cur.code) cur.id = v;
      else if (code === 2 && !cur.code) cur.code = fixText(v); // texte lu en latin1 : UTF-8 rétabli
      else if (code === 3 && cur.code && !cur.closed) cur.code += fixText(v); // code long (suite)
      else if (code === 90 && cur.n === 0) { cur.n = 1; cur.nChilds = parseInt(t, 10); }
      else if (code === 360 && cur.childs.length < (cur.nChilds || 0)) cur.childs.push(t.toUpperCase());
      else if (code === 331) cur.objs.push(t.toUpperCase());
      else if (code === 91) cur.closed = true;
    }
  }
  close();
  const out = new Map();
  for (const [h, xd] of xdicts) {
    const info = resolveFieldInfo(xd, dicts, fields);
    if (info) out.set(h, info);
  }
  return out;
}
