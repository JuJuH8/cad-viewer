// SPDX-License-Identifier: GPL-3.0-or-later
// Tracé PDF vectoriel (jsPDF) : la zone choisie du dessin, à l'échelle ou ajustée à la page.
import { FOREGROUND, BACKGROUND, aciToColor } from '../colors.js';
import { drawKey } from '../core/draworder.js';
import { updateFields } from '../core/fields.js';
import { viewportMatrix, viewportRect, viewportScale } from '../render/viewports.js';
import { partLineweight } from '../core/document.js';
import { styleOf, plotColor, PLOT_LINETYPES } from '../plot/styles.js';
import { plotUnderlay } from '../underlay/plot.js';
import { clipSegment } from '../core/clip.js';
import { pointInLoop } from '../underlay/underlay.js';

const JSPDF_URL = new URL('../../vendor/esm/jspdf@2.5.2.mjs', import.meta.url).href; // copie locale (scripts/vendor.py)
export const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
const MAX_SEGMENTS = 400000;

// Découpe du segment [a, b] par le rectangle (Liang-Barsky) ; null s'il est dehors.
function clip(ax, ay, bx, by, box) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const edges = [[-dx, ax - box.minX], [dx, box.maxX - ax], [-dy, ay - box.minY], [dy, box.maxY - ay]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

// opts : { paper, landscape, box (zone monde), scale (null = ajuster, sinon N pour 1:N), mono, title,
//         lineweights (true : épaisseurs des objets / calques, « Défaut » = 0,18 mm ; false : tout à 0,13 mm),
//         sheet (présentation : mise en page { w, h, origin, margins } — feuille tracée telle quelle, au 1:1),
//         styles (table de styles de tracé CTB : couleur, trame, niveaux de gris, type de ligne, épaisseur par couleur),
//         frame (false : sans cadre ni cartouche pour l'espace objet), transparency (false : transparences ignorées) }
const DEFAULT_LW = 0.18, FINE_LW = 0.13;
// Format et orientation de la page jsPDF.
const pageOf = (o) => {
  if (o.sheet) return { format: [Math.min(o.sheet.w, o.sheet.h), Math.max(o.sheet.w, o.sheet.h)], orientation: o.sheet.w >= o.sheet.h ? 'landscape' : 'portrait' };
  return { format: PAPERS[o.paper] || PAPERS.A3, orientation: o.landscape ? 'landscape' : 'portrait' };
};
export async function plotPdf(renderer, doc, opts) {
  const { jsPDF } = await import(JSPDF_URL);
  const pg = pageOf(opts);
  const pdf = new jsPDF({ orientation: pg.orientation, unit: 'mm', format: pg.format });
  const r = await drawPage(pdf, renderer, doc, opts);
  return { blob: pdf.output('blob'), ...r };
}

// Jeu de plans (PUBLIER) : une page par élément { space, paper, landscape, box?, scale, mono, title, lineweights }.
// L'espace affiché est rétabli à la fin (vue comprise).
export async function plotPages(renderer, doc, pages) {
  const { jsPDF } = await import(JSPDF_URL);
  const prev = { space: renderer.space, center: { ...renderer.center }, scale: renderer.scale, sheet: renderer.sheet };
  let pdf = null;
  const results = [];
  try {
    for (const pg of pages) {
      const page = pageOf(pg);
      if (!pdf) pdf = new jsPDF({ orientation: page.orientation, unit: 'mm', format: page.format });
      else pdf.addPage(page.format, page.orientation);
      if (renderer.space !== pg.space) renderer.setSpace(pg.space);
      results.push(await drawPage(pdf, renderer, doc, { ...pg, box: pg.box || renderer.robustExtents() }));
    }
  } finally {
    if (renderer.space !== prev.space) renderer.setSpace(prev.space, prev.sheet);
    Object.assign(renderer.center, prev.center);
    renderer.scale = prev.scale;
    renderer.requestRender(true);
  }
  return { blob: pdf.output('blob'), pages: results };
}

// Une page du PDF : zone `box` du dessin, à l'échelle ou ajustée, cadre et cartouche ; ou feuille d'une
// présentation (opts.sheet), tracée telle quelle au 1:1, découpée à la zone imprimable.
async function drawPage(pdf, renderer, doc, opts) {
  // Champs mis à jour au tracé (date de tracé, présentation…), sans étape d'annulation.
  const plotDate = new Date();
  doc.header = { ...(doc.header || {}), plotDate: plotDate.toISOString() };
  updateFields(doc, { plotDate }, { quiet: true });
  const sh = opts.sheet;
  const [pw0, ph0] = PAPERS[opts.paper] || PAPERS.A3;
  const [pw, ph] = sh ? [sh.w, sh.h] : opts.landscape ? [pw0, ph0] : [ph0, pw0];
  const noFrame = !sh && opts.frame === false;
  const margin = sh ? 0 : noFrame ? 5 : 10, footer = sh || noFrame ? 0 : 8;
  const area = { x: margin, y: margin, w: pw - 2 * margin, h: ph - 2 * margin - footer };
  const box = sh ? { minX: sh.origin[0], minY: sh.origin[1], maxX: sh.origin[0] + sh.w, maxY: sh.origin[1] + sh.h } : opts.box;
  const bw = Math.max(box.maxX - box.minX, 1e-9), bh = Math.max(box.maxY - box.minY, 1e-9);
  const unitMm = UNIT_MM[doc.header?.insunits] ?? 1;
  const s = sh ? 1 : opts.scale ? unitMm / opts.scale : Math.min(area.w / bw, area.h / bh); // mm de papier par unité
  // Centrage de la zone dans le cadre.
  const ox = area.x + (area.w - bw * s) / 2, oy = area.y + (area.h - bh * s) / 2;
  const X = (x) => ox + (x - box.minX) * s;
  const Y = (y) => oy + (box.maxY - y) * s;
  // Zone réellement visible sur la feuille (à l'échelle, elle peut dépasser la zone choisie) ; feuille : zone
  // imprimable (marges de la mise en page).
  const [ml, mb, mr, mt] = sh?.margins || [0, 0, 0, 0];
  const view = sh ? { minX: box.minX + ml, minY: box.minY + mb, maxX: box.maxX - mr, maxY: box.maxY - mt } : {
    minX: box.minX - (ox - area.x) / s, maxX: box.minX + (area.x + area.w - ox) / s,
    minY: box.maxY - (area.y + area.h - oy) / s, maxY: box.maxY + (oy - area.y) / s,
  };

  pdf.setLineCap('round');
  // Couleur tracée : table de styles (couleur imposée, niveaux de gris, trame), sinon noir (monochrome) ou celle
  // de l'objet ; la couleur 7 (blanc / noir) est noire sur le papier.
  // Style : par la couleur (CTB) ou par le style nommé du morceau, de l'objet sinon de son calque (STB).
  const table = opts.styles || null;
  const plotRgb = (c, part) => (table ? plotColor(styleOf(table, c, part, doc), c) : opts.mono || c === FOREGROUND ? 0x000000 : c);
  const dashFor = (c, part) => { const lt = table ? styleOf(table, c, part, doc)?.linetype : null; return lt != null ? lt : -1; };
  const colorOf = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  let count = 0;
  const ids = renderer.index.search(view).map((h) => h.id);
  // Bandes d'ordre de tracé : dans une bande, aplats puis traits puis textes ; un masque (WIPEOUT) est tracé en
  // blanc entre deux bandes et recouvre donc tout ce qui a été tracé avant lui. Sans masque : une seule bande.
  const bands = [];
  let band = null;
  const newBand = () => { band = { byColor: new Map(), texts: [] }; bands.push(band); };
  newBand();
  const addMask = (tris) => { if (tris.length) { bands.push({ mask: tris }); newBand(); } };
  // Épaisseur (mm) d'un objet sur la feuille.
  const defLw = doc.header?.lwdefault > 0 ? doc.header.lwdefault / 100 : DEFAULT_LW;
  const lwOf = (v) => (opts.lineweights === false ? FINE_LW : v > 0 ? v / 100 : defLw);
  // Épaisseur tracée : celle de la table de styles pour la couleur, sinon celle de l'objet.
  const lwFor = (c, v, part) => {
    if (opts.lineweights === false) return FINE_LW;
    const st = table ? styleOf(table, c, part, doc) : null;
    return st?.lineweight != null ? Math.max(st.lineweight, 0.05) : lwOf(v);
  };
  // Groupes de tracé de la bande courante : couleur (objet → couleur tracée), épaisseur, opacité (transparences
  // imposées dans une fenêtre), type de ligne imposé par la table.
  const groupOf = (color, lw, alpha = 1, dash = -1, part = null) => {
    const rgb = plotRgb(color, part);
    const a = opts.transparency === false ? 1 : alpha;
    const key = `${rgb}|${lw}|${a}|${dash}`;
    let g = band.byColor.get(key);
    if (!g) { g = { color: rgb, lw, alpha: a, dash, segs: [], tris: [] }; band.byColor.set(key, g); }
    return g;
  };
  const transp = (v) => 1 - Math.min(90, Math.max(0, v || 0)) / 100;
  let nTexts = 0;
  const pushText = (t) => { band.texts.push(t); nTexts++; };
  // Présentation : contenu de l'espace objet dans chaque fenêtre, transformé et découpé au cadre (sous le contenu
  // de la présentation, tracé ensuite).
  const vps = (renderer.viewports || []).filter((v) => !v.off);
  const mv = vps.length ? renderer.ensureModelView() : null;
  const vpParts = mv ? [...mv.parts].sort((x, y) => (x.key ?? 0) - (y.key ?? 0)) : [];
  for (const v of mv ? vps : []) {
    const r = viewportRect(v);
    const box = { minX: Math.max(r.minX, view.minX), maxX: Math.min(r.maxX, view.maxX), minY: Math.max(r.minY, view.minY), maxY: Math.min(r.maxY, view.maxY) };
    if (box.minX >= box.maxX || box.minY >= box.maxY) continue;
    const [a, b, c, d, e, f] = viewportMatrix(v);
    const k = viewportScale(v), tw = v.twist || 0;
    const poly = v.clip?.length >= 3 ? v.clip : null; // fenêtre découpée par un contour
    const inside = (x, y) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && (!poly || pointInLoop(x, y, poly));
    const frozen = new Set(v.frozen || []); // calques gelés dans la fenêtre
    const fillA = transp(v.hatchAlpha); // transparence des hachures et remplissages de la fenêtre
    const triangles = (T) => {
      const out = [];
      for (let i = 0; i + 8 < T.length; i += 9) {
        const p = [0, 3, 6].map((j) => [a * T[i + j] + c * T[i + j + 1] + e, b * T[i + j] + d * T[i + j + 1] + f]);
        if (inside((p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3)) out.push(...p[0], ...p[1], ...p[2]);
      }
      return out;
    };
    for (const { part, color: col0, lw, frame } of vpParts) {
      if (frame || part.noPlot || doc.layers.get(part.layer)?.plot === false || frozen.has(part.layer)) continue;
      if (col0 === BACKGROUND) { addMask(triangles(part.tris)); continue; } // masque de l'espace objet
      // Couleur, épaisseur et transparence imposées au calque dans cette fenêtre.
      const ov = v.layerOvr?.[part.layer];
      const color = ov?.color != null ? aciToColor(ov.color) : col0;
      const width = ov?.lweight != null ? lwOf(ov.lweight) : lwFor(color, lw, part);
      const alpha = transp(ov?.transparency);
      const g = groupOf(color, width, alpha, dashFor(color, part), part);
      const gf = fillA === 1 ? g : groupOf(color, width, alpha * fillA, dashFor(color, part), part);
      const S = part.segs;
      for (let i = 0; i + 5 < S.length; i += 6) {
        const cl = clip(a * S[i] + c * S[i + 1] + e, b * S[i] + d * S[i + 1] + f, a * S[i + 3] + c * S[i + 4] + e, b * S[i + 3] + d * S[i + 4] + f, box);
        if (!cl) continue;
        if (poly) for (const q of clipSegment(cl[0], cl[1], cl[2], cl[3], poly)) g.segs.push(q[0], q[1], q[2], q[3]);
        else g.segs.push(cl[0], cl[1], cl[2], cl[3]);
      }
      gf.tris.push(...triangles(part.tris));
      for (const t of part.texts) {
        if (t.shx) continue;
        const x = a * t.x + c * t.y + e, y = b * t.x + d * t.y + f;
        if (!inside(x, y)) continue;
        pushText({ ...t, x, y, em: t.em * k, first: t.first * k, pitch: t.pitch * k, radius: t.radius * k, rot: (t.rot || 0) + tw, color: plotRgb(color, part) });
      }
    }
  }
  // Objets de l'espace tracé, dans l'ordre de tracé.
  const items = ids.map((id) => doc.get(id)).filter((e) => e && renderer.cache.has(e.id)).sort((x, y) => drawKey(x) - drawKey(y));
  for (const e of items) {
    const entry = renderer.cache.get(e.id);
    const own = doc.layers.get(e.layer);
    if (own?.frozen || own?.plot === false) continue;
    if (e.type === 'UNDERLAY') continue; // fond : tracé à part (son cadre n'est pas tracé)
    for (const part of entry.parts) {
      if (part.noPlot || !renderer.layerVisible(part.layer)) continue; // cadre de découpe : affiché seulement
      if (part.color === BACKGROUND) { // masque : recouvre ce qui précède
        const T = part.tris, m = [];
        for (let i = 0; i + 8 < T.length; i += 9) m.push(T[i], T[i + 1], T[i + 3], T[i + 4], T[i + 6], T[i + 7]);
        addMask(m);
        continue;
      }
      const color = renderer.resolveColor(part.color);
      const g = groupOf(color, lwFor(color, partLineweight(doc, part), part), 1, dashFor(color, part), part);
      for (let i = 0; i + 5 < part.segs.length; i += 6) g.segs.push(part.segs[i], part.segs[i + 1], part.segs[i + 3], part.segs[i + 4]);
      for (let i = 0; i + 8 < part.tris.length; i += 9) g.tris.push(part.tris[i], part.tris[i + 1], part.tris[i + 3], part.tris[i + 4], part.tris[i + 6], part.tris[i + 7]);
      for (const t of part.texts) if (!t.shx) pushText({ ...t, color: plotRgb(color, part) }); // SHX : en traits
    }
  }
  // Fonds PDF et images, sous les traits : ceux de l'espace tracé, puis ceux de l'espace objet vus dans les fenêtres.
  const fromPaper = (px, py) => [box.minX + (px - ox) / s, box.maxY - (py - oy) / s];
  const sheetClip = { x0: X(view.minX), x1: X(view.maxX), y0: Y(view.maxY), y1: Y(view.minY) };
  const plotted = (e) => {
    const l = doc.layers.get(e.layer);
    return e.show !== false && l?.plot !== false && !l?.frozen && renderer.layerVisible(e.layer);
  };
  for (const id of ids) {
    const e = doc.get(id);
    if (e?.type === 'UNDERLAY' && plotted(e)) await plotUnderlay(pdf, e, (x, y) => [X(x), Y(y)], fromPaper, sheetClip).catch((err) => console.warn('Fond non tracé', err));
  }
  for (const v of mv ? vps : []) {
    const r = viewportRect(v);
    const b = { minX: Math.max(r.minX, view.minX), maxX: Math.min(r.maxX, view.maxX), minY: Math.max(r.minY, view.minY), maxY: Math.min(r.maxY, view.maxY) };
    if (b.minX >= b.maxX || b.minY >= b.maxY) continue;
    const [a, bb, c, d, e0, f] = viewportMatrix(v);
    const det = a * d - bb * c;
    const frozen = new Set(v.frozen || []);
    const toPaper = (x, y) => [X(a * x + c * y + e0), Y(bb * x + d * y + f)];
    const fromVp = (px, py) => {
      const [x, y] = fromPaper(px, py);
      return [(d * (x - e0) - c * (y - f)) / det, (-bb * (x - e0) + a * (y - f)) / det];
    };
    const clipVp = { x0: X(b.minX), x1: X(b.maxX), y0: Y(b.maxY), y1: Y(b.minY) };
    for (const e of doc.entities.values()) {
      if (e.type !== 'UNDERLAY' || e.space !== 'model' || frozen.has(e.layer) || !plotted(e)) continue;
      await plotUnderlay(pdf, e, toPaper, fromVp, clipVp, undefined, v.clip?.length >= 3 ? v.clip.map(([x, y]) => [X(x), Y(y)]) : null).catch((err) => console.warn('Fond non tracé', err));
    }
  }
  const gstate = (alpha) => { if (pdf.GState) pdf.setGState(new pdf.GState({ opacity: alpha, 'stroke-opacity': alpha })); };
  pdf.setFont('helvetica', 'normal');
  bands: for (const bd of bands) {
    if (bd.mask) { // masque : blanc du papier
      pdf.setFillColor(255, 255, 255);
      const T = bd.mask;
      for (let i = 0; i + 5 < T.length; i += 6) pdf.triangle(X(T[i]), Y(T[i + 1]), X(T[i + 2]), Y(T[i + 3]), X(T[i + 4]), Y(T[i + 5]), 'F');
      continue;
    }
    // Groupes opaques d'abord, transparents ensuite (par-dessus, comme à l'écran).
    const ordered = [...bd.byColor.values()].sort((x, y) => (y.alpha ?? 1) - (x.alpha ?? 1));
    // Remplissages d'abord (hachures pleines, fonds de hachure), traits ensuite : rien n'est masqué par un aplat.
    for (const g of ordered) {
      if (!g.tris.length) continue;
      const [r, gg, b] = colorOf(g.color);
      pdf.setFillColor(r, gg, b);
      if (g.alpha < 1) gstate(g.alpha);
      for (let i = 0; i < g.tris.length; i += 6) {
        pdf.triangle(X(g.tris[i]), Y(g.tris[i + 1]), X(g.tris[i + 2]), Y(g.tris[i + 3]), X(g.tris[i + 4]), Y(g.tris[i + 5]), 'F');
      }
      if (g.alpha < 1) gstate(1);
    }
    for (const g of ordered) {
      if (!g.segs.length) continue;
      const [r, gg, b] = colorOf(g.color);
      pdf.setDrawColor(r, gg, b);
      pdf.setFillColor(r, gg, b);
      pdf.setLineWidth(g.lw);
      if (g.alpha < 1) gstate(g.alpha);
      // Type de ligne imposé par la table de styles (motif en mm sur la feuille).
      if (g.dash > 0 && pdf.setLineDashPattern) pdf.setLineDashPattern(PLOT_LINETYPES[g.dash][1].map((v) => Math.max(Math.abs(v), 0.01)), 0);
      for (let i = 0; i < g.segs.length; i += 4) {
        const c = clip(g.segs[i], g.segs[i + 1], g.segs[i + 2], g.segs[i + 3], view);
        if (!c) continue;
        pdf.line(X(c[0]), Y(c[1]), X(c[2]), Y(c[3]));
        if (++count > MAX_SEGMENTS) break bands; // plafond atteint : on arrête tout
      }
      if (g.alpha < 1) gstate(1);
      if (g.dash > 0 && pdf.setLineDashPattern) pdf.setLineDashPattern([], 0);
    }
    // Textes (Helvetica) : taille, rotation et alignement calculés comme à l'écran.
    for (const t of bd.texts) {
      if (t.x < view.minX - t.radius || t.x > view.maxX + t.radius || t.y < view.minY - t.radius || t.y > view.maxY + t.radius) continue;
      const emMm = t.em * s;
      if (emMm < 0.4) continue; // illisible à cette échelle
      const [r, gg, b] = colorOf(t.color);
      pdf.setTextColor(r, gg, b);
      pdf.setFontSize((emMm * 72) / 25.4);
      const dir = [Math.cos(t.rot), Math.sin(t.rot)], down = [Math.sin(t.rot), -Math.cos(t.rot)];
      t.lines.forEach((line, i) => {
        const wMm = pdf.getTextWidth(line) * (t.widthFactor || 1);
        const shift = t.align === 'center' ? -wMm / 2 : t.align === 'right' ? -wMm : 0;
        const offDown = (t.first + i * t.pitch) * s;
        const px = X(t.x) + (dir[0] * shift + down[0] * offDown);
        const py = Y(t.y) - (dir[1] * shift + down[1] * offDown);
        pdf.text(line, px, py, { angle: (t.rot * 180) / Math.PI, baseline: 'alphabetic' });
      });
    }
  }
  if (sh) return { segments: count, texts: nTexts, scale: 1 };
  if (noFrame) return { segments: count, texts: nTexts, scale: unitMm / s };
  // Cadre et cartouche.
  pdf.setDrawColor(0, 0, 0);
  pdf.setTextColor(0, 0, 0);
  pdf.setLineWidth(0.35);
  pdf.rect(margin / 2, margin / 2, pw - margin, ph - margin);
  pdf.setFontSize(8);
  // Police PDF standard (WinAnsi) : pas de « ≈ ».
  const scaleTxt = opts.scale ? `Échelle 1:${opts.scale}` : `Ajusté (env. 1:${Math.round(unitMm / s)})`;
  const date = new Date().toLocaleDateString('fr-FR');
  pdf.text(`${opts.title || 'Dessin'}  —  ${scaleTxt}  —  ${opts.paper} ${opts.landscape ? 'paysage' : 'portrait'}  —  ${date}`, margin, ph - margin / 2 - 2);
  return { segments: count, texts: nTexts, scale: unitMm / s };
}

