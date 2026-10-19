// SPDX-License-Identifier: GPL-3.0-or-later
// Tableaux et circuits : les appareils (insertions avec `elec`) sont rattachés à un tableau et à un circuit ;
// les réglages des circuits (type, mode de pose, longueur, protection imposée…) sont rangés dans le tableau
// (elec.circuits), donc annulables et enregistrés avec lui. Dimensionnement de toute l'arborescence de
// tableaux : puissances des tableaux secondaires remontées, chutes de tension cumulées depuis l'origine.

import { SYMBOLS, CATEGORIES, refreshAttribs } from './symbols.js';
import { sizeCircuit, sizeBoard, CIRCUIT_TYPES } from './nibt.js';
import { elecData } from './settings.js';
import { makeRouter, trayFill } from './routing.js';
import { sourceImpedance, throughCable, currents, tripCurrent } from './shortcircuit.js';
import { selectivity } from './selectivity.js';

export const PREFIX = { LUMIERE: 'L', PRISES: 'P', FORCE: 'F', STORES: 'S', CHAUFFAGE: 'C', SECOURS: 'E', TABLEAU: 'T' };

const isElec = (e) => e.type === 'INSERT' && e.elec && SYMBOLS[e.elec.sym];
export const boards = (doc) => [...doc.entities.values()].filter((e) => isElec(e) && e.elec.kind === 'board');
export const devices = (doc) => [...doc.entities.values()].filter((e) => isElec(e) && e.elec.kind !== 'board');
export const boardByName = (doc, name) => boards(doc).find((b) => b.elec.board === name) || null;

// Type de circuit d'un appareil (null : appareil sans alimentation propre, courant faible…).
export function circuitTypeOf(e) {
  const s = SYMBOLS[e.elec.sym];
  if (!s || !(e.elec.p > 0 || s.p > 0)) return null;
  return s.circuit || CATEGORIES[s.cat].circuit;
}

// Prochain numéro libre d'un type dans un tableau (L1, L2… P1…).
export function nextCircuitId(doc, boardName, type) {
  const pre = PREFIX[type] || 'X';
  const used = new Set(devices(doc).filter((d) => d.elec.board === boardName).map((d) => d.elec.circuit));
  for (const c of boardByName(doc, boardName)?.elec.circuits || []) used.add(c.id);
  for (const b of boards(doc)) if (b.elec.parent === boardName && b.elec.feeder) used.add(b.elec.feeder);
  let n = 1;
  while (used.has(`${pre}${n}`)) n++;
  return `${pre}${n}`;
}

// Nom libre pour un nouveau tableau (TP pour le premier, puis TD1, TD2…).
export function nextBoardName(doc) {
  const names = new Set(boards(doc).map((b) => b.elec.board));
  if (!names.has('TP')) return 'TP';
  let n = 1;
  while (names.has(`TD${n}`)) n++;
  return `TD${n}`;
}

// Longueur de câble estimée (m) : arbre couvrant le plus court en trajets orthogonaux, depuis le tableau,
// majoré de 15 % (cheminement) et de 3 m (montée depuis le tableau, descentes vers les appareils).
export function estimateLength(from, points, unitM) {
  if (!from || !points.length) return 0;
  const pts = [from, ...points];
  const inTree = new Array(pts.length).fill(false);
  const best = new Array(pts.length).fill(Infinity);
  best[0] = 0;
  let total = 0;
  for (let k = 0; k < pts.length; k++) {
    let i = -1;
    for (let j = 0; j < pts.length; j++) if (!inTree[j] && (i < 0 || best[j] < best[i])) i = j;
    inTree[i] = true;
    total += best[i];
    for (let j = 0; j < pts.length; j++) {
      if (inTree[j]) continue;
      const d = Math.abs(pts[i][0] - pts[j][0]) + Math.abs(pts[i][1] - pts[j][1]);
      if (d < best[j]) best[j] = d;
    }
  }
  return total * unitM * 1.15 + 3;
}

