// SPDX-License-Identifier: GPL-3.0-or-later
// Raccordements (piquages) : une gaine ou un chemin de câbles dont l'extrémité est posée sur
// un autre réseau de même nature s'arrête sur la paroi de celui-ci au lieu de le traverser.
import * as G from '../core/geom.js';
import { planWidth } from './systems.js';

// Paroi de `main` rencontrée par la droite (from → to), du côté de `from`.
function wallHit(main, seg, from, to) {
  const hw = planWidth(main.mep) / 2;
  const [a, b] = seg;
  const dir = G.norm(G.sub(b, a));
  const n = G.perp(dir);
  const side = Math.sign(G.dot(G.sub(from, a), n)) || 1;
  const wa = G.add(a, G.mul(n, hw * side)), wb = G.add(b, G.mul(n, hw * side));
  const x = G.lineLine(from, to, wa, wb);
  return x ? x.point : null;
}

// Renvoie les sommets ajustés de `e` (ou les sommets d'origine si aucun raccordement).
export function connectEnds(e, others) {
  if (!e.mep || e.mep.kind === 'pipe' || e.pts.length < 2) return e.pts;
  const pts = e.pts.map((p) => [p[0], p[1]]);
  const ends = [[0, 1], [pts.length - 1, pts.length - 2]];
  for (const [i, j] of ends) {
    const p = pts[i], q = pts[j];
    let best = null;
    for (const o of others) {
      if (o.id === e.id || !o.mep || o.type !== 'LWPOLYLINE' || o.mep.kind !== e.mep.kind || o.pts.length < 2) continue;
      const hw = planWidth(o.mep) / 2;
      for (let k = 1; k < o.pts.length; k++) {
        const a = o.pts[k - 1], b = o.pts[k];
        const r = G.closestOnSegment(p, a, b);
        if (r.d > hw + 1e-6 || r.t <= 1e-6 || r.t >= 1 - 1e-6) continue; // extrémité hors de la gaine, ou sur un bout
        // Tronçon parallèle à la gaine principale : c'est un prolongement, pas un piquage.
        const cos = Math.abs(G.dot(G.norm(G.sub(q, p)), G.norm(G.sub(b, a))));
        if (cos > 0.98) continue;
        const hit = wallHit(o, [a, b], q, p);
        if (hit && (!best || r.d < best.d)) best = { d: r.d, hit };
      }
    }
    if (best) pts[i] = best.hit;
  }
  return pts;
}
