// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes de cotation : COTLIN (linéaire), COTALI (alignée), COTRAYON, COTDIA, ECHELLEANNO.
// Une cote est un BLOCKREF « DIMENSION » vers un bloc généré, avec ses paramètres (pour la régénérer).
import { dimStyleOf } from '../core/drawing-settings.js';
import * as G from '../core/geom.js';
import { dimSizes, linearDimension, radialDimension } from '../core/dimension.js';
import { fmt } from './editor.js';
import { assocRef, installAssociativeDims } from './assoc.js';

export function annoScale(doc) {
  const h = doc.header || (doc.header = {});
  if (h.annoScale) return h.annoScale;
  if (h.dimscale > 1) return h.dimscale;
  return h.insunits === 4 ? 50 : 1; // dessin en mm : annotations au 1/50 par défaut
}

function addDimension(doc, entities, meta) {
  doc.dimCounter = (doc.dimCounter || 0) + 1;
  let name;
  do name = `*DIMGEN${doc.dimCounter++}`; while (doc.blocks.has(name));
  doc.blocks.set(name, { name, base: [0, 0, 0], flags: 1, xref: false, entities });
  return doc.add({ type: 'BLOCKREF', kind: 'DIMENSION', name, m: [1, 0, 0, 1, 0, 0], color: 256, meta, space: doc.currentSpace || 'model' });
}

