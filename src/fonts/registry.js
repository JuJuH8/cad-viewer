// SPDX-License-Identifier: GPL-3.0-or-later
// Polices des styles de texte : les polices SHX sont lues par le serveur de l'appli là où elles sont (dossier Fonts
// d'AutoCAD, dossiers de support, dossier choisi), une seule fois, puis le dessin est redessiné. Une police absente
// ou TrueType garde l'affichage en police de l'appli.
import { parseShx } from './shx.js';

const fonts = new Map(); // nom → { status: 'loading' | 'ok' | 'missing', font }
const listeners = new Set();
let folder = null;
let fetcher = null;

export const fontKey = (name) => String(name || '').split(/[\\/]/).pop().toLowerCase().replace(/\.shx$/, '');

// Police SHX ? (« romans », « romans.shx » ; pas « arial.ttf », ni un nom vide)
export function isShx(name) {
  const n = String(name || '').trim().toLowerCase();
  return !!n && (n.endsWith('.shx') || !/\.[a-z0-9]{2,4}$/.test(n));
}

export function onFontLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Dossier de polices supplémentaire (préférences) ; les polices introuvables sont redemandées.
export function setFontFolder(path) {
  folder = path || null;
  for (const [k, f] of fonts) if (f.status !== 'ok') fonts.delete(k);
}

// Lecture des octets d'une police (tests : autre source).
export function setFontFetcher(fn) { fetcher = fn; }

async function fetchFont(key) {
  if (fetcher) return fetcher(key);
  const q = `nom=${encodeURIComponent(`${key}.shx`)}${folder ? `&dossier=${encodeURIComponent(folder)}` : ''}`;
  const r = await fetch(`/__police?${q}`).catch(() => null);
  return r?.ok ? r.arrayBuffer() : null;
}

// Police SHX prête, ou null (chargement lancé en arrière-plan ; les abonnés sont prévenus à la fin).
export function shxFont(name) {
  if (!isShx(name)) return null;
  const key = fontKey(name);
  let f = fonts.get(key);
  if (!f) {
    f = { status: 'loading', font: null };
    fonts.set(key, f);
    f.ready = fetchFont(key).then((bytes) => {
      if (!bytes) { f.status = 'missing'; return f; }
      try { f.font = parseShx(bytes); f.status = 'ok'; } catch (err) { f.status = 'missing'; f.error = err.message; }
      for (const fn of listeners) { try { fn(key, f); } catch (err) { console.warn(err); } }
      return f;
    }).catch(() => { f.status = 'missing'; return f; });
  }
  return f.status === 'ok' ? f.font : null;
}

// Attendre une police (tests, tracé) : la police ou null.
export async function loadShx(name) {
  if (!isShx(name)) return null;
  shxFont(name);
  const f = fonts.get(fontKey(name));
  await f.ready;
  return f.status === 'ok' ? f.font : null;
}

export function fontStatus(name) {
  return fonts.get(fontKey(name))?.status || null;
}

// Police d'un objet texte : celle de son style (doc.styles), si c'est une police SHX disponible.
export function fontOfText(doc, e) {
  const st = doc?.styles?.get(String(e.style || 'Standard').toUpperCase());
  return st && isShx(st.font) ? shxFont(st.font) : null;
}

// Style d'un objet texte (ou null).
export function styleOfText(doc, e) {
  return doc?.styles?.get(String(e.style || 'Standard').toUpperCase()) || null;
}
