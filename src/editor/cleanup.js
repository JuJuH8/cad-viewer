// SPDX-License-Identifier: GPL-3.0-or-later
// Nettoyage des dessins : PURGER (blocs, calques, types de ligne inutilisés) et SUPPRDOUBLONS
// (objets en double et lignes colinéaires qui se chevauchent, comme OVERKILL d'AutoCAD).
import * as G from '../core/geom.js';

const LAYOUT_BLOCK = /^\*(model|paper)_space/i;
const KEEP_LTYPES = new Set(['continuous', 'bylayer', 'byblock']);

const refsOf = (ents) => ents.filter((e) => (e.type === 'INSERT' || e.type === 'BLOCKREF') && e.name).map((e) => e.name);

// Blocs utilisés : référencés par une entité du dessin, directement ou par un bloc utilisé.
export function usedBlocks(doc) {
  const used = new Set();
  const stack = refsOf([...doc.entities.values()]);
  while (stack.length) {
    const n = stack.pop();
    if (used.has(n)) continue;
    used.add(n);
    const b = doc.blocks.get(n);
    if (b) stack.push(...refsOf(b.entities || []));
  }
  return used;
}

// Supprime ce qui n'est pas utilisé (annulable). Renvoie les noms supprimés par table.
export function purgeDocument(doc) {
  const out = { blocks: [], layers: [], ltypes: [] };
  const used = usedBlocks(doc);
  const spaces = new Set((doc.spaces || []).map((s) => s.id));
  for (const [name, b] of [...doc.blocks]) {
    if (used.has(name) || b.xref || LAYOUT_BLOCK.test(name) || spaces.has(name)) continue;
    doc.setTableEntry('blocks', name, null);
    out.blocks.push(name);
  }
  for (const name of [...doc.layers.keys()]) {
    if (name.toUpperCase() === 'DEFPOINTS' || name.includes('|')) continue;
    if (doc.deleteLayer(name)) out.layers.push(name);
  }
  if (doc.ltypes?.size) {
    const usedLt = new Set();
    const note = (lt) => { if (lt) usedLt.add(String(lt).toLowerCase()); };
    for (const l of doc.layers.values()) note(l.ltype);
    const noteAll = (e) => { note(e.ltype); for (const a of e.attribs || []) note(a.ltype); };
    for (const e of doc.entities.values()) noteAll(e);
    for (const b of doc.blocks.values()) for (const e of b.entities || []) noteAll(e);
    for (const name of [...doc.ltypes.keys()]) {
      const k = name.toLowerCase();
      if (KEEP_LTYPES.has(k) || usedLt.has(k) || name.includes('|')) continue;
      doc.setTableEntry('ltypes', name, null);
      out.ltypes.push(name);
    }
  }
  return out;
}

// --- SUPPRDOUBLONS ---------------------------------------------------------------------

const style = (e) => `${e.layer}|${e.color ?? 256}|${e.rgb ?? ''}|${e.ltype ?? ''}|${e.lweight ?? ''}|${e.space}`;

// Clé géométrique arrondie à la tolérance (null : type non comparé).
function geomKey(e, tol) {
  const r = (v) => Math.round((v || 0) / tol);
  const P = (p) => `${r(p[0])},${r(p[1])},${r(p[2])}`;
  const A = (a) => Math.round(G.normAngle(a) / Math.max(tol, 1e-9));
  switch (e.type) {
    case 'LINE': {
      const a = P(e.p1), b = P(e.p2);
      return `L${a < b ? a + b : b + a}`;
    }
    case 'CIRCLE': return `C${P(e.c)}:${r(e.r)}`;
    case 'ARC': return `A${P(e.c)}:${r(e.r)}:${A(e.a0)}:${A(e.a1)}`;
    case 'POINT': return `P${P(e.p)}`;
    case 'TEXT': case 'MTEXT': return `T${e.type}${P(e.p)}:${r(e.h)}:${A(e.rot || 0)}:${e.align}:${e.valign}:${e.attach}:${e.style}:${e.wf}:${e.text}`;
    // Insertions : valeurs d'attributs et paramètres MEP (bouches) font partie de l'identité.
    case 'INSERT': return `I${e.name}:${P(e.p)}:${r((e.sx ?? 1) * 1e6)}:${r((e.sy ?? 1) * 1e6)}:${A(e.rot || 0)}:${(e.attribs || []).map((a) => `${a.tag}=${a.text}`).join('|')}:${e.mep ? JSON.stringify(e.mep) : ''}`;
    case 'LWPOLYLINE': {
      if (e.mep) return null; // réseaux MEP : jamais fusionnés automatiquement
      const f = e.pts.map((p, i) => `${r(p[0])},${r(p[1])},${Math.round((e.bulges?.[i] || 0) * 1e6)}`).join(';');
      const n = e.pts.length;
      const rev = e.pts.map((_, i) => {
        const p = e.pts[n - 1 - i];
        const b = i < n - 1 ? -(e.bulges?.[n - 2 - i] || 0) : 0;
        return `${r(p[0])},${r(p[1])},${Math.round(b * 1e6)}`;
      }).join(';');
      return `W${e.closed ? 1 : 0}:${r(e.z)}:${r(e.width)}:${e.closed || f < rev ? f : rev}`;
    }
    default: return null;
  }
}

