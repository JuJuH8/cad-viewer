// SPDX-License-Identifier: GPL-3.0-or-later
// Réservations (trémies) : traversées des murs par les réseaux MEP. Les deux faces d'un même mur
// (intersections proches le long du réseau) donnent une seule réservation, dont l'épaisseur est la
// distance entre les faces ; la section est celle du réseau (calorifuge compris) plus un jeu.
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { planWidth, sectionLabel } from './systems.js';
import { curvePoints } from '../core/tessellate.js';

const isRun = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2;

// Segments des murs (lignes, polylignes, arcs… déjà ramenés en coordonnées du dessin).
function wallSegments(walls) {
  const segs = [];
  for (const w of walls) {
    const c = curvePoints(w);
    if (!c || c.pts.length < 2) continue;
    for (let i = 1; i < c.pts.length; i++) segs.push([c.pts[i - 1], c.pts[i]]);
    if (c.closed || (w.type === 'LWPOLYLINE' && w.closed)) segs.push([c.pts[c.pts.length - 1], c.pts[0]]);
  }
  return segs;
}

// opts : { margin (jeu de chaque côté), maxThickness (épaisseur de mur maximale pour regrouper deux faces) }.
// Renvoie [{ run, p (centre), dir (direction du réseau), w, h (section réservée), thickness, z }].
export function findReservations(runs, walls, { margin = 50, maxThickness = 600 } = {}) {
  const segs = wallSegments(walls);
  const tree = new RBush();
  tree.load(segs.map(([c, d], i) => ({ minX: Math.min(c[0], d[0]), minY: Math.min(c[1], d[1]), maxX: Math.max(c[0], d[0]), maxY: Math.max(c[1], d[1]), i })));
  const out = [];
  for (const e of runs.filter(isRun)) {
    const m = e.mep;
    const round = m.kind === 'pipe' || m.shape === 'round';
    const w = (round ? m.d : planWidth(m)) + 2 * (m.ins || 0) + 2 * margin;
    const h = (round ? m.d : m.h || (m.kind === 'tray' ? 60 : planWidth(m))) + 2 * (m.ins || 0) + 2 * margin;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const len = G.dist(a, b);
      if (len < 1e-9) continue;
      // Intersections le long du tronçon (paramètre t), triées.
      const ts = [];
      const near = tree.search({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) });
      for (const { i: si } of near) {
        const [c, d] = segs[si];
        const x = G.segSeg(a, b, c, d, 1e-9);
        if (x) ts.push(x.t);
      }
      ts.sort((x, y) => x - y);
      // Regroupement des faces d'un même mur.
      for (let k = 0; k < ts.length;) {
        let j = k;
        while (j + 1 < ts.length && (ts[j + 1] - ts[k]) * len <= maxThickness) j++;
        const t0 = ts[k], t1 = ts[j];
        const dir = G.norm(G.sub(b, a));
        out.push({
          run: e.id, system: m.system, section: sectionLabel(m), kind: m.kind,
          p: G.lerp(a, b, (t0 + t1) / 2), dir, w, h, thickness: (t1 - t0) * len, z: m.z || 0,
        });
        k = j + 1;
      }
    }
  }
  return out;
}

// Symbole : rectangle (largeur réservée × épaisseur du mur, au moins la largeur / 4) et croix.
export function reservationEntities(r, layer, textH) {
  const u = r.dir, n = G.perp(u);
  const depth = Math.max(r.thickness, r.w / 4);
  const c = r.p;
  const P = (su, sn) => G.add(c, G.add(G.mul(u, (su * depth) / 2), G.mul(n, (sn * r.w) / 2)));
  const pts = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)];
  return [
    { type: 'LWPOLYLINE', layer, color: 256, pts, bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 },
    { type: 'LINE', layer, color: 256, p1: [...pts[0], 0], p2: [...pts[2], 0] },
    { type: 'LINE', layer, color: 256, p1: [...pts[1], 0], p2: [...pts[3], 0] },
    {
      type: 'TEXT', layer, color: 256, p: [...G.add(c, G.mul(n, r.w / 2 + textH * 1.2)), 0], h: textH, rot: 0,
      text: `R ${Math.round(r.w)}×${Math.round(r.h)}`, align: 'center', valign: 'middle', wf: 1,
    },
  ];
}

export function reservationsCsv(list, unitM = 0.001) {
  const num = (v, d = 2) => v.toFixed(d).replace('.', ',');
  const lines = ['N°;Système;Section du réseau;Réservation L×H (mm);Épaisseur du mur (mm);Altitude axe (m);X;Y',
    ...list.map((r, i) => [i + 1, r.system, r.section, `${Math.round(r.w)}×${Math.round(r.h)}`, Math.round(r.thickness), num(r.z * unitM), num(r.p[0], 0), num(r.p[1], 0)].join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
