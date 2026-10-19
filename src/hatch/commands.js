// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes des hachures : HACHURES (boîte : motif, échelle, angle, origine, contour, îlots, associativité, fond),
// -HACHURES (ligne de commande), HACHEDIT (modifier) ; hachures associatives : le contour suit les objets dont il
// est issu (point intérieur ou objets fermés), comme dans AutoCAD.
import { placeUnder } from '../core/draworder.js';
import * as G from '../core/geom.js';
import { curvePoints } from '../core/tessellate.js';
import { findBoundary, expandInserts } from '../editor/boundary.js';
import { annoScaleOf, isMetric } from '../core/drawing-settings.js';
import { BUILTIN, findPattern, patternLines, defFromHatch, loadPatFile } from './patterns.js';
import { newEntity } from '../editor/commands.js';

// Échelle proposée : motifs en mm du papier × échelle des annotations ; acad.pat (pouces) × 25,4 en métrique.
export function defaultHatchScale(doc, source) {
  const k = annoScaleOf(doc);
  return source === 'acad.pat' && isMetric(doc) ? k * 25.4 : source === 'acadiso.pat' && !isMetric(doc) ? k / 25.4 : k;
}

// Contour fermé d'un objet (polyligne fermée, cercle, ellipse, spline fermée) en points, ou null.
export function closedLoop(e) {
  if (!['LWPOLYLINE', 'POLY3D', 'CIRCLE', 'ELLIPSE', 'SPLINE'].includes(e?.type)) return null;
  if ((e.type === 'LWPOLYLINE' || e.type === 'POLY3D') && !e.closed) return null;
  const c = curvePoints(e);
  if (!c || c.pts.length < 3) return null;
  const pts = c.pts.map((p) => [p[0], p[1]]);
  const a = pts[0], b = pts[pts.length - 1];
  if (e.type === 'SPLINE' && G.dist(a, b) > 1e-6 * (1 + Math.abs(a[0]) + Math.abs(a[1]))) return null;
  if (G.dist(a, b) < 1e-9) pts.pop();
  return pts;
}

// Objet hachure d'après les réglages de la boîte.
export function makeHatch(loops, opt, { origin = [0, 0], assoc = null, layer } = {}) {
  const e = {
    type: 'HATCH', loops, solid: !!opt.solid, pattern: opt.solid ? 'SOLID' : opt.def.name, z: 0,
    lines: opt.solid ? [] : patternLines(opt.def, { scale: opt.scale, angle: opt.angle, origin }),
    patScale: opt.solid ? 1 : opt.scale, patAngle: opt.solid ? 0 : opt.angle, patOrigin: origin,
  };
  if (!opt.solid) { e.patDef = opt.def; e.patSource = opt.source; }
  if (opt.bg != null) e.bg = opt.bg;
  if (assoc) e.assoc = assoc;
  if (layer) e.layer = layer;
  return e;
}

// Contours d'une hachure associative recalculés depuis ses objets sources (null si impossible).
export function recomputeLoops(doc, h) {
  const a = h.assoc;
  if (!a?.ids?.length) return null;
  const ents = a.ids.map((id) => doc.get(id)).filter(Boolean);
  if (ents.length !== a.ids.length) return null; // un objet source a disparu : la hachure n'est plus associative
  if (a.mode === 'objets') {
    const loops = ents.map(closedLoop);
    return loops.every(Boolean) ? loops : null;
  }
  const loops = [];
  const all = expandInserts(doc, ents);
  for (const seed of a.seeds || []) {
    const b = findBoundary(all, seed);
    if (!b) return null;
    loops.push(b.outer, ...(a.islands === 'ignorer' ? [] : b.islands));
  }
  return loops.length ? loops : null;
}