// Fusionne les lignes colinéaires qui se chevauchent ou se touchent (même style).
// Renvoie { remove: [ids], update: [lignes prolongées] }.
function mergeCollinear(lines, tol) {
  const groups = new Map();
  for (const e of lines) {
    const a = [e.p1[0], e.p1[1]], b = [e.p2[0], e.p2[1]];
    const len = G.dist(a, b);
    if (len < tol || Math.abs((e.p1[2] || 0) - (e.p2[2] || 0)) > tol) continue;
    let d = G.norm(G.sub(b, a));
    if (d[0] < -1e-12 || (Math.abs(d[0]) <= 1e-12 && d[1] < 0)) d = [-d[0], -d[1]];
    const ang = Math.atan2(d[1], d[0]);
    const off = G.cross(d, a); // distance signée de la droite à l'origine
    const key = `${style(e)}|${Math.round(ang / 1e-9)}|${Math.round(off / tol)}|${Math.round((e.p1[2] || 0) / tol)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { d, items: [] }));
    const t1 = G.dot(a, g.d), t2 = G.dot(b, g.d);
    g.items.push({ e, t0: Math.min(t1, t2), t1: Math.max(t1, t2) });
  }
  const remove = [], update = [];
  for (const g of groups.values()) {
    if (g.items.length < 2) continue;
    g.items.sort((x, y) => x.t0 - y.t0);
    let cur = null;
    const flush = () => {
      if (!cur || cur.members.length < 2) return;
      const keep = cur.members[0].e;
      // Point de la droite au paramètre t : on part d'une extrémité de la ligne gardée.
      const base = [keep.p1[0], keep.p1[1]];
      const t0 = G.dot(base, g.d);
      const at = (t) => G.add(base, G.mul(g.d, t - t0));
      const p1 = at(cur.t0), p2 = at(cur.t1);
      update.push({ ...keep, p1: [p1[0], p1[1], keep.p1[2] || 0], p2: [p2[0], p2[1], keep.p2[2] || 0] });
      for (const m of cur.members.slice(1)) remove.push(m.e.id);
    };
    for (const it of g.items) {
      // Chevauchement partiel ou inclusion (des lignes seulement bout à bout restent séparées, comme OVERKILL).
      if (cur && it.t0 < cur.t1 - tol) {
        cur.t1 = Math.max(cur.t1, it.t1);
        cur.members.push(it);
      } else {
        flush();
        cur = { t0: it.t0, t1: it.t1, members: [it] };
      }
    }
    flush();
  }
  return { remove, update };
}

// Analyse les entités et renvoie { remove: [ids], update: [entités] } sans toucher au document.
export function findOverkill(entities, tol = 1e-6) {
  const seen = new Map();
  const remove = new Set();
  for (const e of entities) {
    const k = geomKey(e, tol);
    if (k == null) continue;
    const key = `${style(e)}#${k}`;
    if (seen.has(key)) remove.add(e.id); else seen.set(key, e.id);
  }
  const lines = entities.filter((e) => e.type === 'LINE' && !remove.has(e.id));
  const merged = mergeCollinear(lines, tol);
  for (const id of merged.remove) remove.add(id);
  return { remove: [...remove], update: merged.update.filter((u) => !remove.has(u.id)) };
}
