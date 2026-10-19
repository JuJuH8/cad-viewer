// SPDX-License-Identifier: GPL-3.0-or-later
// Vue 3D des réseaux MEP : chaque tronçon devient un volume à son altitude
// (gaine / chemin de câbles : parallélépipède ; canalisation / gaine circulaire : cylindre).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { planWidth, vertexZ, riseDrops } from './systems.js';
import { filletedAxis, elbowRadius } from './geometry.js';
import { pathOf, pointAt } from '../core/path.js';

function segmentGeometry(m, a, b, extendStart, extendEnd, za = m.z || 0, zb = za) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len, uy = dy / len;
  const round = m.kind === 'pipe' || m.shape === 'round';
  const w = round ? m.d : planWidth(m);
  const h = round ? m.d : (m.h || (m.kind === 'tray' ? 60 : w));
  // Prolongement aux coudes pour que les tronçons se rejoignent sans trou (facteur × demi-largeur).
  const e0 = (+extendStart || 0) * w / 2, e1 = (+extendEnd || 0) * w / 2;
  const L = len + e0 + e1;
  const cx = a[0] - ux * e0 + ux * L / 2, cy = a[1] - uy * e0 + uy * L / 2;
  // Altitude : axe pour les gaines et canalisations, dessous pour les chemins de câbles.
  const cz = (za + zb) / 2 + (m.kind === 'tray' ? h / 2 : 0);
  let g;
  if (round) {
    g = new THREE.CylinderGeometry(w / 2, w / 2, L, 20, 1);
    g.rotateZ(-Math.PI / 2);                // axe du cylindre selon X
  } else {
    g = new THREE.BoxGeometry(L, w, h);
  }
  if (Math.abs(zb - za) > 1e-9) g.rotateY(-Math.atan2(zb - za, len)); // pente : l'axe monte de za à zb
  g.rotateZ(Math.atan2(uy, ux));
  g.translate(cx, cy, cz);
  return g;
}

// Terminal (bouche, appareil, émetteur) : plaque de 60 mm à son altitude, ronde ou rectangulaire.
function terminalGeometry(e, origin) {
  const m = e.mep;
  const t = 60;
  const round = m.d && !m.w;
  let g;
  if (round) {
    g = new THREE.CylinderGeometry(m.d / 2, m.d / 2, t, 24, 1);
    g.rotateX(Math.PI / 2); // axe vertical
  } else {
    g = new THREE.BoxGeometry(m.w || 300, m.h || 300, t);
  }
  g.rotateZ(e.rot || 0);
  g.translate(e.p[0] - origin.x, e.p[1] - origin.y, (m.z || 0) - origin.z);
  return g;
}

// Support : traverse sous le réseau et deux tiges de 600 mm vers le plafond (gris).
// Accessoire : volume à la section du réseau, un peu plus grand (longueur le long de l'axe).
function hangerGeometries(e, origin) {
  const m = e.mep;
  const along = Math.abs(e.sx || 80), across = Math.abs(e.sy || 300), h = m.h || 0;
  const place = (g, dz) => { g.rotateZ(e.rot || 0); g.translate(e.p[0] - origin.x, e.p[1] - origin.y, dz - origin.z); return g; };
  if (m.kind === 'accessory') {
    const hh = (h || across * 0.6) + 40;
    return [place(new THREE.BoxGeometry(along, across, hh), m.z || 0)];
  }
  const bottom = (m.z || 0) - (m.tray ? 0 : h / 2);
  const bar = place(new THREE.BoxGeometry(Math.min(along, 60), across, 40), bottom - 20);
  const rodH = 600 + h;
  const rods = [-1, 1].map((k) => {
    const g = new THREE.CylinderGeometry(5, 5, rodH, 8, 1);
    g.rotateX(Math.PI / 2);
    g.translate(0, (k * across) / 2 - k * 10, 0);
    return place(g, bottom - 20 + rodH / 2);
  });
  return [bar, ...rods];
}

const G_normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // dans ]-π, π]

const clean = (g) => {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  return g.index ? g.toNonIndexed() : g;
};

