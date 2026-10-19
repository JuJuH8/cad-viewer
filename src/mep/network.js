// SPDX-License-Identifier: GPL-3.0-or-later
// Réseaux aérauliques et hydrauliques : connexions (bout à bout et piquages) et terminaux (bouches,
// appareils sanitaires), cumul des débits jusqu'à l'origine, dimensionnement à vitesse limite.
// Débits : m³/h pour les gaines, l/s pour les canalisations (simultanéité DTU 60.11).
//
// Position le long d'une gaine : abscisse curviligne s sur son axe (0 au premier sommet).
import * as G from '../core/geom.js';
import { planWidth, zAt } from './systems.js';
import { connectEnds } from './connect.js';

export const isRun = (e, kind) => !!e?.mep && e.type === 'LWPOLYLINE' && e.mep.kind === kind && e.pts.length >= 2;
export const isDuct = (e) => isRun(e, 'duct');
export const isTerminal = (e) => !!e?.mep && e.type === 'INSERT' && e.mep.kind === 'terminal';

// Diamètres normalisés des conduits circulaires (mm).
export const ROUND_SIZES = [80, 100, 125, 160, 200, 250, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1120, 1250, 1400, 1600];
// Diamètres intérieurs courants des canalisations d'eau (mm).
export const PIPE_SIZES = [10, 12, 14, 16, 20, 26, 32, 40, 50, 65, 80, 100, 125, 150];

// Coefficient de simultanéité (DTU 60.11) pour n appareils desservis.
export const simultaneity = (n) => (n <= 1 ? 1 : Math.min(1, 0.8 / Math.sqrt(n - 1)));

// Réseaux sanitaires : débit probable (simultanéité) ; chauffage, eau glacée, gaines : débit cumulé.
export const SANITARY = new Set(['EF', 'ECS']);
export const designFlow = (sec, kind, system) => (kind === 'pipe' && SANITARY.has(system) ? sec.q * simultaneity(sec.n || 0) : sec.q);

// Débit d'eau (l/s) d'un émetteur de puissance P (W) avec un écart de température ΔT (K).
export const hydronicFlow = (power, dt) => (dt > 0 ? power / (4186 * dt) : 0);

export function stations(e) {
  const s = [0];
  for (let i = 1; i < e.pts.length; i++) s.push(s[i - 1] + G.dist(e.pts[i - 1], e.pts[i]));
  return s;
}

// Point de l'axe le plus proche de p : { s, d, point }.
export function nearestOnAxis(e, p, st = stations(e)) {
  let best = { s: 0, d: Infinity, point: e.pts[0] };
  for (let k = 1; k < e.pts.length; k++) {
    const r = G.closestOnSegment(p, e.pts[k - 1], e.pts[k]);
    if (r.d < best.d) best = { s: st[k - 1] + r.t * (st[k] - st[k - 1]), d: r.d, point: r.point };
  }
  return best;
}

export function pointAtS(e, s, st = stations(e)) {
  for (let k = 1; k < e.pts.length; k++) {
    if (s <= st[k] || k === e.pts.length - 1) {
      const len = st[k] - st[k - 1];
      return G.lerp(e.pts[k - 1], e.pts[k], len > 0 ? Math.min(1, Math.max(0, (s - st[k - 1]) / len)) : 0);
    }
  }
  return e.pts[0];
}

const terminalHalf = (t) => {
  const m = t.mep;
  return (m.d && !m.w ? m.d : Math.max(m.w || 0, m.h || 0, m.d || 0)) / 2 * Math.abs(t.sx || 1);
};

