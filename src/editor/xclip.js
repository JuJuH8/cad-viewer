// SPDX-License-Identifier: GPL-3.0-or-later
// DECOUPXREF (XCLIP) : découpe des blocs, références externes et fonds de plan par un rectangle, un polygone ou une
// polyligne fermée ; découpe inversée (garder l'extérieur), activée / désactivée, supprimée, ou recopiée en polyligne.
// Le contour est gardé en coordonnées du bloc : il suit l'insertion quand on la déplace.
import * as G from '../core/geom.js';
import { insertMatrix } from '../core/entities.js';
import { curvePoints } from '../core/tessellate.js';

const toBlock = (doc, e, pts) => {
  const m = G.invert(insertMatrix(e, doc.blocks.get(e.name)?.base || [0, 0]));
  return pts.map((q) => G.apply(m, q[0], q[1]));
};
const toWorld = (doc, e) => {
  const m = insertMatrix(e, doc.blocks.get(e.name)?.base || [0, 0]);
  return e.clip.pts.map((q) => G.apply(m, q[0], q[1]));
};

// Contour polygonal désigné point par point (aperçu), ou null.
export async function askPolygon(ctx, layer) {
  const poly = (list) => ({ type: 'LWPOLYLINE', id: -1, layer, pts: list.map((q) => [q[0], q[1]]), bulges: list.map(() => 0), closed: true, z: 0 });
  const list = [await ctx.getPoint('Premier point du contour')];
  while (true) {
    const q = await ctx.getPoint('Point suivant (Entrée pour fermer)', { base: list[list.length - 1], allowNone: true, preview: (c) => [poly([...list, c])] });
    if (!q) break;
    list.push(q);
  }
  if (list.length < 3) { ctx.print('Il faut au moins trois points.'); return null; }
  return list.map((q) => [q[0], q[1]]);
}

