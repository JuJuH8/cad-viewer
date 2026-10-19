// SPDX-License-Identifier: GPL-3.0-or-later
// Cheminement des câbles sur les chemins de câbles et les tubes dessinés : graphe des axes (tronçons, coudes,
// piquages, prolongements, montées), plus court chemin depuis le tableau.
// - Chemin de câbles : on y entre et on en sort n'importe où ; un appareil sans tube est raccordé au chemin le plus
//   proche (horizontale puis verticale jusqu'à sa hauteur de pose).
// - Tube : d'un point A à un point B, utilisé en entier : on n'y entre et on n'en sort que par ses extrémités, posées
//   sur une boîte (de dérivation, de sol, montée…), un appareil, un tableau, un autre tube ou un chemin de câbles.
//   Une boîte sur CDC relie ses tubes au chemin de câbles qui la porte.
// Longueur d'un circuit = réunion des chemins vers ses appareils + raccordements, majorée de la réserve.
// Appareils trop loin d'un chemin ou sur un chemin non relié au tableau : longueur estimée (trajet orthogonal).

import * as G from '../core/geom.js';
import { buildNetwork, pointAtS } from '../mep/network.js';
import { zAt, planWidth } from '../mep/systems.js';
import { routingSystems } from './settings.js';
import { SYMBOLS } from './symbols.js';

const key = (id, s) => `${id}@${Math.round(s * 1e4) / 1e4}`;