// Connexions entre gaines d'un même système et rattachement des bouches.
// Renvoie { ducts, st, links: id → [{ s, id, os }], terminals: id → [{ s, id, q }], unconnected }.
export function buildNetwork(entities, kind = 'duct') {
  const ducts = new Map(), st = new Map(), links = new Map(), terminals = new Map(), accessories = new Map();
  for (const e of entities) {
    if (!isRun(e, kind)) continue;
    ducts.set(e.id, e);
    st.set(e.id, stations(e));
    links.set(e.id, []);
    terminals.set(e.id, []);
  }
  const list = [...ducts.values()];
  const hw = (e) => planWidth(e.mep) / 2;
  const tolOf = (a, b) => Math.max(1e-6, 0.02 * Math.max(planWidth(a.mep), planWidth(b.mep), 1));
  const box = (e) => {
    const b = G.emptyBox();
    for (const p of e.pts) G.growBox(b, p[0], p[1]);
    const m = hw(e) * 1.1 + 1e-6;
    return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
  };
  const boxes = new Map(list.map((e) => [e.id, box(e)]));
  const overlap = (a, b) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
  const ends = (e) => [[0, e.pts[0]], [st.get(e.id).at(-1), e.pts[e.pts.length - 1]]];
  const link = (a, sa, b, sb) => {
    links.get(a.id).push({ s: sa, id: b.id, os: sb });
    links.get(b.id).push({ s: sb, id: a.id, os: sa });
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.mep.system !== b.mep.system || !overlap(boxes.get(a.id), boxes.get(b.id))) continue;
      const tol = tolOf(a, b);
      let found = false;
      // Bout à bout.
      for (const [sa, pa] of ends(a)) {
        for (const [sb, pb] of ends(b)) {
          if (G.dist(pa, pb) <= tol) { link(a, sa, b, sb); found = true; }
        }
      }
      if (found) continue;
      // Piquage : une extrémité posée sur l'axe ou la paroi de l'autre gaine.
      for (const [x, y] of [[a, b], [b, a]]) {
        const ly = st.get(y.id).at(-1);
        for (const [sx, px] of ends(x)) {
          const r = nearestOnAxis(y, px, st.get(y.id));
          if (r.s > tol && r.s < ly - tol && r.d <= hw(y) + tol) link(x, sx, y, r.s);
        }
      }
    }
  }
  const unconnected = [];
  for (const t of entities) {
    if (!isTerminal(t)) continue;
    let best = null;
    for (const d of list) {
      if (d.mep.system !== t.mep.system) continue;
      const r = nearestOnAxis(d, t.p, st.get(d.id));
      const limit = hw(d) + terminalHalf(t) + tolOf(d, d);
      if (r.d <= limit && (!best || r.d < best.d)) best = { d: r.d, duct: d.id, s: r.s };
    }
    if (best) terminals.get(best.duct).push({ s: best.s, id: t.id, q: +t.mep.q || 0, z: t.mep.z || 0 });
    else unconnected.push(t.id);
  }
  // Accessoires en ligne (registres, clapets…) posés sur l'axe d'un réseau : comptés dans les pertes de charge.
  for (const a of entities) {
    if (a?.type !== 'INSERT' || a.mep?.kind !== 'accessory') continue;
    let best = null;
    for (const d of list) {
      if (d.mep.system !== a.mep.system) continue;
      const r = nearestOnAxis(d, a.p, st.get(d.id));
      const lim = Math.max(planWidth(d.mep), d.mep.d || 0) / 2 + tolOf(d, d);
      if (r.d <= lim && (!best || r.d < best.d)) best = { d: r.d, duct: d.id, s: r.s };
    }
    if (best) {
      if (!accessories.has(best.duct)) accessories.set(best.duct, []);
      accessories.get(best.duct).push({ s: best.s, id: a.id, type: a.mep.type });
    }
  }
  return { kind, ducts, st, links, terminals, accessories, unconnected };
}

// Débits cumulés depuis l'origine (gaine sourceId, abscisse sourceS).
// Renvoie id → { entry, taps: [{ s, q, id }], q (débit entrant), length }.
export function computeFlows(net, sourceId, sourceS) {
  const out = new Map();
  const visit = (id, s0, fromId) => {
    if (out.has(id)) return null; // boucle : déjà comptée
    const info = { entry: s0, taps: [], q: 0, n: 0, length: net.st.get(id).at(-1) };
    out.set(id, info);
    for (const l of net.links.get(id)) {
      if (l.id === fromId && Math.abs(l.s - s0) < 1e-6) continue;
      if (out.has(l.id)) continue;
      const sub = visit(l.id, l.os, id);
      if (sub) info.taps.push({ s: l.s, q: sub.q, n: sub.n, id: l.id });
    }
    for (const t of net.terminals.get(id)) info.taps.push({ s: t.s, q: t.q, n: 1, id: t.id, z: t.z, terminal: true });
    info.q = info.taps.reduce((a, t) => a + t.q, 0);
    info.n = info.taps.reduce((a, t) => a + t.n, 0);
    return info;
  };
  visit(sourceId, sourceS, null);
  return out;
}

