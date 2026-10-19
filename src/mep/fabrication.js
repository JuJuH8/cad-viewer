// SPDX-License-Identifier: GPL-3.0-or-later
// Repérage des pièces de réseau et nomenclature (première brique « fabrication ») : chaque gaine,
// canalisation ou chemin de câbles reçoit un repère par système (SOUF-001…), que la géométrie du réseau
// dessine dans une bulle (geometry.js) ; la nomenclature liste les pièces avec section, longueur, coudes,
// calorifuge et altitude.
import * as G from '../core/geom.js';
import { KIND_LABELS, kindLabel, sectionLabel, vertexZ } from './systems.js';
import { mepLength, elbowPlan } from './geometry.js';
import { buildNetwork } from './network.js';

const isRun = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2;

// Ordre de repérage : par système, puis de gauche à droite et de bas en haut (point de départ).
export function numberRuns(entities, { start = 1 } = {}) {
  const runs = entities.filter(isRun);
  const bySys = new Map();
  for (const e of runs) {
    if (!bySys.has(e.mep.system)) bySys.set(e.mep.system, []);
    bySys.get(e.mep.system).push(e);
  }
  const out = new Map(); // id → repère
  for (const [sys, list] of [...bySys].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.pts[0][0] - b.pts[0][0] || a.pts[0][1] - b.pts[0][1]);
    list.forEach((e, i) => out.set(e.id, `${sys}-${String(start + i).padStart(3, '0')}`));
  }
  return out;
}

// Nomenclature : une ligne par pièce repérée (longueur en m).
export function billOfMaterials(entities, unitM = 0.001) {
  return entities.filter((e) => isRun(e) && e.mep.num)
    .sort((a, b) => a.mep.num.localeCompare(b.mep.num, 'fr', { numeric: true }))
    .map((e) => ({
      num: e.mep.num, system: e.mep.system, type: kindLabel(e.mep), section: sectionLabel(e.mep),
      length: mepLength(e) * unitM, elbows: Math.max(0, e.pts.length - 2), ins: e.mep.ins || 0, z: (e.mep.z || 0) * unitM,
    }));
}

