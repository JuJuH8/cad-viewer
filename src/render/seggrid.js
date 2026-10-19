// SPDX-License-Identifier: GPL-3.0-or-later
// Index en grille des segments et triangles d'une géométrie tessellée lourde : une référence de bloc qui
// contient des dizaines de milliers d'objets (fond de plan, xref) n'est plus parcourue en entier à chaque
// mouvement de souris ; la sélection et l'accrochage ne testent que ce qui est près du curseur.

export const GRID_MIN_ITEMS = 4000;
const MAX_CELLS = 4e6;
const LONG_CELLS = 256;          // un élément qui couvre plus de cellules va dans la liste « longs »
const IDX = 67108864;            // 2^26 : code = (part * 2 + genre) * IDX + indice

// Construit l'index (null si la géométrie est petite). parts : [{ segs, tris }] (x, y, z à plat).
export function buildGrid(parts, box) {
  let n = 0;
  for (const p of parts) n += ((p.segs.length / 6) | 0) + ((p.tris.length / 9) | 0);
  if (n < GRID_MIN_ITEMS || !box) return null;
  const w = Math.max(box.maxX - box.minX, 1e-9), h = Math.max(box.maxY - box.minY, 1e-9);
  let size = Math.sqrt((w * h) / Math.max(1, n / 6)) || 1;
  let nx = Math.max(1, Math.ceil(w / size)), ny = Math.max(1, Math.ceil(h / size));
  while (nx * ny > MAX_CELLS) { size *= 1.5; nx = Math.max(1, Math.ceil(w / size)); ny = Math.max(1, Math.ceil(h / size)); }
  const x0 = box.minX, y0 = box.minY;
  const cx = (x) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / size)));
  const cy = (y) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / size)));
  const counts = new Uint32Array(nx * ny + 1);
  const long = [];
  // Parcours commun aux deux passes : appelle visit(cellule, code) pour chaque cellule couverte.
  const each = (visit) => {
    for (let pi = 0; pi < parts.length; pi++) {
      const { segs, tris } = parts[pi];
      for (let i = 0; i + 5 < segs.length; i += 6) {
        const ax = cx(Math.min(segs[i], segs[i + 3])), bx = cx(Math.max(segs[i], segs[i + 3]));
        const ay = cy(Math.min(segs[i + 1], segs[i + 4])), by = cy(Math.max(segs[i + 1], segs[i + 4]));
        const code = (pi * 2) * IDX + i / 6;
        if ((bx - ax + 1) * (by - ay + 1) > LONG_CELLS) { if (visit === null) long.push(code); continue; }
        if (visit) for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) visit(y * nx + x, code);
      }
      for (let i = 0; i + 8 < tris.length; i += 9) {
        const mnx = Math.min(tris[i], tris[i + 3], tris[i + 6]), mxx = Math.max(tris[i], tris[i + 3], tris[i + 6]);
        const mny = Math.min(tris[i + 1], tris[i + 4], tris[i + 7]), mxy = Math.max(tris[i + 1], tris[i + 4], tris[i + 7]);
        const ax = cx(mnx), bx = cx(mxx), ay = cy(mny), by = cy(mxy);
        const code = (pi * 2 + 1) * IDX + i / 9;
        if ((bx - ax + 1) * (by - ay + 1) > LONG_CELLS) { if (visit === null) long.push(code); continue; }
        if (visit) for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) visit(y * nx + x, code);
      }
    }
  };
  each(null); // éléments longs
  each((c) => { counts[c + 1]++; });
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const refs = new Float64Array(counts[counts.length - 1]);
  const fill = counts.slice(0, -1);
  each((c, code) => { refs[fill[c]++] = code; });
  return { x0, y0, size, nx, ny, start: counts, refs, long };
}

// Codes des éléments dont les cellules touchent la boîte (sans doublon).
export function gridQuery(grid, box) {
  const { x0, y0, size, nx, ny, start, refs } = grid;
  const ax = Math.max(0, Math.floor((box.minX - x0) / size)), bx = Math.min(nx - 1, Math.floor((box.maxX - x0) / size));
  const ay = Math.max(0, Math.floor((box.minY - y0) / size)), by = Math.min(ny - 1, Math.floor((box.maxY - y0) / size));
  const out = new Set(grid.long);
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      const c = y * nx + x;
      for (let k = start[c]; k < start[c + 1]; k++) out.add(refs[k]);
    }
  }
  return out;
}

// Segments [x1, y1, x2, y2, …] et triangles [x1, y1, x2, y2, x3, y3, …] proches de la boîte.
export function gridItems(grid, parts, box) {
  const segs = [], tris = [];
  for (const code of gridQuery(grid, box)) {
    const k = Math.floor(code / IDX), i = code - k * IDX;
    const part = parts[k >> 1];
    if (k & 1) {
      const t = part.tris, o = i * 9;
      tris.push(t[o], t[o + 1], t[o + 3], t[o + 4], t[o + 6], t[o + 7]);
    } else {
      const s = part.segs, o = i * 6;
      segs.push(s[o], s[o + 1], s[o + 3], s[o + 4]);
    }
  }
  return { segs, tris };
}