// Contour d'un objet fermé désigné (polyligne fermée, cercle, ellipse) : { pts, id } ou null.
export async function askClosed(ctx) {
  const pick = await ctx.getEntity('Choisissez une polyligne fermée, un cercle ou une ellipse', { allowNone: true });
  if (!pick) return null;
  const e = ctx.doc.get(pick.id);
  const ok = e && ((e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE' || e.type === 'ELLIPSE');
  const c = ok ? curvePoints(e) : null;
  if (!c) { ctx.print('Il faut un contour fermé.'); return null; }
  const pts = c.pts.map((q) => [q[0], q[1]]);
  if (pts.length > 2 && G.dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
  return { pts, id: e.id };
}

// Fenêtre découpée par un contour : cadre (centre, largeur, hauteur) recalé sur l'emprise du contour, même échelle
// et même vue (le contenu ne bouge pas sur la feuille).
export function clipViewport(v, pts) {
  const b = G.emptyBox();
  for (const q of pts) G.growBox(b, q[0], q[1]);
  const k = v.h / v.vh;
  const c = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0];
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return { ...v, clip: pts, c, w, h, vh: h / k, vc: [v.vc[0] + (c[0] - v.c[0]) / k, v.vc[1] + (c[1] - v.c[1]) / k] };
}

export function registerClipCommands(ed) {
  // DECOUPFENETRE (VPCLIP) : fenêtre de présentation découpée par un polygone ou un objet fermé, ou rendue
  // rectangulaire.
  ed.register('DECOUPFENETRE', async (ctx) => {
    const { doc } = ctx;
    let v = [...ed.selection].map((id) => doc.get(id)).find((e) => e?.type === 'VIEWPORT');
    if (!v) {
      const pick = await ctx.getEntity('Choisissez le cadre de la fenêtre à découper', { allowNone: true });
      if (!pick) return;
      v = doc.get(pick.id);
      if (v?.type !== 'VIEWPORT') { ctx.print('Ce n’est pas une fenêtre de présentation.'); return; }
    }
    const kw = await ctx.getKeyword('Contour de la fenêtre', v.clip ? ['Polygonal', 'Objet', 'Supprimer'] : ['Polygonal', 'Objet'], { default: 'Polygonal' });
    if (kw === 'Supprimer') {
      doc.transaction('Fenêtre rectangulaire', () => { const x = { ...v }; delete x.clip; doc.update(x); });
      return;
    }
    let pts, src = null;
    if (kw === 'Polygonal') pts = await askPolygon(ctx, v.layer);
    else { const r = await askClosed(ctx); if (r) { pts = r.pts; src = r.id; } }
    if (!pts) return;
    doc.transaction('Découpe de la fenêtre', () => {
      doc.update(clipViewport(v, pts));
      if (src != null && src !== v.id) doc.remove(src); // l'objet devient le cadre de la fenêtre
    });
    ctx.print('Fenêtre découpée.');
  }, { aliases: ['VPCLIP', 'DECOUPFEN'], label: 'DECOUPFENETRE', transaction: false });

  ed.register('DECOUPXREF', async (ctx) => {
    const { doc } = ctx;
    let ids = [...ed.selection].filter((id) => doc.get(id)?.type === 'INSERT');
    if (!ids.length) {
      const sel = await ctx.getSelection('Choisissez les blocs ou références à découper');
      ids = sel.filter((id) => doc.get(id)?.type === 'INSERT');
    }
    if (!ids.length) { ctx.print('Aucune insertion de bloc ou de référence choisie.'); return; }
    const has = ids.some((id) => doc.get(id).clip);
    const kw = await ctx.getKeyword('Option de découpe', ['Activé', 'Désactivé', 'Supprimer', 'Polyligne', 'Nouveau'], { default: 'Nouveau' });
    const each = (label, fn) => doc.transaction(label, () => { for (const id of ids) { const x = doc.get(id); if (x) doc.update(fn({ ...x }) || x); } });
    if (kw === 'Supprimer') { each('Découpe supprimée', (x) => { delete x.clip; return x; }); return; }
    if (kw === 'Activé' || kw === 'Désactivé') {
      if (!has) { ctx.print('Aucune découpe sur ces objets.'); return; }
      each('Découpe', (x) => { if (x.clip) { x.clip = { ...x.clip }; if (kw === 'Désactivé') x.clip.off = true; else delete x.clip.off; } return x; });
      return;
    }
    if (kw === 'Polyligne') {
      doc.transaction('Contour de découpe', () => {
        for (const id of ids) {
          const x = doc.get(id);
          if (!x?.clip) continue;
          const pts = toWorld(doc, x);
          doc.add({ type: 'LWPOLYLINE', layer: doc.currentLayer, pts, bulges: pts.map(() => 0), closed: true, z: 0, width: 0, space: x.space });
        }
      });
      return;
    }
    // Nouveau contour.
    let invert = false;
    let pts = null;
    while (!pts) {
      const k = await ctx.getKeyword(`Contour de découpe${invert ? ' (inversée : on garde l’extérieur)' : ''}`, ['Rectangulaire', 'Polygonal', 'Sélectionner', 'Inverser'], { default: 'Rectangulaire' });
      if (k === 'Inverser') { invert = !invert; continue; }
      const poly = (list) => ({ type: 'LWPOLYLINE', id: -1, layer: doc.currentLayer, pts: list.map((q) => [q[0], q[1]]), bulges: list.map(() => 0), closed: true, z: 0 });
      if (k === 'Rectangulaire') {
        const a = await ctx.getPoint('Premier coin');
        const corners = (b) => [a, [b[0], a[1]], b, [a[0], b[1]]];
        const b = await ctx.getPoint('Coin opposé', { base: a, preview: (q) => [poly(corners(q))] });
        pts = corners(b);
      } else if (k === 'Polygonal') {
        const list = [await ctx.getPoint('Premier point')];
        while (true) {
          const q = await ctx.getPoint('Point suivant (Entrée pour fermer)', { base: list[list.length - 1], allowNone: true, preview: (c) => [poly([...list, c])] });
          if (!q) break;
          list.push(q);
        }
        if (list.length < 3) { ctx.print('Il faut au moins trois points.'); return; }
        pts = list;
      } else {
        const pick = await ctx.getEntity('Choisissez une polyligne fermée (ou un cercle)', { allowNone: true });
        if (!pick) return;
        const e = doc.get(pick.id);
        const c = e && ((e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE') ? curvePoints(e) : null;
        if (!c) { ctx.print('Il faut une polyligne fermée ou un cercle.'); continue; }
        pts = c.pts.map((q) => [q[0], q[1]]);
        if (pts.length > 2 && G.dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
      }
    }
    each('Découpe', (x) => { x.clip = { pts: toBlock(doc, x, pts), invert }; return x; });
    ctx.print(`${ids.length} objet(s) découpé(s)${invert ? ' (découpe inversée)' : ''}.`);
  }, { aliases: ['XCLIP', 'DECOUPBLOC', 'CLIPBLOC', 'DECOUPREF'], label: 'DECOUPXREF', transaction: false });
}
