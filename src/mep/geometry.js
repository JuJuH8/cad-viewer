// SPDX-License-Identifier: GPL-3.0-or-later
// Représentation en plan des objets MEP à partir de leur axe (polyligne) :
// gaine / chemin de câbles → double trait + extrémités + étiquette de section,
// canalisation → trait d'axe + étiquette « Ø… système ».
import * as G from '../core/geom.js';
import { offsetSigned, pathOf } from '../core/path.js';
import { sectionLabel, planWidth, slopeText, riseDrops, EMBED_LABELS } from './systems.js';

function axisOf(e) {
  return { type: 'LWPOLYLINE', pts: e.pts, bulges: e.bulges || e.pts.map(() => 0), closed: false, z: e.z || 0, width: 0 };
}

// Coudes de l'axe : pour chaque sommet, déviation signée (turn) et longueur de tangente t (0 = angle vif).
// Chemin de câbles : tronçons droits et coudes du catalogue, jamais réduits ; un coude qui ne tient pas
// entre ses voisins devient un coude à onglet (indices dans `short`). Gaine : rayon réduit si la place manque.
export function elbowPlan(e, R = elbowRadius(e)) {
  const pts = e.pts, n = pts.length;
  const turn = pts.map((v, i) => {
    if (i === 0 || i === n - 1) return 0;
    const d1 = G.norm(G.sub(v, pts[i - 1])), d2 = G.norm(G.sub(pts[i + 1], v));
    return Math.atan2(G.cross(d1, d2), G.dot(d1, d2));
  });
  const bends = turn.map((a) => Math.abs(a) > 1e-6 && Math.abs(Math.abs(a) - Math.PI) > 1e-6);
  const t = turn.map((a, i) => (bends[i] && R > 0 ? R * Math.tan(Math.abs(a) / 2) : 0));
  const short = [];
  if (e.mep?.kind === 'tray') {
    for (let changed = true; changed;) {
      changed = false;
      for (let k = 1; k < n; k++) {
        const L = G.dist(pts[k - 1], pts[k]);
        if (t[k - 1] + t[k] <= L * (1 + 1e-9)) continue;
        const j = t[k - 1] >= t[k] ? k - 1 : k; // le plus grand coude passe en onglet
        t[j] = 0;
        short.push(j);
        changed = true;
      }
    }
    short.sort((a, b) => a - b);
  } else {
    let prev = pts[0];
    for (let i = 1; i < n - 1; i++) {
      if (!t[i]) { prev = pts[i]; continue; }
      t[i] = Math.min(t[i], G.dist(prev, pts[i]) * 0.5, G.dist(pts[i], pts[i + 1]) * 0.5); // place disponible
      prev = G.add(pts[i], G.mul(G.norm(G.sub(pts[i + 1], pts[i])), t[i]));
    }
  }
  return { turn, t, bends, short, R };
}

// Axe avec coudes à rayon : chaque sommet intérieur est remplacé par un arc tangent (voir elbowPlan).
// Les arcs déjà présents sont conservés tels quels. `corners` : indices des angles vifs (coudes à onglet).
export function filletedAxis(e, R) {
  const axis = axisOf(e);
  const n = axis.pts.length;
  if (n < 3 || !(R > 0) || axis.bulges.some((b) => b)) return { ...axis, corners: Array.from({ length: Math.max(0, n - 2) }, (_, i) => i + 1) };
  const plan = elbowPlan(e, R);
  const pts = [[axis.pts[0][0], axis.pts[0][1]]];
  const bulges = [];
  const corners = [];
  for (let i = 1; i < n - 1; i++) {
    const a = axis.pts[i - 1], v = axis.pts[i], c = axis.pts[i + 1];
    const t = plan.t[i];
    if (!t) {
      bulges.push(0);
      pts.push([v[0], v[1]]);
      if (plan.bends[i]) corners.push(pts.length - 1);
      continue;
    }
    const d1 = G.norm(G.sub(v, a)), d2 = G.norm(G.sub(c, v));
    const t1 = G.sub(v, G.mul(d1, t)), t2 = G.add(v, G.mul(d2, t));
    bulges.push(0);                       // tronçon droit jusqu'au début du coude
    pts.push(t1);
    bulges.push(Math.tan(plan.turn[i] / 4)); // arc tangent du coude
    pts.push(t2);
  }
  bulges.push(0);
  pts.push([axis.pts[n - 1][0], axis.pts[n - 1][1]]);
  bulges.push(0);
  // Tronçons de longueur nulle (deux coudes bout à bout) retirés.
  for (let k = pts.length - 1; k > 0; k--) {
    if (G.dist(pts[k - 1], pts[k]) > 1e-9 || bulges[k - 1]) continue;
    pts.splice(k, 1);
    bulges.splice(k - 1, 1);
    for (let c = 0; c < corners.length; c++) if (corners[c] >= k) corners[c]--;
  }
  return { ...axis, pts, bulges, corners, short: plan.short };
}

