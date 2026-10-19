// SPDX-License-Identifier: GPL-3.0-or-later
// Extrusion des contours 2D en volumes 3D.
// - Contours fermés → volumes pleins (les contours inclus dans un autre deviennent des trous).
// - Lignes ouvertes → murs verticaux (faces d'épaisseur nulle, visibles des deux côtés).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX_NESTING = 3000; // au-delà, on renonce à détecter les trous (coût quadratique)

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return Math.abs(a / 2);
}

// Profondeur d'imbrication de chaque contour fermé : pair = matière, impair = trou.
function nest(closed) {
  const info = closed.map((s) => ({ s, area: area(s.pts), depth: 0, parent: -1 }));
  if (info.length > MAX_NESTING) return info;
  for (let i = 0; i < info.length; i++) {
    const a = info[i].s, [x, y] = a.pts[0];
    let best = -1;
    for (let j = 0; j < info.length; j++) {
      const b = info[j].s;
      if (i === j || info[j].area <= info[i].area) continue;
      if (a.minX < b.minX || a.maxX > b.maxX || a.minY < b.minY || a.maxY > b.maxY) continue;
      if (pointInPolygon(x, y, b.pts)) {
        info[i].depth++;
        if (best < 0 || info[j].area < info[best].area) best = j;
      }
    }
    info[i].parent = best;
  }
  return info;
}

function toVec2(pts, o) {
  const out = pts.map(([x, y]) => new THREE.Vector2(x - o.x, y - o.y));
  const a = out[0], b = out[out.length - 1];
  if (out.length > 3 && a.distanceTo(b) < 1e-9) out.pop(); // contour fermé : pas de point en double
  return out;
}

function solidGeometries(closed, base, height, origin) {
  const info = nest(closed);
  const geos = [];
  info.forEach((outer, i) => {
    if (outer.depth % 2 !== 0 || outer.s.pts.length < 3 || outer.area < 1e-12) return;
    const shape = new THREE.Shape(toVec2(outer.s.pts, origin));
    for (const h of info) {
      if (h.parent === i && h.depth % 2 === 1) shape.holes.push(new THREE.Path(toVec2(h.s.pts, origin)));
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, base - origin.z);
    geos.push(g.toNonIndexed());
  });
  return geos;
}

function wallGeometry(open, base, height, origin) {
  const pos = [];
  const z0 = base - origin.z, z1 = z0 + height;
  for (const s of open) {
    for (let i = 1; i < s.pts.length; i++) {
      const ax = s.pts[i - 1][0] - origin.x, ay = s.pts[i - 1][1] - origin.y;
      const bx = s.pts[i][0] - origin.x, by = s.pts[i][1] - origin.y;
      if (Math.hypot(bx - ax, by - ay) < 1e-12) continue;
      pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Construit un groupe three.js (faces + arêtes) pour une liste de contours.
export function extrudeShapes(shapes, { base, height, color, origin }) {
  const group = new THREE.Group();
  const closed = shapes.filter((s) => s.closed && s.pts.length >= 3);
  const open = shapes.filter((s) => !s.closed);

  const faceMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1f24, transparent: true, opacity: 0.55 });

  const parts = [];
  const solids = solidGeometries(closed, base, height, origin);
  if (solids.length) {
    for (const g of solids) g.deleteAttribute('uv');
    parts.push(mergeGeometries(solids));
    solids.forEach((g) => g.dispose());
  }
  const walls = wallGeometry(open, base, height, origin);
  if (walls) parts.push(walls);

  let triangles = 0;
  for (const geo of parts) {
    triangles += geo.attributes.position.count / 3;
    group.add(new THREE.Mesh(geo, faceMat));
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat));
  }
  group.userData = { solids: solids.length, walls: open.length, triangles };
  return group;
}

export function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}
