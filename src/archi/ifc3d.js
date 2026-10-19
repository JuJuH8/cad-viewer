// SPDX-License-Identifier: GPL-3.0-or-later
// Maquette IFC d'un fond de plan en volumes dans la vue 3D : géométrie lue par web-ifc, placée comme le plan 2D du
// fond (même insertion, échelle et rotation ; niveau du plan à z = 0), couleurs de la maquette. Par défaut, le niveau
// du plan avec sa dalle et la dalle du dessus (plafond) ; option : tout le bâtiment. Les coupes et les mesures de la
// vue 3D s'appliquent aux volumes (laser jusqu'au plafond, coupe d'un local…).
import * as THREE from 'three';
import { ifcApi, storeysOf } from './ifc.js';

const SKIP = ['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCANNOTATION', 'IFCGRID', 'IFCSITE'];

// buffer : fichier IFC ; place(x, y, z) : point du plan (mm, z au-dessus du niveau) → coordonnées de la scène ;
// opts : { storey (nom ou indice du niveau du plan), all (tout le bâtiment) }.
// Renvoie { group, floor, top, storey, triangles } (floor / top en m, altitudes de la maquette).
export async function buildIfc3d(buffer, place, { storey = null, all = false } = {}) {
  const { api, W } = await ifcApi();
  const id = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
  try {
    const storeys = storeysOf(api, W, id);
    const st = (typeof storey === 'number' ? storeys[storey] : storeys.find((s) => s.name === storey)) || storeys[0];
    const floor = st ? st.elevation : 0;
    const next = st ? storeys.find((s) => s.elevation > floor + 0.5) : null;
    const top = next ? next.elevation : floor + 4;
    const lo = floor - 0.15, hi = top + 0.45; // dalle du niveau et dalle du dessus comprises
    const skip = new Set(SKIP.map((n) => W[n]).filter((v) => v != null));
    const byColor = new Map();
    let triangles = 0;
    api.StreamAllMeshes(id, (mesh) => {
      if (skip.has(api.GetLineType(id, mesh.expressID))) return;
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const geom = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const ix = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        geom.delete();
        const T = pg.flatTransformation;
        const n = v.length / 6;
        // Altitudes (m) : y de web-ifc après transformation ; pièce gardée si elle touche l'étage.
        let zmin = Infinity, zmax = -Infinity;
        const P = new Float64Array(n * 3), N = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          const x = v[k * 6], y = v[k * 6 + 1], z = v[k * 6 + 2];
          const X = T[0] * x + T[4] * y + T[8] * z + T[12], Y = T[1] * x + T[5] * y + T[9] * z + T[13], Z = T[2] * x + T[6] * y + T[10] * z + T[14];
          zmin = Math.min(zmin, Y); zmax = Math.max(zmax, Y);
          // Plan : X = x, Y = −z (web-ifc a l'axe Y vers le haut), altitude = y − niveau ; en mm.
          P[k * 3] = X * 1000; P[k * 3 + 1] = -Z * 1000; P[k * 3 + 2] = (Y - floor) * 1000;
          const nx = v[k * 6 + 3], ny = v[k * 6 + 4], nz = v[k * 6 + 5];
          const NX = T[0] * nx + T[4] * ny + T[8] * nz, NY = T[1] * nx + T[5] * ny + T[9] * nz, NZ = T[2] * nx + T[6] * ny + T[10] * nz;
          N[k * 3] = NX; N[k * 3 + 1] = -NZ; N[k * 3 + 2] = NY;
        }
        if (!all && (zmax < lo || zmin > hi)) continue;
        const c = pg.color;
        const key = `${Math.round(c.x * 255)},${Math.round(c.y * 255)},${Math.round(c.z * 255)},${Math.round(c.w * 100)}`;
        if (!byColor.has(key)) byColor.set(key, { color: c, pos: [], nrm: [], idx: [] });
        const b = byColor.get(key);
        const base = b.pos.length / 3;
        for (let k = 0; k < n; k++) {
          const q = place(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
          b.pos.push(q[0], q[1], q[2]);
          b.nrm.push(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]);
        }
        for (let t = 0; t < ix.length; t++) b.idx.push(ix[t] + base);
        triangles += ix.length / 3;
      }
    });
    const group = new THREE.Group();
    group.name = 'ifc3d';
    for (const b of byColor.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      geo.setIndex(b.idx);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const a = b.color.w;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(b.color.x, b.color.y, b.color.z), roughness: 0.85, metalness: 0,
        transparent: a < 0.99, opacity: Math.max(0.25, a), depthWrite: a >= 0.99, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      group.add(new THREE.Mesh(geo, mat));
    }
    return { group, floor, top, storey: st?.name ?? null, triangles };
  } finally {
    api.CloseModel(id);
  }
}

