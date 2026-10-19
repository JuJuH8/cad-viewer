// SPDX-License-Identifier: GPL-3.0-or-later
// Fonds de plan : une base architecte (DWG, DXF, IFC) attachée comme une référence externe, que l'on peut
// recharger, remplacer par une nouvelle version (même position, même traitement) et comparer à la précédente.
//
// Un fond est un bloc xref dont la définition porte `fond` (fichier, source, profil, version, historique),
// inséré dans l'espace objet sur son propre calque « FOND-<nom> » (affichage, verrouillage).
// Attacher, remplacer et retirer sont annulables (une étape chacun).

import * as G from '../core/geom.js';
import { insertMatrix, transformEntity } from '../core/entities.js';
import { revisionCloud } from '../editor/commands.js';
import { compareEntities, changeZones, defaultTolerance } from './compare.js';

export const FOND_LAYER = (name) => `FOND-${name}`;
export const CHANGES_LAYER = 'FOND-MODIFICATIONS';

const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 };

// Facteur d'échelle d'une base (unités src) insérée dans un dessin (unités dst) ; 1 si l'une est inconnue.
export function unitScale(src, dst) {
  return UNIT_M[src] && UNIT_M[dst] ? UNIT_M[src] / UNIT_M[dst] : 1;
}

export function listFonds(doc) {
  return [...doc.blocks.values()].filter((b) => b.fond);
}

export function fondInserts(doc, name) {
  return [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.name === name);
}