// File de priorité minimale (tas binaire) pour Dijkstra.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, v) {
    const a = this.a;
    a.push([d, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Routeur d'un dessin. opts : { unitM (m par unité), data (elecData), heightOf(e) → hauteur de pose (m) }.
// Les points d'accès de tous les appareils et tableaux sont calculés une fois ; route() fait un Dijkstra par origine.
export function makeRouter(doc, { unitM = 0.001, data, heightOf }) {
  const systems = new Set(routingSystems(data));
  const ents = [...doc.entities.values()].filter((e) => (e.space || 'model') === 'model');
  const usable = (e) => systems.has(String(e.mep?.system).toUpperCase());
  // Chemins de câbles et tubes : deux réseaux réunis (identifiants distincts), puis raccords tube → chemin.
  const net = buildNetwork(ents.filter((e) => e.mep?.kind === 'tray' && usable(e)), 'tray');
  const tubes = buildNetwork(ents.filter((e) => e.mep?.conduit && usable(e)), 'pipe');
  for (const k of ['ducts', 'st', 'links']) for (const [id, v] of tubes[k]) net[k].set(id, v);
  const trays = [...net.ducts.values()];
  const isTube = (id) => !!net.ducts.get(id)?.mep.conduit;
  const isEnd = (id, s) => { const st = net.st.get(id); return Math.abs(s) < 1e-6 * (1 + st.at(-1)) || Math.abs(s - st.at(-1)) < 1e-6 * (1 + st.at(-1)); };
  // Un tube ne se raccorde que par ses extrémités (pas de piquage au milieu d'un tube).
  for (const [id, links] of net.links) net.links.set(id, links.filter((l) => (!isTube(id) || isEnd(id, l.s)) && (!isTube(l.id) || isEnd(l.id, l.os))));
  const elecEnts = ents.filter((e) => e.type === 'INSERT' && e.elec);
  const elById = new Map(elecEnts.map((e) => [e.id, e]));
  // Un symbole intégré de taille s couvre environ ±s/2 ; bloc de bibliothèque (échelle 1) : 20 cm au moins.
  const reach = (e) => Math.max(0.6 * Math.abs(e.sx || 1), 0.2 / unitM);
  const join = (data.routing.joinTol ?? 0.5) / unitM;
  for (const t of tubes.ducts.values()) {
    const st = net.st.get(t.id);
    for (const [s, p] of [[0, t.pts[0]], [st.at(-1), t.pts[t.pts.length - 1]]]) {
      if (net.links.get(t.id).some((l) => Math.abs(l.s - s) < 1e-9)) continue; // déjà relié à un autre tube
      if (elecEnts.some((e) => G.dist(p, e.p) <= reach(e))) continue; // posé sur une boîte ou un appareil : relié par lui
      let best = null;
      for (const c of trays) {
        if (c.mep.kind !== 'tray') continue;
        const cs = net.st.get(c.id);
        for (let k = 1; k < c.pts.length; k++) {
          const r = G.closestOnSegment(p, c.pts[k - 1], c.pts[k]);
          if (r.d <= planWidth(c.mep) / 2 + join && (!best || r.d < best.d)) best = { c, s: cs[k - 1] + r.t * (cs[k] - cs[k - 1]), d: r.d };
        }
      }
      if (!best) continue;
      net.links.get(t.id).push({ s, id: best.c.id, os: best.s });
      net.links.get(best.c.id).push({ s: best.s, id: t.id, os: s });
    }
  }
  const maxAccess = (data.routing.maxAccess || 0) / unitM;
  // Extrémités de tubes posées sur un symbole (boîte, appareil, tableau) : { e, id (tube), s, p }.
  const tubeEnds = new Map(); // id de symbole → [extrémités]
  for (const t of tubes.ducts.values()) {
    const st = net.st.get(t.id);
    for (const [s, p] of [[0, t.pts[0]], [st.at(-1), t.pts[t.pts.length - 1]]]) {
      let best = null;
      for (const e of elecEnts) {
        const d = G.dist(p, e.p);
        if (d <= reach(e) && (!best || d < best.d)) best = { e, d };
      }
      if (!best) continue;
      if (!tubeEnds.has(best.e.id)) tubeEnds.set(best.e.id, []);
      tubeEnds.get(best.e.id).push({ id: t.id, s, p });
    }
  }
  // Boîtes sur CDC : station du chemin de câbles qui les porte.
  const onTray = new Map(); // id de boîte → { tray, s, point }
  for (const e of elecEnts) {
    if (!SYMBOLS[e.elec.sym]?.onTray) continue;
    let best = null;
    for (const t of trays) {
      if (t.mep.conduit) continue;
      const st = net.st.get(t.id);
      for (let k = 1; k < t.pts.length; k++) {
        const r = G.closestOnSegment(e.p, t.pts[k - 1], t.pts[k]);
        if (r.d <= planWidth(t.mep) / 2 + reach(e) && (!best || r.d < best.d)) best = { tray: t, s: st[k - 1] + r.t * (st[k] - st[k - 1]), point: r.point, d: r.d };
      }
    }
    if (best) onTray.set(e.id, best);
  }
  // Accès : un appareil (ou tableau) où aboutit un tube y est relié directement ; sinon chemin de câbles le plus
  // proche dans la distance maximale (jamais le milieu d'un tube).
  const access = new Map(); // id d'appareil → { node, tray, s, point, h (m horizontaux), v (m verticaux) }
  const accessOf = (e) => {
    if (access.has(e.id)) return access.get(e.id);
    if (tubeEnds.has(e.id) && !SYMBOLS[e.elec.sym]?.node) {
      const a = { node: `el:${e.id}`, tray: null, point: e.p, h: 0, v: 0 };
      access.set(e.id, a);
      return a;
    }
    let best = null;
    for (const t of trays) {
      if (t.mep.conduit) continue;
      const st = net.st.get(t.id);
      for (let k = 1; k < t.pts.length; k++) {
        const r = G.closestOnSegment(e.p, t.pts[k - 1], t.pts[k]);
        if (r.d > maxAccess || (best && r.d >= best.d)) continue;
        best = { tray: t, s: st[k - 1] + r.t * (st[k] - st[k - 1]), point: r.point, d: r.d };
      }
    }
    const a = best && { ...best, node: key(best.tray.id, best.s), h: best.d * unitM, v: Math.abs(zAt(best.tray, best.s) * unitM - heightOf(e)) };
    access.set(e.id, a);
    return a;
  };
  for (const e of elecEnts) if (!SYMBOLS[e.elec.sym]?.node) accessOf(e);
  // Graphe : sommets aux stations remarquables de chaque chemin, arêtes le long des axes et aux raccords.
  const adj = new Map();
  const node = (k) => { if (!adj.has(k)) adj.set(k, []); return k; };
  const edge = (a, b, len, tray) => { adj.get(node(a)).push({ to: node(b), len, tray }); adj.get(node(b)).push({ to: a, len, tray }); };
  const stationsOf = new Map(trays.map((t) => [t.id, new Set(net.st.get(t.id))]));
  for (const [id, links] of net.links) for (const l of links) stationsOf.get(id)?.add(l.s);
  for (const a of access.values()) if (a?.tray) stationsOf.get(a.tray.id).add(a.s);
  for (const b of onTray.values()) stationsOf.get(b.tray.id).add(b.s);
  for (const t of trays) {
    const ss = [...stationsOf.get(t.id)].sort((x, y) => x - y);
    for (let i = 1; i < ss.length; i++) {
      const ds = (ss[i] - ss[i - 1]) * unitM, dz = (zAt(t, ss[i]) - zAt(t, ss[i - 1])) * unitM;
      edge(key(t.id, ss[i - 1]), key(t.id, ss[i]), Math.hypot(ds, dz), t.id);
    }
    if (ss.length === 1) node(key(t.id, ss[0]));
  }
  for (const [id, links] of net.links) {
    const a = net.ducts.get(id);
    for (const l of links) {
      if (l.id < id) continue;
      const b = net.ducts.get(l.id);
      const pa = pointAtS(a, l.s, net.st.get(id)), pb = pointAtS(b, l.os, net.st.get(l.id));
      edge(key(id, l.s), key(l.id, l.os), G.dist(pa, pb) * unitM + Math.abs(zAt(a, l.s) - zAt(b, l.os)) * unitM, null);
    }
  }
  // Symboles où aboutissent des tubes. Boîte : jonction entre ses tubes (et le chemin qui la porte), avec la
  // différence d'altitude (tube de dalle → tube de mur) ; appareil ou tableau : sommet propre, à sa hauteur de pose.
  for (const [eid, list] of tubeEnds) {
    const e = elById.get(eid);
    const ends = list.map((x) => ({ k: key(x.id, x.s), p: x.p, z: zAt(net.ducts.get(x.id), x.s) * unitM }));
    if (SYMBOLS[e.elec.sym]?.node) {
      const b = onTray.get(eid);
      if (b) ends.push({ k: key(b.tray.id, b.s), p: b.point, z: zAt(b.tray, b.s) * unitM });
      for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
        edge(ends[i].k, ends[j].k, (G.dist(ends[i].p, e.p) + G.dist(ends[j].p, e.p)) * unitM + Math.abs(ends[i].z - ends[j].z), null);
      }
    } else {
      const h = heightOf(e);
      for (const x of ends) edge(`el:${eid}`, x.k, G.dist(x.p, e.p) * unitM + Math.abs(x.z - h), null);
    }
  }
  const trees = new Map();
  const dijkstra = (src) => {
    if (trees.has(src)) return trees.get(src);
    const dist = new Map([[src, 0]]), prev = new Map();
    const h = new Heap();
    h.push(0, src);
    while (h.size) {
      const [d, v] = h.pop();
      if (d > dist.get(v)) continue;
      for (const e of adj.get(v) || []) {
        const nd = d + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: v, e }); h.push(nd, e.to); }
      }
    }
    const tree = { dist, prev };
    trees.set(src, tree);
    return tree;
  };
  const accessKey = (a) => a.node;
  const reserve = 1 + (data.routing.reservePct || 0) / 100, end = data.routing.reserveEnd || 0;

  // Route d'un départ : origine (tableau) → cibles (appareils ou tableau aval). Renvoie { len, routed (tout par
  // les chemins), partial, trayLen, accessLen, estLen, trays: Map id → longueur parcourue, unreachable: [ids],
  // paths: [[points du dessin]] (pour le dessin du cheminement) }.
  function route(from, targets) {
    const out = { len: 0, trayLen: 0, accessLen: 0, estLen: 0, trays: new Map(), unreachable: [], paths: [], routed: false, partial: false };
    if (!targets.length) return out;
    const a0 = accessOf(from);
    const tree = a0 ? dijkstra(accessKey(a0)) : null;
    const used = new Set();
    const reached = [];
    for (const t of targets) {
      const a = accessOf(t);
      const k = a && accessKey(a);
      if (!tree || !a || !tree.dist.has(k)) { out.unreachable.push(t); continue; }
      reached.push(t);
      out.accessLen += a.h + a.v;
      if (a.tray) out.paths.push([t.p, a.point]);
      // Remontée vers l'origine en ajoutant les arêtes pas encore comptées.
      const pts = [];
      for (let v = k; tree.prev.has(v); v = tree.prev.get(v).from) {
        const { from: u, e } = tree.prev.get(v);
        const id = [u, v].sort().join('|');
        if (!used.has(id)) {
          used.add(id);
          out.trayLen += e.len;
          if (e.tray != null) out.trays.set(e.tray, (out.trays.get(e.tray) || 0) + e.len);
        }
        pts.push(pointOfKey(v));
        if (!tree.prev.has(u)) pts.push(pointOfKey(u));
      }
      if (pts.length) out.paths.push(pts);
    }
    if (reached.length) {
      out.accessLen += a0.h + a0.v;
      if (a0.tray) out.paths.push([from.p, a0.point]);
    }
    // Appareils hors chemins : rattachés au plus proche point déjà desservi (trajet orthogonal + 15 %).
    const served = [from.p, ...reached.map((t) => t.p)];
    for (const t of out.unreachable) {
      const d = Math.min(...served.map((p) => Math.abs(p[0] - t.p[0]) + Math.abs(p[1] - t.p[1])));
      out.estLen += d * unitM * 1.15 + Math.abs(heightOf(t) - heightOf(from));
      served.push(t.p);
    }
    out.routed = reached.length > 0 && !out.unreachable.length;
    out.partial = reached.length > 0 && out.unreachable.length > 0;
    const ends = (reached.length + out.unreachable.length + 1) * end;
    out.len = (out.trayLen + out.accessLen + out.estLen) * reserve + ends;
    out.unreachable = out.unreachable.map((t) => t.id);
    return out;
  }
  function pointOfKey(k) {
    if (k.startsWith('el:')) return elById.get(Number(k.slice(3)))?.p || elById.get(k.slice(3))?.p;
    const [id, s] = k.split('@');
    const t = net.ducts.get(Number(id)) || net.ducts.get(id);
    return pointAtS(t, Number(s), net.st.get(t.id));
  }
  return { route, accessOf, trays: net.ducts, hasTrays: trays.length > 0 };
}

