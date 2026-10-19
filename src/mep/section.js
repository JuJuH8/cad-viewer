// SPDX-License-Identifier: GPL-3.0-or-later
// Coupe des réseaux MEP le long d'une ligne de coupe (COUPE) : sections des gaines, canalisations et
// chemins de câbles coupés, à leur altitude, et réseaux vus en élévation dans la profondeur de vue.
// La coupe est dessinée à l'échelle 1:1 : X = abscisse le long de la ligne de coupe, Y = altitude.
import * as G from '../core/geom.js';
import { planWidth, sectionLabel, vertexZ } from './systems.js';
import { curvePoints } from '../core/tessellate.js';

const isRun = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2 && ['duct', 'pipe', 'tray'].includes(e.mep.kind);

// Dimensions vues en coupe : largeur w (dans le plan), hauteur h, forme ronde ou non, bas (z0) et haut (z1).
function profile(m, z = m.z || 0) {
  const round = m.kind === 'pipe' || m.shape === 'round';
  const w = round ? m.d : planWidth(m);
  const h = round ? m.d : m.h || (m.kind === 'tray' ? 60 : w);
  const [z0, z1] = m.kind === 'tray' ? [z, z + h] : [z - h / 2, z + h / 2];
  return { round, w, h, z0, z1, zc: (z0 + z1) / 2, ins: m.ins || 0 };
}

