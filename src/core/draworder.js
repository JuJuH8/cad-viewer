// SPDX-License-Identifier: GPL-3.0-or-later
// Ordre de tracé (ORDRETRACE / DRAWORDER, comme AutoCAD) : chaque objet a une clé — son champ `order` s'il en a
// un, sinon son id (ordre de création) — et les objets sont dessinés par clé croissante : le dernier créé est
// au-dessus. Les opérations ci-dessous donnent de nouvelles clés aux objets choisis, dans chaque espace, en gardant
// leur ordre relatif ; un nouvel objet (id = doc.nextId) reste toujours au-dessus de tous.

export const drawKey = (e) => e.order ?? e.id;

const MIN_GAP = 1e-6;

// Objets d'un espace triés par clé.
function sortedSpace(doc, space) {
  return [...doc.entities.values()].filter((e) => (e.space || 'model') === space).sort((a, b) => drawKey(a) - drawKey(b));
}

// Clés régulières entre lo et hi (exclus) pour n objets.
function spread(lo, hi, n) {
  const step = (hi - lo) / (n + 1);
  return step > MIN_GAP ? Array.from({ length: n }, (_, i) => lo + step * (i + 1)) : null;
}

// Plafond des clés : celle du prochain objet créé (toujours au-dessus), sauf clé déjà plus haute.
const ceiling = (doc, lo) => (lo < doc.nextId ? doc.nextId : lo + 1);

// Renumérotation d'un espace (clés 1…N dans l'ordre actuel) quand les intervalles deviennent trop fins.
function renumber(doc, space) {
  sortedSpace(doc, space).forEach((e, i) => { if (e.order !== i + 1) doc.update({ ...e, order: i + 1 }); });
}

// Applique `place(others, sel)` → clés (ou null : renuméroter puis réessayer) aux objets choisis, espace par espace.
function reorder(doc, ids, place) {
  const bySpace = new Map();
  for (const id of ids) {
    const e = doc.get(id);
    if (!e) continue;
    const sp = e.space || 'model';
    if (!bySpace.has(sp)) bySpace.set(sp, new Set());
    bySpace.get(sp).add(id);
  }
  let n = 0;
  for (const [space, set] of bySpace) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const all = sortedSpace(doc, space);
      const sel = all.filter((e) => set.has(e.id));
      const others = all.filter((e) => !set.has(e.id));
      const keys = place(others, sel, space);
      if (keys === undefined) break; // rien à faire (référence absente de cet espace)
      if (!keys) { renumber(doc, space); continue; }
      sel.forEach((e, i) => { if (drawKey(e) !== keys[i]) doc.update({ ...e, order: keys[i] }); });
      n += sel.length;
      break;
    }
  }
  return n;
}

// Premier plan : au-dessus de tous les autres objets (mais sous les objets créés ensuite).
export function bringToFront(doc, ids) {
  return reorder(doc, ids, (others, sel) => {
    const lo = others.length ? drawKey(others[others.length - 1]) : drawKey(sel[0]) - 1;
    return spread(lo, ceiling(doc, lo), sel.length);
  });
}

// Arrière-plan : sous tous les autres objets.
export function sendToBack(doc, ids) {
  return reorder(doc, ids, (others, sel) => {
    const hi = others.length ? drawKey(others[0]) : drawKey(sel[0]) + 1;
    return sel.map((_, i) => hi - (sel.length - i));
  });
}

// Au-dessus des objets de référence (juste au-dessus du plus haut d'entre eux).
export function placeAbove(doc, ids, refIds) {
  const refs = new Set(refIds);
  return reorder(doc, ids, (others, sel, space) => {
    const r = others.filter((e) => refs.has(e.id) && (e.space || 'model') === space);
    if (!r.length) return undefined;
    const lo = Math.max(...r.map(drawKey));
    const next = others.find((e) => drawKey(e) > lo);
    return spread(lo, next ? drawKey(next) : ceiling(doc, lo), sel.length);
  });
}

// Au-dessous des objets de référence (juste sous le plus bas d'entre eux).
export function placeUnder(doc, ids, refIds) {
  const refs = new Set(refIds);
  return reorder(doc, ids, (others, sel, space) => {
    const r = others.filter((e) => refs.has(e.id) && (e.space || 'model') === space);
    if (!r.length) return undefined;
    const hi = Math.min(...r.map(drawKey));
    const prev = [...others].reverse().find((e) => drawKey(e) < hi);
    return spread(prev ? drawKey(prev) : hi - sel.length - 1, hi, sel.length);
  });
}

// Objets d'un espace dans l'ordre de tracé (écriture DXF, tracé PDF).
export const inDrawOrder = (entities) => [...entities].sort((a, b) => drawKey(a) - drawKey(b));
