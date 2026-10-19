// SPDX-License-Identifier: GPL-3.0-or-later
// Maquette IFC → plan d'un niveau, pour servir de fond de plan : coupe horizontale des éléments à une hauteur
// donnée au-dessus du niveau (murs, poteaux, menuiseries coupés : traits épais), arêtes vues en dessous
// projetées (dalles, escaliers, mobilier, sanitaires : traits fins) et noms des locaux.
// Lecture par web-ifc (WASM, licence MPL-2.0), chargé à la première utilisation.

import { Document, defaultLayer } from '../core/document.js';

const WEB_IFC = new URL('../../vendor/web-ifc@0.0.77/', import.meta.url).href; // copie locale (scripts/vendor.py)
let apiPromise = null;

export async function ifcApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const W = await import(`${WEB_IFC}web-ifc-api.js`);
      const api = new W.IfcAPI();
      api.SetWasmPath(WEB_IFC, true);
      await api.Init();
      return { api, W };
    })().catch((err) => { apiPromise = null; throw err; });
  }
  return apiPromise;
}

// Catégories d'éléments → calque et rendu (coupé : trait épais ; vu : trait fin gris).
const CATEGORIES = [
  [/^IfcWall/i, 'IFC-Murs', 7],
  [/^IfcColumn/i, 'IFC-Poteaux', 7],
  [/^IfcCurtainWall|^IfcPlate|^IfcMember/i, 'IFC-Façades', 5],
  [/^IfcDoor/i, 'IFC-Portes', 3],
  [/^IfcWindow/i, 'IFC-Fenêtres', 4],
  [/^IfcStair|^IfcRamp|^IfcRailing/i, 'IFC-Escaliers', 2],
  [/^IfcSlab|^IfcRoof/i, 'IFC-Dalles', 8],
  [/^IfcBeam/i, 'IFC-Poutres', 8],
  [/^IfcCovering/i, 'IFC-Revêtements', 9],
  [/^IfcFurni/i, 'IFC-Mobilier', 6],
  [/^IfcSanitary|^IfcFlowTerminal|^IfcElectric/i, 'IFC-Équipements', 6],
  [/^IfcSpace/i, 'IFC-Locaux', 140],
];
const categoryOf = (type) => CATEGORIES.find(([re]) => re.test(type)) || [null, 'IFC-Autres', 8];

// Éléments dont on dessine les arêtes vues sous le plan de coupe (les murs, coupés, ne le sont pas).
const SEEN = /^(IfcSlab|IfcStair|IfcRamp|IfcRailing|IfcFurni|IfcSanitary|IfcFlowTerminal|IfcElectric|IfcDoor|IfcWindow|IfcColumn|IfcCovering|IfcBuildingElementProxy)/i;

// Niveaux de la maquette : [{ id, name, elevation (m) }], triés par altitude.
export async function ifcStoreys(buffer) {
  const { api, W } = await ifcApi();
  const id = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
  try {
    return storeysOf(api, W, id);
  } finally {
    api.CloseModel(id);
  }
}

function lengthUnit(api, W, id) {
  const us = api.GetLineIDsWithType(id, W.IFCSIUNIT);
  for (let i = 0; i < us.size(); i++) {
    const u = api.GetLine(id, us.get(i));
    if (u.UnitType?.value === 'LENGTHUNIT') return { MILLI: 0.001, CENTI: 0.01, DECI: 0.1 }[u.Prefix?.value] || 1;
  }
  return 1;
}

export function storeysOf(api, W, id) {
  const k = lengthUnit(api, W, id);
  const st = api.GetLineIDsWithType(id, W.IFCBUILDINGSTOREY);
  const out = [];
  for (let i = 0; i < st.size(); i++) {
    const s = api.GetLine(id, st.get(i));
    out.push({ id: st.get(i), name: s.Name?.value || s.LongName?.value || `Niveau ${i + 1}`, elevation: (s.Elevation?.value ?? 0) * k });
  }
  return out.sort((a, b) => a.elevation - b.elevation);
}