// Débit au point s (ce qui passe en s en s'éloignant de l'entrée).
export function flowAt(info, s) {
  let q = 0;
  for (const t of info.taps) {
    if (s >= info.entry ? t.s > s : t.s < s) q += t.q;
  }
  return q;
}

// Nombre de terminaux desservis au point s.
export function countAt(info, s) {
  let n = 0;
  for (const t of info.taps) {
    if (s >= info.entry ? t.s > s : t.s < s) n += t.n || 0;
  }
  return n;
}

// Tronçons à débit constant : [{ s0, s1, q }], du début à la fin de l'axe.
export function flowSections(info) {
  const L = info.length;
  const cuts = [];
  for (const v of [0, L, info.entry, ...info.taps.map((t) => t.s)].map((x) => Math.min(L, Math.max(0, x))).sort((x, y) => x - y)) {
    if (!cuts.length || v - cuts[cuts.length - 1] > 1e-6) cuts.push(v);
  }
  if (cuts[cuts.length - 1] < L) cuts[cuts.length - 1] = L;
  const out = [];
  for (let i = 1; i < cuts.length; i++) {
    const s0 = cuts[i - 1], s1 = cuts[i];
    if (s1 - s0 < 1e-9) continue;
    const q = flowAt(info, (s0 + s1) / 2), n = countAt(info, (s0 + s1) / 2);
    if (out.length && out[out.length - 1].q === q && out[out.length - 1].n === n) out[out.length - 1].s1 = s1;
    else out.push({ s0, s1, q, n });
  }
  return out;
}

// Section pour un débit q (m³/h) à la vitesse vmax (m/s). Dimensions en mm.
// Rectangulaire : hauteur imposée, largeur arrondie au pas supérieur.
export function sizeFor(q, { vmax = 4, shape = 'rect', h = 200, step = 50, minW = 100 } = {}) {
  const area = q / 3600 / vmax * 1e6; // mm²
  if (shape === 'round') {
    const d = Math.sqrt((4 * area) / Math.PI);
    return { shape: 'round', d: ROUND_SIZES.find((x) => x >= d - 1e-9) || Math.ceil(d / 100) * 100 };
  }
  const w = Math.max(minW, Math.ceil(area / h / step - 1e-9) * step);
  return { shape: 'rect', w, h };
}

// Diamètre intérieur (mm) d'une canalisation pour un débit q (l/s) à la vitesse vmax (m/s).
export function pipeSizeFor(q, vmax = 1.5) {
  const d = Math.sqrt((4 * (q / 1000 / vmax)) / Math.PI) * 1000;
  return PIPE_SIZES.find((x) => x >= d - 1e-9) || Math.ceil(d / 10) * 10;
}

// Vitesse (m/s) d'un débit q (m³/h pour une gaine, l/s pour une canalisation) dans la section de `m` (mm).
export function velocity(q, m) {
  const area = m.shape === 'round' || m.kind === 'pipe' ? (Math.PI * m.d * m.d) / 4 : m.w * m.h;
  const qm3s = m.kind === 'pipe' ? q / 1000 : q / 3600;
  return area > 0 ? qm3s / (area * 1e-6) : 0;
}

// Découpe l'axe d'une gaine (sans arcs) aux abscisses données ; renvoie les morceaux de sommets.
export function splitPoints(e, cuts, st = stations(e)) {
  const L = st.at(-1);
  const at = [0];
  for (const c of cuts.filter((x) => x > 1e-9 && x < L - 1e-9).sort((a, b) => a - b)) if (c - at[at.length - 1] > 1e-6) at.push(c);
  if (L - at[at.length - 1] > 1e-6) at.push(L); else at[at.length - 1] = L;
  const pieces = [];
  for (let i = 1; i < at.length; i++) {
    const s0 = at[i - 1], s1 = at[i];
    const pts = [pointAtS(e, s0, st)];
    for (let k = 1; k < e.pts.length - 1; k++) if (st[k] > s0 + 1e-9 && st[k] < s1 - 1e-9) pts.push(e.pts[k]);
    pts.push(pointAtS(e, s1, st));
    pieces.push({ s0, s1, pts: pts.map((p) => [p[0], p[1]]) });
  }
  return pieces;
}