// Diamètre extérieur approximatif (mm) d'un câble cuivre multiconducteur (type FE0 / TT) : 5 conducteurs,
// 3 conducteurs ≈ 85 %. Valeurs générales pour le contrôle de remplissage (à remplacer par le catalogue).
const D5 = { 1.5: 10.5, 2.5: 12, 4: 14, 6: 15.5, 10: 19, 16: 23, 25: 28, 35: 31, 50: 37, 70: 42, 95: 48, 120: 53, 150: 59, 185: 65, 240: 74 };
export function cableDiameter(section, cores = 3) {
  const d = D5[section] ?? 10 + 4 * Math.sqrt(section);
  return cores >= 5 ? d : Math.round(d * 0.85 * 10) / 10;
}

// Diamètre extérieur approximatif (mm) d'un conducteur isolé (fil T) de section donnée.
const DT = { 1.5: 3, 2.5: 3.6, 4: 4.2, 6: 4.8, 10: 6.2, 16: 7.3, 25: 9, 35: 10, 50: 12, 70: 13.8, 95: 16, 120: 17.6, 150: 19.6, 185: 21.8, 240: 24.6 };
export const wireDiameter = (section) => DT[section] ?? 2 + 1.5 * Math.sqrt(section);

// Diamètre intérieur approximatif (mm) d'un tube électrique de diamètre extérieur D (M16… M40).
export const conduitInner = (D) => Math.round(D * 0.72 * 10) / 10;

