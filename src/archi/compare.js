// SPDX-License-Identifier: GPL-3.0-or-later
// Comparaison de deux versions d'une base architecte : objets ajoutés, supprimés, inchangés, et zones
// où se concentrent les changements. Seules la géométrie et le texte comptent (pas le calque ni la couleur :
// un objet simplement déplacé sur un autre calque n'est pas une modification du plan).

const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 };

// Tolérance ≈ 1 mm dans les unités du dessin.
export function defaultTolerance(insunits) {
  const f = UNIT_M[insunits];
  return f ? 0.001 / f : 1e-3;
}

// Points caractéristiques d'un objet (emprise).
export function entityPoints(e) {
  switch (e.type) {
    case 'LINE': return [e.p1, e.p2];
    case 'CIRCLE': case 'ARC': return [[e.c[0] - e.r, e.c[1] - e.r], [e.c[0] + e.r, e.c[1] + e.r]];
    case 'ELLIPSE': {
      const L = Math.hypot(e.major[0], e.major[1]);
      return [[e.c[0] - L, e.c[1] - L], [e.c[0] + L, e.c[1] + L]];
    }
    case 'LWPOLYLINE': case 'POLY3D': case 'SOLID': return e.pts;
    case 'SPLINE': return e.ctrl?.length ? e.ctrl : e.fit || [];
    case 'HATCH': return e.loops.flat();
    case 'TEXT': case 'MTEXT': case 'ATTDEF': case 'POINT': case 'INSERT': case 'XLINE': return [e.p];
    default: return [];
  }
}