// Circuits d'un tableau : réglages enregistrés + appareils rattachés (circuits créés à la volée).
export function boardCircuits(doc, board) {
  const name = board.elec.board;
  const defs = new Map((board.elec.circuits || []).map((c) => [c.id, { ...c }]));
  const devs = devices(doc).filter((d) => d.elec.board === name && d.elec.circuit);
  const byId = new Map();
  for (const d of devs) (byId.get(d.elec.circuit) || byId.set(d.elec.circuit, []).get(d.elec.circuit)).push(d);
  for (const [id, list] of byId) {
    if (!defs.has(id)) {
      const types = list.map(circuitTypeOf).filter(Boolean);
      defs.set(id, { id, type: types.sort((a, b) => types.filter((t) => t === b).length - types.filter((t) => t === a).length)[0] || 'FORCE' });
    }
  }
  // Tableaux secondaires alimentés par ce tableau : un circuit de type TABLEAU chacun.
  for (const sub of boards(doc).filter((b) => b.elec.parent === name)) {
    const id = sub.elec.feeder || `→${sub.elec.board}`;
    defs.set(id, { ...(defs.get(id) || {}), id, type: 'TABLEAU', sub: sub.elec.board });
  }
  // Ordre du schéma : circuits par numéro, départs vers les tableaux secondaires à la fin.
  return [...defs.values()].map((c) => ({ ...c, devices: c.sub ? [] : byId.get(c.id) || [] }))
    .sort((a, b) => (a.sub ? 1 : 0) - (b.sub ? 1 : 0) || a.id.localeCompare(b.id, 'fr', { numeric: true }));
}

// Hauteur de pose (m) d'un appareil ou d'un tableau : saisie (elec.h), sinon valeur générale des données.
export function heightOf(e, data) {
  if (e.elec?.h != null) return e.elec.h;
  const r = data.routing;
  if (e.elec?.kind === 'board') return r.hBoard;
  const t = circuitTypeOf(e);
  return t === 'LUMIERE' || t === 'SECOURS' ? r.hLight : t === 'PRISES' ? r.hSocket : r.hOther;
}