// Mise à jour automatique des hachures associatives (crochet de fin de transaction, comme les cotes).
export function installAssociativeHatches(doc) {
  if (doc.hatchAssoc || !doc.commitHooks) return;
  doc.hatchAssoc = true;
  let index = null; // id d'objet source → ids des hachures
  const note = (h) => {
    for (const id of h.assoc?.ids || []) {
      if (!index.has(id)) index.set(id, new Set());
      index.get(id).add(h.id);
    }
  };
  doc.commitHooks.push((change) => {
    if (!index) {
      index = new Map();
      for (const e of doc.entities.values()) if (e.type === 'HATCH' && e.assoc) note(e);
    }
    for (const id of [...change.added, ...change.modified]) { const e = doc.get(id); if (e?.type === 'HATCH' && e.assoc) note(e); }
    const hatches = new Set();
    for (const id of [...change.modified, ...change.removed]) for (const h of index.get(id) || []) hatches.add(h);
    for (const id of hatches) {
      const h = doc.get(id);
      if (h?.type !== 'HATCH' || !h.assoc) continue;
      const loops = recomputeLoops(doc, h);
      if (!loops) { const x = { ...h }; delete x.assoc; doc.update(x); continue; } // association perdue, contour gardé
      if (JSON.stringify(loops) !== JSON.stringify(h.loops)) doc.update({ ...h, loops });
    }
  });
}

