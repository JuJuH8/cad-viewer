// SPDX-License-Identifier: GPL-3.0-or-later
// Traits épais (affichage des épaisseurs de ligne, LWDISPLAY) : segments élargis sur la carte graphique
// (LineSegments2). L'épaisseur est une longueur sur le papier (mm), convertie en pixels à chaque image selon
// le zoom de la présentation, au moins 1 pixel — comme AutoCAD dans une présentation.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const DEFAULT_LW_MM = 0.18; // épaisseur « Défaut » (LWDEFAULT), comme au tracé PDF

// Épaisseur en mm d'une valeur DXF (centièmes de mm ; négative = Défaut, def en mm).
export const lwMm = (v, def = DEFAULT_LW_MM) => (v > 0 ? v / 100 : def);

// Segments (positions xyz par paires, couleurs en octets) d'une même épaisseur.
export function fatLines(pos, col, material) {
  const g = new LineSegmentsGeometry();
  g.setPositions(pos);
  const c = new Float32Array(col.length);
  for (let i = 0; i < col.length; i++) c[i] = col[i] / 255;
  g.setColors(c);
  return new LineSegments2(g, material);
}

// Matériaux partagés, par épaisseur, couleur imposée (null : couleurs des objets) et opacité.
const materials = new Map();
export function fatMaterial(mm, color = null, opacity = 1) {
  const key = `${mm}|${color ?? 'v'}|${opacity}`;
  let m = materials.get(key);
  if (!m) {
    m = new LineMaterial({
      linewidth: 1, worldUnits: false, vertexColors: color == null, color: color ?? 0xffffff,
      transparent: opacity < 1, opacity, depthTest: false, depthWrite: false,
    });
    m.userData.mm = mm;
    materials.set(key, m);
  }
  return m;
}

// Avant chaque image : largeur en pixels de chaque matériau (pxPerMm : pixels de l'écran par mm de papier).
export function updateFatMaterials(pxPerMm, width, height) {
  for (const m of materials.values()) {
    m.linewidth = Math.max(1, m.userData.mm * pxPerMm);
    m.resolution.set(width, height);
  }
}

// Matériaux simples pour les fenêtres (couleur / transparence imposées par calque).
const basics = new Map();
export function overrideMaterial(kind, color, opacity) {
  const key = `${kind}|${color ?? 'v'}|${opacity}`;
  let m = basics.get(key);
  if (!m) {
    const common = { vertexColors: color == null, transparent: opacity < 1, opacity, depthTest: false, depthWrite: false };
    if (color != null) common.color = color;
    m = kind === 'fill'
      ? new THREE.MeshBasicMaterial({ ...common, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : kind === 'point' ? new THREE.PointsMaterial({ ...common, size: 3, sizeAttenuation: false })
        : new THREE.LineBasicMaterial(common);
    basics.set(key, m);
  }
  return m;
}
