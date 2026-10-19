// SPDX-License-Identifier: GPL-3.0-or-later
// Fichiers des fonds (PDF, images) chargés en mémoire, partagés par toutes les références au même fichier.
//
// Une source : { key, path, name, kind, status: 'loading' | 'ok' | 'missing' | 'error', error, pdf (document pdf.js),
//                pages: Map(n → { page, size:[wMm,hMm] }), bitmap (image décodée), width, height, dpi, ocg: [{ id, name }] }
// L'appli fournit le chargeur (setSourceLoader) : chemin → octets (serveur local, fichier choisi, voisin du dessin…).
import { openPdf } from './pdfjs.js';
import { kindOfPath, fileName } from './underlay.js';

const sources = new Map();
const listeners = new Set();
let loader = null;

export const sourceKey = (path) => String(path || '').replace(/\//g, '\\').toLowerCase();

export function setSourceLoader(fn) { loader = fn; }

// Abonnement aux changements d'état des sources (chargement terminé, introuvable…).
export function onSourceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(src) {
  for (const fn of listeners) {
    try { fn(src); } catch (err) { console.warn(err); }
  }
}

export function getSource(path) {
  return sources.get(sourceKey(path)) || null;
}

export function allSources() {
  return [...sources.values()];
}

// Source d'un chemin, chargée si besoin (une seule fois ; une source introuvable n'est redemandée qu'avec reload).
export function ensureSource(path) {
  const key = sourceKey(path);
  let src = sources.get(key);
  if (src) return src.ready;
  src = { key, path, name: fileName(path), kind: kindOfPath(path), status: 'loading', pages: new Map() };
  sources.set(key, src);
  src.ready = (async () => {
    try {
      const bytes = loader ? await loader(path) : null;
      if (!bytes) { src.status = 'missing'; notify(src); return src; }
      await decode(src, bytes);
    } catch (err) {
      src.status = 'error';
      src.error = err.message || String(err);
    }
    notify(src);
    return src;
  })();
  return src.ready;
}

// Fichier fourni par l'utilisateur (choisi sur le disque) : remplace la source de ce chemin.
export async function addSource(path, bytes) {
  const key = sourceKey(path);
  const old = sources.get(key);
  if (old?.pdf) old.pdf.destroy?.();
  const src = { key, path, name: fileName(path), kind: kindOfPath(path), status: 'loading', pages: new Map() };
  sources.set(key, src);
  src.ready = (async () => {
    try { await decode(src, bytes); } catch (err) { src.status = 'error'; src.error = err.message || String(err); }
    notify(src);
    return src;
  })();
  return src.ready;
}

// Relecture d'une source (fichier modifié, retrouvé…).
export function reloadSource(path) {
  const key = sourceKey(path);
  const old = sources.get(key);
  if (old?.pdf) old.pdf.destroy?.();
  sources.delete(key);
  return ensureSource(path);
}

// Sources introuvables ou illisibles oubliées : redemandées à la prochaine occasion (autre dessin, autre dossier).
export function retryMissingSources() {
  for (const [k, s] of sources) if (s.status === 'missing' || s.status === 'error') sources.delete(k);
}

export function forgetSources() {
  for (const s of sources.values()) s.pdf?.destroy?.();
  sources.clear();
}

async function decode(src, bytes) {
  if (!src.kind) throw new Error(`Type de fichier non pris en charge : ${src.name}`);
  if (src.kind === 'pdf') {
    src.pdf = await openPdf(bytes);
    src.pageCount = src.pdf.numPages;
    try {
      const cfg = await src.pdf.getOptionalContentConfig();
      const groups = cfg.getGroups?.() || {};
      src.ocg = Object.entries(groups).map(([id, g]) => ({ id, name: g.name || id }));
      src.ocgOrder = cfg.getOrder?.() || null;
    } catch { src.ocg = []; }
  } else {
    const u8 = new Uint8Array(bytes);
    src.bitmap = await createImageBitmap(new Blob([u8]));
    src.width = src.bitmap.width;
    src.height = src.bitmap.height;
    src.dpi = imageDpi(u8);
  }
  src.status = 'ok';
}

// Page d'un PDF (mise en cache) : { page, size: [largeur, hauteur] en mm de papier, rotation comprise }.
export async function pdfPage(src, n = 1) {
  let p = src.pages.get(n);
  if (!p) {
    const page = await src.pdf.getPage(Math.min(Math.max(1, n), src.pageCount || 1));
    const vp = page.getViewport({ scale: 1 });
    p = { page, size: [(vp.width * 25.4) / 72, (vp.height * 25.4) / 72] };
    src.pages.set(n, p);
  }
  return p;
}

// Taille propre d'une source : PDF → mm de la page ; image → pixels.
export async function nativeSize(src, page = 1) {
  if (src.kind === 'pdf') return (await pdfPage(src, page)).size;
  return [src.width, src.height];
}

// Résolution d'une image (points par pouce) si le fichier l'indique : PNG (pHYs), JPEG (JFIF).
export function imageDpi(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50) {
    for (let i = 8; i + 8 < u8.length;) {
      const len = (u8[i] << 24 | u8[i + 1] << 16 | u8[i + 2] << 8 | u8[i + 3]) >>> 0;
      const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (type === 'pHYs' && u8[i + 16] === 1) {
        const ppm = (u8[i + 8] << 24 | u8[i + 9] << 16 | u8[i + 10] << 8 | u8[i + 11]) >>> 0;
        return ppm > 0 ? ppm * 0.0254 : null;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + len;
    }
    return null;
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    for (let i = 2; i + 16 < u8.length && u8[i] === 0xff;) {
      const marker = u8[i + 1], len = (u8[i + 2] << 8) | u8[i + 3];
      if (marker === 0xe0 && u8[i + 4] === 0x4a && u8[i + 5] === 0x46) { // JFIF
        const units = u8[i + 11], x = (u8[i + 12] << 8) | u8[i + 13];
        return units === 1 ? x : units === 2 ? x * 2.54 : null;
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  return null;
}