// Dimensionnement du réseau parcouru : chaque gaine est découpée après les piquages où le débit
// change (la réduction suit le piquage), et chaque morceau reçoit la section de son débit.
// opts : { vmax (m/s), unitMm (mm par unité du dessin), step, minW }.
// Renvoie [{ id, pieces }] : le morceau qui contient l'entrée garde l'identifiant de la gaine.
export function resizeNetwork(net, flows, opts = {}) {
  const unitMm = opts.unitMm || 1;
  const results = new Map();
  for (const [id, info] of flows) {
    const e = net.ducts.get(id);
    const st = net.st.get(id);
    const L = info.length;
    const m = e.mep;
    const w = planWidth(m);
    const secs = flowSections(info);
    const canSplit = !(e.bulges || []).some((b) => b);
    const cuts = [];
    if (canSplit) {
      for (let i = 0; i + 1 < secs.length; i++) {
        const b = secs[i].s1;
        const down = b >= info.entry ? 1 : -1;
        // Bout mort après le dernier piquage (débit nul) : il garde la section précédente.
        if (!designFlow(down > 0 ? secs[i + 1] : secs[i], m.kind, m.system)) continue;
        // Largeur de ce qui part à ce piquage.
        let wb = 0;
        for (const t of info.taps) {
          if (Math.abs(t.s - b) > 1e-6) continue;
          const o = net.ducts.get(t.id);
          wb = Math.max(wb, o ? planWidth(o.mep) : 0);
        }
        let c = b + down * (wb / 2 + 100 / unitMm);
        // Pas de réduction dans un coude : on la repousse après le sommet.
        for (let k = 1; k < st.length - 1; k++) if (Math.abs(c - st[k]) < w) c = st[k] + down * w;
        if (c > w && c < L - w) cuts.push(c);
      }
    }
    const pieces = canSplit && cuts.length ? splitPoints(e, cuts, st) : [{ s0: 0, s1: L, pts: e.pts.map((p) => [p[0], p[1]]) }];
    const entities = pieces.map((p) => {
      let q = 0;
      for (const sec of secs) if (sec.s1 > p.s0 + 1e-9 && sec.s0 < p.s1 - 1e-9) q = Math.max(q, designFlow(sec, m.kind, m.system));
      const mep = { ...m };
      if (m.z1 != null) { // réseau en pente : altitudes du morceau
        const k = st.at(-1) > 0 ? (m.z1 - (m.z || 0)) / st.at(-1) : 0;
        mep.z = (m.z || 0) + k * p.s0;
        mep.z1 = (m.z || 0) + k * p.s1;
      }
      if (m.kind === 'pipe') {
        mep.q = Math.round(q * 1000) / 1000;
        mep.d = pipeSizeFor(q, opts.vmax) / unitMm;
      } else {
        const size = sizeFor(q, { vmax: opts.vmax, shape: m.shape, h: (m.h || 200) * unitMm, step: opts.step, minW: opts.minW });
        mep.q = Math.round(q);
        if (size.shape === 'round') mep.d = size.d / unitMm;
        else { mep.w = size.w / unitMm; mep.h = size.h / unitMm; }
      }
      return { piece: p, entity: { ...e, pts: p.pts, bulges: p.pts.map(() => 0), z: mep.z ?? e.z, mep } };
    });
    // Le morceau de l'entrée garde l'identifiant ; les autres sont de nouvelles gaines.
    const keep = entities.findIndex((x) => x.piece.s0 <= info.entry + 1e-9 && info.entry <= x.piece.s1 + 1e-9);
    entities.forEach((x, k) => { if (k !== keep) delete x.entity.id; });
    if (!canSplit) entities[0].entity.bulges = e.bulges;
    results.set(id, entities.map((x) => x.entity));
  }
  // Piquages : l'extrémité de la gaine piquée est recalée sur la nouvelle paroi de la gaine principale.
  for (const [id] of flows) {
    const e = net.ducts.get(id);
    const L = net.st.get(id).at(-1);
    for (const l of net.links.get(id)) {
      const atStart = Math.abs(l.s) < 1e-6, atEnd = Math.abs(l.s - L) < 1e-6;
      if (!atStart && !atEnd) continue;
      const main = net.ducts.get(l.id);
      const Lm = net.st.get(l.id).at(-1);
      if (l.os < 1e-6 || l.os > Lm - 1e-6) continue; // bout à bout : rien à recaler
      const mine = results.get(id) || [e];
      const piece = atStart ? mine.find((x) => G.dist(x.pts[0], e.pts[0]) < 1e-6) : mine.find((x) => G.dist(x.pts.at(-1), e.pts.at(-1)) < 1e-6);
      if (!piece) continue;
      const end = atStart ? piece.pts[0] : piece.pts.at(-1);
      const inner = atStart ? piece.pts[1] : piece.pts.at(-2);
      const mains = results.get(l.id) || [main];
      // Morceau principal au droit du piquage, puis intersection de l'axe piqué avec son axe.
      let best = null;
      for (const mp of mains) {
        const r = nearestOnAxis(mp, end);
        if (!best || r.d < best.r.d) best = { mp, r };
      }
      if (!best) continue;
      let onAxis = best.r.point;
      for (let k = 1; k < best.mp.pts.length; k++) {
        const x = G.lineLine(inner, end, best.mp.pts[k - 1], best.mp.pts[k]);
        if (x && G.dist(x.point, best.r.point) < planWidth(best.mp.mep) + planWidth(main.mep)) { onAxis = x.point; break; }
      }
      const moved = { ...piece, pts: piece.pts.map((p, i) => ((atStart ? i === 0 : i === piece.pts.length - 1) ? [onAxis[0], onAxis[1]] : p)) };
      piece.pts = connectEnds(moved, [best.mp.id != null ? best.mp : { ...best.mp, id: -1 }]);
    }
  }
  return [...results].map(([id, pieces]) => ({ id, pieces }));
}