// Construit le groupe 3D des réseaux du dessin (coordonnées recentrées sur `origin`).
export function buildMep3d(entities, colorOf, origin) {
  const byColor = new Map();
  const insulation = [];
  let maxZ = 0;
  const add = (c, g) => {
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(clean(g));
  };
  // Montées / descentes : tronçon vertical entre deux prolongements à des altitudes différentes.
  const runs = entities.filter((x) => x.mep && x.type === 'LWPOLYLINE' && x.pts.length >= 2);
  for (const e of runs) {
    for (const r of riseDrops(e, runs)) {
      if (r.n.id < e.id) continue;
      const m = e.mep, round = m.kind === 'pipe' || m.shape === 'round';
      const w = round ? m.d : planWidth(m), h = round ? m.d : (m.h || (m.kind === 'tray' ? 60 : w));
      const z0 = vertexZ(e)[r.end === 0 ? 0 : e.pts.length - 1], len = Math.abs(r.dz) + h;
      let g;
      if (round) { g = new THREE.CylinderGeometry(w / 2, w / 2, len, 20, 1); g.rotateX(Math.PI / 2); } else g = new THREE.BoxGeometry(w, h, len);
      const i = r.end === 0 ? 0 : e.pts.length - 1, j = r.end === 0 ? 1 : e.pts.length - 2;
      g.rotateZ(Math.atan2(e.pts[i][1] - e.pts[j][1], e.pts[i][0] - e.pts[j][0]));
      g.translate(r.p[0] - origin.x, r.p[1] - origin.y, z0 + r.dz / 2 + (m.kind === 'tray' ? h / 2 : 0) - origin.z);
      add(colorOf(e), g);
    }
  }
  for (const e of entities) {
    if ((e.mep?.kind === 'support' || e.mep?.kind === 'accessory') && e.type === 'INSERT') {
      const col = e.mep.kind === 'support' ? 0x8a8f98 : colorOf(e);
      for (const g of hangerGeometries(e, origin)) add(col, g);
      continue;
    }
    if (e.mep?.kind === 'terminal' && e.type === 'INSERT') {
      add(colorOf(e), terminalGeometry(e, origin));
      maxZ = Math.max(maxZ, e.mep.z || 0);
      continue;
    }
    if (!e.mep || e.type !== 'LWPOLYLINE' || e.pts.length < 2) continue;
    let pts = e.pts.map((p) => [p[0] - origin.x, p[1] - origin.y]);
    let vz = vertexZ(e);
    // Prolongement d'un tronçon au sommet i : 1 (demi-largeur) à un angle droit, moins pour un angle plus ouvert.
    let ext = pts.map(() => 1);
    // Réseau horizontal à coudes à rayon : axe arrondi comme en plan, arcs découpés en morceaux de 10° au plus.
    const R = elbowRadius(e); // canalisation : 0 (angles vifs) ; tube souple : courbes
    if (R > 0 && pts.length > 2 && vz.every((z) => Math.abs(z - vz[0]) < 1e-9)) {
      const path = pathOf(filletedAxis({ ...e, pts, bulges: null }, R));
      const chain = [path.curves[0] && pointAt(path.curves[0], 0)];
      for (const c of path.curves) {
        const k = c.k === 'arc' ? Math.max(1, Math.ceil(Math.abs(c.sw) / (Math.PI / 18))) : 1;
        for (let j = 1; j <= k; j++) chain.push(pointAt(c, j / k));
      }
      pts = chain;
      vz = pts.map(() => vz[0]);
      ext = pts.map((v, i) => {
        if (i === 0 || i === pts.length - 1) return 0;
        const a = Math.atan2(v[1] - pts[i - 1][1], v[0] - pts[i - 1][0]), b = Math.atan2(pts[i + 1][1] - v[1], pts[i + 1][0] - v[0]);
        return Math.min(1, Math.abs(Math.tan(Math.abs(G_normAngle(b - a)) / 2)));
      });
    }
    const exS = (i) => (i > 1 ? ext[i - 1] : 0), exE = (i) => (i < pts.length - 1 ? ext[i] : 0);
    for (let i = 1; i < pts.length; i++) {
      const g = segmentGeometry(e.mep, pts[i - 1], pts[i], exS(i), exE(i), vz[i - 1], vz[i]);
      if (!g) continue;
      g.translate(0, 0, -origin.z);
      add(colorOf(e), g);
      maxZ = Math.max(maxZ, Math.max(vz[i - 1], vz[i]) + (e.mep.h || e.mep.d || 0));
      // Calorifuge : enveloppe translucide.
      const k = e.mep.ins || 0;
      if (k > 0) {
        const m = e.mep;
        const env = { ...m, w: (m.w || 0) + 2 * k, h: (m.h || 0) + 2 * k, d: (m.d || 0) + 2 * k };
        const gi = segmentGeometry(env, pts[i - 1], pts[i], exS(i), exE(i), vz[i - 1], vz[i]);
        if (gi) { gi.translate(0, 0, -origin.z); insulation.push(clean(gi)); }
      }
    }
  }
  const group = new THREE.Group();
  group.name = 'mep3d';
  for (const [color, geos] of byColor) {
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    group.add(new THREE.Mesh(merged, mat));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), new THREE.LineBasicMaterial({ color: 0x15191f, transparent: true, opacity: 0.45 }));
    group.add(edges);
  }
  if (insulation.length) {
    const merged = mergeGeometries(insulation);
    insulation.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.9 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'calorifuge';
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  group.userData.maxZ = maxZ;
  return group;
}

export function disposeGroup(group) {
  group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
}