// opts : { depth (profondeur de vue, côté gauche de p1 → p2), base (point d'insertion), unitM (m par unité), textH }
export function sectionEntities(entities, p1, p2, opts) {
  const L = G.dist(p1, p2);
  if (!(L > 0)) return [];
  const u = G.norm(G.sub(p2, p1));
  const n = G.perp(u); // sens de la vue : à gauche de la ligne de coupe
  const depth = opts.depth ?? 2000;
  const bx = opts.base[0], by = opts.base[1];
  const th = opts.textH || 100;
  const unitM = opts.unitM ?? 0.001;
  const out = [];
  const line = (x0, y0, x1, y1, layer, extra = {}) => out.push({ type: 'LINE', layer, color: 256, p1: [bx + x0, by + y0, 0], p2: [bx + x1, by + y1, 0], ...extra });
  const text = (x, y, s, layer, extra = {}) => out.push({ type: 'TEXT', layer, color: 256, p: [bx + x, by + y, 0], h: th, rot: 0, text: s, align: 'left', valign: 'middle', wf: 1, ...extra });
  const zTxt = (z) => `${z * unitM >= 0 ? '+' : ''}${(z * unitM).toFixed(2).replace('.', ',')}`;
  let zMax = 0;
  const cut = [];
  for (const e of entities) {
    if (!isRun(e)) continue;
    const m = e.mep;
    const vz = vertexZ(e);
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const zOf = (t) => vz[i - 1] + (vz[i] - vz[i - 1]) * t; // altitude de l'axe le long du tronçon
      const pr = profile(m, Math.max(vz[i - 1], vz[i]));
      zMax = Math.max(zMax, pr.z1 + pr.ins);
      const x = G.segSeg(p1, p2, a, b);
      if (x && i > 1 && x.u < 1e-9) continue; // déjà comptée à la fin du tronçon précédent
      // Tronçon coupé : section vraie (largeur apparente si la coupe est oblique). Presque parallèle à la coupe :
      // dessiné en élévation comme un tronçon vu.
      const sin = x ? Math.abs(G.cross(u, G.norm(G.sub(b, a)))) : 0;
      if (x && sin >= 0.05) {
        const xc = x.t * L;
        const wv = pr.w / sin;
        const zc = zOf(x.u);
        cut.push({ e, xc, pr: profile(m, zc), wv, z: zc });
        continue;
      }
      // Tronçon vu dans la profondeur : ses deux extrémités devant la coupe, à moins de `depth`.
      const da = G.dot(G.sub(a, p1), n), db = G.dot(G.sub(b, p1), n);
      // Partie du tronçon comprise entre la coupe et la profondeur de vue (0 ≤ distance ≤ depth).
      let t0 = 0, t1 = 1;
      for (const [lim, sign] of [[0, 1], [depth, -1]]) {
        const fa = sign * (da - lim), fb = sign * (db - lim);
        if (fa < 0 && fb < 0) { t0 = 1; t1 = 0; break; }
        if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
        else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
      }
      if (t1 - t0 < 1e-9) continue;
      const ca = G.lerp(a, b, t0), cb = G.lerp(a, b, t1);
      let xa = G.dot(G.sub(ca, p1), u), xb = G.dot(G.sub(cb, p1), u);
      let ta = t0, tb = t1;
      if (xa > xb) { [xa, xb] = [xb, xa]; [ta, tb] = [tb, ta]; }
      // Bornes ramenées dans [0, L] : paramètre du tronçon recalculé pour l'altitude.
      const xa0 = xa, xb0 = xb;
      xa = Math.max(0, xa); xb = Math.min(L, xb);
      if (xb - xa < 1e-6) continue;
      const tOf = (x) => (xb0 - xa0 > 1e-12 ? ta + (tb - ta) * ((x - xa0) / (xb0 - xa0)) : ta);
      const pa = profile(m, zOf(tOf(xa))), pb = profile(m, zOf(tOf(xb)));
      const layer = e.layer;
      line(xa, pa.z0, xb, pb.z0, layer);
      line(xa, pa.z1, xb, pb.z1, layer);
    }
  }
  for (const { e, xc, pr, wv, z } of cut) {
    const layer = e.layer;
    const x0 = xc - wv / 2, x1 = xc + wv / 2;
    if (pr.round) {
      out.push({ type: 'CIRCLE', layer, color: 256, c: [bx + xc, by + pr.zc, 0], r: pr.w / 2 });
      if (pr.ins) out.push({ type: 'CIRCLE', layer, color: 256, c: [bx + xc, by + pr.zc, 0], r: pr.w / 2 + pr.ins, ltype: 'DASHED' });
    } else {
      out.push({ type: 'LWPOLYLINE', layer, color: 256, pts: [[bx + x0, by + pr.z0], [bx + x1, by + pr.z0], [bx + x1, by + pr.z1], [bx + x0, by + pr.z1]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
      if (e.mep.kind !== 'tray') { line(x0, pr.z0, x1, pr.z1, layer); line(x0, pr.z1, x1, pr.z0, layer); }
      if (pr.ins) {
        const k = pr.ins;
        out.push({ type: 'LWPOLYLINE', layer, color: 256, ltype: 'DASHED', pts: [[bx + x0 - k, by + pr.z0 - k], [bx + x1 + k, by + pr.z0 - k], [bx + x1 + k, by + pr.z1 + k], [bx + x0 - k, by + pr.z1 + k]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
      }
    }
    text(xc + wv / 2 + pr.ins + th * 0.5, pr.zc + th * 0.6, `${e.mep.system} ${sectionLabel(e.mep)}`, layer);
    text(xc + wv / 2 + pr.ins + th * 0.5, pr.zc - th * 0.6, `Z ${zTxt(z)}`, layer);
  }
  // Murs coupés (opts.walls : objets des calques de murs) : les deux faces d'un mur donnent une bande hachurée
  // sur la hauteur d'étage, une face isolée un simple trait.
  const floorH = Math.max(opts.wallHeight || 3 / unitM, zMax + 0.2 / unitM); // 3 m, ou 20 cm au-dessus des réseaux
  if (opts.walls?.length) {
    const xs = [];
    for (const w of opts.walls) {
      const c = curvePoints(w);
      if (!c || c.pts.length < 2) continue;
      const pts = c.closed || (w.type === 'LWPOLYLINE' && w.closed) ? [...c.pts, c.pts[0]] : c.pts;
      for (let i = 1; i < pts.length; i++) {
        const x = G.segSeg(p1, p2, pts[i - 1], pts[i], 1e-9);
        if (x) xs.push(x.t * L);
      }
    }
    xs.sort((a, b) => a - b);
    const maxT = (opts.maxWallThickness ?? 0.6 / unitM);
    for (let k = 0; k < xs.length;) {
      let j = k;
      while (j + 1 < xs.length && xs[j + 1] - xs[k] <= maxT) j++;
      const x0 = xs[k], x1 = xs[j];
      if (x1 - x0 < 1e-9) line(x0, 0, x0, floorH, opts.layer);
      else {
        out.push({ type: 'LWPOLYLINE', layer: opts.layer, color: 256, pts: [[bx + x0, by], [bx + x1, by], [bx + x1, by + floorH], [bx + x0, by + floorH]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
        // Hachures à 45° tous les (x1 − x0) : lecture immédiate du mur coupé.
        const step = Math.max(x1 - x0, floorH / 40);
        for (let y = 0; y < floorH; y += step) line(x0, y, x1, Math.min(floorH, y + (x1 - x0)), opts.layer);
      }
      k = j + 1;
    }
  }
  // Niveau 0, cadre et titre.
  const top = Math.max(zMax * 1.15, th * 10, opts.walls?.length ? floorH : 0);
  line(0, 0, L, 0, opts.layer, {});
  text(-th * 6, 0, '±0,00', opts.layer);
  line(0, 0, 0, top, opts.layer, { ltype: 'DASHED' });
  line(L, 0, L, top, opts.layer, { ltype: 'DASHED' });
  text(L / 2, -th * 2.5, opts.title || 'COUPE', opts.layer, { h: th * 1.6, align: 'center' });
  return out;
}

// Symbole de la ligne de coupe en plan : trait mixte, flèches vers la vue, repères aux extrémités.
export function sectionMarker(p1, p2, name, layer, size) {
  const u = G.norm(G.sub(p2, p1));
  const n = G.perp(u);
  const out = [{ type: 'LINE', layer, color: 256, p1: [p1[0], p1[1], 0], p2: [p2[0], p2[1], 0], ltype: 'DASHED' }];
  for (const [p, sign] of [[p1, -1], [p2, 1]]) {
    const tip = G.add(p, G.mul(n, size * 2));
    const back = G.add(p, G.mul(n, size * 1.2));
    out.push(
      { type: 'LINE', layer, color: 256, p1: [p[0], p[1], 0], p2: [tip[0], tip[1], 0] },
      { type: 'SOLID', layer, color: 256, pts: [tip, G.add(back, G.mul(u, size * 0.4)), G.sub(back, G.mul(u, size * 0.4)), G.sub(back, G.mul(u, size * 0.4))], z: 0 },
      { type: 'TEXT', layer, color: 256, p: [p[0] + sign * u[0] * size * 1.5, p[1] + sign * u[1] * size * 1.5, 0], h: size * 1.2, rot: 0, text: name, align: 'center', valign: 'middle', wf: 1 },
    );
  }
  return out;
}
