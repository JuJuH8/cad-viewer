// SPDX-License-Identifier: GPL-3.0-or-later
// Sources des fonds de plan : un fichier choisi sur le disque (poignée conservée par le navigateur, quand il
// le permet) ou un chemin local lu par le serveur de l'appli (serve.py, route /__fichier). Les deux
// permettent de recharger la base et de savoir si une nouvelle version a été enregistrée.

const DB = 'cadviewer-fonds';
const STORE = 'poignees';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const hasFilePicker = () => typeof window.showOpenFilePicker === 'function';

// Choix d'un fichier par l'utilisateur ; renvoie { file, handle? } ou null (annulé).
export async function pickDrawing() {
  if (hasFilePicker()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'fonds-de-plan',
        types: [{ description: 'Dessins (DWG, DXF, IFC)', accept: { 'application/octet-stream': ['.dwg', '.dxf', '.ifc'] } }],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dwg,.dxf,.ifc';
    input.onchange = () => resolve(input.files[0] ? { file: input.files[0] } : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Poignée de fichier conservée sous une clé (pour recharger après une fermeture de l'appli).
export async function storeHandle(key, handle) {
  await idb('readwrite', (s) => s.put(handle, key));
}

async function loadHandle(key) {
  try { return await idb('readonly', (s) => s.get(key)); } catch { return null; }
}

function serverUrl(route, path) {
  return `${route}?chemin=${encodeURIComponent(path)}`;
}

// Informations sur la source (sans demander d'autorisation) : { mtime, name } ou null si inaccessible.
export async function sourceInfo(source) {
  if (!source) return null;
  if (source.kind === 'path') {
    const r = await fetch(serverUrl('__fichier/info', source.path)).catch(() => null);
    if (!r?.ok) return null;
    const info = await r.json();
    return info.exists ? { mtime: info.mtime, name: info.name, size: info.size } : null;
  }
  if (source.kind === 'handle') {
    const h = await loadHandle(source.key);
    if (!h || (await h.queryPermission?.({ mode: 'read' })) !== 'granted') return null;
    const f = await h.getFile().catch(() => null);
    return f ? { mtime: f.lastModified, name: f.name, size: f.size } : null;
  }
  return null;
}

// Lit la source ; renvoie { buffer, name, mtime }. Une poignée peut demander l'autorisation (clic requis).
export async function readSource(source) {
  if (source?.kind === 'path') {
    const r = await fetch(serverUrl('__fichier', source.path));
    if (r.status === 404 && !(await r.clone().text()).startsWith('Fichier introuvable')) {
      throw new Error('le serveur de l’appli ne sait pas lire les fichiers locaux : relancez « Lancer CAD Viewer.bat »');
    }
    if (!r.ok) throw new Error(await r.text());
    const info = await sourceInfo(source);
    return { buffer: await r.arrayBuffer(), name: source.path.split(/[\\/]/).pop(), mtime: info?.mtime ?? Date.now() };
  }
  if (source?.kind === 'handle') {
    const h = await loadHandle(source.key);
    if (!h) throw new Error('fichier d’origine oublié par le navigateur : utilisez « Remplacer… »');
    if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') {
      throw new Error('lecture du fichier refusée');
    }
    const f = await h.getFile();
    return { buffer: await f.arrayBuffer(), name: f.name, mtime: f.lastModified };
  }
  throw new Error('aucune source connue pour ce fond : utilisez « Remplacer… »');
}

// Le serveur sait-il lire des fichiers locaux (route /__fichier) ?
export async function serverCanReadFiles() {
  const r = await fetch(serverUrl('__fichier/info', 'C:\\__test__.dwg')).catch(() => null);
  return !!r && r.ok;
}