// Plan d'un niveau. opts : { storey (nom ou indice), cut (m au-dessus du niveau), below (arêtes vues), spaces,
// chooseStorey(storeys) → { storey, cut } (appelé si opts.storey n'est pas donné) }.
// Renvoie un Document en millimètres (xdoc.ifc = réglages retenus, pour les versions suivantes).
export async function ifcToDocument(buffer, opts = {}) {
  const { api, W } = await ifcApi();
  const id = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
  try {
    const storeys = storeysOf(api, W, id);
    let { storey, cut = 1.1 } = opts;
    if (storey == null && opts.chooseStorey) {
      const r = await opts.chooseStorey(storeys);
      if (!r) throw new Error('import IFC annulé');
      ({ storey, cut = cut } = r);
    }
    const st = typeof storey === 'number' ? storeys[storey] : storeys.find((s) => s.name === storey) || storeys[0];
    const floor = st ? st.elevation : 0;
    const next = st ? storeys.find((s) => s.elevation > floor + 0.5) : null;
    const h = floor + cut;
    const top = next ? next.elevation : floor + 4;
    const doc = buildPlan(api, W, id, { floor, h, top, below: opts.below !== false, spaces: opts.spaces !== false });
    doc.ifc = { storey: st?.name ?? null, cut, storeys: storeys.map((s) => s.name) };
    return doc;
  } finally {
    api.CloseModel(id);
  }
}

