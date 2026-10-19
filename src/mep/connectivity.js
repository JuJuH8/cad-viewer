// SPDX-License-Identifier: GPL-3.0-or-later
// Maintien des raccordements MEP : quand un réseau est déplacé, étiré ou redimensionné, les réseaux qui y
// étaient raccordés (piquage sur sa paroi ou prolongement bout à bout) suivent, dans la même transaction.
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { planWidth, axisLength, slopeOf } from './systems.js';
import { connectEnds } from './connect.js';

const isRun = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2;
// Emprise d'un réseau, élargie de `pad`.
function boxOf(e, pad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of e.pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
// Abscisse le long de l'axe de `e` du point p (projection, prolongée au-delà des extrémités).
function abscissa(e, p) {
  let best = null, acc = 0;
  const n = e.pts.length;
  for (let k = 1; k < n; k++) {
    const a = e.pts[k - 1], b = e.pts[k];
    const L = G.dist(a, b);
    let t = L > 0 ? G.dot(G.sub(p, a), G.sub(b, a)) / (L * L) : 0;
    t = Math.max(k === 1 ? -Infinity : 0, Math.min(k === n - 1 ? Infinity : 1, t));
    const d = G.dist(p, G.add(a, G.mul(G.sub(b, a), t)));
    if (!best || d < best.d) best = { d, s: acc + t * L };
    acc += L;
  }
  return best ? best.s : 0;
}

// Réseau en pente raccourci, allongé ou coupé : altitudes de ses extrémités reprises sur la pente de l'état
// d'origine `src` (abscisses projetées sur son axe).
export function keepSlope(src, e) {
  if (src?.mep?.z1 == null || !isRun(e) || e.mep.system !== src.mep.system) return e;
  const k = slopeOf(src), z0 = src.mep.z || 0;
  const z = z0 + k * abscissa(src, e.pts[0]), z1 = z0 + k * abscissa(src, e.pts[e.pts.length - 1]);
  if (Math.abs(z - (e.mep.z || 0)) < 1e-9 && Math.abs(z1 - (e.mep.z1 ?? z)) < 1e-9) return e;
  return { ...e, z, mep: { ...e.mep, z, z1 } };
}

// Crochet « pente » : réseaux en pente dont la longueur change (ajuster, prolonger, étirer) et morceaux
// créés par une coupure. Un déplacement ou une rotation (longueur inchangée) garde les altitudes.
function slopeHook(doc, ops) {
  const sources = ops.filter((op) => (op.op === 'modify' || op.op === 'remove') && isRun(op.before) && op.before.mep.z1 != null).map((op) => op.before);
  if (!sources.length) return;
  for (const op of ops) {
    if (op.op === 'modify' && isRun(op.after) && op.before?.mep?.z1 != null
      && Math.abs(axisLength(op.after) - axisLength(op.before)) > 1e-9 * Math.max(1, axisLength(op.before))) {
      const cur = doc.get(op.after.id);
      if (!cur) continue;
      const upd = keepSlope(op.before, cur);
      if (upd !== cur) doc.update(upd);
    } else if (op.op === 'add' && isRun(op.after) && op.after.mep.z1 != null) {
      const cur = doc.get(op.after.id);
      if (!cur) continue;
      const tol = Math.max(1e-6, 0.02 * Math.max(planWidth(cur.mep), cur.mep.d || 0, 1));
      const onAxis = (src, q) => { for (let k = 1; k < src.pts.length; k++) if (G.closestOnSegment(q, src.pts[k - 1], src.pts[k]).d <= tol) return true; return false; };
      const src = sources.find((x) => x.id !== cur.id && x.mep.system === cur.mep.system && onAxis(x, cur.pts[0]) && onAxis(x, cur.pts[cur.pts.length - 1]));
      if (!src) continue;
      const upd = keepSlope(src, cur);
      if (upd !== cur) doc.update(upd);
    }
  }
}

const geomChanged = (a, b) => JSON.stringify(a.pts) !== JSON.stringify(b.pts) || planWidth(a.mep) !== planWidth(b.mep);

// Lien d'une extrémité (i = 0 ou dernière) de `o` avec `main` (état d'avant) : 'end' (k = extrémité de main
// confondue) ou 'tee' (posée sur l'axe ou la paroi), sinon null.
function linkOf(o, i, main) {
  const p = o.pts[i];
  const tol = Math.max(1e-6, 0.02 * Math.max(planWidth(o.mep), planWidth(main.mep), 1));
  for (const k of [0, main.pts.length - 1]) if (G.dist(p, main.pts[k]) <= tol) return { kind: 'end', k };
  const hw = planWidth(main.mep) / 2;
  for (let s = 1; s < main.pts.length; s++) {
    const r = G.closestOnSegment(p, main.pts[s - 1], main.pts[s]);
    if (r.t > 1e-6 && r.t < 1 - 1e-6 && r.d <= hw + tol) return { kind: 'tee' };
  }
  // Piquage sur un sommet intérieur (coude) du réseau porteur.
  for (let k = 1; k < main.pts.length - 1; k++) if (G.dist(p, main.pts[k]) <= hw + tol) return { kind: 'tee' };
  return null;
}

// L'extrémité i de `o` est-elle encore raccordée à `run` (bout confondu, ou piquage posé sur l'axe ou la paroi) ?
// Un tronçon parallèle posé à l'intérieur n'est pas un piquage : c'est un prolongement que `run` a recouvert.
function stillOn(o, i, run) {
  const p = o.pts[i], q = o.pts[i === 0 ? 1 : o.pts.length - 2];
  const tol = Math.max(1e-6, 0.02 * Math.max(planWidth(o.mep), planWidth(run.mep), 1));
  for (const k of [0, run.pts.length - 1]) if (G.dist(p, run.pts[k]) <= tol) return true;
  const hw = planWidth(run.mep) / 2;
  for (let s = 1; s < run.pts.length; s++) {
    const r = G.closestOnSegment(p, run.pts[s - 1], run.pts[s]);
    if (!(r.t > 1e-6 && r.t < 1 - 1e-6 && (r.d <= tol || Math.abs(r.d - hw) <= tol))) continue;
    const cos = Math.abs(G.dot(G.norm(G.sub(q, p)), G.norm(G.sub(run.pts[s], run.pts[s - 1]))));
    if (cos <= 0.98) return true;
  }
  return false;
}

// Nouvelle extrémité d'un piquage sur `main` : intersection de son dernier tronçon avec l'axe, puis paroi.
function reattachTee(o, i, main) {
  const end = o.pts[i], inner = o.pts[i === 0 ? 1 : o.pts.length - 2];
  let best = null;
  for (let s = 1; s < main.pts.length; s++) {
    const x = G.lineLine(inner, end, main.pts[s - 1], main.pts[s]);
    if (!x || x.u < -1e-9 || x.u > 1 + 1e-9) continue;
    const d = G.dist(x.point, end);
    if (!best || d < best.d) best = { d, p: x.point };
  }
  if (!best) return null;
  const moved = { ...o, pts: o.pts.map((q, k) => (k === i ? [best.p[0], best.p[1]] : q)) };
  return connectEnds(moved, [main]);
}

// Crochet de fin de transaction (voir Document.commitHooks). Les réseaux ajustés propagent à leur tour
// (piquage posé sur un prolongement qui vient d'être étiré…) ; chaque réseau est ajusté au plus quelques fois.
// Un réseau modifié dans la même transaction reste ajustable par celles de ses extrémités que la commande n'a
// pas déplacées (largeur changée sur une sélection qui contient aussi les piquages…).
export function installMepConnectivity(doc) {
  if (doc.mepConnectivity || !doc.commitHooks) return;
  doc.mepConnectivity = true;
  doc.commitHooks.push((change, ops = []) => {
    slopeHook(doc, ops);
    const queue = ops.filter((op) => op.op === 'modify' && isRun(op.before) && isRun(op.after) && geomChanged(op.before, op.after))
      .map(({ before, after }) => ({ before, after: doc.get(after.id) || after }));
    if (!queue.length) return;
    // État d'origine (avant la commande) des réseaux qu'elle a modifiés.
    const userBefore = new Map();
    for (const op of ops) if (op.op === 'modify' && isRun(op.before) && !userBefore.has(op.before.id)) userBefore.set(op.before.id, op.before);
    const excluded = new Set([...change.added, ...change.removed]);
    const runs = [...doc.entities.values()].filter((e) => isRun(e) && !excluded.has(e.id));
    // Extrémité i de `cur` libre d'être ajustée : la commande ne l'a pas déplacée.
    const freeEnd = (cur, i) => {
      const b = userBefore.get(cur.id);
      return !b || G.dist(b.pts[i === 0 ? 0 : b.pts.length - 1], cur.pts[i]) < 1e-9;
    };
    // Index spatial des réseaux candidats (tenu à jour quand un réseau est ajusté).
    const tree = new RBush();
    const items = new Map();
    const itemOf = (e) => { const it = { ...boxOf(e, planWidth(e.mep) + 1), id: e.id }; items.set(e.id, it); return it; };
    tree.load(runs.map(itemOf));
    // État final des réseaux créés ou modifiés : une extrémité encore raccordée à l'un d'eux ne bouge pas
    // (réseau coupé en deux par DIMENSIONNER ou COUPURE, extrémité opposée seule déplacée…).
    const fresh = new RBush();
    const freshItems = new Map();
    const putFresh = (e) => {
      if (freshItems.has(e.id)) fresh.remove(freshItems.get(e.id));
      const it = { ...boxOf(e, planWidth(e.mep) + 1), id: e.id };
      freshItems.set(e.id, it);
      fresh.insert(it);
    };
    for (const id of [...change.added, ...change.modified]) { const e = doc.get(id); if (isRun(e)) putFresh(e); }
    const count = new Map();
    const locked = (e) => !!doc.layers.get(e.layer)?.locked;
    for (let n = 0; n < queue.length && n < 20 * (runs.length + 1); n++) {
      const { before, after } = queue[n];
      // Ajustements calculés sur un même état puis appliqués : résultat indépendant de l'ordre de parcours.
      const updates = [];
      for (const { id } of tree.search(boxOf(before, planWidth(before.mep) + 1))) {
        const cur = doc.get(id);
        if (!cur || cur.id === after.id || cur.mep.kind !== before.mep.kind || cur.mep.system !== before.mep.system) continue;
        if ((cur.space || 'model') !== (after.space || 'model') || locked(cur) || (count.get(cur.id) || 0) >= 4) continue;
        let pts = cur.pts;
        for (const i of [0, cur.pts.length - 1]) {
          if (!freeEnd(cur, i)) continue;
          const link = linkOf({ ...cur, pts }, i, before);
          if (!link) continue;
          let kept = false;
          const [px, py] = pts[i];
          for (const { id: fid } of fresh.search({ minX: px, minY: py, maxX: px, maxY: py })) {
            const f = doc.get(fid);
            if (f && f.id !== cur.id && f.mep.kind === cur.mep.kind && f.mep.system === cur.mep.system && stillOn({ ...cur, pts }, i, f)) { kept = true; break; }
          }
          if (kept) continue;
          if (link.kind === 'end') {
            const q = after.pts[link.k === 0 ? 0 : after.pts.length - 1];
            pts = pts.map((q0, k) => (k === i ? [q[0], q[1]] : q0));
          } else {
            const np = reattachTee({ ...cur, pts }, i, after);
            if (np) pts = np;
          }
        }
        if (pts === cur.pts || JSON.stringify(pts) === JSON.stringify(cur.pts)) continue;
        updates.push({ cur, pts });
      }
      for (const { cur, pts } of updates) {
        doc.update(keepSlope(cur, { ...cur, pts }));
        const upd = doc.get(cur.id);
        tree.remove(items.get(cur.id));
        tree.insert(itemOf(upd));
        count.set(cur.id, (count.get(cur.id) || 0) + 1);
        putFresh(upd);
        queue.push({ before: cur, after: upd });
      }
    }
  });
}