export function bomCsv(rows) {
  const num = (v, d = 2) => v.toFixed(d).replace('.', ',');
  const lines = ['Repère;Système;Type;Section;Longueur (m);Coudes;Calorifuge (mm);Altitude (m)',
    ...rows.map((r) => [r.num, r.system, r.type, r.section, num(r.length), r.elbows, r.ins, num(r.z)].join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

// Pièces de forme (comme une nomenclature CADmep) : coudes par angle (arrondi à 5°), réductions entre deux
// sections raccordées bout à bout, piquages (section du branchement sur section du réseau porteur).
// Renvoie [{ system, kind, type, section, count }].
export function fittings(entities) {
  const out = new Map();
  const add = (system, kind, type, section) => {
    const key = `${system}|${type}|${section}`;
    const r = out.get(key) || { system, kind, type, section, count: 0 };
    r.count++;
    out.set(key, r);
  };
  const area = (m) => (m.kind === 'pipe' || m.shape === 'round' ? (m.d || 0) ** 2 * 0.785 : (m.w || 0) * (m.h || 60));
  for (const e of entities) {
    if (!isRun(e)) continue;
    // Chemin de câbles et gaine : coude à onglet distingué (choisi, ou faute de place pour le coude à rayon).
    const plan = e.mep.kind === 'pipe' ? null : elbowPlan(e);
    if (e.mep.conduit) continue; // tube souple : il se cintre, pas de pièce de coude
    for (let k = 1; k < e.pts.length - 1; k++) {
      const a = G.norm(G.sub(e.pts[k], e.pts[k - 1])), b = G.norm(G.sub(e.pts[k + 1], e.pts[k]));
      const deg = Math.round((Math.acos(Math.max(-1, Math.min(1, G.dot(a, b)))) * 180) / Math.PI / 5) * 5;
      if (deg >= 5) add(e.mep.system, e.mep.kind, `Coude ${deg}°${plan && !plan.t[k] ? ' à onglet' : ''}`, sectionLabel(e.mep));
    }
  }
  for (const kind of ['duct', 'pipe', 'tray']) {
    const net = buildNetwork(entities, kind);
    // Jonctions bout à bout : extrémités reliées regroupées (union-find sur « id:extrémité »).
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const node = (x) => { if (!parent.has(x)) parent.set(x, x); return x; };
    for (const [id, links] of net.links) {
      const a = net.ducts.get(id), La = net.st.get(id).at(-1);
      for (const l of links) {
        const b = net.ducts.get(l.id), Lb = net.st.get(l.id).at(-1);
        const tol = 1e-6 * Math.max(1, La, Lb);
        const aEnd = l.s < tol ? 0 : l.s > La - tol ? 1 : -1, bEnd = l.os < tol ? 0 : l.os > Lb - tol ? 1 : -1;
        if (aEnd >= 0 && bEnd >= 0) {
          const x = find(node(`${id}:${aEnd}`)), y = find(node(`${l.id}:${bEnd}`));
          if (x !== y) parent.set(x, y);
        } else if (aEnd >= 0 && bEnd < 0) {
          add(a.mep.system, kind, kind === 'pipe' ? 'Té' : 'Piquage', `${sectionLabel(a.mep)} sur ${sectionLabel(b.mep)}`);
        }
      }
    }
    const groups = new Map();
    for (const x of parent.keys()) {
      const r = find(x);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(x);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      // Direction de chaque réseau en partant de la jonction.
      const arms = members.map((m) => {
        const [id, end] = m.split(':');
        const e = net.ducts.get(+id) || net.ducts.get(id);
        const n = e.pts.length;
        const [p, q] = end === '0' ? [e.pts[0], e.pts[1]] : [e.pts[n - 1], e.pts[n - 2]];
        return { e, dir: G.norm(G.sub(q, p)), z: vertexZ(e)[end === '0' ? 0 : n - 1] };
      });
      const system = arms[0].e.mep.system;
      if (arms.length === 2) {
        const [u, v] = arms;
        const dev = 180 - (Math.acos(Math.max(-1, Math.min(1, G.dot(u.dir, v.dir)))) * 180) / Math.PI;
        const [big, small] = area(u.e.mep) >= area(v.e.mep) ? [u.e, v.e] : [v.e, u.e];
        const deg = Math.round(dev / 5) * 5;
        // Montée / descente : deux coudes à 90° (le changement de direction en plan s'y fond).
        if (Math.abs(u.z - v.z) > 1e-6 * Math.max(1, big.mep.d || big.mep.w || 1)) add(system, kind, 'Coude 90°', sectionLabel(small.mep)), add(system, kind, 'Coude 90°', sectionLabel(big.mep));
        else if (deg >= 5) add(system, kind, `Coude ${deg}°`, sectionLabel(big.mep));
        if (sectionLabel(big.mep) !== sectionLabel(small.mep)) add(system, kind, 'Réduction', `${sectionLabel(big.mep)} → ${sectionLabel(small.mep)}`);
        continue;
      }
      // Trois réseaux ou plus : les deux les plus alignés forment le passage, les autres sont des tés.
      let best = null;
      for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
        const d = G.dot(arms[i].dir, arms[j].dir);
        if (!best || d < best.d) best = { d, i, j };
      }
      const main = [arms[best.i].e, arms[best.j].e].sort((x, y) => area(y.mep) - area(x.mep))[0];
      arms.forEach((arm, k) => {
        if (k === best.i || k === best.j) return;
        add(system, kind, 'Té', `${sectionLabel(arm.e.mep)} sur ${sectionLabel(main.mep)}`);
      });
    }
  }
  return [...out.values()].sort((x, y) => x.system.localeCompare(y.system) || x.type.localeCompare(y.type, 'fr', { numeric: true })
    || x.section.localeCompare(y.section, 'fr', { numeric: true }));
}