// Rayon d'axe des coudes (0 = onglet). Chemin de câbles : rayon intérieur du catalogue (mep.ri, unités du
// dessin ; à défaut la demi-largeur) + demi-largeur. Gaine : rayon d'axe égal à la largeur.
export function elbowRadius(e) {
  const m = e.mep;
  // Tube électrique souple : courbes larges (20 × le diamètre), réduites si la place manque — pas de coude.
  if (m.conduit) return 20 * (m.d || 20);
  if (m.kind === 'pipe' || m.elbow === 'miter') return 0;
  const w = planWidth(m);
  if (m.kind === 'tray') return (m.ri > 0 ? m.ri : w / 2) + w / 2;
  return w;
}

export function mepLength(e) {
  return pathOf(axisOf(e)).curves.reduce((s, c) => s + (c.k === 'seg' ? G.dist(c.a, c.b) : Math.abs(c.sw) * c.r), 0);
}

// Hauteur de texte par défaut des étiquettes.
export function labelHeight(e) {
  const m = e.mep;
  if (m.th) return m.th;
  const w = planWidth(m);
  return w > 0 ? Math.min(Math.max(w * 0.3, 40), 150) : 80;
}

// Ouvertures dans les parois de `walls` au droit des piquages (réseaux voisins de même nature dont
// une extrémité est posée sur la paroi) : intervalles [t0, t1] par segment de paroi.
function openings(e, walls, neighbors) {
  const out = walls.map((w) => w.pts.slice(1).map(() => []));
  const tol = Math.max(1e-6, planWidth(e.mep) * 1e-4);
  for (const n of neighbors) {
    if (n.id === e.id || !n.mep || n.type !== 'LWPOLYLINE' || n.mep.kind !== e.mep.kind || n.pts.length < 2) continue;
    const wn = planWidth(n.mep);
    if (!(wn > 0)) continue;
    for (const [i, j] of [[0, 1], [n.pts.length - 1, n.pts.length - 2]]) {
      const p = n.pts[i], q = n.pts[j];
      const dir = G.norm(G.sub(q, p));
      walls.forEach((wall, wi) => {
        for (let k = 1; k < wall.pts.length; k++) {
          if (wall.bulges?.[k - 1]) continue; // paroi courbe (coude) : pas de piquage
          const a = wall.pts[k - 1], b = wall.pts[k];
          const r = G.closestOnSegment(p, a, b);
          if (r.d > tol || r.t <= 0 || r.t >= 1) continue;
          const len = G.dist(a, b);
          const sin = Math.abs(G.cross(dir, G.norm(G.sub(b, a))));
          if (sin < 0.2) continue;
          const half = wn / 2 / sin / len;
          out[wi][k - 1].push([r.t - half, r.t + half]);
        }
      });
    }
  }
  return out;
}