// Nom libre pour un nouveau fond (caractères interdits dans un nom de bloc remplacés).
export function freeName(doc, wanted) {
  const base = String(wanted || 'Fond').replace(/\.(dwg|dxf|ifc)$/i, '').replace(/[<>/\\":;?*|=`,]/g, '_').trim() || 'Fond';
  let n = base, i = 2;
  while (doc.blocks.has(n)) n = `${base} (${i++})`;
  return n;
}

// Contenu d'une base préfixé comme une xref AutoCAD (« nom|calque », « nom|bloc ») : calques, types de ligne,
// blocs et objets de l'espace objet.
export function xrefContent(name, xdoc) {
  const prefix = `${name}|`;
  const layerMap = new Map();
  const layers = [];
  for (const l of xdoc.layers.values()) {
    const ln = l.name === '0' ? '0' : prefix + l.name;
    layerMap.set(l.name, ln);
    if (ln !== '0') layers.push({ ...l, name: ln, ltype: l.ltype && !/^continuous$/i.test(l.ltype) ? prefix + l.ltype : l.ltype });
  }
  const ltypes = [...(xdoc.ltypes?.values() || [])].map((t) => ({ ...t, name: prefix + t.name }));
  const blockMap = new Map([...xdoc.blocks.keys()].map((n) => [n, prefix + n]));
  const rename = (e) => {
    const c = structuredClone(e);
    delete c.id; delete c.space; delete c.handle;
    c.layer = layerMap.get(c.layer) ?? c.layer;
    if (c.ltype && !/^(bylayer|byblock|continuous)$/i.test(c.ltype)) c.ltype = prefix + c.ltype;
    if ((c.type === 'INSERT' || c.type === 'BLOCKREF') && blockMap.has(c.name)) c.name = blockMap.get(c.name);
    if (c.attribs) c.attribs = c.attribs.map(rename);
    return c;
  };
  const blocks = [...xdoc.blocks.values()].map((b) => ({ ...b, name: blockMap.get(b.name), entities: b.entities.map(rename), xref: false }));
  const entities = [...xdoc.entities.values()].filter((e) => (e.space ?? 'model') === 'model').map(rename);
  return { layers, ltypes, blocks, entities };
}

function nestedBlockNames(doc, name) {
  const prefix = `${name}|`;
  return [...doc.blocks.keys()].filter((n) => n.startsWith(prefix));
}

// Attache une base traitée. meta : { file, source, profile, cleaned (rapport), count }. Renvoie le nom du fond.
export function attachFond(doc, { name, xdoc, meta = {}, insertion = [0, 0, 0], scale = null }) {
  name = freeName(doc, name);
  const k = scale ?? unitScale(xdoc.header?.insunits, doc.header?.insunits);
  const c = xrefContent(name, xdoc);
  doc.transaction(`Attacher le fond ${name}`, () => {
    for (const l of c.layers) if (!doc.layers.has(l.name)) doc.addLayer(l.name, l);
    for (const t of c.ltypes) if (!doc.ltypes?.has(t.name.toUpperCase())) doc.setTableEntry('ltypes', t.name.toUpperCase(), t);
    for (const b of c.blocks) doc.setTableEntry('blocks', b.name, b);
    const now = new Date().toISOString();
    doc.setTableEntry('blocks', name, {
      name, base: [0, 0, 0], flags: 4, xref: true, xrefLoaded: true, entities: c.entities,
      fond: { ...meta, version: 1, loadedAt: now, count: c.entities.length, scale: k, insunits: xdoc.header?.insunits ?? 0, history: [] },
    });
    // Calque de l'insertion verrouillé : le fond ne se sélectionne pas par mégarde (l'accrochage reste actif).
    const lay = FOND_LAYER(name);
    if (!doc.layers.has(lay)) doc.addLayer(lay, { color: 8, locked: true });
    doc.add({ type: 'INSERT', name, layer: lay, space: 'model', p: [...insertion], sx: k, sy: k, sz: k, rot: 0, cols: 1, rows: 1, dc: 0, dr: 0, attribs: [] });
  });
  return name;
}

// Remplit un fond relu sans son contenu (référence externe d'un dessin rouvert) : pas d'historique.
export function fillFond(doc, name, xdoc) {
  const b = doc.blocks.get(name);
  if (!b) return 0;
  const c = xrefContent(name, xdoc);
  for (const l of c.layers) if (!doc.layers.has(l.name)) doc.layers.set(l.name, l);
  if (!doc.ltypes) doc.ltypes = new Map();
  for (const t of c.ltypes) if (!doc.ltypes.has(t.name.toUpperCase())) doc.ltypes.set(t.name.toUpperCase(), t);
  for (const nb of c.blocks) doc.blocks.set(nb.name, nb);
  b.entities = c.entities;
  b.xrefLoaded = true;
  b.fond = { ...b.fond, count: c.entities.length, insunits: xdoc.header?.insunits ?? b.fond?.insunits };
  doc.blockVersion++;
  doc.emit({ added: new Set(), removed: new Set(), modified: new Set(), layers: new Set(), reset: true });
  return c.entities.length;
}

// Remplace le contenu d'un fond par une nouvelle version (insertion, calques et réglages conservés).
// Renvoie { name, before, after } (objets et blocs des deux versions, pour la comparaison).
export function replaceFond(doc, name, xdoc, meta = {}) {
  const old = doc.blocks.get(name);
  if (!old?.fond) throw new Error(`« ${name} » n’est pas un fond de plan`);
  const oldBlocks = new Map(nestedBlockNames(doc, name).map((n) => [n, doc.blocks.get(n)]));
  const c = xrefContent(name, xdoc);
  doc.transaction(`Nouvelle version du fond ${name}`, () => {
    // Calques : les états réglés par l'utilisateur sur les calques existants sont conservés (comme VISRETAIN).
    for (const l of c.layers) if (!doc.layers.has(l.name)) doc.addLayer(l.name, l);
    for (const t of c.ltypes) if (!doc.ltypes?.has(t.name.toUpperCase())) doc.setTableEntry('ltypes', t.name.toUpperCase(), t);
    const keep = new Set(c.blocks.map((b) => b.name));
    for (const n of oldBlocks.keys()) if (!keep.has(n)) doc.setTableEntry('blocks', n, null);
    for (const b of c.blocks) doc.setTableEntry('blocks', b.name, b);
    const prev = old.fond;
    doc.setTableEntry('blocks', name, {
      ...old, entities: c.entities,
      fond: {
        ...prev, ...meta, version: (prev.version || 1) + 1, loadedAt: new Date().toISOString(), count: c.entities.length,
        insunits: xdoc.header?.insunits ?? prev.insunits,
        history: [...(prev.history || []), { file: prev.file, version: prev.version || 1, loadedAt: prev.loadedAt, count: prev.count }].slice(-20),
      },
    });
    // Les insertions sont redessinées (leur définition a changé).
    for (const ins of fondInserts(doc, name)) doc.modify(ins.id, () => {});
  });
  return {
    name,
    before: { entities: old.entities, blocks: oldBlocks },
    after: { entities: c.entities, blocks: new Map(c.blocks.map((b) => [b.name, b])) },
  };
}

// Retire un fond : insertions, définitions (bloc et blocs imbriqués) et calques devenus inutiles.
export function detachFond(doc, name) {
  if (!doc.blocks.get(name)?.fond) return false;
  doc.transaction(`Retirer le fond ${name}`, () => {
    for (const ins of fondInserts(doc, name)) doc.remove(ins.id);
    for (const n of nestedBlockNames(doc, name)) doc.setTableEntry('blocks', n, null);
    doc.setTableEntry('blocks', name, null);
    const prefix = `${name}|`;
    for (const l of [...doc.layers.keys()]) if (l.startsWith(prefix) || l === FOND_LAYER(name)) doc.deleteLayer(l);
  });
  return true;
}

// Réglages d'un fond (source, profil, table…) : annulable.
export function setFondMeta(doc, name, props) {
  const b = doc.blocks.get(name);
  if (!b?.fond) return;
  doc.setTableEntry('blocks', name, { ...b, fond: { ...b.fond, ...props } });
}

// --- comparaison de versions ------------------------------------------------------------

// Objets simples (blocs décomposés récursivement) dans le repère du bloc parent.
export function explodeForDisplay(entities, blocks, m = G.IDENTITY, depth = 0, out = []) {
  for (const e of entities) {
    if ((e.type === 'INSERT' || e.type === 'BLOCKREF') && depth < 8) {
      const b = blocks.get(e.name);
      if (!b) continue;
      if (e.type === 'BLOCKREF') explodeForDisplay(b.entities, blocks, G.compose(m, e.m || G.IDENTITY), depth + 1, out);
      else explodeForDisplay(b.entities, blocks, G.compose(m, insertMatrix(e, b.base || [0, 0])), depth + 1, out);
      for (const a of e.attribs || []) if (!a.invisible) out.push(transformEntity(a, m));
    } else out.push(m === G.IDENTITY ? e : transformEntity(e, m));
  }
  return out;
}

// Compare deux versions d'un fond ; résultat en coordonnées du dessin (position de l'insertion).
export function compareVersions(doc, name, before, after) {
  const fond = doc.blocks.get(name)?.fond;
  const ins = fondInserts(doc, name)[0];
  const tol = defaultTolerance(fond?.insunits);
  const r = compareEntities(before.entities, after.entities, { tol, oldBlocks: before.blocks, newBlocks: after.blocks });
  const m = ins ? insertMatrix(ins, [0, 0]) : G.IDENTITY;
  const blocksOld = new Map([...doc.blocks, ...before.blocks]);
  const blocksNew = new Map([...doc.blocks, ...after.blocks]);
  const added = explodeForDisplay(r.added, blocksNew, m);
  const removed = explodeForDisplay(r.removed, blocksOld, m);
  // Zones : objets à moins de 1,5 m les uns des autres regroupés (unités du dessin).
  const gap = 1.5 / (UNIT_M[doc.header?.insunits] || 0.001);
  const zones = changeZones([...added.map((e) => ({ e, kind: 'added' })), ...removed.map((e) => ({ e, kind: 'removed' }))], gap);
  return { name, added, removed, same: r.same, addedCount: r.added.length, removedCount: r.removed.length, zones, tol };
}

// Nuages de révision autour des zones, sur le calque FOND-MODIFICATIONS (une étape d'annulation).
export function cloudZones(doc, zones, { arc = null } = {}) {
  const unit = UNIT_M[doc.header?.insunits] || 0.001;
  const len = arc || 0.5 / unit; // arcs de 50 cm
  const margin = 0.3 / unit;
  let n = 0;
  doc.transaction('Nuages des modifications du fond', () => {
    if (!doc.layers.has(CHANGES_LAYER)) doc.addLayer(CHANGES_LAYER, { color: 1 });
    for (const z of zones) {
      const x0 = z.minX - margin, y0 = z.minY - margin, x1 = z.maxX + margin, y1 = z.maxY + margin;
      const c = revisionCloud([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], Math.min(len, Math.max(x1 - x0, y1 - y0) / 3));
      if (!c) continue;
      doc.add({ type: 'LWPOLYLINE', ...c, z: 0, width: 0, layer: CHANGES_LAYER, color: 256, space: 'model' });
      n++;
    }
  });
  return n;
}