// Dimensionnement de toute l'installation. Renvoie Map nom de tableau → { board, circuits: [{ def, devices,
// p, n, len, lenSrc ('saisie' | 'chemins' | 'partiel' | 'estimée'), route, r }], supply (alimentation du
// tableau), p (puissance appelée) }. Longueurs par les chemins de câbles dessinés quand c'est possible.
// La Map porte aussi .router et .fill (remplissage des chemins de câbles).
export function computeInstallation(doc, { unitM = 0.001, duMax, data = elecData(doc) } = {}) {
  duMax ??= data.network.duMax;
  const all = boards(doc);
  const out = new Map();
  const router = makeRouter(doc, { unitM, data, heightOf: (e) => heightOf(e, data) });
  const routes = new Map();
  const routeOf = (board, c, targets) => {
    const k = `${board.elec.board}|${c.id}`;
    if (!routes.has(k)) routes.set(k, router.hasTrays ? router.route(board, targets) : null);
    return routes.get(k);
  };
  const power = new Map(); // puissance appelée de chaque tableau (après simultanéités)
  const circuitInput = (board, c) => {
    const p = c.sub ? power.get(c.sub) ?? 0 : c.devices.reduce((s, d) => s + (d.elec.p || 0), 0);
    const n = c.devices.reduce((s, d) => s + (SYMBOLS[d.elec.sym]?.outlets || 0), 0);
    const ph = c.ph ?? (c.sub ? 3 : c.devices.some((d) => d.elec.ph === 3) ? 3 : 1);
    const subBoard = c.sub ? boardByName(doc, c.sub) : null;
    const targets = c.sub ? (subBoard ? [subBoard] : []) : c.devices;
    const route = routeOf(board, c, targets);
    const viaTrays = route && (route.routed || route.partial);
    const est = viaTrays ? route.len : estimateLength(board.p, targets.map((d) => d.p), unitM);
    const len = c.len ?? Math.round(est * 10) / 10;
    const lenSrc = c.len != null ? 'saisie' : route?.routed ? 'chemins' : route?.partial ? 'partiel' : 'estimée';
    return { p, n, ph, len, lenSrc, route };
  };
  // 1. Puissances, des tableaux sans tableau aval vers l'origine.
  const order = [];
  const visit = (b, seen = new Set()) => {
    if (seen.has(b.elec.board)) return;
    seen.add(b.elec.board);
    for (const sub of all.filter((x) => x.elec.parent === b.elec.board)) visit(sub, seen);
    order.push(b);
  };
  const roots = all.filter((b) => !b.elec.parent || !boardByName(doc, b.elec.parent));
  for (const r of roots) visit(r);
  for (const b of order) {
    const circuits = boardCircuits(doc, b);
    const pabs = circuits.reduce((s, c) => {
      const inp = circuitInput(b, c);
      const t = CIRCUIT_TYPES[c.type] || CIRCUIT_TYPES.FORCE;
      return s + inp.p * (c.ks ?? t.ks(inp.n));
    }, 0);
    power.set(b.elec.board, pabs * (b.elec.ks ?? 0.8));
  }
  // Sélectivité : la protection automatique d'un départ vers un tableau (et de l'alimentation d'origine) est au moins
  // égale au rapport minimal × le plus fort calibre du tableau aval.
  const ratio = data.equipment.selRatio || 1;
  const maxRating = new Map();
  const curveOf = (c) => c.curve || (c.sub ? 'C' : data.equipment.breakerCurve); // départs vers tableaux : courbe C
  const maxRatingOf = (name) => {
    if (maxRating.has(name)) return maxRating.get(name);
    maxRating.set(name, 0); // garde contre les boucles
    const b = boardByName(doc, name);
    const m = b ? Math.max(0, ...boardCircuits(doc, b).map((c) => c.rating
      ?? sizeCircuit({ ...c, ...circuitInput(b, c), curve: curveOf(c), minIn: minInOf(c), upstream: 0, duMax }).rating)) : 0;
    maxRating.set(name, m);
    return m;
  };
  const minInOf = (c) => (c.sub ? ratio * maxRatingOf(c.sub) : 0);
  // 2. Chutes de tension, de l'origine vers l'aval.
  const size = (b, upstream) => {
    const circuits = boardCircuits(doc, b).map((c) => {
      const inp = circuitInput(b, c);
      const r = sizeCircuit({ ...c, ...inp, curve: curveOf(c), minIn: minInOf(c), ambient: c.ambient ?? data.cable.ambient, upstream: 0, duMax });
      return { def: c, devices: c.devices, ...inp, r };
    });
    // Alimentation du tableau : circuit de son tableau amont, ou branchement (longueur saisie).
    const supply = b.elec.parent && out.get(b.elec.parent)
      ? out.get(b.elec.parent).circuits.find((c) => c.def.sub === b.elec.board)?.r
      : sizeBoard(circuits.map((c) => c.r), { ks: b.elec.ks ?? 0.8, ph: 3, len: b.elec.supplyLen || 0, method: b.elec.supplyMethod || 'C', duMax,
        minIn: ratio * Math.max(0, ...circuits.map((c) => c.r.rating)) });
    const base = supply ? supply.duTotal : upstream;
    for (const c of circuits) c.r = sizeCircuit({ ...c.def, curve: curveOf(c.def), minIn: minInOf(c.def), ambient: c.def.ambient ?? data.cable.ambient, p: c.p, n: c.n, ph: c.ph, len: c.len, upstream: base, duMax });
    out.set(b.elec.board, { board: b, circuits, supply, p: power.get(b.elec.board), upstream: base });
    for (const sub of all.filter((x) => x.elec.parent === b.elec.board)) size(sub, base);
  };
  for (const r of roots) size(r, 0);
  // 3. Courants de court-circuit, de l'origine vers l'aval : Ik3 max au jeu de barres de chaque tableau (pouvoir de
  // coupure), Ik1 min au bout de chaque départ (déclenchement). info.ik3 / info.ik1 (A), c.sc = { ik3, ik1, ia }.
  const net = data.network, mat = data.cable.material, icu = data.equipment.icu;
  const kA = (v) => (v / 1000).toFixed(1).replace('.', ',');
  const warn = (r, msg) => { r.warnings.push(msg); r.ok = false; };
  // up : protection d'arrivée du tableau (alimentation ou départ du tableau amont), pour la sélectivité.
  const shortCircuit = (b, zBus, seen, up) => {
    const info = out.get(b.elec.board);
    if (!info || seen.has(b.elec.board)) return;
    seen.add(b.elec.board);
    const bus = currents(zBus, net);
    Object.assign(info, { ik3: bus.ik3, ik1: bus.ik1 });
    for (const c of info.circuits) {
      const zEnd = throughCable(zBus, c.len, c.r.s, mat);
      const end = currents(zEnd, net);
      const ia = tripCurrent(c.r.curve, c.r.rating);
      c.sc = { ik3: bus.ik3, ik1: end.ik1, ia };
      if (bus.ik3 / 1000 > icu + 1e-9) warn(c.r, `Ik3 ${kA(bus.ik3)} kA au tableau > pouvoir de coupure ${String(icu).replace('.', ',')} kA`);
      if (end.ik1 < ia) warn(c.r, `Ik1 min ${Math.round(end.ik1)} A < seuil de déclenchement ${Math.round(ia)} A (${c.r.curve}${c.r.rating})`);
      if (up) {
        c.sel = selectivity(up, c.r, bus.ik3, data.equipment);
        if (c.sel.kind === 'non') warn(c.r, c.sel.text);
      }
      if (c.def.sub) { const sub = boardByName(doc, c.def.sub); if (sub) shortCircuit(sub, zEnd, seen, c.r); }
    }
  };
  const src = sourceImpedance(net);
  const seen = new Set();
  for (const r of roots) {
    const info = out.get(r.elec.board);
    const s = info?.supply;
    if (s) {
      // Alimentation du tableau d'origine : branchement depuis le point de raccordement.
      const z = throughCable(src, r.elec.supplyLen || 0, s.s, mat);
      const atBoard = currents(z, net);
      s.sc = { ik3: currents(src, net).ik3, ik1: atBoard.ik1, ia: tripCurrent(s.curve, s.rating) };
      if (atBoard.ik1 < s.sc.ia) warn(s, `Ik1 min ${Math.round(atBoard.ik1)} A < seuil de déclenchement ${Math.round(s.sc.ia)} A (${s.curve}${s.rating})`);
      shortCircuit(r, z, seen, s);
    } else shortCircuit(r, src, seen, null);
  }
  out.router = router;
  out.fill = trayFill(router, [...out.values()].flatMap((b) => b.circuits.map((c) => ({ board: b.board.elec.board, circuit: c.def.id, route: c.route, s: c.r.s, ph: c.ph })))
    , { unitM, fillMax: data.routing.fillMax, fillConduit: data.routing.fillConduit });
  return out;
}

// Rattache des appareils à un tableau et à un circuit (attributs mis à jour). Dans une transaction.
export function assignCircuit(doc, ids, boardName, circuitId) {
  for (const id of ids) {
    const e = doc.get(id);
    if (!isElec(e) || e.elec.kind === 'board') continue;
    doc.modify(id, (x) => { x.elec = { ...x.elec, board: boardName, circuit: circuitId }; refreshAttribs(x); });
  }
}

// Réglages d'un circuit enregistrés dans son tableau. Dans une transaction.
export function setCircuit(doc, boardName, id, props) {
  const b = boardByName(doc, boardName);
  if (!b) return;
  doc.modify(b.id, (x) => {
    const list = [...(x.elec.circuits || [])];
    const i = list.findIndex((c) => c.id === id);
    const cur = i >= 0 ? list[i] : { id };
    const next = { ...cur, ...props };
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
    if (i >= 0) list[i] = next; else list.push(next);
    x.elec = { ...x.elec, circuits: list };
  });
}