// Prolongement : l'extrémité p de `e` coïncide avec une extrémité d'un voisin de même nature, dans
// l'alignement. Renvoie la largeur du voisin (pour dessiner une réduction), sinon null.
function continuationWidth(e, end, neighbors) {
  const pts = e.pts;
  const p = end === 0 ? pts[0] : pts[pts.length - 1];
  const q = end === 0 ? pts[1] : pts[pts.length - 2];
  const dir = G.norm(G.sub(p, q)); // vers l'extérieur
  const tol = Math.max(1e-6, planWidth(e.mep) * 1e-4);
  for (const n of neighbors) {
    if (n.id === e.id || !n.mep || n.type !== 'LWPOLYLINE' || n.mep.kind !== e.mep.kind || n.pts.length < 2) continue;
    for (const [i, j] of [[0, 1], [n.pts.length - 1, n.pts.length - 2]]) {
      if (G.dist(n.pts[i], p) > tol) continue;
      const nd = G.norm(G.sub(n.pts[j], n.pts[i]));
      if (G.dot(dir, nd) > 0.98) return planWidth(n.mep);
    }
  }
  return null;
}

// L'extrémité p de `e` est-elle posée sur la paroi d'un voisin de même nature (piquage) ?
function endConnected(e, p, neighbors) {
  for (const n of neighbors) {
    if (n.id === e.id || !n.mep || n.type !== 'LWPOLYLINE' || n.mep.kind !== e.mep.kind || n.pts.length < 2) continue;
    const hw = planWidth(n.mep) / 2;
    const tol = Math.max(1e-6, hw * 2e-4);
    for (let k = 1; k < n.pts.length; k++) {
      const r = G.closestOnSegment(p, n.pts[k - 1], n.pts[k]);
      if (r.t > 0 && r.t < 1 && Math.abs(r.d - hw) <= tol) return true;
    }
  }
  return false;
}

// Polyligne découpée en segments, en retirant les ouvertures (les arcs sont gardés entiers).
function cutWall(pts, holes, bulges = []) {
  const segs = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    if (bulges[k - 1]) {
      segs.push({ entity: { type: 'LWPOLYLINE', pts: [a, b], bulges: [bulges[k - 1], 0], closed: false, z: 0, width: 0 } });
      continue;
    }
    let t = 0;
    for (const [t0, t1] of holes[k - 1].sort((x, y) => x[0] - y[0])) {
      if (t0 > t) segs.push({ pts: [G.lerp(a, b, t), G.lerp(a, b, Math.max(t, t0))] });
      t = Math.max(t, t1);
    }
    if (t < 1) segs.push({ pts: [G.lerp(a, b, t), b] });
  }
  return segs;
}