// --- Pertes de charge ------------------------------------------------------------------------
// Air à 20 °C, gaine en acier galvanisé.
// Unités du dessin (INSUNITS) → mètres ; dessin sans unité : mm.
export const UNIT_TO_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
export const unitMmOf = (doc) => (UNIT_TO_M[doc?.header?.insunits] ?? 0.001) * 1000;
// Section ramenée en mm (u : mm par unité du dessin).
export const sectionMm = (m, u) => (u === 1 ? m : { ...m, w: (m.w || 0) * u, h: (m.h || 0) * u, d: (m.d || 0) * u });

export const AIR = { rho: 1.2, nu: 15.1e-6, eps: 0.00015 };
// Eau à 20 °C, tube cuivre / multicouche (rugosité 0,0015 mm).
export const WATER = { rho: 998, nu: 1.0e-6, eps: 0.0000015 };
const fluidOf = (m) => (m.kind === 'pipe' ? WATER : AIR);

// Perte de charge linéique (Pa/m) d'un débit q (m³/h pour une gaine, l/s pour une canalisation) dans la
// section de `m` (mm) : Darcy-Weisbach, coefficient de frottement d'Altshul-Tsal, diamètre hydraulique.
export function frictionRate(q, m) {
  const round = m.shape === 'round' || m.kind === 'pipe';
  const dh = round ? m.d / 1000 : (2 * m.w * m.h) / (m.w + m.h) / 1000;
  const v = velocity(q, m);
  if (!(dh > 0) || !(v > 0)) return 0;
  const fl = fluidOf(m);
  const re = (v * dh) / fl.nu;
  let f = 0.11 * Math.pow(fl.eps / dh + 68 / re, 0.25);
  if (f < 0.018) f = 0.85 * f + 0.0028;
  return (f / dh) * (fl.rho * v * v) / 2;
}

