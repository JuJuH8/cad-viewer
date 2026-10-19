// SPDX-License-Identifier: GPL-3.0-or-later
// Découpe des blocs et références (XCLIP / DECOUPXREF) dans les fichiers : objet SPATIAL_FILTER rangé dans le
// dictionnaire d'extension de l'insertion (ACAD_FILTER → SPATIAL), comme AutoCAD. Contour en coordonnées du monde
// avec la matrice inverse de l'insertion ; découpe inversée : contour « en trou de serrure » autour de l'emprise du
// bloc, plus le contour d'origine dans un enregistrement d'aller-retour (ACAD_XREC_ROUNDTRIP).
//
// Dans l'appli : insertion.clip = { pts: [[x, y]…] (coordonnées du bloc), invert, off }.
import * as G from '../core/geom.js';
import { insertMatrix } from '../core/entities.js';

const key = (h) => String(h ?? '').toUpperCase();
const entriesOf = (d) => {
  const e = d?.entries || d?.items || [];
  return Array.isArray(e) ? e.map((x) => [x.name, x.objectHardId ?? x.objectSoftId ?? x.objectId ?? x.handle]) : Object.entries(e);
};

// Index des objets utiles du fichier (dictionnaires, filtres, enregistrements).
export function clipContext(db) {
  const dicts = new Map(), byOwner = new Map(), filters = new Map(), xrecs = new Map();
  for (const d of db.objects?.DICTIONARY || []) {
    dicts.set(key(d.handle), d);
    const owner = key(d.ownerObjectId ?? d.ownerHandle);
    if (owner) { if (!byOwner.has(owner)) byOwner.set(owner, []); byOwner.get(owner).push(d); }
  }
  for (const f of db.objects?.SPATIAL_FILTER || []) filters.set(key(f.handle), f);
  for (const x of db.objects?.XRECORD || []) xrecs.set(key(x.handle), x);
  return { dicts, byOwner, filters, xrecs };
}

const entry = (d, name) => entriesOf(d).find(([n]) => n === name)?.[1];

// Points d'un enregistrement après un marqueur 102 (DXF : codes 10 / 20 / 30 séparés ; DWG : points).
function xrecPoints(xr, marker) {
  const data = xr?.data || xr?.items || [];
  const out = [];
  let on = false;
  for (let i = 0; i < data.length; i++) {
    const g = data[i], code = g.code ?? g.type;
    if (code === 102) { on = g.value === marker; continue; }
    if (!on || code !== 10) continue;
    if (typeof g.value === 'object') out.push([g.value.x, g.value.y]);
    else out.push([g.value, (data[i + 1]?.code === 20 ? data[i + 1].value : 0)]);
  }
  return out;
}

// Découpe d'une insertion lue (ou null).
export function readInsertClip(raw, ctx) {
  if (!ctx) return null;
  const xd = raw.extensions?.ACAD_XDICTIONARY?.[0]?.value ?? raw.ownerDictionaryHardId;
  const d0 = xd && ctx.dicts.get(key(xd));
  const d1 = d0 && ctx.dicts.get(key(entry(d0, 'ACAD_FILTER')));
  const f = d1 && ctx.filters.get(key(entry(d1, 'SPATIAL')));
  if (!f?.vertices?.length) return null;
  const inv = f.invertBlockMatrix || f.inverse;
  const mat = f.matrix;
  // Monde → bloc : matrice inverse de l'insertion (3 × 4, par lignes), après la matrice du contour.
  const toBlock = ([x, y]) => {
    let px = x, py = y;
    if (mat?.length >= 12) { const nx = mat[0] * px + mat[1] * py + mat[3]; py = mat[4] * px + mat[5] * py + mat[7]; px = nx; }
    if (inv?.length >= 12) return [inv[0] * px + inv[1] * py + inv[3], inv[4] * px + inv[5] * py + inv[7]];
    return [px, py];
  };
  let pts = f.vertices.map((v) => [v.x, v.y]);
  let invert = false;
  // Découpe inversée : contour d'origine dans l'enregistrement d'aller-retour du filtre.
  for (const d of ctx.byOwner.get(key(f.handle)) || []) {
    const xr = ctx.xrecs.get(key(entry(d, 'ACAD_XREC_ROUNDTRIP')));
    const orig = xr ? xrecPoints(xr, 'ACAD_INVERTEDCLIP_ROUNDTRIP') : [];
    if (orig.length >= 2) { pts = orig; invert = true; }
  }
  if (pts.length === 2) {
    const [a, b] = pts;
    pts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  }
  const out = pts.map(toBlock);
  return out.length >= 3 ? { pts: out, invert, ...(f.clipBoundaryVisible === false ? {} : {}) } : null;
}

// --- écriture -------------------------------------------------------------------------------------

// Données d'écriture d'une découpe : contour (monde), matrice inverse (3 × 4), contour en trou de serrure si inversé.
export function clipForWrite(doc, e, extent = null) {
  const block = doc.blocks.get(e.name);
  const m = insertMatrix(e, block?.base || [0, 0]);
  const world = e.clip.pts.map((q) => G.apply(m, q[0], q[1]));
  const im = G.invert(m);
  const sz = e.sz || 1;
  const inverse = [im[0], im[2], 0, im[4], im[1], im[3], 0, im[5], 0, 0, 1 / sz, 0];
  let filterPts = world;
  if (e.clip.invert) {
    // Emprise du bloc (monde) + marge : contour extérieur relié au contour intérieur par un pont.
    const b = extent || world.reduce((acc, p) => ({ minX: Math.min(acc.minX, p[0]), minY: Math.min(acc.minY, p[1]), maxX: Math.max(acc.maxX, p[0]), maxY: Math.max(acc.maxY, p[1]) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const mg = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.05 || 1;
    const x0 = Math.min(b.minX, ...world.map((p) => p[0])) - mg, x1 = Math.max(b.maxX, ...world.map((p) => p[0])) + mg;
    const y0 = Math.min(b.minY, ...world.map((p) => p[1])) - mg, y1 = Math.max(b.maxY, ...world.map((p) => p[1])) + mg;
    const last = world[world.length - 1];
    const eps = (y1 - y0) * 1e-7;
    filterPts = [...world, [x0, last[1]], [x0, y1], [x1, y1], [x1, y0], [x0, y0], [x0, last[1] - eps], [last[0], last[1] - eps]];
  }
  return { world, inverse, filterPts };
}
