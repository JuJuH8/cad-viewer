// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes des fonds PDF et images : ATTACHER (boîte), -ATTACHER (ligne de commande), DECOUPFOND (découpe),
// CALQUESFOND (calques du PDF), AJUSTERFOND (estompage, contraste, monochrome) — comme PDFATTACH, PDFCLIP,
// ULAYERS et PDFADJUST d'AutoCAD.
import * as G from '../core/geom.js';
import { unitMmOf } from '../mep/network.js';
import { ensureSource, nativeSize, getSource } from './sources.js';
import { makeUnderlay, pdfUnitMm, worldToPage, pageToWorld, visibleAt, kindOfPath, fileName, underlayScale } from './underlay.js';
import { layerName, openPdfLayers } from './dialog.js';
import { extractPage } from './vectors.js';
import { importPdfVectors } from './import.js';

// Fond sous un point (le dernier dessiné l'emporte), ou null.
export function underlayAt(doc, renderer, p, space = renderer.space) {
  let found = null;
  for (const h of renderer.index.search({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] })) {
    const e = doc.get(h.id);
    if (e?.type !== 'UNDERLAY' || e.space !== space) continue;
    const st = worldToPage(e, p[0], p[1]);
    if (st && visibleAt(e, st[0], st[1])) found = e;
  }
  return found;
}

// Taille d'un pixel d'image à l'échelle 1, en unités du dessin (résolution du fichier, sinon 1 unité).
function pixelSize(src, doc) {
  return src.dpi ? 25.4 / src.dpi / unitMmOf(doc) : 1;
}

// Facteur d'échelle d'un fond selon le mode choisi.
function scaleFor(opt, native, doc, pixel) {
  if (opt.mode === 'plan') return (opt.plan * pdfUnitMm(doc)) / unitMmOf(doc); // plan au 1:N → taille réelle
  if (opt.mode === 'largeur') return opt.width / (native[0] * pixel);
  if (opt.mode === 'facteur') return opt.factor;
  return 1; // par référence : posé à l'échelle 1, puis mis à l'échelle
}