// Volumes des fonds IFC du dessin dans la vue 3D, reconstruits quand le dessin, la vue ou l'option changent.
// getBuffer(name) → ArrayBuffer du fichier IFC du fond ; insertOf(name) → insertion { p, sx, rot } ; options() →
// { show, all } ; print(message).
export function installIfc3d(renderer, { getDoc, getBuffer, insertOf, options, print = () => {} }) {
  let current = null; // { key, group }
  let building = null;
  const remove = () => {
    if (!current) return;
    renderer.scene.remove(current.group);
    current.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    current = null;
    renderer.ifc3d = null;
  };
  async function refresh() {
    const doc = getDoc();
    const opt = options();
    // Hors 3D ou masquée : volumes gardés (cachés) pour un retour rapide en 3D.
    const shown = renderer.mode === '3d' && !!doc && opt.show;
    if (current) { current.group.visible = shown; renderer.ifc3d = shown && current.group.children.length ? current.group : null; }
    if (!shown) { renderer.requestRender(true); return; }
    const fonds = [...doc.blocks.values()].filter((b) => b.fond?.ifc && insertOf(b.name));
    const key = JSON.stringify([fonds.map((b) => [b.name, b.fond.version, b.fond.ifc, insertOf(b.name)]), renderer.origin, opt.all]);
    if (current?.key === key) { renderer.requestRender(true); return; }
    if (building === key) return;
    building = key;
    try {
      const group = new THREE.Group();
      group.name = 'ifc3d';
      for (const b of fonds) {
        const buffer = await getBuffer(b.name).catch((err) => { print(`Maquette IFC « ${b.name} » non affichée en 3D : ${err.message || err}`); return null; });
        if (!buffer) continue;
        const ins = insertOf(b.name);
        const k = ins.sx || 1, c = Math.cos(ins.rot || 0), s = Math.sin(ins.rot || 0), o = renderer.origin;
        const place = (x, y, z) => [ins.p[0] + k * (c * x - s * y) - o.x, ins.p[1] + k * (s * x + c * y) - o.y, (ins.p[2] || 0) + k * z - (o.z || 0)];
        const r = await buildIfc3d(buffer, place, { storey: b.fond.ifc.storey, all: opt.all });
        group.add(r.group);
        print(`Maquette IFC « ${b.name} » en 3D : ${Math.round(r.triangles).toLocaleString('fr-CH')} triangles${opt.all ? ' (tout le bâtiment)' : ` (niveau ${r.storey ?? ''})`}.`);
      }
      if (building !== key) { group.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); }); return; }
      remove();
      current = { key, group }; // gardé même vide : pas de nouvel essai tant que rien ne change
      if (group.children.length) {
        const now = renderer.mode === '3d' && options().show; // vue changée pendant la lecture
        group.visible = now;
        renderer.ifc3d = now ? group : null;
        renderer.scene.add(group);
        // Vue pas encore déplacée depuis le passage en 3D : recadrée sur le dessin et la maquette.
        if (now && renderer.framedAt && renderer.perspective?.position.equals(renderer.framedAt)) renderer.frame3d();
      }
      renderer.requestRender(true);
    } catch (err) {
      remove();
      current = { key, group: new THREE.Group() };
      print(`Maquette IFC non affichée en 3D : ${err.message || err}`);
    } finally {
      if (building === key) building = null;
    }
  }
  return { refresh, remove };
}