// Pression dynamique (Pa).
export const dynamicPressure = (q, m) => {
  const v = velocity(q, m);
  return (fluidOf(m).rho * v * v) / 2;
};

// Coefficients de pertes singulières (valeurs usuelles des guides CVC et plomberie).
export const ZETA = {
  elbowRadius: 0.25, elbowMiter: 1.2, teeBranch: 1.0, teeStraight: 0.1,
  pipeElbow: 0.5, pipeTeeBranch: 1.3, pipeTeeStraight: 0.3,
  // Accessoires en ligne (ouverts) : registre, clapet coupe-feu, silencieux, vanne.
  registre: 0.3, ccf: 0.5, silencieux: 1.0, vanne: 0.2,
};

const dirAt = (e, s, st) => {
  for (let k = 1; k < e.pts.length; k++) {
    if (s <= st[k] + 1e-9 || k === e.pts.length - 1) return G.norm(G.sub(e.pts[k], e.pts[k - 1]));
  }
  return [1, 0];
};

// Pertes de charge de l'origine jusqu'à chaque bouche. opts : { terminalDp (Pa) }.
// Renvoie { terminals: [{ id, q, dp, path }], max, critical }.
export function pressureDrops(net, flows, sourceId, sourceS, opts = {}) {
  const terminalDp = opts.terminalDp ?? 20;
  // Sections et longueurs du dessin ramenées en mm (unitMm : mm par unité du dessin).
  const u = opts.unitMm || 1;
  const mm = (m) => sectionMm(m, u);
  const out = [];
  const visit = (id, s0, dpIn, path, inDir) => {
    const info = flows.get(id);
    const e = net.ducts.get(id);
    if (!info || !e) return;
    const st = net.st.get(id);
    const secs = flowSections(info);
    const m = mm(e.mep);
    const pipe = m.kind === 'pipe';
    const zElbow = pipe ? ZETA.pipeElbow : m.elbow === 'miter' ? ZETA.elbowMiter : ZETA.elbowRadius;
    const zTeeS = pipe ? ZETA.pipeTeeStraight : ZETA.teeStraight;
    const zTeeB = pipe ? ZETA.pipeTeeBranch : ZETA.teeBranch;
    // Débit de calcul au point s (débit probable pour l'eau sanitaire).
    const qAt = (s) => designFlow({ q: flowAt(info, s), n: countAt(info, s) }, m.kind, m.system);
    // Raccord entre deux gaines non alignées : compté comme un coude.
    let dpEntry = 0;
    if (inDir) {
      let d = dirAt(e, s0, st);
      if (s0 > 1e-9) d = [-d[0], -d[1]];
      const ang = Math.acos(Math.max(-1, Math.min(1, G.dot(inDir, d))));
      if (ang > 0.2) dpEntry = zElbow * (ang / (Math.PI / 2)) * dynamicPressure(designFlow(info, m.kind, m.system), m);
    }
    // Perte entre l'entrée et l'abscisse s (frottement par tronçon, coudes, tés traversés).
    const along = (s) => {
      const lo = Math.min(s0, s), hi = Math.max(s0, s);
      let dp = 0;
      for (const sec of secs) {
        const a = Math.max(lo, sec.s0), b = Math.min(hi, sec.s1);
        if (b > a) dp += frictionRate(designFlow(sec, m.kind, m.system), m) * (((b - a) * u) / 1000);
      }
      for (let k = 1; k < st.length - 1; k++) {
        if (st[k] <= lo + 1e-9 || st[k] >= hi - 1e-9) continue;
        const d1 = G.norm(G.sub(e.pts[k], e.pts[k - 1])), d2 = G.norm(G.sub(e.pts[k + 1], e.pts[k]));
        const ang = Math.acos(Math.max(-1, Math.min(1, G.dot(d1, d2))));
        dp += zElbow * (ang / (Math.PI / 2)) * dynamicPressure(qAt(st[k]), m);
      }
      for (const t of info.taps) {
        if (t.s > lo + 1e-6 && t.s < hi - 1e-6) dp += zTeeS * dynamicPressure(qAt(t.s), m);
      }
      for (const a of net.accessories?.get(id) || []) {
        if (a.s >= lo - 1e-6 && a.s <= hi + 1e-6 && ZETA[a.type]) dp += ZETA[a.type] * dynamicPressure(qAt(a.s), m);
      }
      return dp;
    };
    const L = info.length;
    for (const t of info.taps) {
      const atEnd = Math.abs(t.s - L) < 1e-6 || Math.abs(t.s) < 1e-6;
      const dp = dpIn + dpEntry + along(t.s);
      if (t.terminal) {
        // Hauteur statique (réseaux ouverts : eau sanitaire) entre l'origine et l'appareil.
        const head = opts.staticHead ? WATER.rho * 9.81 * (((t.z || 0) - z0) * u) / 1000 : 0;
        out.push({ id: t.id, q: t.q, dp: dp + terminalDp + head, path: [...path, id] });
        continue;
      }
      const child = net.ducts.get(t.id);
      if (!child) continue;
      const link = net.links.get(id).find((l) => l.id === t.id && Math.abs(l.s - t.s) < 1e-6);
      const cm = mm(child.mep);
      const tee = atEnd ? 0 : zTeeB * dynamicPressure(designFlow(t, cm.kind, cm.system), cm);
      // Montée / descente vers un prolongement à une autre altitude : frottement sur la hauteur et deux coudes.
      let rise = 0;
      if (atEnd && link) {
        const dz = Math.abs(zAt(child, link.os) - zAt(e, t.s));
        if (dz > 1e-6 * Math.max(1, cm.d || cm.w || 1)) {
          const qc = designFlow(t, cm.kind, cm.system);
          const zE = cm.kind === 'pipe' ? ZETA.pipeElbow : cm.elbow === 'miter' ? ZETA.elbowMiter : ZETA.elbowRadius;
          rise = frictionRate(qc, cm) * ((dz * u) / 1000) + 2 * zE * dynamicPressure(qc, cm);
        }
      }
      let dir = dirAt(e, t.s, st);
      if (t.s < s0) dir = [-dir[0], -dir[1]];
      visit(t.id, link ? link.os : 0, dp + tee + rise, [...path, id], atEnd ? dir : null);
    }
  };
  const z0 = net.ducts.get(sourceId)?.mep.z || 0;
  visit(sourceId, sourceS, 0, [], null);
  out.sort((a, b) => b.dp - a.dp);
  return { terminals: out, max: out[0]?.dp || 0, critical: out[0] || null };
}

