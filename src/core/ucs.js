// SPDX-License-Identifier: GPL-3.0-or-later
// Système de coordonnées utilisateur (SCU, UCS d'AutoCAD) en 2D : une origine et l'angle de son axe X, propre à
// chaque espace (objet, présentations). Les coordonnées tapées, l'affichage du curseur, ORTHO, POLAIRE, le
// repérage, la grille et le pas suivent le SCU ; la géométrie reste en coordonnées générales (SCG).
// doc.header.ucs = { [espace]: { origin: [x, y], angle, name } } ; SCU nommés : doc.ucsTable (nom en majuscules).
import * as G from './geom.js';

export const WORLD = Object.freeze({ origin: Object.freeze([0, 0]), angle: 0, name: '' });

export const spaceOf = (doc) => doc?.currentSpace || 'model';
export const ucsOf = (doc, space = spaceOf(doc)) => doc?.header?.ucs?.[space] || WORLD;

export const isWorld = (u) => !u || (Math.abs(u.origin[0]) < 1e-12 && Math.abs(u.origin[1]) < 1e-12 && Math.abs(G.normAngle(u.angle)) < 1e-12);

// SCG → SCU.
export function toUcs(u, p) {
  if (isWorld(u)) return [p[0], p[1]];
  const dx = p[0] - u.origin[0], dy = p[1] - u.origin[1], c = Math.cos(u.angle), s = Math.sin(u.angle);
  return [dx * c + dy * s, -dx * s + dy * c];
}

// SCU → SCG.
export function fromUcs(u, p) {
  if (isWorld(u)) return [p[0], p[1]];
  const c = Math.cos(u.angle), s = Math.sin(u.angle);
  return [u.origin[0] + p[0] * c - p[1] * s, u.origin[1] + p[0] * s + p[1] * c];
}

// Vecteur du SCU (déplacement relatif) → SCG.
export function vecFromUcs(u, v) {
  if (!u?.angle) return [v[0], v[1]];
  const c = Math.cos(u.angle), s = Math.sin(u.angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

// SCU défini par une origine et un point de son axe X (angle gardé si le point manque ou est confondu).
export function ucsFromPoints(origin, xPoint, keepAngle = 0) {
  const angle = xPoint && G.dist(origin, xPoint) > 1e-12 ? Math.atan2(xPoint[1] - origin[1], xPoint[0] - origin[0]) : keepAngle;
  return { origin: [origin[0], origin[1]], angle: G.normAngle(angle), name: '' };
}

// Axes du SCU (vecteurs unitaires X et Y, en 3D pour le DXF).
export function ucsAxes(u) {
  const c = Math.cos(u.angle || 0), s = Math.sin(u.angle || 0);
  return { x: [c, s, 0], y: [-s, c, 0] };
}

// SCU lu dans un fichier : origine et axe X (objets { x, y } ou tableaux).
export function ucsFromAxes(origin, xAxis, name = '') {
  const o = Array.isArray(origin) ? origin : [origin?.x || 0, origin?.y || 0];
  const xa = Array.isArray(xAxis) ? xAxis : [xAxis?.x ?? 1, xAxis?.y ?? 0];
  return { origin: [o[0], o[1]], angle: G.normAngle(Math.atan2(xa[1], xa[0])), name: name || '' };
}

// SCU courant d'un espace (annulable ; la géométrie n'est pas reconstruite) ; l'ancien est gardé pour « Précédent ».
export function setUcs(doc, ucs, space = spaceOf(doc)) {
  const prev = ucsOf(doc, space);
  if (!doc.ucsHistory) doc.ucsHistory = {};
  (doc.ucsHistory[space] ||= []).push(prev);
  if (doc.ucsHistory[space].length > 10) doc.ucsHistory[space].shift();
  const all = { ...(doc.header?.ucs || {}) };
  if (isWorld(ucs) && !ucs.name) delete all[space]; else all[space] = { origin: [ucs.origin[0], ucs.origin[1]], angle: G.normAngle(ucs.angle || 0), name: ucs.name || '' };
  doc.setHeader({ ucs: all }, { light: true });
}

export function previousUcs(doc, space = spaceOf(doc)) {
  const h = doc.ucsHistory?.[space];
  if (!h?.length) return null;
  const u = h.pop();
  const all = { ...(doc.header?.ucs || {}) };
  if (isWorld(u) && !u.name) delete all[space]; else all[space] = u;
  doc.setHeader({ ucs: all }, { light: true });
  return u;
}

// Icône du SCU : { on, origin } (affichée, placée à l'origine quand elle est visible).
export const ucsIconOf = (doc) => ({ on: true, origin: true, ...(doc?.header?.ucsIcon || {}) });