export function registerHatchCommands(ed, deps = {}) {
  (ed.docHooks ||= []).push((doc) => installAssociativeHatches(doc));
  if (ed.doc) installAssociativeHatches(ed.doc);
  let last = null;

  // Objets visibles autour de la vue (candidats pour le contour d'un point intérieur).
  const visibleEntities = (doc) => {
    const r = ed.r;
    const hw = r.width / 2 / r.scale, hh = r.height / 2 / r.scale;
    const view = { minX: r.center.x - hw, maxX: r.center.x + hw, minY: r.center.y - hh, maxY: r.center.y + hh };
    return r.index.search(view).map((h) => doc.get(h.id)).filter((e) => e && e.type !== 'HATCH' && e.type !== 'UNDERLAY' && e.type !== 'TEXT' && e.type !== 'MTEXT' && r.layerVisible(e.layer));
  };

  // Pose : points intérieurs ou objets, puis une hachure par zone.
  async function place(ctx, opt) {
    const { doc } = ctx;
    let origin = [0, 0];
    if (!opt.solid && opt.origin === 'ecran') origin = await ctx.getPoint('Origine du motif');
    const box = (loops) => { const b = G.emptyBox(); for (const l of loops) for (const p of l) G.growBox(b, p[0], p[1]); return b; };
    const add = (loops, assoc, layer) => {
      const o = !opt.solid && opt.origin === 'contour' ? (() => { const b = box(loops); return [b.minX, b.minY]; })() : origin;
      const h = makeHatch(loops, opt, { origin: o, assoc: opt.assoc ? assoc : null, layer: layer || opt.layer });
      return doc.transaction('Hachures', () => {
        const e = doc.add(newEntity(doc, h));
        // Derrière son contour (comme HPDRAWORDER = 3 d'AutoCAD) : les traits du contour restent visibles.
        if (assoc?.ids?.length) placeUnder(doc, [e.id], assoc.ids);
        return e;
      });
    };
    let n = 0;
    let mode = opt.mode;
    while (true) {
      if (mode === 'point') {
        const p = await ctx.getPoint('Cliquez un point intérieur', { keywords: ['Objets'], allowNone: true });
        if (p === null) break;
        if (p === 'Objets') { mode = 'objets'; continue; }
        const cands = visibleEntities(doc);
        const b = findBoundary(expandInserts(doc, cands), p);
        if (!b) { ctx.print('Aucun contour fermé autour de ce point (parmi les objets visibles).'); continue; }
        const loops = [b.outer, ...(opt.islands === 'ignorer' ? [] : b.islands)];
        // Associativité : objets dont l'emprise touche le contour (le contour est recalculé avec eux).
        const lb = box(loops);
        const tol = Math.max(lb.maxX - lb.minX, lb.maxY - lb.minY) * 1e-3;
        const ids = cands.filter((e) => {
          const eb = ed.r.cache.get(e.id)?.box;
          return eb && eb.maxX >= lb.minX - tol && eb.minX <= lb.maxX + tol && eb.maxY >= lb.minY - tol && eb.minY <= lb.maxY + tol;
        }).map((e) => e.id);
        add(loops, { mode: 'point', ids, seeds: [p], islands: opt.islands });
        ctx.print(`Contour trouvé${loops.length > 1 ? ` avec ${loops.length - 1} îlot(s)` : ''}.`);
        n++;
        continue;
      }
      const pick = await ctx.getEntity('Choisissez un contour fermé (polyligne fermée, cercle, ellipse)', { keywords: ['Point'], allowNone: true });
      if (pick === null) break;
      if (pick === 'Point') { mode = 'point'; continue; }
      const e = doc.get(pick.id);
      const loop = closedLoop(e);
      if (!loop) { ctx.print('Il faut un contour fermé.'); continue; }
      add([loop], { mode: 'objets', ids: [e.id] }, opt.layer);
      n++;
    }
    ctx.print(`${n} hachure(s) créée(s).`);
    return n;
  }

  ed.register('HACHURES', async (ctx) => {
    const { doc } = ctx;
    if (!deps.hatchDialog) { await ed.run('-HACHURES'); return; }
    const opt = await deps.hatchDialog({
      doc, last, layers: [...doc.layers.keys()].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })), currentLayer: doc.currentLayer,
      defaultScale: (src) => defaultHatchScale(doc, src),
    });
    if (!opt) return;
    last = { ...opt, originMode: opt.origin };
    await place(ctx, opt);
  }, { aliases: ['H', 'HA', 'HATCH', 'BHATCH'], label: 'HACHURES', transaction: false });

  // Ligne de commande : motifs courants avec leur espacement, ou n'importe quel motif par son nom (« Autre »).
  const SIMPLE = { ANSI31: ['ANSI31', 3.175], Croisillons: ['ANSI37', 3.175], Grille: ['GRILLE', 3], Lignes: ['LIGNES', 3] };
  ed.register('-HACHURES', async (ctx) => {
    const { doc } = ctx;
    const kw = await ctx.getKeyword('Motif', ['Plein', 'ANSI31', 'Croisillons', 'Grille', 'Lignes', 'Autre'], { default: 'Plein' });
    const solid = kw === 'Plein';
    let found = null, scale = 1, angle = 0;
    if (SIMPLE[kw]) {
      const [name, step] = SIMPLE[kw];
      found = { def: BUILTIN.get(name), source: 'intégré' };
      const spacing = await ctx.getDistance('Espacement des lignes', { default: step * annoScaleOf(doc) });
      scale = spacing / step;
    } else if (kw === 'Autre') {
      const name = (await ctx.getString('Nom du motif', { default: last?.pattern || 'ANSI31' })).trim();
      found = findPattern(name, { metric: isMetric(doc) });
      if (!found) { await loadPatFile(isMetric(doc) ? 'acadiso.pat' : 'acad.pat').catch(() => null); found = findPattern(name, { metric: isMetric(doc) }); }
      if (!found) { ctx.print(`Motif « ${name} » introuvable (intégrés : ${[...BUILTIN.keys()].join(', ')}).`); return; }
      scale = await ctx.getDistance('Échelle du motif', { default: defaultHatchScale(doc, found.source) });
      const a = await ctx.getAngle('Angle du motif', { default: 0 });
      angle = typeof a === 'number' ? a : 0;
    }
    const opt = { solid, def: found?.def, source: found?.source, scale, angle, origin: 'defaut', mode: 'point', islands: 'normal', assoc: true, bg: null, layer: doc.currentLayer };
    last = { ...opt, pattern: solid ? 'SOLID' : found.def.name };
    await place(ctx, opt);
  }, { aliases: ['-H', '-HATCH'], label: '-HACHURES', transaction: false });

  // Modifier une hachure : motif, échelle, angle, origine, fond, calque, associativité.
  ed.register('HACHEDIT', async (ctx) => {
    const { doc } = ctx;
    let h = [...ed.selection].map((id) => doc.get(id)).find((e) => e?.type === 'HATCH');
    if (!h) {
      const pick = await ctx.getEntity('Choisissez la hachure à modifier', { allowNone: true });
      if (!pick) return;
      h = doc.get(pick.id);
      if (h?.type !== 'HATCH') { ctx.print('Ce n’est pas une hachure.'); return; }
    }
    if (!deps.hatchDialog) { ctx.print('Modification : palette Propriétés (motif, échelle, angle).'); return; }
    const def = h.solid ? null : defFromHatch(h);
    const opt = await deps.hatchDialog({
      doc, layers: [...doc.layers.keys()], currentLayer: h.layer, defaultScale: (src) => defaultHatchScale(doc, src),
      edit: { solid: h.solid, pattern: h.pattern, source: h.patSource || (def && BUILTIN.has(String(h.pattern).toUpperCase()) ? 'intégré' : 'intégré'), scale: h.patScale || 1, angle: h.patAngle || 0, bg: h.bg ?? null, layer: h.layer, assoc: !!h.assoc, originMode: 'defaut' },
    });
    if (!opt) return;
    const sameDef = !opt.solid && opt.def?.name?.toUpperCase() === String(h.pattern).toUpperCase() && !h.patDef ? def : opt.def;
    doc.transaction('Modifier la hachure', () => {
      const x = { ...h, ...makeHatch(h.loops, { ...opt, def: sameDef }, { origin: h.patOrigin || [0, 0], assoc: opt.assoc ? h.assoc : null, layer: opt.layer }) };
      if (!opt.assoc) delete x.assoc;
      if (opt.bg == null) delete x.bg;
      if (opt.solid) { delete x.patDef; delete x.patSource; }
      doc.update(x);
    });
  }, { aliases: ['HATCHEDIT', 'HE'], label: 'HACHEDIT', transaction: false });

  return { place };
}

