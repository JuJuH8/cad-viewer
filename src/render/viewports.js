// SPDX-License-Identifier: GPL-3.0-or-later
// Fenêtres de présentation : transformation espace objet → papier, et géométrie de l'espace objet
// construite une fois (paquets GPU + textes), puis redessinée dans chaque fenêtre avec un
// rectangle de découpe — comme AutoCAD, sans recalcul quand on se déplace dans la présentation.
import { drawKey } from '../core/draworder.js';
import * as THREE from 'three';
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { Tessellator } from '../core/tessellate.js';
import { partLineweight } from '../core/document.js';
import { fatLines, fatMaterial, lwMm } from './fatlines.js';

// Matrice affine [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f) : objet → papier.
// P = centre + k · (R(torsion) · (W − cible) − centre de vue), avec k = hauteur / hauteur de vue.
export function viewportMatrix(v) {
  const k = v.h / v.vh;
  const cos = Math.cos(v.twist || 0), sin = Math.sin(v.twist || 0);
  const tx = v.target?.[0] || 0, ty = v.target?.[1] || 0;
  return [
    k * cos, k * sin, -k * sin, k * cos,
    v.c[0] + k * (-(cos * tx - sin * ty) - v.vc[0]),
    v.c[1] + k * (-(sin * tx + cos * ty) - v.vc[1]),
  ];
}

export function viewportRect(v) {
  return { minX: v.c[0] - v.w / 2, maxX: v.c[0] + v.w / 2, minY: v.c[1] - v.h / 2, maxY: v.c[1] + v.h / 2 };
}

export const viewportScale = (v) => v.h / v.vh;

// Géométrie de l'espace objet pour les fenêtres. Renvoie { group, texts, parts, origin }.
// opts : { layerVisible, resolveColor, rgbOf, origin, materials, fat (affichage des épaisseurs) }.
export function buildModelView(doc, opts) {
  // Voisins MEP (réductions, piquages) cherchés dans l'espace objet.
  const mepIndex = new RBush();
  const items = [];
  for (const e of doc.entities.values()) {
    if (e.space !== 'model' || !e.mep || e.type !== 'LWPOLYLINE') continue;
    const b = G.emptyBox();
    for (const p of e.pts) G.growBox(b, p[0], p[1]);
    const pad = (e.mep.w || e.mep.d || 0) + 1;
    items.push({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad, id: e.id });
  }
  mepIndex.load(items);
  const byId = new Map(items.map((x) => [x.id, x]));
  const tess = new Tessellator(doc);
  tess.neighborsOf = (e) => (byId.has(e.id) ? mepIndex.search(byId.get(e.id)) : [])
    .map((h) => doc.get(h.id)).filter((o) => o && o.id !== e.id);
  const parts = [];
  const texts = [];
  // Clés d'ordre de tracé (relatives à la plus petite) : profondeur des sommets, voir renderer.js.
  let base = Infinity;
  for (const e of doc.entities.values()) if (e.space === 'model') base = Math.min(base, drawKey(e));
  base = Number.isFinite(base) ? base - 1 : 0;
  let kmax = 1;
  for (const e of doc.entities.values()) {
    if (e.space !== 'model') continue;
    const own = doc.layers.get(e.layer);
    if (own && own.frozen) continue;
    const list = tess.entity(e);
    list.forEach((part, i) => {
      if (!opts.layerVisible(part.layer)) return;
      const color = opts.resolveColor(part.color, part);
      const key = drawKey(e) - base + (list.length > 1 ? (0.9 * i) / list.length : 0);
      if (key > kmax) kmax = key;
      parts.push({ part, color, lw: partLineweight(doc, part), frame: e.type === 'UNDERLAY', key });
      for (const t of part.texts) texts.push({ ...t, color, key });
    });
  }
  const o = opts.origin;
  const geo = (pos, col, ord) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    if (ord) g.setAttribute('drawOrder', new THREE.BufferAttribute(ord, 1));
    return g;
  };
  // Un groupe par calque : une fenêtre peut geler certains calques (VPCALQUE) ou imposer leur couleur,
  // épaisseur et transparence. Avec l'affichage des épaisseurs (opts.fat), un trait épais par épaisseur.
  const byLayer = new Map();
  for (const x of parts) {
    if (!byLayer.has(x.part.layer)) byLayer.set(x.part.layer, []);
    byLayer.get(x.part.layer).push(x);
  }
  const rgbCache = new Map();
  const rgbOf = (color) => {
    let rgb = rgbCache.get(color);
    if (!rgb) rgbCache.set(color, (rgb = opts.rgbOf(color)));
    return rgb;
  };
  // Tableaux typés (positions, couleurs) d'une propriété (segs, tris, pts) d'une liste de parts.
  const arrays = (list, key) => {
    let n = 0;
    for (const { part } of list) n += part[key].length;
    const pos = new Float32Array(n), col = new Uint8Array(n), ord = new Float32Array(n / 3);
    let k = 0;
    for (const { part, color, key: dk } of list) {
      const src = part[key], [r, g, b] = rgbOf(color);
      for (let i = 0; i < src.length; i += 3, k += 3) {
        pos[k] = src[i] - o.x; pos[k + 1] = src[i + 1] - o.y; pos[k + 2] = 0;
        col[k] = r; col[k + 1] = g; col[k + 2] = b;
        ord[k / 3] = dk;
      }
    }
    return n ? [pos, col, ord] : null;
  };
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const layerGroups = new Map();
  for (const [layer, list] of byLayer) {
    const lg = new THREE.Group();
    const tris = arrays(list, 'tris');
    if (tris) { const m = new THREE.Mesh(geo(...tris), opts.materials.fill); m.renderOrder = 0; m.userData = { kind: 'fill', base: m.material }; lg.add(m); }
    const buckets = new Map();
    for (const x of list) {
      if (!x.part.segs.length) continue;
      const key = !opts.fat ? 'all' : opts.lwFor ? opts.lwFor(x.part.color, lwMm(x.lw, opts.lwDefault), x.part) : lwMm(x.lw, opts.lwDefault);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(x);
    }
    for (const [key, sub] of buckets) {
      const segs = arrays(sub, 'segs');
      if (!segs) continue;
      let l;
      if (opts.fat) {
        l = fatLines(segs[0], segs[1], fatMaterial(key)); // traits épais : sans ordre de tracé (par-dessus)
        l.userData = { kind: 'fat', mm: key, base: l.material };
      } else {
        l = new THREE.LineSegments(geo(...segs), opts.materials.line);
        l.userData = { kind: 'line', base: l.material };
      }
      l.renderOrder = 1;
      lg.add(l);
    }
    const pts = arrays(list, 'pts');
    if (pts) { const m = new THREE.Points(geo(...pts), opts.materials.point); m.userData = { kind: 'point', base: m.material }; lg.add(m); }
    group.add(lg);
    layerGroups.set(layer, lg);
  }
  return { group, texts, parts, origin: o, layerGroups, fat: !!opts.fat, orderRange: [0, kmax + 1] };
}

export function disposeModelView(mv) {
  mv?.group.traverse((x) => x.geometry?.dispose());
}