export function mepGeometry(e, neighbors = []) {
  const m = e.mep;
  const axis = filletedAxis(e, elbowRadius(e));
  const out = { lines: [], labels: [] };
  if (axis.pts.length < 2) return out;
  const w = planWidth(m);
  // Prolongements : à section égale, jonction continue ; si le voisin est plus large, ce réseau-ci
  // (le plus étroit) dessine la réduction en raccourcissant son extrémité de la longueur de transition.
  const cont = [0, 1].map((end) => (w > 0 && neighbors.length ? continuationWidth(e, end, neighbors) : null));
  const tapers = [];
  if (w > 0) {
    [0, 1].forEach((end) => {
      const wn = cont[end];
      if (wn == null || wn <= w + 1e-9) return;
      const L = Math.max((wn - w) * 1.5, w * 0.5);
      const i0 = end === 0 ? 0 : axis.pts.length - 1, i1 = end === 0 ? 1 : axis.pts.length - 2;
      const p = axis.pts[i0], q = axis.pts[i1];
      if (G.dist(p, q) <= L * 1.05 || axis.bulges[end === 0 ? 0 : axis.pts.length - 2]) return; // pas la place
      const dir = G.norm(G.sub(q, p));
      const np = [p[0] + dir[0] * L, p[1] + dir[1] * L];
      axis.pts = axis.pts.map((v, k) => (k === i0 ? np : v));
      const nrm = G.perp(dir);
      tapers.push([G.add(p, G.mul(nrm, wn / 2)), G.add(np, G.mul(nrm, w / 2))], [G.sub(p, G.mul(nrm, wn / 2)), G.sub(np, G.mul(nrm, w / 2))]);
    });
  }
  if (w > 0) {
    const left = offsetSigned(axis, w / 2);
    const right = offsetSigned(axis, -w / 2);
    if (left && right && !Array.isArray(left) && !Array.isArray(right)) {
      const holes = neighbors.length ? openings(e, [left, right], neighbors) : null;
      if (holes && holes.some((wall) => wall.some((h) => h.length))) {
        out.lines.push(...cutWall(left.pts, holes[0], left.bulges), ...cutWall(right.pts, holes[1], right.bulges));
      } else {
        out.lines.push({ entity: left }, { entity: right });
      }
      const l0 = left.pts[0], r0 = right.pts[0];
      const l1 = left.pts[left.pts.length - 1], r1 = right.pts[right.pts.length - 1];
      // Extrémités : pas de trait de fermeture quand la gaine est piquée sur une autre ou prolongée.
      const open0 = cont[0] != null || (neighbors.length && endConnected(e, e.pts[0], neighbors));
      const open1 = cont[1] != null || (neighbors.length && endConnected(e, e.pts[e.pts.length - 1], neighbors));
      if (!open0) out.lines.push({ pts: [l0, r0] });
      if (!open1) out.lines.push({ pts: [l1, r1] });
      for (const t of tapers) out.lines.push({ pts: t });
      // Coudes en onglet : arête entre les sommets intérieur et extérieur, comme sur un plan CVC.
      if (left.pts.length === axis.pts.length && right.pts.length === axis.pts.length) {
        for (const i of axis.corners || []) out.lines.push({ pts: [left.pts[i], right.pts[i]] });
      }
    } else {
      out.lines.push({ entity: axis });
    }
  } else {
    out.lines.push({ entity: axis });
  }
  // Montée / descente vers un prolongement à une autre altitude : carré à la section (cercle pour une
  // canalisation) avec une diagonale pour une montée, deux pour une descente. Dessiné par le réseau d'id le plus petit.
  if (neighbors.length) {
    for (const r of riseDrops(e, neighbors)) {
      if (r.n.id != null && e.id != null && r.n.id < e.id) continue;
      const i = r.end === 0 ? 0 : e.pts.length - 1, j = r.end === 0 ? 1 : e.pts.length - 2;
      const u = G.norm(G.sub(e.pts[i], e.pts[j])), v = G.perp(u);
      const s = (w > 0 ? w : (m.d || 0) * 3 || labelHeight(e)) / 2;
      const c = r.p, P = (a, b) => G.add(c, G.add(G.mul(u, a * s), G.mul(v, b * s)));
      const A = P(-1, -1), B = P(1, -1), C = P(1, 1), D = P(-1, 1);
      if (w > 0) out.lines.push({ pts: [A, B, C, D, A] });
      else out.lines.push({ pts: Array.from({ length: 25 }, (_, k) => G.polar(c, (k / 24) * Math.PI * 2, s)) });
      const f = w > 0 ? 1 : Math.SQRT1_2;
      out.lines.push({ pts: [P(-f, -f), P(f, f)] });
      if (r.dz < 0) out.lines.push({ pts: [P(f, -f), P(-f, f)] });
    }
  }
  // Calorifuge (mep.ins, épaisseur en mm) : contour en tirets à la demi-largeur + épaisseur.
  if (m.ins > 0) {
    const half = (w > 0 ? w : m.d || 0) / 2 + m.ins;
    for (const side of [1, -1]) {
      const o = offsetSigned(axis, side * half);
      if (o && !Array.isArray(o)) out.lines.push({ entity: o, ins: true });
    }
  }
  // Flèches de sens de circulation (mep.flow : 1 = sens du tracé, -1 = sens inverse).
  if (m.flow) {
    const sa = axisOf(e);
    const size = Math.max(labelHeight(e) * 1.2, (w || 0) * 0.35);
    for (let i = 1; i < sa.pts.length; i++) {
      const p0 = sa.pts[i - 1], p1 = sa.pts[i];
      const len = G.dist(p0, p1);
      if (len < size * 4) continue;
      const d = G.mul(G.norm(G.sub(p1, p0)), m.flow < 0 ? -1 : 1);
      // À un quart du tronçon (le milieu porte l'étiquette).
      const tip = G.add(G.lerp(p0, p1, 0.25), G.mul(d, size / 2));
      const back = G.sub(tip, G.mul(d, size));
      const n = G.mul(G.perp(d), size * 0.45);
      out.lines.push({ pts: [G.add(back, n), tip] }, { pts: [G.sub(back, n), tip] });
    }
  }
  // Étiquette au milieu du plus long tronçon, lisible (jamais à l'envers).
  const straightAxis = axisOf(e);
  let best = 0, bi = 0;
  for (let i = 1; i < straightAxis.pts.length; i++) {
    const d = G.dist(straightAxis.pts[i - 1], straightAxis.pts[i]);
    if (d > best) { best = d; bi = i; }
  }
  const a = straightAxis.pts[bi - 1], b = straightAxis.pts[bi];
  let rot = G.angleOf(a, b);
  if (rot > Math.PI / 2 + 1e-9 || rot <= -Math.PI / 2 + 1e-9) rot += Math.PI;
  const h = labelHeight(e);
  const slope = slopeText(e);
  const text = m.conduit ? `${sectionLabel(m)} ${EMBED_LABELS[m.embed] || ''}`.trim()
    : m.kind === 'pipe' ? `${sectionLabel(m)} ${m.system}${m.q ? ` — ${m.q.toFixed(m.q < 1 ? 3 : 2).replace('.', ',')} l/s` : ''}${slope ? ` — pente ${slope}` : ''}`
    : m.kind === 'duct' && m.q ? `${sectionLabel(m)} — ${Math.round(m.q)} m³/h` : sectionLabel(m);
  const mid = G.mid(a, b);
  // Canalisation : étiquette décalée au-dessus du trait ; gaine : centrée dans la gaine.
  const off = m.kind === 'pipe' ? G.polar(mid, rot + Math.PI / 2, h * 0.8) : mid;
  out.labels.push({ p: [off[0], off[1], e.z || 0], h, rot, text, align: 'center', valign: m.kind === 'pipe' ? 'bottom' : 'middle' });
  // Repère de fabrication (NUMEROTER) : bulle à deux tiers du plus long tronçon, sur le côté.
  if (m.num) {
    const u = G.norm(G.sub(b, a));
    const r = h * (0.6 + m.num.length * 0.32);
    const c = G.add(G.lerp(a, b, 0.66), G.mul(G.perp(u), (w || 0) / 2 + r * 1.6));
    out.lines.push({ entity: { type: 'LWPOLYLINE', pts: [[c[0] + r, c[1]], [c[0] - r, c[1]]], bulges: [1, 1], closed: true, z: 0, width: 0 } });
    out.labels.push({ p: [c[0], c[1], e.z || 0], h, rot: 0, text: m.num, align: 'center', valign: 'middle' });
  }
  return out;
}

// Entités simples équivalentes (pour DECOMPOS et l'enregistrement DXF).
export function mepToEntities(e, neighbors = []) {
  const g = mepGeometry(e, neighbors);
  const base = { layer: e.layer, color: e.color, rgb: e.rgb, space: e.space };
  const ents = [];
  // Calorifuge : type de ligne DASHED (motif 300 / 150) mis à l'échelle de l'étiquette.
  const insStyle = { ltype: 'DASHED', ltscale: (labelHeight(e) * 0.6) / 300 };
  for (const l of g.lines) {
    if (l.entity) ents.push({ ...base, ...l.entity, type: 'LWPOLYLINE', mep: undefined, ...(l.ins ? insStyle : {}) });
    else ents.push({ ...base, type: 'LINE', p1: [l.pts[0][0], l.pts[0][1], e.z || 0], p2: [l.pts[1][0], l.pts[1][1], e.z || 0] });
  }
  for (const t of g.labels) ents.push({ ...base, type: 'TEXT', p: t.p, h: t.h, rot: t.rot, text: t.text, align: t.align, valign: t.valign, wf: 1 });
  for (const x of ents) delete x.mep;
  return ents;
}
