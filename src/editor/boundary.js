// SPDX-License-Identifier: GPL-3.0-or-later
// Contour d'une zone fermée autour d'un point (HACHURES « point intérieur », comme AutoCAD) :
// les courbes sont découpées à leurs intersections, on retire les bouts pendants, puis on suit la
// face du graphe plan qui contient le point. Les îlots (contours fermés intérieurs) sont ajoutés
// comme trous (remplissage pair-impair, comme le style « normal » d'AutoCAD).
import { blockForInsert } from '../blocks/dynamic.js';
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { curvePoints } from '../core/tessellate.js';
import { transformEntity, insertMatrix } from '../core/entities.js';

const BOUNDARY_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLY3D', 'ELLIPSE', 'SPLINE']);

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Contenu des blocs insérés (portes, équipements…) ramené en coordonnées du dessin, pour que les
// contours passent aussi par eux, comme dans AutoCAD.
export function expandInserts(doc, entities, depth = 0) {
  const out = [];
  for (const e of entities) {
    if (e.type !== 'INSERT' || depth > 8) { out.push(e); continue; }
    const b = blockForInsert(doc, e); // bloc dynamique : définition évaluée
    if (!b || b.xref && !b.entities?.length) continue;
    const cols = Math.max(1, e.cols || 1), rows = Math.max(1, e.rows || 1);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const m = insertMatrix(e, b.base || [0, 0], c, r);
        const inner = expandInserts(doc, b.entities.filter((x) => x.type === 'INSERT' || BOUNDARY_TYPES.has(x.type)), depth + 1);
        for (const x of inner) out.push(transformEntity(x, m));
      }
    }
  }
  return out;
}

// Segments des courbes (arcs et cercles en petits segments).
function segmentsOf(entities) {
  const segs = [];
  for (const e of entities) {
    if (!BOUNDARY_TYPES.has(e.type) || e.mep) continue;
    const c = curvePoints(e);
    if (!c || c.pts.length < 2) continue;
    const pts = c.pts;
    for (let i = 1; i < pts.length; i++) segs.push([[pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]]);
    if (c.closed || (e.type === 'LWPOLYLINE' && e.closed && G.dist(pts[0], pts[pts.length - 1]) > 1e-12)) {
      segs.push([[pts[pts.length - 1][0], pts[pts.length - 1][1]], [pts[0][0], pts[0][1]]]);
    }
  }
  return segs.filter(([a, b]) => G.dist(a, b) > 1e-12);
}

// Graphe plan : sommets fusionnés à la tolérance, arêtes découpées aux intersections.
function buildGraph(segs, tol) {
  const tree = new RBush();
  tree.load(segs.map(([a, b], i) => ({
    minX: Math.min(a[0], b[0]) - tol, minY: Math.min(a[1], b[1]) - tol, maxX: Math.max(a[0], b[0]) + tol, maxY: Math.max(a[1], b[1]) + tol, i,
  })));
  // Points de coupure { t, p } : chaque point est calculé une seule fois et partagé par les deux segments
  // (une extrémité reste l'extrémité exacte), pour que les sommets se rejoignent.
  const cuts = segs.map(([a, b]) => [{ t: 0, p: a }, { t: 1, p: b }]);
  const END = 1e-9;
  segs.forEach(([a, b], i) => {
    for (const h of tree.search({ minX: Math.min(a[0], b[0]) - tol, minY: Math.min(a[1], b[1]) - tol, maxX: Math.max(a[0], b[0]) + tol, maxY: Math.max(a[1], b[1]) + tol })) {
      if (h.i <= i) continue;
      const [c, d] = segs[h.i];
      const x = G.segSeg(a, b, c, d, 1e-9);
      if (x) {
        const p = x.t <= END ? a : x.t >= 1 - END ? b : x.u <= END ? c : x.u >= 1 - END ? d : x.point;
        cuts[i].push({ t: x.t, p });
        cuts[h.i].push({ t: x.u, p });
        continue;
      }
      // Extrémité posée sur l'autre segment (té) à la tolérance près : la coupure est l'extrémité elle-même.
      for (const [p, other] of [[c, i], [d, i], [a, h.i], [b, h.i]]) {
        const [s0, s1] = segs[other];
        const r = G.closestOnSegment(p, s0, s1);
        if (r.d <= tol && r.t > 0 && r.t < 1) cuts[other].push({ t: r.t, p });
      }
    }
  });
  // Sommets fusionnés à la tolérance (case de la grille et cases voisines).
  const cell = (p) => [Math.round(p[0] / tol), Math.round(p[1] / tol)];
  const ids = new Map(), pts = [], adj = [];
  const vid = (p) => {
    const [cx, cy] = cell(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = ids.get(`${cx + dx},${cy + dy}`);
        if (id != null && G.dist(pts[id], p) <= tol * 1.5) return id;
      }
    }
    const id = pts.length;
    ids.set(`${cx},${cy}`, id);
    pts.push(p);
    adj.push(new Set());
    return id;
  };
  segs.forEach((seg, i) => {
    const list = cuts[i].map((c) => ({ t: Math.min(1, Math.max(0, c.t)), p: c.p })).sort((x, y) => x.t - y.t);
    let prev = vid(list[0].p);
    for (let k = 1; k < list.length; k++) {
      const v = vid(list[k].p);
      if (v !== prev) { adj[prev].add(v); adj[v].add(prev); }
      prev = v;
    }
  });
  // Bouts pendants retirés (ils ne ferment rien).
  const stack = [];
  adj.forEach((s, v) => { if (s.size === 1) stack.push(v); });
  while (stack.length) {
    const v = stack.pop();
    if (adj[v].size !== 1) continue;
    const [w] = adj[v];
    adj[v].delete(w); adj[w].delete(v);
    if (adj[w].size === 1) stack.push(w);
  }
  return { pts, adj };
}