export function boxOf(points) {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (!p) continue;
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Signature géométrique d'un objet, coordonnées arrondies à la tolérance.
export function signature(e, tol, blocks) {
  const r = (v) => Math.round((v || 0) / tol);
  const pt = (p) => `${r(p[0])},${r(p[1])}`;
  const ang = (a) => Math.round(((((a || 0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 1000);
  switch (e.type) {
    case 'LINE': return `L|${[pt(e.p1), pt(e.p2)].sort().join('|')}`;
    case 'CIRCLE': return `C|${pt(e.c)}|${r(e.r)}`;
    case 'ARC': return `A|${pt(e.c)}|${r(e.r)}|${ang(e.a0)}|${ang(e.a1)}`;
    case 'ELLIPSE': return `E|${pt(e.c)}|${pt(e.major)}|${Math.round(e.ratio * 1000)}|${ang(e.a0)}|${ang(e.a1)}`;
    case 'LWPOLYLINE': {
      if (e.closed) return `PC|${e.pts.map(pt).sort().join('|')}`;
      // Polyligne ouverte : même signature dans les deux sens (le segment k à l'envers est le segment
      // n-2-k à l'endroit, renflement opposé).
      const n = e.pts.length, bu = (i) => Math.round((e.bulges?.[i] || 0) * 1000);
      const fwd = e.pts.map((p, i) => `${pt(p)}:${i < n - 1 ? bu(i) : 0}`).join('|');
      const rev = [...e.pts].reverse().map((p, k) => `${pt(p)}:${k < n - 1 ? -bu(n - 2 - k) : 0}`).join('|');
      return `P|${fwd < rev ? fwd : rev}`;
    }
    case 'POLY3D': case 'SOLID': return `${e.type}|${e.pts.map(pt).join('|')}`;
    case 'SPLINE': return `S|${(e.ctrl?.length ? e.ctrl : e.fit || []).map(pt).join('|')}`;
    case 'HATCH': return `H|${e.solid ? 'SOLID' : e.pattern}|${e.loops.map((l) => l.map(pt).sort().join(',')).sort().join('|')}`;
    case 'TEXT': case 'MTEXT': case 'ATTDEF': return `T|${pt(e.p)}|${r(e.h)}|${ang(e.rot)}|${e.text}`;
    case 'POINT': return `O|${pt(e.p)}`;
    case 'XLINE': return `X|${pt(e.p)}|${Math.round(e.dir[0] * 1000)},${Math.round(e.dir[1] * 1000)}`;
    case 'INSERT': {
      const name = String(e.name).replace(/^[^|]*\|/, '');
      const att = (e.attribs || []).map((a) => a.text).join('¤');
      return `I|${name}|${pt(e.p)}|${ang(e.rot)}|${Math.round((e.sx ?? 1) * 1000)}|${Math.round((e.sy ?? 1) * 1000)}|${att}`;
    }
    case 'BLOCKREF': {
      const b = blocks?.get(e.name);
      const box = b ? boxOf(b.entities.flatMap(entityPoints)) : null;
      const m = e.m || [];
      return `B|${e.kind}|${e.meta?.text ?? ''}|${e.meta?.measurement != null ? Math.round(e.meta.measurement / tol) : ''}|${box ? `${pt([box.minX, box.minY])}|${pt([box.maxX, box.maxY])}` : ''}|${m.map((v) => Math.round(v * 1000)).join(',')}`;
    }
    default: return `${e.type}|${JSON.stringify(e).length}`;
  }
}

// Compare deux listes d'objets (mêmes coordonnées) ; renvoie { added, removed, same }.
export function compareEntities(oldEnts, newEnts, { tol = 1e-3, oldBlocks, newBlocks } = {}) {
  const pool = new Map();
  for (const e of oldEnts) {
    const k = signature(e, tol, oldBlocks);
    (pool.get(k) || pool.set(k, []).get(k)).push(e);
  }
  const added = [];
  let same = 0;
  for (const e of newEnts) {
    const list = pool.get(signature(e, tol, newBlocks));
    if (list?.length) { list.pop(); same++; } else added.push(e);
  }
  let removed = [...pool.values()].flat();
  // Deuxième passe : un arrondi de part et d'autre d'une limite de grille ne doit pas compter comme un
  // changement. Objets de même type (et même texte) dont l'emprise ne diffère que de la tolérance.
  if (added.length && removed.length) {
    const cell = tol * 20;
    const grid = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const info = (e) => {
      const b = boxOf(entityPoints(e));
      return b && { e, b, t: `${e.type}|${e.text ?? ''}|${entityPoints(e).length}` };
    };
    for (const x of removed.map(info).filter(Boolean)) {
      const k = key(x.b.minX, x.b.minY);
      (grid.get(k) || grid.set(k, []).get(k)).push(x);
    }
    const matched = new Set();
    const still = [];
    for (const e of added) {
      const a = info(e);
      let hit = null;
      if (a) {
        const cx = Math.floor(a.b.minX / cell), cy = Math.floor(a.b.minY / cell);
        for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (const x of grid.get(`${cx + dx},${cy + dy}`) || []) {
            if (matched.has(x) || x.t !== a.t) continue;
            if (Math.abs(x.b.minX - a.b.minX) <= 2 * tol && Math.abs(x.b.minY - a.b.minY) <= 2 * tol
              && Math.abs(x.b.maxX - a.b.maxX) <= 2 * tol && Math.abs(x.b.maxY - a.b.maxY) <= 2 * tol) { hit = x; break; }
          }
        }
      }
      if (hit) { matched.add(hit); same++; } else still.push(e);
    }
    const gone = new Set([...matched].map((x) => x.e));
    removed = removed.filter((e) => !gone.has(e));
    return { added: still, removed, same };
  }
  return { added, removed, same };
}

// Zones de changements : emprises regroupées quand elles sont à moins de `gap` l'une de l'autre.
// Regroupement en grille (cellules de la taille de l'écart) avec union des voisins : quasi linéaire, même
// pour une base entièrement redessinée.
export function changeZones(changes, gap) {
  const boxes = [];
  for (const { e, kind } of changes) {
    const b = boxOf(entityPoints(e));
    if (b) boxes.push({ ...b, added: kind === 'added' ? 1 : 0, removed: kind === 'removed' ? 1 : 0 });
  }
  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const size = Math.max(gap, 1e-9);
  const cells = new Map();
  boxes.forEach((b, i) => {
    const x0 = Math.floor((b.minX - gap / 2) / size), x1 = Math.floor((b.maxX + gap / 2) / size);
    const y0 = Math.floor((b.minY - gap / 2) / size), y1 = Math.floor((b.maxY + gap / 2) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 2500) return; // très grand objet : zone à lui seul
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const first = cells.get(k);
        if (first == null) cells.set(k, i); else union(i, first);
      }
    }
  });
  const zones = new Map();
  boxes.forEach((b, i) => {
    const r = find(i);
    const z = zones.get(r);
    if (!z) { zones.set(r, { ...b }); return; }
    z.minX = Math.min(z.minX, b.minX); z.minY = Math.min(z.minY, b.minY);
    z.maxX = Math.max(z.maxX, b.maxX); z.maxY = Math.max(z.maxY, b.maxY);
    z.added += b.added; z.removed += b.removed;
  });
  return [...zones.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
}