// Pentes d'un réseau gravitaire (évacuation) : l'altitude de l'axe est fixée au point bas (canalisation
// sourceId, extrémité la plus proche de sourceS) et le réseau remonte vers les appareils avec la pente
// `slope` (sans unité). Aux piquages, les fils d'eau sont alignés (axe du branchement = axe du collecteur
// − D/2 + d/2). Renvoie { z: id → { z (premier sommet), z1 (dernier) }, max, min }.
export function slopeNetwork(net, flows, sourceId, sourceS, z0, slope) {
  const out = new Map();
  let max = -Infinity, min = Infinity;
  const half = (m) => (m.kind === 'pipe' || m.shape === 'round' ? m.d : m.h || 0) / 2;
  const visit = (id, entry, zEntry) => {
    const info = flows.get(id);
    const e = net.ducts.get(id);
    if (!info || !e || out.has(id)) return;
    const L = net.st.get(id).at(-1);
    // Entrée ramenée à l'extrémité la plus proche : profil linéaire montant en s'éloignant de l'entrée.
    const fromStart = entry <= L / 2;
    const zOf = (s) => zEntry + slope * (fromStart ? s : L - s);
    out.set(id, { z: zOf(0), z1: zOf(L) });
    max = Math.max(max, zOf(0), zOf(L));
    min = Math.min(min, zOf(0), zOf(L));
    for (const t of info.taps) {
      if (t.terminal) continue;
      const child = net.ducts.get(t.id), ci = flows.get(t.id);
      if (!child || !ci) continue;
      visit(t.id, ci.entry, zOf(t.s) - half(e.mep) + half(child.mep));
    }
  };
  visit(sourceId, sourceS, z0);
  return { z: out, max, min };
}