export function registerDimCommands(ed) {
  // Cotes associatives sur chaque document ouvert.
  (ed.docHooks ||= []).push((doc) => installAssociativeDims(doc, annoScale));
  if (ed.doc) installAssociativeDims(ed.doc, annoScale);

  // Ligne de repère : flèche, segments, palier et note (comme QLEADER).
  ed.register('LIGNEREPERE', async (ctx) => {
    const { doc } = ctx;
    const h = 2.5 * annoScale(doc);
    const space = doc.currentSpace || 'model';
    const build = (pts, text) => {
      if (pts.length < 2 || G.dist(pts[0], pts[1]) < 1e-9) return [];
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const right = last[0] >= prev[0];
      const shoulder = [last[0] + (right ? 1 : -1) * h, last[1]];
      const dir = G.norm(G.sub(pts[0], pts[1]));
      const back = G.sub(pts[0], G.mul(dir, h));
      const n = G.mul(G.perp(dir), h * 0.25);
      const base = { layer: doc.currentLayer, color: 256, space };
      const out = [
        { ...base, type: 'LWPOLYLINE', pts: [...pts, shoulder].map((p) => [p[0], p[1]]), bulges: [...pts, shoulder].map(() => 0), closed: false, z: 0, width: 0 },
        { ...base, type: 'SOLID', pts: [pts[0], G.add(back, n), G.sub(back, n), G.sub(back, n)], z: 0 },
      ];
      if (text) out.push({ ...base, type: 'TEXT', p: [shoulder[0] + (right ? 1 : -1) * h * 0.4, shoulder[1], 0], h, rot: 0, text, align: right ? 'left' : 'right', valign: 'middle', wf: 1 });
      return out;
    };
    const pts = [await ctx.getPoint('Pointe de la flèche')];
    while (true) {
      const p = await ctx.getPoint(pts.length < 2 ? 'Point suivant' : 'Point suivant (Entrée : saisir la note)', {
        base: pts[pts.length - 1], allowNone: pts.length >= 2, preview: (q) => build([...pts, q], ''),
      });
      if (p === null) break;
      if (G.dist(p, pts[pts.length - 1]) < 1e-9) continue;
      pts.push(p);
    }
    const text = await ctx.getString('Texte de la note');
    for (const x of build(pts, text.trim())) doc.add(x);
  }, { aliases: ['LE', 'QLEADER', 'LEADER', 'REPERE', 'MLEADER', 'MLD'], label: 'LIGNEREPERE' });

  let lastLinear = null; // dernière cote linéaire / alignée (base de COTCONT et COTLIGNEBASE)
  const linear = (aligned) => async (ctx) => {
    const { doc } = ctx;
    const sizes = dimSizes(annoScale(doc), dimStyleOf(doc));
    {
      const p1 = await ctx.getPoint('Origine de la première ligne d’attache');
      const p2 = await ctx.getPoint('Origine de la deuxième ligne d’attache', { base: p1 });
      // COTLIN : horizontale ou verticale selon la position du curseur (comme AutoCAD).
      const rotFor = (p) => {
        if (aligned) return null;
        const minX = Math.min(p1[0], p2[0]), maxX = Math.max(p1[0], p2[0]);
        const minY = Math.min(p1[1], p2[1]), maxY = Math.max(p1[1], p2[1]);
        const outX = p[0] < minX || p[0] > maxX, outY = p[1] < minY || p[1] > maxY;
        return outX && !outY ? Math.PI / 2 : 0;
      };
      const build = (loc) => linearDimension({ p1, p2, loc, rotation: rotFor(loc), sizes });
      const loc = await ctx.getPoint('Position de la ligne de cote', {
        base: p2, preview: (p) => build(p)?.entities || [],
      });
      const res = build(loc);
      if (!res) return;
      // Accrochage des points de définition aux objets (cote associative).
      const near = (p) => ctx.editor.r.near(p, ctx.editor.worldTol(2));
      const assoc = [assocRef(doc, near(p1), p1), assocRef(doc, near(p2), p2)];
      const meta = { type: aligned ? 'aligned' : 'linear', p1, p2, loc, rotation: rotFor(loc), measurement: res.measure, assoc };
      addDimension(doc, res.entities, meta);
      lastLinear = meta;
      ctx.print(`Cote : ${fmt(res.measure)}`);
    }
  };

  ed.register('COTLIN', linear(false), { aliases: ['DLI', 'DIMLINEAR', 'COTATION'], label: 'COTLIN' });

  // COTCONT / COTLIGNEBASE : cotes enchaînées à partir de la dernière cote linéaire ou alignée (ou d'une cote
  // choisie) — continue : depuis la deuxième ligne d'attache précédente, même ligne de cote ; ligne de base :
  // depuis la première ligne d'attache de la cote de base, chaque cote décalée d'un pas (DIMDLI = 1,5 × texte).
  const chain = (baseline) => async (ctx) => {
    const { doc } = ctx;
    const sizes = dimSizes(annoScale(doc), dimStyleOf(doc));
    let base = lastLinear;
    const pickBase = async () => {
      const pick = await ctx.getEntity('Choisissez une cote linéaire ou alignée');
      const m = doc.get(pick.id)?.meta;
      if (!m || (m.type !== 'linear' && m.type !== 'aligned')) { ctx.print('Ce n’est pas une cote linéaire ou alignée.'); return null; }
      return m;
    };
    if (!base) base = await pickBase();
    if (!base) return;
    const near = (p) => ctx.editor.r.near(p, ctx.editor.worldTol(2));
    let prev = base;
    while (true) {
      const from = baseline ? base.p1 : prev.p2;
      const rot = prev.rotation ?? G.angleOf(prev.p1, prev.p2); // cote alignée : direction de la cote de base
      const dir = [Math.cos(rot), Math.sin(rot)], n = G.perp(dir);
      const side = Math.sign(G.dot(G.sub(prev.loc, prev.p1), n)) || 1;
      const loc = baseline ? G.add(prev.loc, G.mul(n, side * sizes.txt * 1.5)) : prev.loc;
      const build = (p) => linearDimension({ p1: from, p2: p, loc, rotation: rot, sizes });
      const p2 = await ctx.getPoint('Origine de la deuxième ligne d’attache', { base: from, allowNone: true, keywords: ['Choisir'], preview: (p) => build(p)?.entities || [] });
      if (p2 === null) return;
      if (p2 === 'Choisir') { const b = await pickBase(); if (b) { base = b; prev = b; } continue; }
      const res = build(p2);
      if (!res) continue;
      const meta = { type: 'linear', p1: from, p2, loc, rotation: rot, measurement: res.measure, assoc: [assocRef(doc, near(from), from), assocRef(doc, near(p2), p2)] };
      addDimension(doc, res.entities, meta);
      ctx.print(`Cote : ${fmt(res.measure)}`);
      prev = meta;
      lastLinear = meta;
    }
  };
  ed.register('COTCONT', chain(false), { aliases: ['DCO', 'DIMCONTINUE', 'DIMCONT'], label: 'COTCONT' });
  ed.register('COTLIGNEBASE', chain(true), { aliases: ['DBA', 'DIMBASELINE', 'DIMBASE'], label: 'COTLIGNEBASE' });
  ed.register('COTALI', linear(true), { aliases: ['DAL', 'DIMALIGNED'], label: 'COTALI' });

  const radial = (diameter) => async (ctx) => {
    const { doc } = ctx;
    const sizes = dimSizes(annoScale(doc), dimStyleOf(doc));
    {
      const pick = await ctx.getEntity('Choisissez un arc ou un cercle');
      const e = doc.get(pick.id);
      if (e.type !== 'CIRCLE' && e.type !== 'ARC') { ctx.print('Il faut un cercle ou un arc.'); return; }
      const c = [e.c[0], e.c[1]];
      const build = (p) => radialDimension({ c, r: e.r, loc: p, diameter, sizes });
      const loc = await ctx.getPoint('Position de la ligne de cote', {
        base: c, preview: (p) => build(p)?.entities || [],
      });
      const res = build(loc);
      if (!res) return;
      addDimension(doc, res.entities, { type: diameter ? 'diameter' : 'radius', c, r: e.r, loc, measurement: res.measure, assoc: [{ id: e.id, k: 'circle', i: 0 }] });
    }
  };
  ed.register('COTRAYON', radial(false), { aliases: ['DRA', 'DIMRADIUS'], label: 'COTRAYON' });
  ed.register('COTDIA', radial(true), { aliases: ['DDI', 'DIMDIAMETER'], label: 'COTDIA' });

  ed.register('ECHELLEANNO', async (ctx) => {
    const v = await ctx.getDistance('Échelle d’annotation (ex. 50 pour 1:50)', { default: annoScale(ctx.doc) });
    if (v > 0) { ctx.doc.setHeader({ annoScale: v }); ctx.print(`Échelle d’annotation : 1:${fmt(v)} (textes de cote ${fmt(2.5 * v)}).`); }
  }, { aliases: ['ANNOSCALE', 'ECH'], label: 'ECHELLEANNO' });
}

