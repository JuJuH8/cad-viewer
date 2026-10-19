// SPDX-License-Identifier: GPL-3.0-or-later
// Sauvegarde automatique du dessin dans le navigateur (IndexedDB), pour ne jamais perdre son travail
// si l'onglet est fermé ou si le navigateur plante. Une seule sauvegarde est conservée.
import { Document } from '../core/document.js';

const DB = 'cadviewer';
const STORE = 'autosave';
const KEY = 'current';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export function serialize(doc) {
  return {
    v: 1,
    layers: [...doc.layers.values()],
    blocks: [...doc.blocks.values()].filter((b) => !b.name.startsWith('*DIMPREVIEW')),
    entities: [...doc.entities.values()],
    spaces: doc.spaces,
    header: doc.header,
    ltypes: doc.ltypes ? [...doc.ltypes.values()] : [],
    styles: doc.styles ? [...doc.styles.values()] : [],
    layerStates: doc.layerStates ? [...doc.layerStates.values()] : [],
    ucsTable: doc.ucsTable ? [...doc.ucsTable.values()] : [],
    currentLayer: doc.currentLayer,
    nextId: doc.nextId,
  };
}

export function deserialize(data) {
  const doc = new Document();
  doc.layers = new Map(data.layers.map((l) => [l.name, l]));
  doc.blocks = new Map(data.blocks.map((b) => [b.name, b]));
  doc.spaces = data.spaces?.length ? data.spaces : doc.spaces;
  doc.header = data.header || doc.header;
  doc.ltypes = new Map((data.ltypes || []).map((t) => [t.name.toUpperCase(), t]));
  if (data.styles?.length) doc.styles = new Map(data.styles.map((t) => [t.name.toUpperCase(), t]));
  if (data.layerStates?.length) doc.layerStates = new Map(data.layerStates.map((t) => [t.name.toUpperCase(), t]));
  if (data.ucsTable?.length) doc.ucsTable = new Map(data.ucsTable.map((t) => [t.name.toUpperCase(), t]));
  doc.currentLayer = doc.layers.has(data.currentLayer) ? data.currentLayer : '0';
  // Boucle (et non Math.max(...)) : au-delà d'environ 120 000 objets, l'étalement d'arguments déborde la pile.
  let next = Math.max(data.nextId || 1, 1);
  for (const e of data.entities) {
    doc.entities.set(e.id, e);
    if (e.id + 1 > next) next = e.id + 1;
  }
  doc.nextId = next;
  return doc;
}

export async function saveAutosave(doc, name) {
  const record = { name, date: Date.now(), count: doc.entities.size, data: serialize(doc) };
  await tx('readwrite', (s) => s.put(record, KEY));
  return record;
}

export async function loadAutosave() {
  try {
    return (await tx('readonly', (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

export async function clearAutosave() {
  try { await tx('readwrite', (s) => s.delete(KEY)); } catch { /* stockage indisponible */ }
}