function buildPlan(api, W, id, { floor, h, top, below, spaces }) {
  const MM = 1000;
  const doc = new Document();
  doc.header.insunits = 4;
  const layers = new Map();
  const layer = (name, color, cutLine) => {
    const key = cutLine ? name : `${name} (vue)`;
    if (!layers.has(key)) {
      layers.set(key, true);
      doc.layers.set(key, defaultLayer(key, cutLine ? { color, lweight: name === 'IFC-Murs' || name === 'IFC-Poteaux' ? 50 : 25 } : { color: 8, lweight: 13 }));
    }
    return key;
  };
  const out = [];
  const typeName = (expressID) => {
    const code = api.GetLineType(id, expressID);
    return api.GetNameFromTypeCode ? api.GetNameFromTypeCode(code) : String(code);
  };
  const eps = 1e-6;
  const zcut = h + 1e-4; // évite les sommets pile sur le plan de coupe

  const handleMesh = (mesh, forceType) => {
    const type = forceType || typeName(mesh.expressID);
    const [, catLayer, color] = categoryOf(type);
    const seen = below && SEEN.test(type);
    const segs = [], edges = new Map();
    for (let g = 0; g < mesh.geometries.size(); g++) {
      const pg = mesh.geometries.get(g);
      const geom = api.GetGeometry(id, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const ix = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      geom.delete();
      const T = pg.flatTransformation;
      // Sommets en coordonnées du plan : web-ifc donne Y vers le haut → X, Y du plan = x, −z ; altitude = y.
      const P = new Float64Array((v.length / 6) * 3);
      for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
        const x = v[k], y = v[k + 1], z = v[k + 2];
        P[j] = T[0] * x + T[4] * y + T[8] * z + T[12];
        P[j + 1] = -(T[2] * x + T[6] * y + T[10] * z + T[14]);
        P[j + 2] = T[1] * x + T[5] * y + T[9] * z + T[13];
      }
      for (let t = 0; t + 2 < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const za = P[a + 2], zb = P[b + 2], zc = P[c + 2];
        const lo = Math.min(za, zb, zc), hi = Math.max(za, zb, zc);
        // Coupe : intersection du triangle avec le plan horizontal z = zcut.
        if (lo < zcut && hi > zcut) {
          const pts = [];
          for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const zp = P[p + 2], zq = P[q + 2];
            if ((zp - zcut) * (zq - zcut) < 0) {
              const s = (zcut - zp) / (zq - zp);
              pts.push(P[p] + (P[q] - P[p]) * s, P[p + 1] + (P[q + 1] - P[p + 1]) * s);
            }
          }
          if (pts.length === 4 && Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) > eps) segs.push(pts);
        }
        // Vu en dessous : arêtes du triangle entre le niveau et la coupe (arêtes vives retenues plus bas).
        if (seen && hi <= zcut && lo >= floor - 0.05) {
          const nx = (P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c + 1] - P[a + 1]);
          const ny = (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]);
          const nz = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
          const L = Math.hypot(nx, ny, nz) || 1;
          const n = [nx / L, ny / L, nz / L];
          for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const kp = `${Math.round(P[p] * 1e4)},${Math.round(P[p + 1] * 1e4)},${Math.round(P[p + 2] * 1e4)}`;
            const kq = `${Math.round(P[q] * 1e4)},${Math.round(P[q + 1] * 1e4)},${Math.round(P[q + 2] * 1e4)}`;
            const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
            const e = edges.get(key);
            if (e) e.n.push(n); else edges.set(key, { p: [P[p], P[p + 1]], q: [P[q], P[q + 1]], n: [n] });
          }
        }
      }
    }
    if (type.toUpperCase() === 'IFCSPACE') return; // locaux : traités à part (nom au centre)
    const lc = layer(catLayer, color, true);
    for (const s of segs) out.push({ type: 'LINE', layer: lc, p1: [s[0] * MM, s[1] * MM, 0], p2: [s[2] * MM, s[3] * MM, 0] });
    if (seen) {
      const lv = layer(catLayer, color, false);
      for (const e of edges.values()) {
        // Arête vive : bord libre ou faces voisines nettement inclinées l'une par rapport à l'autre.
        const sharp = e.n.length === 1 || e.n.some((m) => m[0] * e.n[0][0] + m[1] * e.n[0][1] + m[2] * e.n[0][2] < 0.94);
        if (!sharp || Math.hypot(e.q[0] - e.p[0], e.q[1] - e.p[1]) < 0.002) continue;
        out.push({ type: 'LINE', layer: lv, p1: [e.p[0] * MM, e.p[1] * MM, 0], p2: [e.q[0] * MM, e.q[1] * MM, 0] });
      }
    }
  };

  api.StreamAllMeshes(id, (mesh) => handleMesh(mesh));

  // Locaux : contour à 10 cm du sol et nom au centre.
  if (spaces && api.StreamAllMeshesWithTypes) {
    const lab = layer('IFC-Locaux', 140, true);
    api.StreamAllMeshesWithTypes(id, [W.IFCSPACE], (mesh) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, lo = Infinity, hi = -Infinity;
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const geom = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        geom.delete();
        const T = pg.flatTransformation;
        for (let k = 0; k < v.length; k += 6) {
          const x = v[k], y = v[k + 1], z = v[k + 2];
          const X = T[0] * x + T[4] * y + T[8] * z + T[12], Y = -(T[2] * x + T[6] * y + T[10] * z + T[14]), Z = T[1] * x + T[5] * y + T[9] * z + T[13];
          minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
          lo = Math.min(lo, Z); hi = Math.max(hi, Z);
        }
      }
      if (!(hi > floor + 0.2 && lo < top - 0.2)) return; // local d'un autre niveau
      const sp = api.GetLine(id, mesh.expressID);
      const name = [sp.Name?.value, sp.LongName?.value].filter(Boolean).join(' ');
      if (name) {
        out.push({ type: 'TEXT', layer: lab, p: [((minX + maxX) / 2) * MM, ((minY + maxY) / 2) * MM, 0], h: 200, rot: 0, text: name, align: 'center', valign: 'middle' });
      }
    });
  }
  doc.load(out);
  return doc;
}
