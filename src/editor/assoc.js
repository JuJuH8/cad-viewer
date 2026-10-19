// SPDX-License-Identifier: GPL-3.0-or-later
// Cotes associatives : les points de définition d'une cote suivent les objets auxquels ils ont été
// accrochés (extrémité, milieu, centre…). La mise à jour se fait dans la même transaction que la
// modification (un seul « annuler »), grâce aux crochets de fin de transaction du document.
import { dimStyleOf } from '../core/drawing-settings.js';
import * as G from '../core/geom.js';
import { snapPointsOf } from '../core/entities.js';
import { dimSizes, linearDimension, radialDimension } from '../core/dimension.js';
import { refFor } from '../core/dimassoc.js';

// Référence d'accrochage du point p sur l'un des objets ids : { id, k, i } (i = rang parmi les points
// du même type), ou null.
export function assocRef(doc, ids, p) {
  for (const id of ids) {
    const r = refFor(doc.get(id), p);
    if (r) return r;
  }
  return null;
}

function resolve(doc, ref) {
  const e = doc.get(ref.id);
  if (!e) return null;
  let i = -1;
  for (const s of snapPointsOf(e)) if (s.k === ref.k && ++i === ref.i) return [s.p[0], s.p[1]];
  return null;
}

const same = (a, b) => G.dist(a, b) < 1e-9;

// Recalcule la cote (en coordonnées du dessin) ; renvoie true si elle a changé.
function regenerate(doc, dim, sizes) {
  const m = dim.meta;
  const M = dim.m || [1, 0, 0, 1, 0, 0];
  const T = (p) => G.applyPt(M, p);
  // Cote d'AutoCAD régénérée : position de texte d'origine oubliée (le texte suit la cote).
  const { textPoint, userText, ...base } = m;
  let res, meta;
  if (m.type === 'linear' || m.type === 'aligned') {
    const p1o = T(m.p1), p2o = T(m.p2), loco = T(m.loc);
    const p1 = (m.assoc[0] && resolve(doc, m.assoc[0])) || p1o;
    const p2 = (m.assoc[1] && resolve(doc, m.assoc[1])) || p2o;
    if (same(p1, p1o) && same(p2, p2o) && M.every((v, k) => v === [1, 0, 0, 1, 0, 0][k])) return false;
    // Déplacement d'ensemble des objets : la ligne de cote suit ; étirement : elle reste en place.
    const d1 = G.sub(p1, p1o), d2 = G.sub(p2, p2o);
    const loc = same(d1, d2) ? G.add(loco, d1) : loco;
    let rotation = null;
    if (m.type !== 'aligned') {
      const d = G.applyVec(M, [Math.cos(m.rotation || 0), Math.sin(m.rotation || 0)]);
      rotation = Math.atan2(d[1], d[0]);
    }
    res = linearDimension({ p1, p2, loc, rotation, sizes });
    meta = { ...base, p1, p2, loc, rotation, measurement: res?.measure };
  } else if (m.type === 'radius' || m.type === 'diameter') {
    const e = doc.get(m.assoc[0]?.id);
    if (!e || (e.type !== 'CIRCLE' && e.type !== 'ARC')) return false;
    const co = T(m.c), loco = T(m.loc);
    const c = [e.c[0], e.c[1]];
    if (same(c, co) && Math.abs(e.r - m.r) < 1e-9 && M.every((v, k) => v === [1, 0, 0, 1, 0, 0][k])) return false;
    const loc = G.add(loco, G.sub(c, co));
    res = radialDimension({ c, r: e.r, loc, diameter: m.type === 'diameter', sizes });
    meta = { ...base, c, r: e.r, loc, measurement: res?.measure };
  } else return false;
  if (!res) return false;
  // Nouveau bloc à chaque régénération : l'ancien peut être partagé par une copie de la cote.
  let n = (doc.dimCounter || 0) + 1, name;
  do name = `*DIMGEN${n++}`; while (doc.blocks.has(name));
  doc.dimCounter = n;
  doc.setTableEntry('blocks', name, { name, base: [0, 0, 0], flags: 1, xref: false, entities: res.entities });
  doc.update({ ...dim, name, m: [1, 0, 0, 1, 0, 0], meta });
  return true;
}

// Branche la mise à jour automatique sur un document (une seule fois).
export function installAssociativeDims(doc, scaleOf) {
  if (doc.assocInstalled || !doc.commitHooks) return;
  doc.assocInstalled = true;
  let index = null; // id d'objet → ids des cotes qui y sont accrochées
  const note = (dim) => {
    for (const ref of dim.meta?.assoc || []) {
      if (!ref) continue;
      if (!index.has(ref.id)) index.set(ref.id, new Set());
      index.get(ref.id).add(dim.id);
    }
  };
  const isAssocDim = (e) => e?.type === 'BLOCKREF' && e.kind === 'DIMENSION' && e.meta?.assoc;
  doc.commitHooks.push((change) => {
    if (!index) {
      index = new Map();
      for (const e of doc.entities.values()) if (isAssocDim(e)) note(e);
    }
    for (const id of [...change.added, ...change.modified]) { const e = doc.get(id); if (isAssocDim(e)) note(e); }
    const dims = new Set();
    for (const id of [...change.modified, ...change.removed]) for (const d of index.get(id) || []) dims.add(d);
    if (!dims.size) return;
    const sizes = dimSizes(scaleOf(doc), dimStyleOf(doc));
    for (const id of dims) {
      const dim = doc.get(id);
      if (isAssocDim(dim)) regenerate(doc, dim, sizes);
    }
  });
}