// Suit la face à gauche de l'arête orientée u → v (virage le plus à gauche à chaque sommet).
function traceFace(g, u, v, used) {
  const poly = [];
  const start = `${u}>${v}`;
  let a = u, b = v, guard = 0;
  do {
    used.add(`${a}>${b}`);
    poly.push(g.pts[a]);
    const back = Math.atan2(g.pts[a][1] - g.pts[b][1], g.pts[a][0] - g.pts[b][0]);
    let best = null, bestAng = Infinity;
    for (const w of g.adj[b]) {
      const ang = Math.atan2(g.pts[w][1] - g.pts[b][1], g.pts[w][0] - g.pts[b][0]);
      let cw = back - ang;
      while (cw <= 1e-12) cw += 2 * Math.PI;
      while (cw > 2 * Math.PI + 1e-12) cw -= 2 * Math.PI;
      if (w === a && g.adj[b].size > 1) cw = 4 * Math.PI; // demi-tour seulement en cul-de-sac
      if (cw < bestAng) { bestAng = cw; best = w; }
    }
    if (best == null) return null;
    a = b; b = best;
    if (++guard > 200000) return null;
  } while (`${a}>${b}` !== start);
  return poly;
}

// Premières arêtes coupées par la demi-droite horizontale partant de p vers +x, de la plus proche à la plus lointaine.
function rayHits(g, p) {
  const hits = [];
  g.adj.forEach((s, u) => {
    for (const v of s) {
      if (v < u) continue;
      const a = g.pts[u], b = g.pts[v];
      if ((a[1] > p[1]) === (b[1] > p[1])) continue;
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) hits.push({ x, u, v });
    }
  });
  return hits.sort((h, k) => h.x - k.x);
}

// Face fermée contenant p : { outer: [[x, y]…], islands: [[…]…] } ou null si la zone n'est pas fermée.
export function findBoundary(entities, p, { tol } = {}) {
  const segs = segmentsOf(entities);
  if (!segs.length) return null;
  const box = G.emptyBox();
  for (const [a, b] of segs) { G.growBox(box, a[0], a[1]); G.growBox(box, b[0], b[1]); }
  const size = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) || 1;
  const eps = tol || size * 1e-9;
  const g = buildGraph(segs, eps);
  const used = new Set();
  const islands = [];
  let outer = null;
  for (const h of rayHits(g, p)) {
    const a = g.pts[h.u], b = g.pts[h.v];
    const [u, v] = G.cross(G.sub(b, a), G.sub(p, a)) > 0 ? [h.u, h.v] : [h.v, h.u];
    if (used.has(`${u}>${v}`)) continue;
    const poly = traceFace(g, u, v, used);
    if (!poly || poly.length < 3) continue;
    if (signedArea(poly) > 0 && pointInPolygon(p, poly)) { outer = poly; break; }
    // Contour d'un îlot vu depuis la zone (sens horaire). Le côté lointain d'un îlot donne son intérieur
    // (sens trigonométrique, sans p) : on l'ignore.
    if (signedArea(poly) < 0) islands.push(poly);
  }
  if (!outer) return null;
  // Autres îlots : composantes entièrement à l'intérieur du contour, non encore rencontrées.
  const onOuter = new Set(outer.map((q) => `${q[0]},${q[1]}`));
  const seen = new Set();
  g.adj.forEach((s, start) => {
    if (!s.size || seen.has(start)) return;
    const comp = [];
    const st = [start];
    seen.add(start);
    while (st.length) {
      const v = st.pop();
      comp.push(v);
      for (const w of g.adj[v]) if (!seen.has(w)) { seen.add(w); st.push(w); }
    }
    if (comp.some((v) => onOuter.has(`${g.pts[v][0]},${g.pts[v][1]}`))) return;
    if (!comp.every((v) => pointInPolygon(g.pts[v], outer))) return;
    if (islands.some((isl) => comp.some((v) => isl.includes(g.pts[v])))) return;
    // Contour extérieur de la composante : demi-droite depuis un point juste à gauche de son sommet le plus à gauche.
    const left = comp.reduce((m, v) => (g.pts[v][0] < g.pts[m][0] ? v : m), comp[0]);
    // Sonde juste à gauche du milieu d'une arête non horizontale partant du sommet le plus à gauche :
    // la demi-droite coupe forcément cette arête (un départ au sommet même peut la manquer).
    const w = [...g.adj[left]].find((x) => Math.abs(g.pts[x][1] - g.pts[left][1]) > eps) ?? [...g.adj[left]][0];
    const mid = G.mid(g.pts[left], g.pts[w]);
    const probe = [Math.min(g.pts[left][0], g.pts[w][0]) - size * 1e-6, mid[1]];
    const inComp = new Set(comp);
    const hit = rayHits(g, probe).find((h) => inComp.has(h.u) && inComp.has(h.v));
    if (!hit) return;
    const a = g.pts[hit.u], b = g.pts[hit.v];
    const [u, v] = G.cross(G.sub(b, a), G.sub(probe, a)) > 0 ? [hit.u, hit.v] : [hit.v, hit.u];
    const poly = traceFace(g, u, v, used);
    if (poly && poly.length >= 3 && signedArea(poly) < 0) islands.push(poly);
  });
  return { outer, islands };
}