export function registerUnderlayCommands(ed, deps = {}) {
  const r = () => ed.r;
  let last = null;

  // Fond désigné : sélection courante (un seul fond), sinon clic dans un fond ou sur son cadre.
  async function chooseUnderlay(ctx, prompt = 'Cliquez dans le fond (PDF ou image)') {
    const sel = [...ed.selection].map((id) => ctx.doc.get(id)).filter((e) => e?.type === 'UNDERLAY');
    if (sel.length === 1) return sel[0];
    while (true) {
      const p = await ctx.getPoint(prompt, { allowNone: true });
      if (!p) return null;
      const e = underlayAt(ctx.doc, r(), p) || (() => {
        const id = r().pick(p, ed.worldTol(ed.settings.pickbox));
        const x = id != null ? ctx.doc.get(id) : null;
        return x?.type === 'UNDERLAY' ? x : null;
      })();
      if (e) return e;
      ctx.print('Aucun fond à cet endroit.');
    }
  }

  // Pose d'un fond : point d'insertion (aperçu du cadre), puis mise à l'échelle par référence si demandé.
  async function place(ctx, opt) {
    const { doc } = ctx;
    const src = await ensureSource(opt.path);
    if (src.status !== 'ok') { ctx.print(`Fond « ${fileName(opt.path)} » ${src.status === 'missing' ? 'introuvable' : 'illisible'}.`); return null; }
    const kind = src.kind;
    const native = await nativeSize(src, opt.page || 1);
    const pixel = kind === 'image' ? pixelSize(src, doc) : 1;
    const scale = scaleFor(opt, native, doc, pixel);
    const rot = ((opt.rot || 0) * Math.PI) / 180;
    const layer = opt.layer || doc.currentLayer;
    const mk = (p) => makeUnderlay({ kind, path: opt.path, page: opt.page || 1, native, pixel, p, scale, rot, unitMm: pdfUnitMm(doc), layer, space: r().space });
    const p = opt.origin ? [0, 0] : await ctx.getPoint('Point d’insertion (coin inférieur gauche)', { preview: (q) => [{ ...mk(q), id: -1 }] });
    let e = null;
    doc.transaction(`Joindre ${fileName(opt.path)}`, () => {
      if (!doc.layers.has(layer)) doc.addLayer(layer, { color: 8 });
      e = doc.add(mk(p));
    });
    ctx.print(`Fond « ${fileName(opt.path)} »${kind === 'pdf' ? `, page ${opt.page || 1}` : ''} joint (échelle ${+underlayScale(e, pdfUnitMm(doc)).toPrecision(6)}).`);
    if (opt.mode === 'reference') e = await byReference(ctx, e);
    deps.changed?.();
    return e;
  }

  // Mise à l'échelle par référence : deux points sur le fond, puis leur longueur réelle (comme ECHELLE / Référence).
  async function byReference(ctx, e) {
    await r().underlays.prepareSnap(e).catch(() => {});
    const a = await ctx.getPoint('Premier point de la longueur connue (sur le fond)');
    const b = await ctx.getPoint('Deuxième point', { base: a });
    const d = G.dist(a, b);
    if (d < 1e-12) { ctx.print('Points confondus : échelle inchangée.'); return e; }
    const L = await ctx.getDistance('Longueur réelle (unités du dessin)', { default: +d.toPrecision(6) });
    if (!(L > 0)) return e;
    const k = L / d;
    let out = e;
    ctx.doc.transaction('Échelle du fond', () => {
      out = ctx.doc.modify(e.id, (x) => {
        x.u = [x.u[0] * k, x.u[1] * k];
        x.v = [x.v[0] * k, x.v[1] * k];
        x.p = [e.p[0] + (x.p[0] - e.p[0]) * k, e.p[1] + (x.p[1] - e.p[1]) * k, x.p[2] || 0];
      });
    });
    ctx.print(`Fond mis à l’échelle : facteur ${+k.toPrecision(6)} (échelle ${+underlayScale(out, pdfUnitMm(ctx.doc)).toPrecision(6)}).`);
    return out;
  }

  // (JOINDRE est la jonction d'objets, comme dans AutoCAD en français.)
  ed.register('ATTACHER', async (ctx) => {
    if (!deps.attachDialog) { await ed.run('-ATTACHER'); return; }
    const opt = await deps.attachDialog({ doc: ctx.doc, last });
    if (!opt) return;
    last = { path: opt.path, mode: opt.mode, plan: opt.plan, newLayer: opt.newLayer };
    await place(ctx, opt);
  }, { aliases: ['ATTACH', 'PDFATTACH', 'IMAGEATTACH', 'PDFJOINDRE', 'IMAGEJOINDRE', 'ATTACHERPDF', 'FONDPDF'], label: 'ATTACHER', transaction: false });

  ed.register('-ATTACHER', async (ctx) => {
    const path = (await ctx.getString('Chemin du fichier PDF ou image', { default: last?.path || '' })).trim().replace(/^"|"$/g, '');
    if (!path) return;
    if (!kindOfPath(path)) { ctx.print('Seuls les PDF et les images (PNG, JPG…) peuvent être joints.'); return; }
    const src = await ensureSource(path);
    if (src.status !== 'ok') { ctx.print(`Fichier ${src.status === 'missing' ? 'introuvable' : 'illisible'} : ${path}`); return; }
    let page = 1;
    if (src.kind === 'pdf' && src.pageCount > 1) {
      page = Math.round(await ctx.getDistance(`Numéro de page (1 à ${src.pageCount})`, { default: 1 }));
      page = Math.min(Math.max(1, page || 1), src.pageCount);
    }
    const plan = src.kind === 'pdf' ? await ctx.getDistance('Plan au 1:', { default: last?.plan || 50 }) : null;
    const factor = src.kind === 'image' ? await ctx.getDistance('Facteur d’échelle', { default: 1 }) : null;
    const rot = await ctx.getAngle('Rotation', { default: 0 });
    last = { path, mode: plan ? 'plan' : 'facteur', plan: plan || last?.plan };
    await place(ctx, { path, page, mode: plan ? 'plan' : 'facteur', plan, factor, rot: (rot * 180) / Math.PI, layer: layerName(path) });
  }, { aliases: ['-ATTACH', '-PDFATTACH', '-IMAGEATTACH'], label: '-ATTACHER', transaction: false });

  // Découpe : rectangle ou polygone dessiné sur le fond, inversion, suppression, activation.
  ed.register('DECOUPFOND', async (ctx) => {
    const e = await chooseUnderlay(ctx, 'Cliquez dans le fond à découper');
    if (!e) return;
    const has = !!e.clip?.pts?.length;
    const kws = has ? ['Nouveau', 'Inverser', 'Supprimer', e.clip.off ? 'Activer' : 'Désactiver'] : ['Rectangulaire', 'Polygonal'];
    let kw = await ctx.getKeyword(has ? 'Découpe du fond' : 'Contour de découpe', kws, { default: has ? 'Nouveau' : 'Rectangulaire' });
    const set = (label, fn) => ctx.doc.transaction(label, () => ctx.doc.modify(e.id, fn));
    if (kw === 'Supprimer') { set('Découpe supprimée', (x) => { x.clip = null; }); return; }
    if (kw === 'Inverser') { set('Découpe inversée', (x) => { x.clip = { ...x.clip, invert: !x.clip.invert }; }); return; }
    if (kw === 'Activer' || kw === 'Désactiver') { set('Découpe', (x) => { x.clip = { ...x.clip, off: kw === 'Désactiver' }; if (!x.clip.off) delete x.clip.off; }); return; }
    if (kw === 'Nouveau') kw = await ctx.getKeyword('Contour de découpe', ['Rectangulaire', 'Polygonal'], { default: 'Rectangulaire' });
    let pts;
    const poly = (list, closed = true) => ({ type: 'LWPOLYLINE', layer: e.layer, pts: list.map((q) => [q[0], q[1]]), bulges: list.map(() => 0), closed, z: 0, id: -1 });
    if (kw === 'Rectangulaire') {
      const a = await ctx.getPoint('Premier coin');
      const corners = (b) => [a, [b[0], a[1]], b, [a[0], b[1]]];
      const b = await ctx.getPoint('Coin opposé', { base: a, preview: (q) => [poly(corners(q))] });
      pts = corners(b);
    } else {
      pts = [await ctx.getPoint('Premier point du contour')];
      while (true) {
        const q = await ctx.getPoint('Point suivant (Entrée pour fermer)', { base: pts[pts.length - 1], allowNone: true, preview: (c) => [poly([...pts, c])] });
        if (!q) break;
        pts.push(q);
      }
      if (pts.length < 3) { ctx.print('Il faut au moins trois points.'); return; }
    }
    const local = pts.map((q) => worldToPage(e, q[0], q[1])).filter(Boolean);
    const inv = await ctx.getKeyword('Garder', ['Intérieur', 'Extérieur'], { default: 'Intérieur' });
    set('Découpe du fond', (x) => { x.clip = { pts: local, invert: inv === 'Extérieur' }; });
  }, { aliases: ['PDFCLIP', 'IMAGECLIP', 'DECOUPPDF', 'DECOUPIMAGE', 'PDFDECOUPE'], label: 'DECOUPFOND', transaction: false });

  // Calques du PDF affichés / masqués (boîte).
  ed.register('CALQUESFOND', async (ctx) => {
    const e = await chooseUnderlay(ctx);
    if (!e) return;
    if (e.kind !== 'pdf') { ctx.print('Les calques ne concernent que les fonds PDF.'); return; }
    await ensureSource(e.path);
    openPdfLayers(e, (off) => {
      ctx.doc.transaction('Calques du PDF', () => ctx.doc.modify(e.id, (x) => { x.ocgOff = off; }));
      const n = getSource(e.path)?.ocg?.length || 0;
      ctx.print(`Calques du PDF : ${n - off.length} affiché(s), ${off.length} masqué(s).`);
    });
  }, { aliases: ['ULAYERS', 'PDFLAYERS', 'PDFCALQUES', 'CALQUESPDF'], label: 'CALQUESFOND', transaction: false });

  // Réglages d'affichage en ligne de commande (la palette Propriétés offre les mêmes).
  ed.register('AJUSTERFOND', async (ctx) => {
    const e = await chooseUnderlay(ctx);
    if (!e) return;
    const kw = await ctx.getKeyword('Réglage', ['Estompage', 'Contraste', 'Monochrome', 'Fond'], { default: 'Estompage' });
    if (kw === 'Monochrome' || kw === 'Fond') {
      const k = kw === 'Monochrome' ? 'mono' : 'adjust';
      const on = await ctx.getKeyword(kw === 'Monochrome' ? 'Monochrome' : 'Couleurs adaptées au fond', ['Oui', 'Non'], { default: e[k] ? 'Non' : 'Oui' });
      ctx.doc.transaction('Réglage du fond', () => ctx.doc.modify(e.id, (x) => { x[k] = on === 'Oui'; }));
      return;
    }
    const k = kw === 'Estompage' ? 'fade' : 'contrast';
    const max = k === 'fade' ? 80 : 100;
    const v = await ctx.getDistance(`${kw} (0 à ${max})`, { default: e[k] ?? (k === 'fade' ? 0 : 100) });
    ctx.doc.transaction('Réglage du fond', () => ctx.doc.modify(e.id, (x) => { x[k] = Math.round(Math.min(max, Math.max(0, v))); }));
  }, { aliases: ['PDFADJUST', 'IMAGEADJUST', 'AJUSTERPDF'], label: 'AJUSTERFOND', transaction: false });

  // Conversion d'un fond PDF en objets (lignes, polylignes, arcs, cercles, hachures pleines, textes).
  ed.register('PDFIMPORT', async (ctx) => {
    const { doc } = ctx;
    const e = await chooseUnderlay(ctx, 'Cliquez dans le fond PDF à convertir');
    if (!e) return;
    if (e.kind !== 'pdf') { ctx.print('PDFIMPORT ne convertit que les fonds PDF (pas les images).'); return; }
    const src = await ensureSource(e.path);
    if (src.status !== 'ok') { ctx.print(`Fond « ${fileName(e.path)} » ${src.status === 'missing' ? 'introuvable' : 'illisible'}.`); return; }
    let zone = null;
    const z = await ctx.getKeyword('Zone à convertir', ['Tout', 'Rectangle'], { default: 'Tout' });
    if (z === 'Rectangle') {
      const a = await ctx.getPoint('Premier coin');
      const b = await ctx.getPoint('Coin opposé', { base: a, preview: (q) => [{ type: 'LWPOLYLINE', id: -1, layer: doc.currentLayer, pts: [a, [q[0], a[1]], q, [a[0], q[1]]], bulges: [0, 0, 0, 0], closed: true, z: 0 }] });
      zone = { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
    }
    const lay = await ctx.getKeyword('Calques des objets', ['Pdf', 'Objet', 'Courant'], { default: 'Pdf' });
    const keep = await ctx.getKeyword('Garder le fond PDF', ['Oui', 'Non'], { default: 'Oui' });
    ctx.print('Lecture des tracés du PDF…');
    const data = await extractPage(src, e.page || 1);
    const res = importPdfVectors(e, data, { layers: lay.toLowerCase(), currentLayer: doc.currentLayer, zone });
    if (!res.entities.length) { ctx.print('Aucun tracé à convertir dans cette zone.'); return; }
    let ids = [];
    doc.transaction('PDFIMPORT', () => {
      for (const l of res.layers) if (!doc.layers.has(l)) doc.addLayer(l, { color: 7 });
      ids = res.entities.map((x) => doc.add({ ...x, space: e.space }).id);
      if (keep === 'Non') doc.remove(e.id);
    });
    const c = res.counts;
    ctx.print(`PDFIMPORT : ${ids.length} objets (${c.lines} lignes, ${c.polylines} polylignes, ${c.arcs} arcs, ${c.circles} cercles, ${c.hatches} remplissages, ${c.texts} textes) sur ${res.layers.size} calque(s).`);
    ed.setSelection(ids);
  }, { aliases: ['IMPORTPDF', 'PDFCONVERTIR'], label: 'PDFIMPORT', transaction: false });

  return { chooseUnderlay, place, byReference };
}

// --- palette Propriétés --------------------------------------------------------------------

export function underlayRows(e, doc, { row, fmt, esc }) {
  const src = getSource(e.path);
  const status = !src ? 'non chargé' : src.status === 'ok' ? 'chargé' : src.status === 'loading' ? 'chargement…' : src.status === 'missing' ? 'introuvable' : 'illisible';
  const scale = underlayScale(e, pdfUnitMm(doc));
  const rot = (G.normAngle(Math.atan2(e.u[1], e.u[0])) * 180) / Math.PI;
  const clip = !e.clip?.pts?.length ? 'aucune' : e.clip.off ? 'désactivée' : e.clip.invert ? 'inversée' : 'active';
  const pages = src?.pageCount > 1 ? Array.from({ length: src.pageCount }, (_, i) => i + 1) : null;
  let h = `<div class="section">${e.kind === 'pdf' ? 'Fond PDF' : 'Image'}</div>`
    + row('Fichier', 'ulPath', e.path)
    + row('État', '', status, { ro: true })
    + (e.kind === 'pdf' ? (pages ? `<div class="row"><label>Page</label><select data-f="ulPage">${pages.map((n) => `<option ${n === (e.page || 1) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>` : row('Page', '', String(e.page || 1), { ro: true })) : '')
    + row('Échelle', 'ulScale', fmt(scale))
    + (e.kind === 'pdf' ? row('Plan au 1:', 'ulPlan', fmt((scale * unitMmOf(doc)) / pdfUnitMm(doc))) : '')
    + row('Rotation (°)', 'ulRot', fmt(rot))
    + row('Position X', 'ulPx', fmt(e.p[0])) + row('Position Y', 'ulPy', fmt(e.p[1]))
    + row('Estompage (0–80)', 'ulFade', String(e.fade || 0))
    + row('Contraste (0–100)', 'ulContrast', String(e.contrast ?? 100))
    + row('Monochrome', 'ulMono', !!e.mono, { check: true })
    + row('Adapter au fond sombre', 'ulAdjust', e.adjust !== false, { check: true })
    + row('Blanc transparent', 'ulWhite', e.whiteOff !== false, { check: true })
    + row('Afficher', 'ulShow', e.show !== false, { check: true })
    + row('Découpe', '', clip, { ro: true })
    + `<div class="row"><label>Outils</label><span class="fond-row">${e.kind === 'pdf' ? `<button class="btn small" data-act="ulLayers">Calques du PDF${e.ocgOff?.length ? ` (${e.ocgOff.length} masqué${e.ocgOff.length > 1 ? 's' : ''})` : ''}…</button>` : ''}
      <button class="btn small" data-act="ulClip">Découper…</button>${e.kind === 'pdf' ? '<button class="btn small" data-act="ulImport">Convertir en objets…</button>' : ''}</span></div>`;
  return esc ? h : h;
}

// Champ modifié dans la palette Propriétés ; renvoie vrai si l'objet a changé.
export function setUnderlayField(e, f, v, doc) {
  const n = parseFloat(String(v).replace(',', '.'));
  const around = (k, rotDelta = 0) => {
    const c = Math.cos(rotDelta), s = Math.sin(rotDelta);
    const tr = (w) => [(w[0] * c - w[1] * s) * k, (w[0] * s + w[1] * c) * k];
    e.u = tr(e.u); e.v = tr(e.v);
  };
  switch (f) {
    case 'ulPath': { const p = String(v).trim().replace(/^"|"$/g, ''); if (!p || !kindOfPath(p)) return false; e.path = p; return true; }
    case 'ulPage': { const k = parseInt(v, 10); if (!(k >= 1)) return false; e.page = k; return true; }
    case 'ulScale': { if (!(n > 0)) return false; around(n / underlayScale(e, pdfUnitMm(doc))); return true; }
    case 'ulPlan': { if (!(n > 0)) return false; const target = (n * pdfUnitMm(doc)) / unitMmOf(doc); around(target / underlayScale(e, pdfUnitMm(doc))); return true; }
    case 'ulRot': { if (!Number.isFinite(n)) return false; around(1, (n * Math.PI) / 180 - Math.atan2(e.u[1], e.u[0])); return true; }
    case 'ulPx': if (!Number.isFinite(n)) return false; e.p = [n, e.p[1], e.p[2] || 0]; return true;
    case 'ulPy': if (!Number.isFinite(n)) return false; e.p = [e.p[0], n, e.p[2] || 0]; return true;
    case 'ulFade': if (!Number.isFinite(n)) return false; e.fade = Math.round(Math.min(80, Math.max(0, n))); return true;
    case 'ulContrast': if (!Number.isFinite(n)) return false; e.contrast = Math.round(Math.min(100, Math.max(0, n))); return true;
    case 'ulMono': e.mono = !!v; return true;
    case 'ulAdjust': e.adjust = !!v; return true;
    case 'ulWhite': e.whiteOff = !!v; return true;
    case 'ulShow': e.show = !!v; return true;
  }
  return false;
}

export { pageToWorld };
