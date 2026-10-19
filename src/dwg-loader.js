// SPDX-License-Identifier: GPL-3.0-or-later
// Lecture des fichiers DWG (LibreDWG compilé en WebAssembly) et DXF (dxf-json).
import { readRaw } from './io/read.js';

const VERSIONS = {
  AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000–2002',
  AC1018: 'AutoCAD 2004–2006', AC1021: 'AutoCAD 2007–2009', AC1024: 'AutoCAD 2010–2012',
  AC1027: 'AutoCAD 2013–2017', AC1032: 'AutoCAD 2018–2025',
};

export function describeVersion(buffer, fileName) {
  const bytes = new Uint8Array(buffer);
  if (/\.dxf$/i.test(fileName)) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    const m = head.match(/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/);
    return m ? `DXF ${m[1]}${VERSIONS[m[1]] ? ` (${VERSIONS[m[1]]})` : ''}` : 'DXF';
  }
  const code = new TextDecoder('ascii').decode(bytes.subarray(0, 6));
  return VERSIONS[code] ? `${code} (${VERSIONS[code]})` : code;
}

// Lecture dans le fil principal (tests, et repli si les Web Workers ne sont pas disponibles).
export function readDrawing(buffer, fileName) {
  return readRaw(buffer, fileName);
}

// Lecture dans des Web Workers : l'interface ne se fige pas pendant le décodage, et les gros DWG
// sont convertis en parallèle par plusieurs workers (voir readDwgPart / mergeParts).
const workers = [];
let nextId = 1;
const pending = new Map();
const PARALLEL_MIN_BYTES = 1.5e6;

export function parallelism(byteLength, fileName) {
  if (/\.dxf$/i.test(fileName) || byteLength < PARALLEL_MIN_BYTES) return 1;
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, cores - 1, Math.ceil(byteLength / PARALLEL_MIN_BYTES)));
}

function getWorker(i) {
  if (workers[i]) return workers[i];
  const w = new Worker(new URL('./io/read-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du lecteur'));
    pending.clear();
    workers[i] = null;
  };
  workers[i] = w;
  return w;
}

function ask(i, msg) {
  const w = getWorker(i);
  const id = nextId++;
  const copy = msg.buffer ? msg.buffer.slice(0) : null; // le tampon est transféré au worker
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id, buffer: copy }, copy ? [copy] : []);
  });
}

// Démarre les workers de lecture et précompile LibreDWG (à appeler au repos, après le chargement).
export function prewarmReaders(count = parallelism(Infinity, 'x.dwg')) {
  if (typeof Worker === 'undefined') return Promise.resolve();
  return Promise.all(Array.from({ length: count }, (_, i) => ask(i, { warm: true }).catch(() => {})));
}

// parts : nombre de workers (par défaut selon la taille du fichier et le nombre de cœurs).
export async function readDrawingAsync(buffer, fileName, parts = parallelism(buffer.byteLength, fileName)) {
  if (typeof Worker === 'undefined') return readDrawing(buffer, fileName);
  try {
    if (parts <= 1) return await ask(0, { buffer, name: fileName });
    const { mergeParts } = await import('./io/read.js');
    const results = await Promise.all(Array.from({ length: parts }, (_, k) => ask(k, { buffer, name: fileName, part: k, parts })));
    return mergeParts(results);
  } catch (err) {
    console.warn('Lecture dans le worker impossible, lecture directe :', err);
    return readDrawing(buffer, fileName);
  }
}
