// SPDX-License-Identifier: GPL-3.0-or-later
// Détection d'interférences entre réseaux MEP.
// Chaque tronçon droit est un volume horizontal : emprise en plan (segment épaissi de sa
// demi-largeur) et plage d'altitude. Deux tronçons de systèmes différents sont en conflit si
// leurs emprises en plan se touchent ET leurs plages d'altitude se chevauchent (jeu compris).
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { planWidth, vertexZ, EMBEDDED } from './systems.js';

// Plage d'altitude d'un tronçon dont l'axe va de za à zb (réseau en pente).
function zRange(m, za = m.z || 0, zb = za) {
  const round = m.kind === 'pipe' || m.shape === 'round';
  const h = round ? m.d : (m.h || (m.kind === 'tray' ? 60 : planWidth(m)));
  const lo = Math.min(za, zb), hi = Math.max(za, zb), ins = m.ins || 0;
  return m.kind === 'tray' ? [lo - ins, hi + h + ins] : [lo - h / 2 - ins, hi + h / 2 + ins];
}

function halfWidth(m) {
  const round = m.kind === 'pipe' || m.shape === 'round';
  return (round ? m.d : planWidth(m)) / 2 + (m.ins || 0); // calorifuge compris
}

// Distance minimale entre deux segments 2D (0 s'ils se coupent) et point le plus proche.
export function segmentDistance(a1, a2, b1, b2) {
  const x = G.segSeg(a1, a2, b1, b2);
  if (x) return { d: 0, p: x.point };
  const c = [
    { ...G.closestOnSegment(a1, b1, b2), from: a1 },
    { ...G.closestOnSegment(a2, b1, b2), from: a2 },
    { ...G.closestOnSegment(b1, a1, a2), from: b1 },
    { ...G.closestOnSegment(b2, a1, a2), from: b2 },
  ].sort((u, v) => u.d - v.d)[0];
  return { d: c.d, p: G.mid(c.point, c.from) };
}

// entities : objets MEP (LWPOLYLINE + mep). clearance : jeu minimal exigé entre réseaux.
export function findClashes(entities, { clearance = 0, sameSystem = false } = {}) {
  const segs = [];
  for (const e of entities) {
    if (!e.mep || e.type !== 'LWPOLYLINE' || e.pts.length < 2) continue;
    if (e.mep.conduit && EMBEDDED.has(e.mep.embed || 'dalle')) continue; // tube noyé dans la structure : pas de conflit MEP
    const hw = halfWidth(e.mep), vz = vertexZ(e);
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const [z0, z1] = zRange(e.mep, vz[i - 1], vz[i]);
      const [lo, hi] = zRange(e.mep, 0); // plage autour de l'axe (pour l'altitude au point de conflit)
      const pad = hw + clearance / 2;
      segs.push({
        id: e.id, system: e.mep.system, a, b, hw, z0, z1, i, za: vz[i - 1], zb: vz[i], lo, hi,
        minX: Math.min(a[0], b[0]) - pad, maxX: Math.max(a[0], b[0]) + pad,
        minY: Math.min(a[1], b[1]) - pad, maxY: Math.max(a[1], b[1]) + pad,
      });
    }
  }
  const tree = new RBush();
  tree.load(segs);
  const found = new Map();
  for (const s of segs) {
    for (const t of tree.search(s)) {
      if (t.id <= s.id) continue;                          // chaque paire une seule fois, jamais avec soi-même
      if (!sameSystem && t.system === s.system) continue;   // même réseau : ce sont des raccordements
      let zGap = Math.max(s.z0, t.z0) - Math.min(s.z1, t.z1); // < 0 : les plages se chevauchent
      if (zGap >= clearance) continue;
      const { d, p } = segmentDistance(s.a, s.b, t.a, t.b);
      const planGap = d - s.hw - t.hw;
      if (planGap >= clearance) continue;
      // Tronçon en pente : altitudes comparées sur toute la zone où les emprises en plan se touchent
      // (point de conflit et échantillons le long des deux tronçons).
      if (s.za !== s.zb || t.za !== t.zb) {
        const zr = (g, q) => { const z = g.za + (g.zb - g.za) * G.closestOnSegment(q, g.a, g.b).t; return [z + g.lo, z + g.hi]; };
        const gapAt = (qs, qt) => { const [a0, a1] = zr(s, qs), [b0, b1] = zr(t, qt); return Math.max(a0, b0) - Math.min(a1, b1); };
        let best = gapAt(p, p);
        for (let k = 0; k <= 16; k++) {
          for (const [g, h, gs] of [[s, t, true], [t, s, false]]) {
            const q = G.lerp(g.a, g.b, k / 16);
            const c = G.closestOnSegment(q, h.a, h.b);
            if (c.d - g.hw - h.hw >= clearance) continue;
            best = Math.min(best, gs ? gapAt(q, c.point) : gapAt(c.point, q));
          }
        }
        zGap = best;
        if (zGap >= clearance) continue;
      }
      const key = `${s.id}-${t.id}`;
      const depth = Math.min(-planGap, -zGap);
      const prev = found.get(key);
      if (!prev || depth > prev.depth) {
        found.set(key, { a: s.id, b: t.id, p, depth, planGap, zGap, systems: [s.system, t.system] });
      }
    }
  }
  return [...found.values()].sort((x, y) => y.depth - x.depth);
}