// Remplissage des chemins de câbles et des tubes : [{ tray, conduit, cables: [{ board, circuit, section, cores,
// d }], area (mm²), fill (%), max (%), ok }]. results : départs dimensionnés [{ board, circuit, route, s, ph }].
// Chemin : section utile = largeur × hauteur ; tube : section intérieure.
export function trayFill(router, results, { unitM = 0.001, fillMax = 50, fillConduit = 33 } = {}) {
  const per = new Map();
  for (const r of results) {
    for (const id of r.route?.trays?.keys() || []) {
      if (!per.has(id)) per.set(id, []);
      const cores = r.ph === 3 ? 5 : 3;
      // Tube : conducteurs isolés (fils T) tirés dans le tube ; chemin de câbles : câble multiconducteur.
      const wires = !!router.trays.get(id)?.mep.conduit;
      per.get(id).push({ board: r.board, circuit: r.circuit, section: r.s, cores, wires, d: wires ? wireDiameter(r.s) : cableDiameter(r.s, cores) });
    }
  }
  const out = [];
  for (const [id, cables] of per) {
    const t = router.trays.get(id);
    const mm = unitM * 1000;
    const conduit = !!t.mep.conduit;
    const usable = conduit ? (Math.PI * conduitInner((t.mep.d || 0) * mm) ** 2) / 4 : planWidth(t.mep) * mm * (t.mep.h || 60 / mm) * mm;
    const area = cables.reduce((s, c) => s + ((c.wires ? c.cores : 1) * Math.PI * c.d * c.d) / 4, 0);
    const fill = usable > 0 ? (area / usable) * 100 : 0;
    const max = conduit ? fillConduit : fillMax;
    out.push({ tray: t, conduit, cables, area, fill, max, ok: fill <= max + 1e-9 });
  }
  return out.sort((a, b) => b.fill - a.fill);
}