// --- palette Propriétés ------------------------------------------------------------------

// Aire d'une hachure (règle pair-impair sur ses contours).
export function hatchArea(e) {
  const area = (l) => { let a = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += (l[j][0] - l[i][0]) * (l[j][1] + l[i][1]); return Math.abs(a / 2); };
  const loops = (e.loops || []).filter((l) => l.length >= 3);
  const inside = (p, l) => { let c = false; for (let i = 0, j = l.length - 1; i < l.length; j = i++) { const [xi, yi] = l[i], [xj, yj] = l[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  let s = 0;
  for (const l of loops) {
    const depth = loops.filter((o) => o !== l && inside(l[0], o)).length;
    s += depth % 2 ? -area(l) : area(l);
  }
  return Math.abs(s);
}

export function hatchRows(e, doc, { row, fmt }) {
  const BG = [[null, 'Aucune'], [7, 'Blanc / noir'], [8, 'Gris 8'], [9, 'Gris 9'], [254, 'Gris clair 254'], [2, 'Jaune'], [4, 'Cyan'], [30, 'Orange 30'], [151, 'Bleu clair 151']];
  const bgOpts = BG.map(([v, l]) => `<option value="${v ?? ''}" ${(e.bg ?? null) === v ? 'selected' : ''}>${l}</option>`).join('')
    + (e.bg != null && !BG.some(([v]) => v === e.bg) ? `<option value="${e.bg}" selected>Couleur ${e.bg}</option>` : '');
  return '<div class="section">Hachure</div>'
    + row('Motif', '', e.solid ? 'Plein (SOLID)' : e.pattern || 'Utilisateur', { ro: true })
    + (e.solid ? '' : row('Échelle', 'hScale', fmt(e.patScale || 1)) + row('Angle (°)', 'hAngle', fmt(((e.patAngle || 0) * 180) / Math.PI)))
    + `<div class="row"><label>Couleur de fond</label><select data-f="hBg">${bgOpts}</select></div>`
    + row('Associative', 'hAssoc', !!e.assoc, { check: true })
    + row('Contours', '', String((e.loops || []).length), { ro: true })
    + row('Aire', '', fmt(hatchArea(e)), { ro: true })
    + '<div class="row"><label>Motif</label><button class="btn small" data-act="hatchedit">Modifier…</button></div>';
}

// Champ de la palette ; vrai si la hachure a changé.
export function setHatchField(e, f, v) {
  const n = parseFloat(String(v).replace(',', '.'));
  if (f === 'hBg') { if (v === '' || v == null) delete e.bg; else e.bg = parseInt(v, 10); return true; }
  if (f === 'hAssoc') { if (!v) delete e.assoc; return !v; } // l'association ne peut qu'être retirée ici
  if (e.solid) return false;
  if (f === 'hScale' || f === 'hAngle') {
    if (!Number.isFinite(n) || (f === 'hScale' && !(n > 0))) return false;
    const def = defFromHatch(e);
    if (f === 'hScale') e.patScale = n; else e.patAngle = (n * Math.PI) / 180;
    e.patDef = def;
    e.lines = patternLines(def, { scale: e.patScale || 1, angle: e.patAngle || 0, origin: e.patOrigin || [0, 0] });
    return true;
  }
  return false;
}
