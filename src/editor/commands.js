// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes de dessin et de modification, à la manière d'AutoCAD.
// Noms français (comme AutoCAD en français), alias anglais et raccourcis habituels.
import { ucsOf } from '../core/ucs.js';
import { blockForInsert } from '../blocks/dynamic.js';
import * as G from '../core/geom.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { trimEntity, extendEntity, offsetEntity, cornerLines, cornerPolylineSegments, cornerPolylineAll, filletCurves, segmentIndexAt, joinEntities, pathOf, PATH_TYPES, breakEntity, stretchEntity, areaOf, polygonArea } from '../core/path.js';
import { Cancel, fmt } from './editor.js';
import { mepToEntities } from '../mep/geometry.js';
import { purgeDocument, findOverkill } from './cleanup.js';
import { findBoundary, expandInserts } from './boundary.js';
import { curvePoints } from '../core/tessellate.js';
import { showQuickSelect } from '../ui/qselect.js';
import { showLayerManager } from '../ui/layers-dialog.js';
import { showFind } from '../ui/find.js';
import { allFormats, makePlot, fittingScale } from '../layout/sheet.js';
import { annoScaleOf } from '../core/drawing-settings.js';

const MAX_PREVIEW = 400;
const deg = (r) => (r * 180) / Math.PI;

// Nouvel objet : calque courant, et couleur / type de ligne / épaisseur courants s'ils sont imposés
// (réglages du dessin, comme CECOLOR, CELTYPE, CELWEIGHT ; DuCalque sinon).
export function newEntity(doc, props) {
  const h = doc.header || {};
  const cur = {};
  if (h.cecolor != null && h.cecolor !== 256) cur.color = h.cecolor;
  if (h.celtype && !/^bylayer$/i.test(h.celtype)) cur.ltype = h.celtype;
  if (h.celweight != null && h.celweight !== -1) cur.lweight = h.celweight;
  const out = { layer: doc.currentLayer, color: 256, space: doc.currentSpace || 'model', ...cur, ...props };
  // Texte : style courant du dessin (onglet Format › Textes), avec son facteur de largeur.
  const st = h.textstyle && doc.styles?.get(String(h.textstyle).toUpperCase());
  if (st && ['TEXT', 'MTEXT', 'ATTDEF'].includes(props.type) && !props.style) {
    out.style = st.name;
    if (props.type !== 'MTEXT' && (props.wf ?? 1) === 1 && st.widthFactor && st.widthFactor !== 1) out.wf = st.widthFactor;
  }
  return out;
}

// Nuage de révision le long d'un contour fermé : sommets régulièrement espacés (longueur d'arc ≈ arcLen), arcs
// de 106° (bulge 0,5) bombés vers l'extérieur. Renvoie { pts, bulges, closed } ou null.
export function revisionCloud(outline, arcLen) {
  let P = outline.map((p) => [p[0], p[1]]);
  if (P.length > 1 && G.dist(P[0], P[P.length - 1]) < 1e-9) P.pop();
  if (P.length < 2 || !(arcLen > 0)) return null;
  let area = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) P = P.reverse(); // sens anti-horaire : bulge positif = arc vers l'extérieur
  const acc = [0];
  for (let i = 1; i <= P.length; i++) acc.push(acc[i - 1] + G.dist(P[i - 1], P[i % P.length]));
  const per = acc[acc.length - 1];
  const n = Math.round(per / arcLen);
  if (n < 3) return null;
  const pts = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const d = (per * i) / n;
    while (j < acc.length - 1 && acc[j] < d) j++;
    const t = (d - acc[j - 1]) / (acc[j] - acc[j - 1] || 1);
    pts.push(G.lerp(P[j - 1], P[j % P.length], t));
  }
  return { pts, bulges: pts.map(() => 0.5), closed: true };
}

// Allonge / raccourcit une ligne ou un arc à l'extrémité la plus proche de `pick`.
function lengthenEntity(e, pick, { mode, delta, pct, total }) {
  const target = (L) => (mode === 'Delta' ? L + delta : mode === 'Pourcentage' ? (L * pct) / 100 : total);
  if (e.type === 'LINE') {
    const L = G.dist(e.p1, e.p2);
    const T = target(L);
    if (L < 1e-12 || !(T > 1e-9)) return null;
    const atEnd = G.dist(pick, e.p2) <= G.dist(pick, e.p1);
    const [fix, mov] = atEnd ? [e.p1, e.p2] : [e.p2, e.p1];
    const q = G.add(fix, G.mul(G.norm(G.sub(mov, fix)), T));
    const np = [q[0], q[1], mov[2] || 0];
    return atEnd ? { ...e, p2: np } : { ...e, p1: np };
  }
  if (e.type === 'ARC') {
    const sw = G.sweep(e.a0, e.a1);
    const nsw = target(sw * e.r) / e.r;
    if (!(nsw > 1e-9) || nsw >= 2 * Math.PI - 1e-9) return null;
    const atEnd = G.dist(pick, G.polar(e.c, e.a1, e.r)) <= G.dist(pick, G.polar(e.c, e.a0, e.r));
    return atEnd ? { ...e, a1: e.a0 + nsw } : { ...e, a0: e.a1 - nsw };
  }
  return null;
}

function stripId(e) {
  const c = structuredClone(e);
  delete c.id;
  delete c.handle;
  delete c.group; // une copie n'appartient pas au groupe de l'original
  // Une cote copiée sans ses objets n'est plus associative (elle resterait liée aux originaux).
  if (c.meta?.assoc) delete c.meta.assoc;
  return c;
}

function previewOf(doc, ids, m) {
  const out = [];
  for (const id of ids.slice(0, MAX_PREVIEW)) {
    const e = doc.get(id);
    if (e) out.push(transformEntity(e, m));
  }
  return out;
}

function line(doc, a, b) {
  return newEntity(doc, { type: 'LINE', p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
}

// Coupants / frontières : toutes les courbes des entités visibles proches de l'objet.
function cuttersAround(ed, e, exclude = new Set()) {
  const r = ed.r;
  const entry = r.cache.get(e.id);
  const box = entry?.box;
  if (!box) return [];
  const pad = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 2 + 1;
  const ids = r.index.search({ minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad }).map((h) => h.id);
  const out = [];
  for (const id of ids) {
    if (id === e.id || exclude.has(id)) continue;
    const other = ed.doc.get(id);
    if (!other || !r.layerVisible(other.layer)) continue;
    out.push(...r.curvesOf(other));
  }
  return out;
}

// AJOUTSELECT (« dessiner un objet semblable ») : les modules ajoutent leurs types d'objets dans ed.addSelected
// ({ label(e) → texte ou null, draw(ctx, e) }) ; les objets de base sont traités ici.
const ADD_SELECTED_BASE = {
  LINE: ['une ligne', 'LIGNE'], LWPOLYLINE: ['une polyligne', 'POLYLIGN'], CIRCLE: ['un cercle', 'CERCLE'],
  ARC: ['un arc', 'ARC'], TEXT: ['un texte', 'TEXTE'],
};
export function addSelectedLabel(ed, e) {
  if (!e) return null;
  for (const h of ed.addSelected || []) { const l = h.label(e); if (l) return l; }
  if (e.type === 'INSERT') return `le bloc « ${e.name} »`;
  return ADD_SELECTED_BASE[e.type]?.[0] || null;
}

export function registerCommands(ed) {
  // --- DESSIN ------------------------------------------------------------------------

  ed.register('LIGNE', async (ctx) => {
    const { doc } = ctx;
    const first = await ctx.getPoint('Spécifiez le premier point');
    const pts = [first];
    const added = [];
    while (true) {
      const base = pts[pts.length - 1];
      const keywords = pts.length >= 3 ? ['Clore', 'annUler'] : ['annUler'];
      const r = await ctx.getPoint('Spécifiez le point suivant', {
        base, keywords, allowNone: true, preview: (p) => [line(doc, base, p)],
      });
      if (r === null) return;
      if (r === 'annUler') {
        if (added.length) { doc.remove(added.pop()); pts.pop(); } else ctx.print('Rien à annuler.');
        continue;
      }
      if (r === 'Clore') { doc.add(line(doc, base, pts[0])); return; }
      added.push(doc.add(line(doc, base, r)).id);
      pts.push(r);
    }
  }, { aliases: ['L', 'LINE'], label: 'LIGNE' });

  ed.register('POLYLIGN', async (ctx) => {
    const { doc } = ctx;
    const pts = [await ctx.getPoint('Spécifiez le point de départ')];
    const bulges = [];
    let arcMode = false;
    let dir = null; // direction de la tangente en fin de polyligne
    const build = (closed = false) => newEntity(doc, {
      type: 'LWPOLYLINE', pts: pts.map((p) => [p[0], p[1]]), bulges: [...bulges, 0], closed, z: 0, width: 0,
    });
    const arcTo = (a, b) => {
      // Arc tangent à la direction courante : bulge = tan(α/2), α = angle tangente → corde.
      const t = dir || [1, 0];
      const chord = G.sub(b, a);
      const alpha = Math.atan2(G.cross(t, chord), G.dot(t, chord));
      return Math.tan(alpha / 2);
    };
    const finish = (closed = false) => {
      if (pts.length >= 2) doc.add(build(closed));
    };
    try {
      while (true) {
        const base = pts[pts.length - 1];
        const keywords = arcMode ? ['Ligne', 'Clore', 'annUler'] : ['Arc', 'Clore', 'annUler'];
        const r = await ctx.getPoint(arcMode ? 'Spécifiez l’extrémité de l’arc' : 'Spécifiez le point suivant', {
          base, keywords, allowNone: true,
          preview: (p) => {
            const tmp = build();
            tmp.pts.push([p[0], p[1]]);
            tmp.bulges = [...bulges, arcMode ? arcTo(base, p) : 0, 0];
            return tmp.pts.length >= 2 ? [tmp] : [];
          },
        });
        if (r === null) { finish(); return; }
        if (r === 'Arc') { arcMode = true; continue; }
        if (r === 'Ligne') { arcMode = false; continue; }
        if (r === 'annUler') {
          if (pts.length > 1) { pts.pop(); bulges.pop(); } else ctx.print('Rien à annuler.');
          continue;
        }
        if (r === 'Clore') {
          if (pts.length < 2) { ctx.print('Il faut au moins deux points.'); continue; }
          bulges.push(arcMode ? arcTo(base, pts[0]) : 0);
          doc.add(newEntity(doc, { type: 'LWPOLYLINE', pts: pts.map((p) => [p[0], p[1]]), bulges, closed: true, z: 0, width: 0 }));
          return;
        }
        const b = arcMode ? arcTo(base, r) : 0;
        bulges.push(b);
        pts.push(r);
        const chordAngle = G.angleOf(base, r);
        dir = arcMode ? [Math.cos(chordAngle + 2 * Math.atan(b)), Math.sin(chordAngle + 2 * Math.atan(b))] : G.norm(G.sub(r, base));
      }
    } catch (err) {
      if (err instanceof Cancel) finish();
      throw err;
    }
  }, { aliases: ['PL', 'PLINE', 'POLYLIGNE'], label: 'POLYLIGN' });

  let lastRadius = 10;
  ed.register('CERCLE', async (ctx) => {
    const { doc } = ctx;
    const circle = (c, r) => newEntity(doc, { type: 'CIRCLE', c: [c[0], c[1], 0], r });
    const r0 = await ctx.getPoint('Spécifiez le centre du cercle', { keywords: ['3P', '2P'] });
    if (r0 === '2P') {
      const a = await ctx.getPoint('Spécifiez la première extrémité du diamètre');
      const b = await ctx.getPoint('Spécifiez la deuxième extrémité du diamètre', { base: a, preview: (p) => [circle(G.mid(a, p), G.dist(a, p) / 2)] });
      doc.add(circle(G.mid(a, b), G.dist(a, b) / 2));
      return;
    }
    if (r0 === '3P') {
      const a = await ctx.getPoint('Spécifiez le premier point du cercle');
      const b = await ctx.getPoint('Spécifiez le deuxième point du cercle', { base: a });
      const c = await ctx.getPoint('Spécifiez le troisième point du cercle', {
        base: b, preview: (p) => { const k = G.circleFrom3Points(a, b, p); return k ? [circle(k.c, k.r)] : []; },
      });
      const k = G.circleFrom3Points(a, b, c);
      if (!k) { ctx.print('Les trois points sont alignés.'); return; }
      doc.add(circle(k.c, k.r));
      return;
    }
    const c = r0;
    let r = await ctx.getDistance('Spécifiez le rayon du cercle', {
      base: c, keywords: ['Diamètre'], default: lastRadius, preview: (p) => [circle(c, G.dist(c, p))],
    });
    if (r === 'Diamètre') {
      r = (await ctx.getDistance('Spécifiez le diamètre du cercle', {
        base: c, default: lastRadius * 2, preview: (p) => [circle(c, G.dist(c, p) / 2)],
      })) / 2;
    }
    if (!(r > 0)) { ctx.print('Le rayon doit être positif.'); return; }
    lastRadius = r;
    doc.add(circle(c, r));
  }, { aliases: ['C', 'CIRCLE'], label: 'CERCLE' });

  ed.register('ARC', async (ctx) => {
    const { doc } = ctx;
    const arc3 = (a, b, c) => {
      const k = G.arcFrom3Points(a, b, c);
      return k ? newEntity(doc, { type: 'ARC', c: [k.c[0], k.c[1], 0], r: k.r, a0: k.a0, a1: k.a1 }) : null;
    };
    const r0 = await ctx.getPoint('Spécifiez le point de départ de l’arc', { keywords: ['Centre'] });
    if (r0 === 'Centre') {
      const c = await ctx.getPoint('Spécifiez le centre de l’arc');
      const s = await ctx.getPoint('Spécifiez le point de départ de l’arc', { base: c });
      const r = G.dist(c, s), a0 = G.angleOf(c, s);
      const mk = (p) => newEntity(doc, { type: 'ARC', c: [c[0], c[1], 0], r, a0, a1: G.angleOf(c, p) });
      const e = await ctx.getPoint('Spécifiez l’extrémité de l’arc', { base: c, preview: (p) => [mk(p)] });
      doc.add(mk(e));
      return;
    }
    const a = r0;
    const b = await ctx.getPoint('Spécifiez le deuxième point de l’arc', { base: a });
    const c = await ctx.getPoint('Spécifiez l’extrémité de l’arc', { base: b, preview: (p) => { const x = arc3(a, b, p); return x ? [x] : []; } });
    const x = arc3(a, b, c);
    if (!x) { ctx.print('Les trois points sont alignés.'); return; }
    doc.add(x);
  }, { aliases: ['A'], label: 'ARC' });

  ed.register('RECTANG', async (ctx) => {
    const { doc } = ctx;
    const rect = (a, b) => newEntity(doc, {
      type: 'LWPOLYLINE', pts: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0,
    });
    const a = await ctx.getPoint('Spécifiez le premier coin');
    let b = await ctx.getPoint('Spécifiez l’autre coin', { base: a, keywords: ['Cotes'], preview: (p) => [rect(a, p)] });
    if (b === 'Cotes') {
      const w = await ctx.getDistance('Spécifiez la longueur du rectangle', { base: a });
      const h = await ctx.getDistance('Spécifiez la largeur du rectangle', { base: a });
      b = [a[0] + w, a[1] + h];
    }
    doc.add(rect(a, b));
  }, { aliases: ['REC', 'RECTANGLE'], label: 'RECTANG' });

  ed.register('POINT', async (ctx) => {
    while (true) {
      const p = await ctx.getPoint('Spécifiez un point', { allowNone: true });
      if (p === null) return;
      ctx.doc.add(newEntity(ctx.doc, { type: 'POINT', p: [p[0], p[1], 0] }));
    }
  }, { aliases: ['PO'], label: 'POINT' });

  let lastTextHeight = null; // hauteur tapée en dernier ; sinon hauteur par défaut du dessin
  ed.register('TEXTE', async (ctx) => {
    const { doc } = ctx;
    const p = await ctx.getPoint('Spécifiez le point de départ du texte');
    const h = await ctx.getDistance('Spécifiez la hauteur', { base: p, default: lastTextHeight ?? (doc.header?.textsize > 0 ? doc.header.textsize : 2.5 * annoScaleOf(doc)) });
    lastTextHeight = h;
    const rot = await ctx.getAngle('Spécifiez l’angle de rotation du texte', { base: p, default: 0, absolute: true });
    while (true) {
      const text = await ctx.getString('Entrez le texte (Entrée vide pour terminer)');
      if (!text) return;
      const i = doc.add(newEntity(doc, { type: 'TEXT', p: [p[0], p[1], 0], h, rot: typeof rot === 'number' ? rot : 0, text, align: 'left', valign: 'baseline', wf: 1 }));
      // Ligne suivante en dessous, comme TEXTDYN.
      const dy = h * 1.6;
      p[0] += Math.sin(i.rot) * dy;
      p[1] -= Math.cos(i.rot) * dy;
    }
  }, { aliases: ['TX', 'DT', 'TEXT', 'TEXTDYN'], label: 'TEXTE' });

  // --- MODIFICATION ------------------------------------------------------------------

  ed.register('EFFACER', async (ctx) => {
    const ids = await ctx.getSelection();
    for (const id of ids) ctx.doc.remove(id);
    ctx.print(`${ids.length} objet(s) effacé(s).`);
  }, { aliases: ['E', 'EF', 'ERASE'], label: 'EFFACER' });

  const pickTransform = async (ctx, ids, verb) => {
    const base = await ctx.getPoint('Spécifiez le point de base');
    const target = await ctx.getPoint(`Spécifiez le deuxième point${verb}`, {
      base, preview: (p) => previewOf(ctx.doc, ids, G.translation(p[0] - base[0], p[1] - base[1])),
    });
    return G.translation(target[0] - base[0], target[1] - base[1]);
  };

  ed.register('DEPLACER', async (ctx) => {
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const m = await pickTransform(ctx, ids, '');
    for (const id of ids) ctx.doc.update(transformEntity(ctx.doc.get(id), m));
  }, { aliases: ['M', 'DE', 'MOVE'], label: 'DEPLACER' });

  ed.register('COPIER', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const base = await ctx.getPoint('Spécifiez le point de base');
    while (true) {
      const target = await ctx.getPoint('Spécifiez le deuxième point', {
        base, allowNone: true, preview: (p) => previewOf(doc, ids, G.translation(p[0] - base[0], p[1] - base[1])),
      });
      if (target === null) return;
      const m = G.translation(target[0] - base[0], target[1] - base[1]);
      for (const id of ids) doc.add(stripId(transformEntity(doc.get(id), m)));
    }
  }, { aliases: ['CO', 'CP', 'COPY'], label: 'COPIER' });

  ed.register('ROTATION', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const base = await ctx.getPoint('Spécifiez le point de base');
    let a = await ctx.getAngle('Spécifiez l’angle de rotation', {
      base, keywords: ['Copier', 'Référence'], preview: (p) => previewOf(doc, ids, G.rotation(G.angleOf(base, p), base[0], base[1])),
    });
    let copy = false;
    if (a === 'Copier') {
      copy = true;
      a = await ctx.getAngle('Spécifiez l’angle de rotation', { base, preview: (p) => previewOf(doc, ids, G.rotation(G.angleOf(base, p), base[0], base[1])) });
    }
    if (a === 'Référence') {
      const r1 = await ctx.getPoint('Spécifiez l’angle de référence (premier point)');
      const r2 = await ctx.getPoint('Deuxième point', { base: r1 });
      const ref = G.angleOf(r1, r2);
      const target = await ctx.getAngle('Spécifiez le nouvel angle', { base, preview: (p) => previewOf(doc, ids, G.rotation(G.angleOf(base, p) - ref, base[0], base[1])) });
      a = target - ref;
    }
    const m = G.rotation(a, base[0], base[1]);
    for (const id of ids) {
      const e = transformEntity(doc.get(id), m);
      if (copy) doc.add(stripId(e)); else doc.update(e);
    }
    ctx.print(`Rotation de ${fmt(deg(a))}°.`);
  }, { aliases: ['RO', 'ROTATE'], label: 'ROTATION' });

  ed.register('ECHELLE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const base = await ctx.getPoint('Spécifiez le point de base');
    let k = await ctx.getDistance('Spécifiez le facteur d’échelle', {
      base, keywords: ['Référence'], preview: (p) => { const f = G.dist(base, p); return f > 1e-9 ? previewOf(doc, ids, G.scaling(f, f, base[0], base[1])) : []; },
    });
    if (k === 'Référence') {
      const ref = await ctx.getDistance('Spécifiez la longueur de référence', { default: 1 });
      const len = await ctx.getDistance('Spécifiez la nouvelle longueur', { base });
      k = len / ref;
    }
    if (!(k > 0)) { ctx.print('Le facteur doit être positif.'); return; }
    const m = G.scaling(k, k, base[0], base[1]);
    for (const id of ids) doc.update(transformEntity(doc.get(id), m));
  }, { aliases: ['SC', 'EC', 'SCALE'], label: 'ECHELLE' });

  ed.register('MIROIR', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const a = await ctx.getPoint('Spécifiez le premier point de l’axe de symétrie');
    const b = await ctx.getPoint('Spécifiez le deuxième point de l’axe de symétrie', {
      base: a, preview: (p) => (G.dist(a, p) > 1e-9 ? previewOf(doc, ids, G.mirroring(a, p)) : []),
    });
    if (G.dist(a, b) < 1e-12) return;
    const erase = await ctx.getKeyword('Effacer les objets source ?', ['Oui', 'Non'], { default: 'Non' });
    const m = G.mirroring(a, b);
    for (const id of ids) {
      const e = transformEntity(doc.get(id), m);
      if (erase === 'Oui') doc.update(e); else doc.add(stripId(e));
    }
  }, { aliases: ['MI', 'MIRROR'], label: 'MIROIR' });

  let lastOffset = 10;
  ed.register('DECALER', async (ctx) => {
    const { doc } = ctx;
    let d = await ctx.getDistance('Spécifiez la distance de décalage', { default: lastOffset });
    lastOffset = d;
    while (true) {
      const pick = await ctx.getEntity('Choisissez l’objet à décaler', { allowNone: true });
      if (pick === null) return;
      const e = doc.get(pick.id);
      if (!PATH_TYPES.has(e.type)) { ctx.print('Seuls les lignes, arcs, cercles et polylignes peuvent être décalés.'); continue; }
      const side = await ctx.getPoint('Spécifiez un point sur le côté à décaler', {
        preview: (p) => { const o = offsetEntity(e, d, p); return o ? [].concat(o) : []; },
      });
      const o = offsetEntity(e, d, side);
      if (!o) { ctx.print('Décalage impossible avec cette distance.'); continue; }
      for (const x of [].concat(o)) doc.add(stripId(x));
    }
  }, { aliases: ['O', 'DC', 'OFFSET'], label: 'DECALER' });

  ed.register('AJUSTER', async (ctx) => {
    const { doc, editor } = ctx;
    ctx.print('Mode rapide : tous les objets servent d’arêtes de coupe.');
    while (true) {
      const pick = await ctx.getEntity('Choisissez l’objet à ajuster', { allowNone: true });
      if (pick === null) return;
      const e = doc.get(pick.id);
      if (!PATH_TYPES.has(e.type)) { ctx.print('Objet non ajustable (lignes, arcs, cercles, polylignes).'); continue; }
      const result = trimEntity(e, pick.p, cuttersAround(editor, e));
      if (!result) { ctx.print('Aucune arête de coupe.'); continue; }
      doc.remove(e.id);
      for (const x of result) doc.add(x);
    }
  }, { aliases: ['TR', 'AJ', 'TRIM'], label: 'AJUSTER' });

  ed.register('PROLONGER', async (ctx) => {
    const { doc, editor } = ctx;
    while (true) {
      const pick = await ctx.getEntity('Choisissez l’objet à prolonger', { allowNone: true });
      if (pick === null) return;
      const e = doc.get(pick.id);
      const r = extendEntity(e, pick.p, cuttersAround(editor, e));
      if (!r) { ctx.print('Aucune frontière trouvée dans cette direction.'); continue; }
      doc.update({ ...r, id: e.id });
    }
  }, { aliases: ['EX', 'PR', 'EXTEND'], label: 'PROLONGER' });

  // RACCORD et CHANFREIN : entre deux lignes, deux segments d'une même polyligne, une ligne et le
  // segment d'extrémité d'une polyligne (le tout est alors joint), ou sur tous les sommets d'une
  // polyligne (option Polyligne ; un rayon nul retire les raccords existants).
  const corner = { r: 0, d1: 0, d2: 0 };
  const CORNER_ERRORS = {
    'trop grand': 'Rayon ou distance trop grand pour ces segments.',
    'segments courbes': 'Le coin touche un segment courbe.',
    'segments alignés': 'Les segments sont alignés.',
    'segments non adjacents': 'Les deux segments ne se suivent pas.',
  };

  // Ligne support d'un objet : la ligne elle-même, ou le segment droit d'extrémité choisi d'une polyligne
  // ouverte (p1 = sommet intérieur, p2 = extrémité).
  function cornerSupport(e, p) {
    if (e.type === 'LINE') return { line: e };
    if (e.type !== 'LWPOLYLINE' || e.closed || e.pts.length < 2) return null;
    const i = segmentIndexAt(e, p);
    const n = e.pts.length;
    const z = e.z || 0;
    const v = (k) => [e.pts[k][0], e.pts[k][1], z];
    if (i === n - 2 && !(e.bulges?.[i])) return { line: { type: 'LINE', p1: v(n - 2), p2: v(n - 1) }, end: 'end' };
    if (i === 0 && !(e.bulges?.[0])) return { line: { type: 'LINE', p1: v(1), p2: v(0) }, end: 'start' };
    return null;
  }

  function applyCorner(doc, first, second, opts) {
    const e1 = doc.get(first.id), e2 = doc.get(second.id);
    if (e1.id === e2.id) {
      if (e1.type !== 'LWPOLYLINE') return 'Choisissez deux objets différents.';
      const r = cornerPolylineSegments(e1, segmentIndexAt(e1, first.p), segmentIndexAt(e1, second.p), opts);
      if (r.error) return CORNER_ERRORS[r.error] || r.error;
      doc.update(r.entity);
      return null;
    }
    // Arcs et cercles (avec une ligne, un arc ou un cercle) : raccord tangent ou coin vif.
    const CURVES = new Set(['LINE', 'ARC', 'CIRCLE']);
    if (CURVES.has(e1.type) && CURVES.has(e2.type) && (e1.type !== 'LINE' || e2.type !== 'LINE')) {
      if (opts.d1 != null) return 'Les arcs et les cercles ne se chanfreinent pas (comme dans AutoCAD).';
      const r = filletCurves(e1, first.p, e2, second.p, opts.r || 0);
      if (r.error) return 'Pas de raccord possible avec ce rayon.';
      doc.update(r.e1);
      doc.update(r.e2);
      if (r.arc) doc.add({ ...r.arc, space: e1.space });
      return null;
    }
    const s1 = cornerSupport(e1, first.p), s2 = cornerSupport(e2, second.p);
    if (!s1 || !s2) return 'Choisissez des lignes, des segments droits d’extrémité de polylignes, ou deux segments d’une même polyligne.';
    const r = cornerLines(s1.line, first.p, s2.line, second.p, opts);
    if (!r) return 'Les objets sont parallèles.';
    if (r.error) return CORNER_ERRORS[r.error];
    if (!s1.end && !s2.end) {
      doc.update(r.l1);
      doc.update(r.l2);
      if (r.link) doc.add({ ...r.link, space: e1.space });
      return null;
    }
    // Une polyligne au moins : on raccourcit ses extrémités puis on joint le tout dans la polyligne.
    const pieces = [];
    for (const [s, l, e] of [[s1, r.l1, e1], [s2, r.l2, e2]]) {
      if (!s.end) { pieces.push(l); continue; }
      if (G.dist(l.p1, s.line.p1) > 1e-9) return 'Choisissez la polyligne du côté à conserver.';
      const pts = e.pts.map((q) => [...q]);
      pts[s.end === 'end' ? pts.length - 1 : 0] = [l.p2[0], l.p2[1]];
      pieces.push({ ...e, pts });
    }
    pieces.sort((a, b) => (b.type === 'LWPOLYLINE') - (a.type === 'LWPOLYLINE'));
    if (r.link) pieces.push({ ...r.link, id: -1 });
    const j = joinEntities(pieces);
    if (!j || j.used.length !== pieces.length) return 'Impossible de joindre le résultat.';
    const base = pieces[0];
    doc.update({ ...j.entity, id: base.id });
    for (const p of pieces.slice(1)) if (p.id > 0 && doc.get(p.id)) doc.remove(p.id);
    return null;
  }

  const cornerCommand = (chamfer) => async (ctx) => {
    const { doc } = ctx;
    const opts = () => (chamfer ? { d1: corner.d1, d2: corner.d2 } : { r: corner.r });
    const status = () => (chamfer ? `distances = ${fmt(corner.d1)}, ${fmt(corner.d2)}` : `rayon = ${fmt(corner.r)}`);
    let multiple = false;
    while (true) {
      const first = await ctx.getEntity(`Choisissez le premier objet (${status()})`, { keywords: [chamfer ? 'Distance' : 'Rayon', 'Polyligne', 'Multiple'], allowNone: multiple });
      if (first === null) return;
      if (first === 'Rayon') { corner.r = await ctx.getDistance('Spécifiez le rayon de raccord', { default: corner.r }); continue; }
      if (first === 'Distance') {
        corner.d1 = await ctx.getDistance('Première distance de chanfrein', { default: corner.d1 });
        corner.d2 = await ctx.getDistance('Deuxième distance de chanfrein', { default: corner.d1 });
        continue;
      }
      if (first === 'Multiple') { multiple = true; continue; }
      if (first === 'Polyligne') {
        const pick = await ctx.getEntity('Choisissez la polyligne');
        const e = doc.get(pick.id);
        if (e.type !== 'LWPOLYLINE') ctx.print('Ce n’est pas une polyligne.');
        else {
          const r = cornerPolylineAll(e, opts());
          if (r.changed) doc.update(r.entity);
          ctx.print(`${r.done} sommet(s) ${chamfer ? 'chanfreiné(s)' : 'raccordé(s)'}${r.tooShort ? `, ${r.tooShort} trop court(s)` : ''}.`);
        }
        if (!multiple) return;
        continue;
      }
      const second = await ctx.getEntity('Choisissez le deuxième objet');
      const msg = applyCorner(doc, first, second, opts());
      if (msg) ctx.print(msg);
      if (!multiple) return;
    }
  };
  ed.register('RACCORD', cornerCommand(false), { aliases: ['F', 'RA', 'FILLET'], label: 'RACCORD' });
  ed.register('CHANFREIN', cornerCommand(true), { aliases: ['CHA', 'CHAMFER'], label: 'CHANFREIN' });

  ed.register('ETIRER', async (ctx) => {
    const { doc, editor } = ctx;
    ctx.print('Choisissez les sommets à étirer par une fenêtre de capture.');
    const c1 = await ctx.getPoint('Premier coin de la fenêtre de capture');
    const rect = (p) => [newEntity(doc, { type: 'LWPOLYLINE', pts: [[c1[0], c1[1]], [p[0], c1[1]], [p[0], p[1]], [c1[0], p[1]]], bulges: [0, 0, 0, 0], closed: true, z: 0 })];
    const c2 = await ctx.getPoint('Coin opposé', { preview: rect });
    const box = { minX: Math.min(c1[0], c2[0]), maxX: Math.max(c1[0], c2[0]), minY: Math.min(c1[1], c2[1]), maxY: Math.max(c1[1], c2[1]) };
    const ids = editor.r.selectBox(box, true);
    if (!ids.length) { ctx.print('Aucun objet dans la fenêtre.'); return; }
    editor.setSelection(ids);
    const base = await ctx.getPoint('Point de base');
    const target = await ctx.getPoint('Deuxième point', {
      base, preview: (p) => ids.slice(0, MAX_PREVIEW).map((id) => stretchEntity(doc.get(id), box, p[0] - base[0], p[1] - base[1])).filter(Boolean),
    });
    let n = 0;
    for (const id of ids) {
      const r = stretchEntity(doc.get(id), box, target[0] - base[0], target[1] - base[1]);
      if (r) { doc.update(r); n++; }
    }
    editor.setSelection([]);
    ctx.print(`${n} objet(s) étiré(s).`);
  }, { aliases: ['S', 'STRETCH'], label: 'ETIRER' });

  ed.register('COUPURE', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez l’objet à couper');
    const e = doc.get(pick.id);
    if (!PATH_TYPES.has(e.type)) { ctx.print('Coupure possible sur les lignes, arcs, cercles et polylignes.'); return; }
    let p1 = pick.p;
    let p2 = await ctx.getPoint('Deuxième point de coupure (« @ » pour couper en un point)', { keywords: ['Premier', '@'] });
    if (p2 === 'Premier') {
      p1 = await ctx.getPoint('Premier point de coupure');
      p2 = await ctx.getPoint('Deuxième point de coupure', { keywords: ['@'] });
    }
    if (p2 === '@') p2 = p1;
    const r = breakEntity(e, p1, p2);
    if (!r) { ctx.print('Coupure impossible à cet endroit.'); return; }
    doc.remove(e.id);
    for (const x of r) doc.add(x);
    ctx.print(r.length === 2 ? 'Objet scindé en deux.' : 'Coupure effectuée.');
  }, { aliases: ['BR', 'BREAK'], label: 'COUPURE' });

  ed.register('DECOMPOS', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    let n = 0;
    for (const id of ids) {
      const e = doc.get(id);
      const parts = explode(doc, e);
      if (!parts) continue;
      doc.remove(id);
      for (const p of parts) doc.add({ ...p, space: e.space });
      n++;
    }
    ctx.print(`${n} objet(s) décomposé(s).`);
  }, { aliases: ['X', 'EXPLODE', 'DECOMPOSER'], label: 'DECOMPOS' });

  ed.register('JOINDRE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    const ents = ids.map((id) => doc.get(id)).filter((e) => e && ['LINE', 'ARC', 'LWPOLYLINE'].includes(e.type));
    const r = joinEntities(ents, 1e-6);
    if (!r || r.used.length < 2) { ctx.print('Aucun objet à joindre (les extrémités doivent coïncider).'); return; }
    for (const id of r.used) doc.remove(id);
    doc.add(r.entity);
    ctx.print(`${r.used.length} objets joints en une polyligne.`);
  }, { aliases: ['J', 'JOIN'], label: 'JOINDRE' });

  // EDITPOLY (PEDIT) : fermer / ouvrir, largeur constante, décurver, joindre. Une ligne ou un arc désigné est
  // d'abord converti en polyligne (comme AutoCAD).
  ed.register('EDITPOLY', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez une polyligne (ou une ligne, un arc)');
    let e = doc.get(pick.id);
    if (e?.mep) { ctx.print('Réseau MEP : modifiez-le avec ses poignées ou la palette Propriétés.'); return; }
    if (e && (e.type === 'LINE' || e.type === 'ARC')) {
      const j = joinEntities([e], 1e-6);
      if (!j) { ctx.print('Conversion impossible.'); return; }
      e = { ...j.entity, id: e.id };
      doc.update(e);
      ctx.print('Objet converti en polyligne.');
    }
    if (e?.type !== 'LWPOLYLINE') { ctx.print('Ce n’est pas une polyligne.'); return; }
    while (true) {
      e = doc.get(e.id);
      const k = await ctx.getKeyword('Option', [e.closed ? 'Ouvrir' : 'Fermer', 'Joindre', 'Largeur', 'Decurver'], { allowNone: true });
      if (k === null) return;
      if (k === 'Fermer' || k === 'Ouvrir') doc.update({ ...e, closed: k === 'Fermer' });
      else if (k === 'Largeur') {
        const w = await ctx.getDistance('Largeur de tous les segments', { default: e.width || 0 });
        if (w >= 0) { const { widths, ...rest } = e; doc.update({ ...rest, width: w }); }
      } else if (k === 'Decurver') doc.update({ ...e, bulges: e.pts.map(() => 0) });
      else if (k === 'Joindre') {
        const ids = await ctx.getSelection('Objets à joindre à la polyligne');
        const others = ids.filter((id) => id !== e.id).map((id) => doc.get(id)).filter((x) => x && !x.mep && ['LINE', 'ARC', 'LWPOLYLINE'].includes(x.type));
        const j = joinEntities([e, ...others], 1e-6);
        if (!j || j.used.length < 2) { ctx.print('Aucun objet joint (les extrémités doivent coïncider).'); continue; }
        for (const id of j.used) if (id !== e.id) doc.remove(id);
        doc.update({ ...j.entity, id: e.id, layer: e.layer, color: e.color, width: e.width || 0 });
        ctx.print(`${j.used.length - 1} objet(s) joint(s).`);
      }
    }
  }, { aliases: ['PE', 'PEDIT', 'EDITPOLYLIGNE'], label: 'EDITPOLY' });

  // Calques des objets choisis (attributs compris), sauf « 0 ».
  const layersOf = (doc, ids) => new Set(ids.map((id) => doc.get(id)?.layer).filter((l) => l && l !== '0'));
  // Objets et définitions de blocs : `fn(e)` renvoie l'objet modifié, null pour le supprimer, ou e inchangé.
  const rewriteLayers = (doc, fn) => {
    for (const e of [...doc.entities.values()]) {
      const r = fn(e);
      if (r === null) doc.remove(e.id); else if (r !== e) doc.update(r);
    }
    for (const b of [...doc.blocks.values()]) {
      if (b.xref) continue;
      const ents = b.entities.map(fn).filter((x) => x !== null);
      if (ents.length !== b.entities.length || ents.some((x, i) => x !== b.entities[i])) doc.setTableEntry('blocks', b.name, { ...b, entities: ents });
    }
  };

  // FUSIONCALQUE (LAYMRG) : les objets des calques choisis passent sur un calque de destination, puis ces
  // calques sont supprimés (objets des blocs et attributs compris).
  ed.register('FUSIONCALQUE', async (ctx) => {
    const { doc } = ctx;
    const src = layersOf(doc, await ctx.getSelection('Objets des calques à fusionner'));
    ctx.editor.setSelection([]);
    const pick = await ctx.getEntity('Objet sur le calque de destination');
    const target = doc.get(pick.id)?.layer;
    src.delete(target);
    if (!target || !src.size) { ctx.print('Rien à fusionner.'); return; }
    const move = (e) => {
      const attribs = e.attribs?.some((a) => src.has(a.layer)) ? e.attribs.map((a) => (src.has(a.layer) ? { ...a, layer: target } : a)) : e.attribs;
      return src.has(e.layer) || attribs !== e.attribs ? { ...e, layer: src.has(e.layer) ? target : e.layer, ...(attribs ? { attribs } : {}) } : e;
    };
    rewriteLayers(doc, move);
    if (src.has(doc.currentLayer)) doc.currentLayer = target;
    for (const n of src) doc.deleteLayer(n);
    ctx.print(`${src.size} calque(s) fusionné(s) dans ${target} : ${[...src].join(', ')}.`);
  }, { aliases: ['LAYMRG', 'FUSIONNERCALQUES'], label: 'FUSIONCALQUE' });

  // SUPPRCALQUE (LAYDEL) : supprime les calques choisis et tous leurs objets (blocs compris).
  ed.register('SUPPRCALQUE', async (ctx) => {
    const { doc } = ctx;
    const src = layersOf(doc, await ctx.getSelection('Objets des calques à supprimer'));
    if (!src.size) { ctx.print('Aucun calque supprimable (le calque 0 ne se supprime pas).'); return; }
    const ok = await ctx.getKeyword(`Supprimer ${[...src].join(', ')} et tous leurs objets`, ['Oui', 'Non'], { default: 'Non' });
    if (ok !== 'Oui') return;
    ctx.editor.setSelection([]);
    rewriteLayers(doc, (e) => {
      if (src.has(e.layer)) return null;
      return e.attribs?.some((a) => src.has(a.layer)) ? { ...e, attribs: e.attribs.filter((a) => !src.has(a.layer)) } : e;
    });
    if (src.has(doc.currentLayer)) doc.currentLayer = '0';
    for (const n of src) doc.deleteLayer(n);
    ctx.print(`${src.size} calque(s) supprimé(s) avec leurs objets.`);
  }, { aliases: ['LAYDEL', 'SUPPRIMERCALQUE'], label: 'SUPPRCALQUE' });

  // ISOLEROBJETS / MASQUEROBJETS / FINISOLEROBJETS : masquage temporaire d'objets (vue seulement).
  ed.register('ISOLEROBJETS', async (ctx) => {
    const { doc, editor } = ctx;
    const ids = new Set(await ctx.getSelection('Objets à isoler'));
    if (!ids.size) return;
    const space = doc.currentSpace || 'model';
    const hidden = new Set(editor.r.hiddenIds || []);
    for (const e of doc.entities.values()) if (e.space === space && !ids.has(e.id)) hidden.add(e.id);
    editor.setSelection([]);
    editor.r.setHidden(hidden);
    ctx.print(`${ids.size} objet(s) isolé(s) ; FINISOLEROBJETS pour tout réafficher.`);
  }, { aliases: ['ISOLATEOBJECTS', 'ISOLER'], label: 'ISOLEROBJETS', transaction: false });

  ed.register('MASQUEROBJETS', async (ctx) => {
    const { editor } = ctx;
    const ids = await ctx.getSelection('Objets à masquer');
    if (!ids.length) return;
    const hidden = new Set(editor.r.hiddenIds || []);
    for (const id of ids) hidden.add(id);
    editor.setSelection([]);
    editor.r.setHidden(hidden);
    ctx.print(`${ids.length} objet(s) masqué(s) ; FINISOLEROBJETS pour tout réafficher.`);
  }, { aliases: ['HIDEOBJECTS', 'MASQUER'], label: 'MASQUEROBJETS', transaction: false });

  ed.register('FINISOLEROBJETS', (ctx) => {
    const n = ctx.editor.r.hiddenIds?.size || 0;
    ctx.editor.r.setHidden(null);
    ctx.print(n ? `${n} objet(s) réaffiché(s).` : 'Aucun objet masqué.');
  }, { aliases: ['UNISOLATEOBJECTS', 'FINISOLER'], label: 'FINISOLEROBJETS', transaction: false });

  // CALQCOUR : le calque de l'objet désigné devient le calque courant.
  ed.register('CALQCOUR', async (ctx) => {
    const pick = await ctx.getEntity('Choisissez un objet dont le calque deviendra courant');
    const e = ctx.doc.get(pick.id);
    if (!e) return;
    ctx.doc.currentLayer = e.layer;
    ctx.editor.ui.onState?.();
    ctx.print(`Calque courant : ${e.layer}.`);
  }, { aliases: ['LAYMCUR', 'CALQUECOURANT'], label: 'CALQCOUR', transaction: false });

  // CORRESPCALQUE : les objets choisis passent sur le calque d'un objet désigné.
  ed.register('CORRESPCALQUE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection('Objets à changer de calque');
    if (!ids.length) return;
    ctx.editor.setSelection([]);
    const pick = await ctx.getEntity('Choisissez un objet sur le calque de destination');
    const layer = doc.get(pick.id)?.layer;
    if (!layer) return;
    for (const id of ids) { const e = doc.get(id); if (e && e.layer !== layer) doc.update({ ...e, layer }); }
    ctx.print(`${ids.length} objet(s) placé(s) sur le calque ${layer}.`);
  }, { aliases: ['LAYMCH', 'CALQUECORRESP'], label: 'CORRESPCALQUE' });

  // Presse-papiers interne (fonctionne aussi d'un dessin à l'autre dans la même session).
  let clipboard = null;
  ed.register('COPIERPRESSE', async (ctx) => {
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const ents = ids.map((id) => stripId(ctx.doc.get(id)));
    const names = new Set();
    const collect = (list) => list.forEach((e) => {
      if ((e.type === 'INSERT' || e.type === 'BLOCKREF') && !names.has(e.name)) {
        names.add(e.name);
        collect(ctx.doc.blocks.get(e.name)?.entities || []);
      }
    });
    collect(ents);
    const blocks = [...names].map((n) => ctx.doc.blocks.get(n)).filter(Boolean).map((b) => structuredClone(b));
    const layers = [...new Set(ents.map((e) => e.layer))].map((n) => ctx.doc.layers.get(n)).filter(Boolean).map((l) => ({ ...l }));
    const box = G.emptyBox();
    for (const id of ids) {
      const bb = ctx.editor.r.cache.get(id)?.box;
      if (bb && G.boxValid(bb)) { G.growBox(box, bb.minX, bb.minY); G.growBox(box, bb.maxX, bb.maxY); }
    }
    clipboard = { ents, blocks, layers, base: G.boxValid(box) ? [box.minX, box.minY] : [0, 0] };
    ctx.print(`${ents.length} objet(s) copié(s) dans le presse-papiers.`);
  }, { aliases: ['COPYCLIP'], label: 'COPIERPRESSE', transaction: false });

  // Couper (Ctrl+X) : copie dans le presse-papiers puis effacement, un seul annuler.
  ed.register('COUPERPRESSE', async (ctx) => {
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    await ed.commands.get('COPIERPRESSE').fn(ctx);
    for (const id of ids) if (ctx.doc.get(id)) ctx.doc.remove(id);
  }, { aliases: ['CUTCLIP'], label: 'COUPERPRESSE' });

  ed.register('COLLER', async (ctx) => {
    const { doc } = ctx;
    if (!clipboard) { ctx.print('Le presse-papiers est vide.'); return; }
    const { ents, base } = clipboard;
    const at = await ctx.getPoint('Point d’insertion', {
      preview: (p) => ents.slice(0, MAX_PREVIEW).map((e) => transformEntity(e, G.translation(p[0] - base[0], p[1] - base[1]))),
    });
    for (const l of clipboard.layers) if (!doc.layers.has(l.name)) doc.addLayer(l.name, l);
    for (const b of clipboard.blocks) if (!doc.blocks.has(b.name)) doc.blocks.set(b.name, structuredClone(b));
    const m = G.translation(at[0] - base[0], at[1] - base[1]);
    for (const e of ents) doc.add({ ...transformEntity(e, m), space: doc.currentSpace || 'model' });
    ctx.print(`${ents.length} objet(s) collé(s).`);
  }, { aliases: ['PASTECLIP'], label: 'COLLER' });

  // COPIERBASE : copie dans le presse-papiers avec un point de base choisi (repris par COLLER).
  ed.register('COPIERBASE', async (ctx) => {
    const base = await ctx.getPoint('Point de base');
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    await ed.commands.get('COPIERPRESSE').fn(ctx);
    if (clipboard) clipboard.base = [base[0], base[1]];
  }, { aliases: ['COPYBASE'], label: 'COPIERBASE', transaction: false });

  // COLLERORIG : colle aux coordonnées d'origine (d'un dessin à l'autre, objets superposés au même endroit).
  ed.register('COLLERORIG', async (ctx) => {
    const { doc } = ctx;
    if (!clipboard) { ctx.print('Le presse-papiers est vide.'); return; }
    for (const l of clipboard.layers) if (!doc.layers.has(l.name)) doc.addLayer(l.name, l);
    for (const b of clipboard.blocks) if (!doc.blocks.has(b.name)) doc.blocks.set(b.name, structuredClone(b));
    for (const e of clipboard.ents) doc.add({ ...structuredClone(e), space: doc.currentSpace || 'model' });
    ctx.print(`${clipboard.ents.length} objet(s) collé(s) aux coordonnées d’origine.`);
  }, { aliases: ['PASTEORIG'], label: 'COLLERORIG' });

  ed.register('CORRESPROP', async (ctx) => {
    const { doc } = ctx;
    const src = await ctx.getEntity('Choisissez l’objet source');
    const s0 = doc.get(src.id);
    const props = { layer: s0.layer, color: s0.color, rgb: s0.rgb, ltype: s0.ltype, ltscale: s0.ltscale, lweight: s0.lweight };
    // Réseau MEP source : système, section, altitude et calorifuge reportés sur les réseaux de même nature.
    const MEP_KEYS = ['system', 'shape', 'w', 'h', 'd', 'z', 'ins', 'elbow', 'maker', 'ri'];
    let n = 0;
    while (true) {
      const dst = await ctx.getEntity('Choisissez les objets de destination', { allowNone: true });
      if (dst === null) break;
      doc.modify(dst.id, (e) => {
        Object.assign(e, props);
        if (props.rgb == null) delete e.rgb;
        if (!props.ltype) delete e.ltype;
        if (s0.mep && e.mep && s0.type === e.type && s0.mep.kind === e.mep.kind) {
          for (const k of MEP_KEYS) { if (s0.mep[k] === undefined) delete e.mep[k]; else e.mep[k] = s0.mep[k]; }
          if (e.type === 'LWPOLYLINE') e.z = s0.mep.z || 0;
        }
      });
      n++;
    }
    ctx.print(`Propriétés appliquées à ${n} objet(s).`);
  }, { aliases: ['MA', 'MATCHPROP'], label: 'CORRESPROP' });

  ed.register('RESEAURECT', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const rows = Math.max(1, Math.round(await ctx.getDistance('Nombre de rangées', { default: 2 })));
    const cols = Math.max(1, Math.round(await ctx.getDistance('Nombre de colonnes', { default: 3 })));
    const dy = rows > 1 ? await ctx.getDistance('Espacement des rangées', { default: 1000 }) : 0;
    const dx = cols > 1 ? await ctx.getDistance('Espacement des colonnes', { default: 1000 }) : 0;
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!r && !c) continue;
        const m = G.translation(c * dx, r * dy);
        for (const id of ids) { doc.add(stripId(transformEntity(doc.get(id), m))); n++; }
      }
    }
    ctx.print(`${n} copie(s) créée(s).`);
  }, { aliases: ['AR', 'ARRAYRECT', 'RESEAU'], label: 'RESEAURECT' });

  ed.register('RESEAUPOLAIRE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const c = await ctx.getPoint('Centre du réseau');
    const count = Math.max(2, Math.round(await ctx.getDistance('Nombre d’éléments', { default: 6 })));
    const fill = await ctx.getDistance('Angle à remplir (degrés)', { default: 360 });
    const step = (fill * Math.PI) / 180 / (Math.abs(fill - 360) < 1e-9 ? count : count - 1);
    for (let k = 1; k < count; k++) {
      const m = G.rotation(step * k, c[0], c[1]);
      for (const id of ids) doc.add(stripId(transformEntity(doc.get(id), m)));
    }
    ctx.print(`${(count - 1) * ids.length} copie(s) créée(s).`);
  }, { aliases: ['ARRAYPOLAR', 'RP'], label: 'RESEAUPOLAIRE' });

  // HACHURES, -HACHURES, HACHEDIT : voir hatch/commands.js.

  ed.register('BLOC', async (ctx) => {
    const { doc } = ctx;
    let name = '';
    while (!name) {
      name = (await ctx.getString('Nom du bloc')).trim();
      if (!name) return;
      if (/[<>/\\":;?*|,=`]/.test(name)) { ctx.print('Caractères interdits dans un nom de bloc.'); name = ''; continue; }
      if (doc.blocks.has(name)) { ctx.print(`Le bloc « ${name} » existe déjà.`); name = ''; }
    }
    const base = await ctx.getPoint('Point de base');
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const ents = ids.map((id) => stripId(doc.get(id))).map((e) => { delete e.space; return e; });
    doc.blocks.set(name, { name, base: [base[0], base[1], 0], flags: 0, xref: false, entities: ents });
    for (const id of ids) doc.remove(id);
    doc.add(newEntity(doc, { type: 'INSERT', name, p: [base[0], base[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] }));
    ctx.print(`Bloc « ${name} » créé avec ${ents.length} objet(s).`);
  }, { aliases: ['B', 'BLOCK'], label: 'BLOC' });

  let lastBlock = null;
  // Insertion d'un bloc : aperçu au curseur, échelle et rotation (demandées ou imposées), valeurs des
  // attributs ; explode : objets du bloc posés décomposés. Renvoie l'insertion (ou null si décomposée).
  async function placeBlock(ctx, name, { scale = null, rot = null, explodeIt = false } = {}) {
    const { doc } = ctx;
    const mk = (p, s = 1, r = 0) => newEntity(doc, { type: 'INSERT', name, p: [p[0], p[1], 0], sx: s, sy: s, sz: 1, rot: r, attribs: [] });
    const ua = ucsOf(doc).angle; // orientation par défaut : axe X du SCU
    const p = await ctx.getPoint('Point d’insertion', { preview: (q) => [mk(q, scale ?? 1, rot ?? ua)] });
    const s = scale ?? await ctx.getDistance('Facteur d’échelle', { default: 1 });
    const r = rot ?? await ctx.getAngle('Angle de rotation', { base: p, default: 0, absolute: true, preview: (q) => [mk(p, s, G.angleOf(p, q))] });
    const ins = mk(p, s || 1, typeof r === 'number' ? r : 0);
    // Attributs : une valeur par définition d'attribut du bloc (valeur par défaut proposée), comme AutoCAD.
    const block = doc.blocks.get(name);
    const m = insertMatrix(ins, block.base || [0, 0]);
    for (const def of block.entities.filter((x) => x.type === 'ATTDEF')) {
      const value = await ctx.getString(`${def.prompt || def.tag}`, { default: def.text || '' });
      const t = transformEntity({ ...def, type: 'TEXT' }, m);
      delete t.prompt; delete t.invisible; delete t.k;
      // Attribut invisible : valeur conservée (Propriétés, export), non dessinée.
      ins.attribs.push({ ...t, type: 'TEXT', tag: def.tag, text: value, ...(def.invisible ? { invisible: true } : {}) });
    }
    if (explodeIt) {
      for (const x of explode(doc, ins) || []) doc.add({ ...x, space: ins.space });
      return null;
    }
    return doc.add(ins);
  }

  async function insertFromCommandLine(ctx) {
    const { doc } = ctx;
    const names = [...doc.blocks.keys()].filter((n) => !n.startsWith('*') && !n.startsWith('CV_MEP_')).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
    if (!names.length) { ctx.print('Aucun bloc dans ce dessin (créez-en un avec BLOC).'); return; }
    ctx.print(`Blocs : ${names.slice(0, 40).join(', ')}${names.length > 40 ? '…' : ''}`);
    let name = null;
    while (!name) {
      const t = (await ctx.getString('Nom du bloc à insérer', { default: lastBlock && doc.blocks.has(lastBlock) ? lastBlock : names[0] })).trim();
      name = names.find((n) => n.toLowerCase() === t.toLowerCase()) || null;
      if (!name) ctx.print(`Bloc « ${t} » introuvable.`);
    }
    lastBlock = name;
    await placeBlock(ctx, name);
  }

  // INSERER : boîte d'insertion avec aperçus quand l'interface la fournit ; -INSERER : ligne de commande.
  ed.register('INSERER', async (ctx) => {
    if (ctx.editor.ui.openInsert) { ctx.editor.ui.openInsert(); return; }
    await insertFromCommandLine(ctx);
  }, { aliases: ['I', 'INSERT', 'INS'], label: 'INSERER' });
  ed.register('-INSERER', insertFromCommandLine, { aliases: ['-I', '-INSERT'], label: '-INSERER' });

  // Pose depuis la boîte d'insertion : bloc et options choisis (ed.insertState), répétée si demandé.
  ed.register('POSERBLOC', async (ctx) => {
    const st = ctx.editor.insertState;
    if (!st?.name || !ctx.doc.blocks.has(st.name)) { ctx.print('Choisissez un bloc dans la boîte d’insertion (INSERER).'); return; }
    lastBlock = st.name;
    let n = 0;
    do {
      try {
        await placeBlock(ctx, st.name, { scale: st.scale ?? 1, rot: st.rotOnScreen ? null : (st.rot || 0), explodeIt: !!st.explode });
        n++;
      } catch (err) {
        if (err instanceof Cancel && n) break;
        throw err;
      }
    } while (st.repeat);
    if (n > 1) ctx.print(`${n} insertions de « ${st.name} ».`);
  }, { label: 'POSERBLOC' });

  ed.register('DEFATT', async (ctx) => {
    const { doc } = ctx;
    const tag = (await ctx.getString('Étiquette de l’attribut (sans espace)')).trim().replace(/\s+/g, '_').toUpperCase();
    if (!tag) return;
    const prompt = (await ctx.getString('Invite', { default: tag })).trim();
    const value = await ctx.getString('Valeur par défaut', { default: '' });
    const p = await ctx.getPoint('Point de départ du texte');
    const h = await ctx.getDistance('Hauteur', { base: p, default: lastTextHeight ?? (doc.header?.textsize > 0 ? doc.header.textsize : 2.5 * annoScaleOf(doc)) });
    doc.add(newEntity(doc, { type: 'ATTDEF', p: [p[0], p[1], 0], h, rot: 0, text: value, tag, prompt, align: 'left', valign: 'baseline', wf: 1 }));
    ctx.print(`Attribut ${tag} défini : incluez-le dans un BLOC ; INSERER demandera sa valeur.`);
  }, { aliases: ['ATT', 'ATTDEF', 'DEFATTRIBUT'], label: 'DEFATT' });

  ed.register('AIRE', async (ctx) => {
    const { doc } = ctx;
    const unit = { 4: 1e-6, 5: 1e-4, 6: 1 }[doc.header?.insunits];
    const report = ({ area, perimeter }) => {
      const m2 = unit ? ` (${(area * unit).toFixed(2).replace('.', ',')} m²)` : '';
      ctx.print(`Aire = ${fmt(area)}${m2}, périmètre = ${fmt(perimeter)}`);
    };
    const first = await ctx.getPoint('Premier sommet', { keywords: ['Objet'], default: 'Objet' });
    if (first === 'Objet') {
      const pick = await ctx.getEntity('Choisissez un objet fermé (polyligne, cercle)');
      const r = areaOf(doc.get(pick.id));
      if (!r) { ctx.print('Objet sans surface.'); return; }
      report(r);
      return;
    }
    const pts = [first];
    while (true) {
      const p = await ctx.getPoint('Sommet suivant (Entrée pour terminer)', {
        base: pts[pts.length - 1], allowNone: true,
        preview: (q) => [newEntity(doc, { type: 'LWPOLYLINE', pts: [...pts, q].map((v) => [v[0], v[1]]), bulges: [...pts, q].map(() => 0), closed: true, z: 0 })],
      });
      if (p === null) break;
      pts.push(p);
    }
    if (pts.length >= 3) report(polygonArea(pts)); else ctx.print('Il faut au moins trois sommets.');
  }, { aliases: ['AA', 'AREA'], label: 'AIRE', transaction: false });

  let lastMtextHeight = 2.5;
  ed.register('TEXTMULT', async (ctx) => {
    const { doc } = ctx;
    const a = await ctx.getPoint('Premier coin de la zone de texte');
    const b = await ctx.getPoint('Coin opposé', {
      base: a,
      preview: (p) => [newEntity(doc, { type: 'LWPOLYLINE', pts: [[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], bulges: [0, 0, 0, 0], closed: true, z: 0 })],
    });
    const h = await ctx.getDistance('Hauteur du texte', { default: lastMtextHeight });
    lastMtextHeight = h;
    const text = await ctx.getString('Texte (« | » pour aller à la ligne)');
    if (!text) return;
    doc.add(newEntity(doc, {
      type: 'MTEXT', p: [Math.min(a[0], b[0]), Math.max(a[1], b[1]), 0], h, rot: 0,
      text: text.split('|').join('\\P'), width: Math.abs(b[0] - a[0]), attach: 1, spacing: 1,
    }));
  }, { aliases: ['T', 'MT', 'MTEXT'], label: 'TEXTMULT' });

  ed.register('GRILLE', async (ctx) => {
    const v = await ctx.getDistance('Espacement de la grille (0 = masquer)', { default: ed.settings.gridSize || 10 });
    if (v > 0) { ed.settings.gridSize = v; ed.settings.grid = true; } else ed.settings.grid = false;
    ed.ui.onState?.(); ed.r.requestRender();
  }, { aliases: ['GRID'], label: 'GRILLE', transaction: false });

  ed.register('PAS', async (ctx) => {
    const v = await ctx.getDistance('Pas d’accrochage (0 = désactiver)', { default: ed.settings.snapSize || ed.settings.gridSize || 10 });
    if (v > 0) { ed.settings.snapSize = v; ed.settings.snap = true; } else ed.settings.snap = false;
    ed.ui.onState?.();
  }, { aliases: ['SNAP'], label: 'PAS', transaction: false });

  ed.register('SELECTSIM', async (ctx) => {
    const { doc, editor } = ctx;
    const ids = await ctx.getSelection('Choisissez les objets de référence');
    if (!ids.length) return;
    const key = (e) => `${e.type}|${e.layer}|${e.mep?.system || ''}|${e.type === 'INSERT' ? e.name : ''}`;
    const keys = new Set(ids.map((id) => key(doc.get(id))));
    const out = [];
    for (const e of doc.entities.values()) {
      if (e.space === editor.r.space && keys.has(key(e)) && editor.r.selectable(e.id)) out.push(e.id);
    }
    ctx.editor.running.usedSelection = false; // on garde la nouvelle sélection après la commande
    editor.setSelection(out);
    ctx.print(`${out.length} objet(s) semblable(s) sélectionné(s).`);
  }, { aliases: ['SELECTSIMILAR', 'SIM'], label: 'SELECTSIM', transaction: false });

  ed.register('XREF', (ctx) => {
    const btn = document.getElementById('xref-input');
    const missing = [...ctx.doc.blocks.values()].filter((b) => b.xref && !b.entities.length).map((b) => b.name);
    if (!missing.length) { ctx.print('Aucune référence externe à charger.'); return; }
    ctx.print(`Références à charger : ${missing.join(', ')}. Choisissez les fichiers correspondants.`);
    btn?.click();
  }, { aliases: ['XR', 'XATTACH'], label: 'XREF', transaction: false });

  // Isoler les calques des objets choisis (les autres sont désactivés), comme ISOLCALQUE d'AutoCAD.
  let isolated = null;
  ed.register('ISOLERCALQUE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection('Choisissez les objets dont les calques restent visibles');
    if (!ids.length) return;
    const keep = new Set(ids.map((id) => doc.get(id)?.layer).filter(Boolean));
    isolated = [...doc.layers.values()].map((l) => ({ name: l.name, on: l.on }));
    for (const l of doc.layers.values()) {
      if (!keep.has(l.name) && l.on) doc.setLayer(l.name, { on: false });
    }
    if (!keep.has(doc.currentLayer)) doc.currentLayer = [...keep][0];
    ctx.print(`${keep.size} calque(s) isolé(s) : ${[...keep].join(', ')}. ANNULISOLER pour revenir.`);
  }, { aliases: ['LAYISO', 'ISOCALQUE'], label: 'ISOLERCALQUE' });

  ed.register('ANNULISOLER', (ctx) => {
    if (!isolated) { ctx.print('Aucun isolement en cours.'); return; }
    for (const { name, on } of isolated) if (ctx.doc.layers.has(name) && ctx.doc.layers.get(name).on !== on) ctx.doc.setLayer(name, { on });
    isolated = null;
    ctx.print('Calques restaurés.');
  }, { aliases: ['LAYUNISO'], label: 'ANNULISOLER' });

  const layerByPick = (prop, value, label) => async (ctx) => {
    const { doc } = ctx;
    while (true) {
      const pick = await ctx.getEntity(`Choisissez un objet du calque à ${label}`, { allowNone: true });
      if (pick === null) return;
      const name = doc.get(pick.id).layer;
      if (name === doc.currentLayer && prop === 'frozen') { ctx.print('On ne peut pas geler le calque courant.'); continue; }
      doc.setLayer(name, { [prop]: value });
      ctx.print(`Calque « ${name} » ${label === 'désactiver' ? 'désactivé' : 'gelé'}.`);
    }
  };
  ed.register('CALQUEOFF', layerByPick('on', false, 'désactiver'), { aliases: ['LAYOFF'], label: 'CALQUEOFF' });
  ed.register('CALQUEGEL', layerByPick('frozen', true, 'geler'), { aliases: ['LAYFRZ'], label: 'CALQUEGEL' });
  ed.register('CALQUEON', (ctx) => {
    for (const l of ctx.doc.layers.values()) if (!l.on || l.frozen) ctx.doc.setLayer(l.name, { on: true, frozen: false });
    ctx.print('Tous les calques sont activés et libérés.');
  }, { aliases: ['LAYON', 'LAYTHW'], label: 'CALQUEON' });

  ed.register('UNITES', async (ctx) => {
    const names = { Millimètres: 4, Centimètres: 5, Mètres: 6, Pouces: 1, Pieds: 2, Aucune: 0 };
    const cur = Object.entries(names).find(([, v]) => v === (ctx.doc.header?.insunits ?? 0))?.[0] || 'Aucune';
    const k = await ctx.getKeyword('Unité du dessin', Object.keys(names), { default: cur });
    ctx.doc.setHeader({ insunits: names[k] });
    ctx.print(`Unité du dessin : ${k.toLowerCase()}.`);
  }, { aliases: ['UNITS', 'UN'], label: 'UNITES' });

  ed.register('ELLIPSE', async (ctx) => {
    const { doc } = ctx;
    // Ellipse complète de centre c, demi-grand axe vers `axis`, autre demi-axe de longueur b.
    const ellipse = (c, axis, b) => {
      let major = G.sub(axis, c);
      const a = Math.hypot(major[0], major[1]);
      if (!(a > 0) || !(b > 0)) return null;
      let ratio = b / a;
      if (ratio > 1) { major = G.mul(G.perp(G.norm(major)), b); ratio = a / b; }
      return newEntity(doc, { type: 'ELLIPSE', c: [c[0], c[1], 0], major: [major[0], major[1]], ratio, a0: 0, a1: G.TAU });
    };
    const line = (a, b) => newEntity(doc, { type: 'LINE', p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
    let c, axis;
    const r0 = await ctx.getPoint('Spécifiez une extrémité d’axe de l’ellipse', { keywords: ['Centre'] });
    if (r0 === 'Centre') {
      c = await ctx.getPoint('Spécifiez le centre de l’ellipse');
      axis = await ctx.getPoint('Spécifiez l’extrémité de l’axe', { base: c, preview: (p) => [line(c, p)] });
    } else {
      const b = await ctx.getPoint('Spécifiez l’autre extrémité de l’axe', { base: r0, preview: (p) => [line(r0, p)] });
      c = G.mid(r0, b);
      axis = b;
    }
    const d = await ctx.getDistance('Spécifiez la distance à l’autre axe', {
      base: c, preview: (p) => { const e = ellipse(c, axis, G.dist(c, p)); return e ? [e] : []; },
    });
    const e = ellipse(c, axis, d);
    if (!e) { ctx.print('Ellipse non valide.'); return; }
    doc.add(e);
  }, { aliases: ['EL'], label: 'ELLIPSE' });

  let polySides = 4, polyMode = 'Inscrit';
  ed.register('POLYGONE', async (ctx) => {
    const { doc } = ctx;
    const n = Math.round(await ctx.getDistance('Nombre de côtés', { default: polySides }));
    if (!(n >= 3 && n <= 1024)) { ctx.print('Entre 3 et 1024 côtés.'); return; }
    polySides = n;
    const poly = (pts) => newEntity(doc, { type: 'LWPOLYLINE', pts: pts.map((p) => [p[0], p[1]]), bulges: pts.map(() => 0), closed: true, z: 0, width: 0 });
    const r0 = await ctx.getPoint('Spécifiez le centre du polygone', { keywords: ['Côté'] });
    if (r0 === 'Côté') {
      const a = await ctx.getPoint('Spécifiez la première extrémité du côté');
      const fromEdge = (b) => {
        const pts = [a, b];
        let dir = G.sub(b, a);
        for (let k = 2; k < n; k++) {
          const a = G.TAU / n;
          dir = [dir[0] * Math.cos(a) - dir[1] * Math.sin(a), dir[0] * Math.sin(a) + dir[1] * Math.cos(a)];
          pts.push(G.add(pts[pts.length - 1], dir));
        }
        return poly(pts);
      };
      const b = await ctx.getPoint('Spécifiez la deuxième extrémité du côté', { base: a, preview: (p) => (G.dist(a, p) > 0 ? [fromEdge(p)] : []) });
      doc.add(fromEdge(b));
      return;
    }
    const c = r0;
    polyMode = await ctx.getKeyword('Inscrit dans le cercle ou Circonscrit au cercle', ['Inscrit', 'Circonscrit'], { default: polyMode });
    const build = (p) => {
      const R = G.dist(c, p);
      const a0 = G.angleOf(c, p);
      const pts = [];
      for (let k = 0; k < n; k++) {
        pts.push(polyMode === 'Inscrit' ? G.polar(c, a0 + (G.TAU * k) / n, R) : G.polar(c, a0 + Math.PI / n + (G.TAU * k) / n, R / Math.cos(Math.PI / n)));
      }
      return poly(pts);
    };
    const p = await ctx.getPoint('Spécifiez le rayon du cercle', { base: c, preview: (q) => (G.dist(c, q) > 0 ? [build(q)] : []) });
    if (!(G.dist(c, p) > 0)) { ctx.print('Rayon nul.'); return; }
    doc.add(build(p));
  }, { aliases: ['POL', 'POLYGON'], label: 'POLYGONE' });

  ed.register('SPLINE', async (ctx) => {
    const { doc } = ctx;
    const spline = (pts, closed) => {
      const fit = (closed ? [...pts, pts[0]] : pts).map((p) => [p[0], p[1], 0]);
      return newEntity(doc, { type: 'SPLINE', degree: 3, knots: [], ctrl: [], weights: null, fit, closed: false });
    };
    const pts = [await ctx.getPoint('Spécifiez le premier point')];
    while (true) {
      const base = pts[pts.length - 1];
      const r = await ctx.getPoint('Entrez le point suivant', {
        base, keywords: pts.length >= 3 ? ['Clore', 'annUler'] : ['annUler'], allowNone: true,
        preview: (p) => [spline([...pts, p], false)],
      });
      if (r === null) break;
      if (r === 'annUler') { if (pts.length > 1) pts.pop(); continue; }
      if (r === 'Clore') { doc.add(spline(pts, true)); return; }
      if (G.dist(base, r) < 1e-9) continue;
      pts.push(r);
    }
    if (pts.length < 2) return;
    doc.add(spline(pts, false));
  }, { aliases: ['SPL'], label: 'SPLINE' });

  ed.register('PURGER', (ctx) => {
    const r = purgeDocument(ctx.doc);
    const n = r.blocks.length + r.layers.length + r.ltypes.length;
    if (!n) { ctx.print('Rien à purger.'); return; }
    ctx.print(`Purgé : ${r.blocks.length} bloc(s), ${r.layers.length} calque(s), ${r.ltypes.length} type(s) de ligne inutilisés.`);
    const list = (names) => names.slice(0, 15).join(', ') + (names.length > 15 ? '…' : '');
    if (r.blocks.length) ctx.print(`Blocs : ${list(r.blocks)}`);
    if (r.layers.length) ctx.print(`Calques : ${list(r.layers)}`);
  }, { aliases: ['PU', 'PURGE'], label: 'PURGER' });

  let overkillTol = 1e-6;
  ed.register('SUPPRDOUBLONS', async (ctx) => {
    const { doc, editor } = ctx;
    let ids = await ctx.getSelection('Choisissez les objets (Entrée = tout le dessin)');
    if (!ids.length) ids = [...doc.entities.values()].filter((e) => e.space === editor.r.space && editor.r.layerVisible(e.layer)).map((e) => e.id);
    overkillTol = await ctx.getDistance('Tolérance', { default: overkillTol });
    const ents = ids.map((id) => doc.get(id)).filter((e) => e && !doc.layers.get(e.layer)?.locked);
    const t0 = performance.now();
    const r = findOverkill(ents, Math.max(overkillTol, 1e-12));
    for (const u of r.update) doc.update(u);
    for (const id of r.remove) doc.remove(id);
    editor.setSelection([]);
    ctx.print(`${r.remove.length} objet(s) en double ou superposé(s) supprimé(s), ${r.update.length} ligne(s) fusionnée(s) — ${ents.length} objets analysés en ${(performance.now() - t0).toFixed(0)} ms.`);
  }, { aliases: ['OVERKILL', 'DOUBLONS'], label: 'SUPPRDOUBLONS' });

  ed.register('CALQUE', (ctx) => {
    showLayerManager(ctx.doc, () => ctx.editor.ui.onState?.());
  }, { aliases: ['LA', 'LAYER', 'CALQUES'], label: 'CALQUE', transaction: false });

  ed.register('RECHERCHER', (ctx) => {
    showFind(ctx.doc, ctx.editor);
  }, { aliases: ['FIND', 'CHERCHER', 'REMPLACER'], label: 'RECHERCHER', transaction: false });

  ed.register('ATTENUER', async (ctx) => {
    const { doc, editor } = ctx;
    const k = await ctx.getKeyword('Atténuer', ['Xrefs', 'Calques', 'Désactiver'], { default: 'Xrefs' });
    if (k === 'Désactiver') { editor.r.setFade(null); ctx.print('Fond de plan normal.'); return; }
    let layers = null;
    if (k === 'Calques') {
      const ids = await ctx.getSelection('Choisissez des objets des calques à atténuer');
      layers = new Set(ids.map((id) => doc.get(id)?.layer).filter(Boolean));
      if (!layers.size) return;
    }
    const pct = await ctx.getDistance('Atténuation (%)', { default: 60 });
    editor.r.setFade({ on: true, layers, amount: Math.min(0.95, Math.max(0, pct / 100)) });
    ctx.print(layers ? `${layers.size} calque(s) atténué(s).` : 'Calques des références externes atténués.');
  }, { aliases: ['FADE', 'XREFFADE', 'ATT_FOND'], label: 'ATTENUER', transaction: false });

  ed.register('SELECTRAPIDE', (ctx) => {
    showQuickSelect(ctx.doc, ctx.editor);
  }, { aliases: ['QSELECT', 'SR'], label: 'SELECTRAPIDE', transaction: false });

  // DIVISER / MESURER : points (ou blocs) régulièrement espacés le long d'un objet.
  // Chemin approché par la polyligne de dessin de l'objet (exacte pour lignes et polylignes droites).
  const MEASURABLE = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLY3D', 'ELLIPSE', 'SPLINE']);
  function walker(e) {
    let pts = curvePoints(e)?.pts?.map((p) => [p[0], p[1]]) || [];
    if (e.type === 'LWPOLYLINE' && e.closed && pts.length > 1 && G.dist(pts[0], pts[pts.length - 1]) > 1e-12) pts = [...pts, pts[0]];
    const acc = [0];
    for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + G.dist(pts[i - 1], pts[i]));
    const length = acc[acc.length - 1] || 0;
    const at = (d) => {
      let i = 1;
      while (i < acc.length - 1 && acc[i] < d) i++;
      const seg = acc[i] - acc[i - 1];
      const t = seg > 0 ? (d - acc[i - 1]) / seg : 0;
      return { p: G.lerp(pts[i - 1], pts[i], Math.min(1, Math.max(0, t))), dir: G.angleOf(pts[i - 1], pts[i]) };
    };
    const closed = e.type === 'CIRCLE' || (e.type === 'ELLIPSE' && Math.abs(G.sweep(e.a0, e.a1) - G.TAU) < 1e-9) || !!e.closed;
    return { length, at, closed, start: pts[0], end: pts[pts.length - 1] };
  }

  async function markerOptions(ctx, prompt, extra) {
    const { doc } = ctx;
    let block = null, align = true;
    while (true) {
      const r = await ctx.getDistance(prompt, { keywords: ['Bloc'], ...extra });
      if (r !== 'Bloc') return { value: r, block, align };
      const name = (await ctx.getString('Nom du bloc à insérer')).trim();
      if (!doc.blocks.has(name)) { ctx.print(`Bloc « ${name} » introuvable.`); continue; }
      block = name;
      align = (await ctx.getKeyword('Aligner le bloc sur l’objet', ['Oui', 'Non'], { default: 'Oui' })) === 'Oui';
    }
  }

  function placeMarkers(ctx, e, positions, w, opts) {
    const { doc } = ctx;
    for (const d of positions) {
      const { p, dir } = w.at(d);
      if (opts.block) {
        const src = [...doc.entities.values()].find((x) => x.type === 'INSERT' && x.name === opts.block && x.mep);
        doc.add(newEntity(doc, {
          type: 'INSERT', name: opts.block, p: [p[0], p[1], 0], sx: 1, sy: 1, sz: 1, rot: opts.align ? dir : 0, attribs: [],
          // Bloc de terminal MEP : le nouveau terminal reprend les paramètres (système, débit…) d'un existant.
          ...(src ? { mep: structuredClone(src.mep), layer: src.layer } : {}),
        }));
      } else {
        doc.add(newEntity(doc, { type: 'POINT', p: [p[0], p[1], 0] }));
      }
    }
    ctx.print(`${positions.length} ${opts.block ? `bloc(s) « ${opts.block} »` : 'point(s)'} placé(s).`);
  }

  ed.register('DIVISER', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez l’objet à diviser');
    const e = doc.get(pick.id);
    if (!MEASURABLE.has(e.type)) { ctx.print('Objet non divisible (ligne, arc, cercle, polyligne, ellipse, spline).'); return; }
    const w = walker(e);
    const opts = await markerOptions(ctx, 'Nombre de segments', {});
    const n = Math.round(opts.value);
    if (!(n >= 2 && n <= 32767)) { ctx.print('Entre 2 et 32 767 segments.'); return; }
    const positions = [];
    for (let k = w.closed ? 0 : 1; k < n; k++) positions.push((w.length * k) / n);
    placeMarkers(ctx, e, positions, w, opts);
  }, { aliases: ['DIV', 'DIVIDE'], label: 'DIVISER' });

  ed.register('MESURER', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez l’objet à mesurer (côté de départ)');
    const e = doc.get(pick.id);
    if (!MEASURABLE.has(e.type)) { ctx.print('Objet non mesurable (ligne, arc, cercle, polyligne, ellipse, spline).'); return; }
    const w = walker(e);
    const opts = await markerOptions(ctx, 'Longueur des segments', {});
    const step = opts.value;
    if (!(step > 0) || w.length / step > 32767) { ctx.print('Longueur non valide.'); return; }
    // Départ à l'extrémité la plus proche du point de sélection (comme AutoCAD).
    const fromEnd = !w.closed && G.dist(pick.p, w.end) < G.dist(pick.p, w.start);
    const positions = [];
    for (let d = step; d < w.length - 1e-9; d += step) positions.push(fromEnd ? w.length - d : d);
    placeMarkers(ctx, e, positions, w, opts);
  }, { aliases: ['MES', 'MEASURE'], label: 'MESURER' });

  // MODIFLONG : allonge ou raccourcit une ligne ou un arc du côté désigné (Delta, Pourcentage, Total).
  const len = { mode: 'Delta', delta: 100, pct: 100, total: 1000 };
  ed.register('MODIFLONG', async (ctx) => {
    const { doc } = ctx;
    const status = () => (len.mode === 'Delta' ? `delta ${fmt(len.delta)}` : len.mode === 'Pourcentage' ? `${fmt(len.pct)} %` : `total ${fmt(len.total)}`);
    while (true) {
      const pick = await ctx.getEntity(`Choisissez l’objet près de l’extrémité à modifier (${status()})`, { keywords: ['Delta', 'Pourcentage', 'Total'], allowNone: true });
      if (pick === null) return;
      if (pick === 'Delta') { len.mode = 'Delta'; len.delta = await ctx.getDistance('Longueur à ajouter (négative pour raccourcir)', { default: len.delta }); continue; }
      if (pick === 'Pourcentage') { len.mode = 'Pourcentage'; len.pct = await ctx.getDistance('Pourcentage de la longueur', { default: len.pct }); continue; }
      if (pick === 'Total') { len.mode = 'Total'; len.total = await ctx.getDistance('Longueur totale', { default: len.total }); continue; }
      const e = doc.get(pick.id);
      const r = e && lengthenEntity(e, pick.p, len);
      if (!r) { ctx.print('Modifiable : lignes et arcs (longueur finale positive).'); continue; }
      doc.update(r);
    }
  }, { aliases: ['LEN', 'LENGTHEN'], label: 'MODIFLONG' });

  // COUPUREPOINT : scinde un objet en deux au point désigné.
  ed.register('COUPUREPOINT', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez l’objet à scinder');
    const e = doc.get(pick.id);
    if (!PATH_TYPES.has(e.type)) { ctx.print('Coupure possible sur les lignes, arcs, cercles et polylignes.'); return; }
    const p = await ctx.getPoint('Point de coupure', { default: pick.p });
    const r = breakEntity(e, p, p);
    if (!r) { ctx.print('Coupure impossible à cet endroit.'); return; }
    doc.remove(e.id);
    for (const x of r) doc.add(x);
    ctx.print(r.length === 2 ? 'Objet scindé en deux.' : 'Coupure effectuée.');
  }, { aliases: ['BREAKATPOINT', 'BRP'], label: 'COUPUREPOINT' });

  // ECHLTP : échelle globale des types de ligne (LTSCALE), enregistrée dans le DXF.
  ed.register('ECHLTP', async (ctx) => {
    const v = await ctx.getDistance('Facteur d’échelle global des types de ligne', { default: ctx.doc.header?.ltscale || 1 });
    if (!(v > 0)) { ctx.print('Facteur non valide.'); return; }
    ctx.doc.setHeader({ ltscale: v }); // annulable ; la vue est reconstruite
    ctx.print(`Échelle des types de ligne : ${fmt(v)}.`);
  }, { aliases: ['LTSCALE', 'LTS'], label: 'ECHLTP' });

  // ANNEAU : polyligne fermée épaisse (deux demi-cercles), pleine si le diamètre intérieur est nul.
  const donut = { din: 0, dout: 10 };
  ed.register('ANNEAU', async (ctx) => {
    const { doc } = ctx;
    donut.din = await ctx.getDistance('Diamètre intérieur', { default: donut.din });
    donut.dout = await ctx.getDistance('Diamètre extérieur', { default: donut.dout });
    if (!(donut.dout > donut.din) || donut.din < 0) { ctx.print('Le diamètre extérieur doit dépasser le diamètre intérieur.'); return; }
    const rc = (donut.din + donut.dout) / 4, width = (donut.dout - donut.din) / 2;
    const mk = (c) => newEntity(doc, { type: 'LWPOLYLINE', pts: [[c[0] - rc, c[1]], [c[0] + rc, c[1]]], bulges: [1, 1], closed: true, z: 0, width });
    while (true) {
      const c = await ctx.getPoint('Centre de l’anneau', { allowNone: true, preview: (q) => [mk(q)] });
      if (c === null) return;
      doc.add(mk(c));
    }
  }, { aliases: ['DONUT', 'DO'], label: 'ANNEAU' });

  // NUAGEREV : nuage de révision (rectangle ou objet fermé) — polyligne fermée d'arcs bombés vers l'extérieur.
  const cloud = { arc: 0 };
  ed.register('NUAGEREV', async (ctx) => {
    const { doc } = ctx;
    const scale = doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    if (!cloud.arc) cloud.arc = 15 * scale; // 15 mm sur le papier
    while (true) {
      const k = await ctx.getKeyword(`Nuage de révision (longueur d’arc ${fmt(cloud.arc)})`, ['Rectangulaire', 'Objet', 'Longueur'], { default: 'Rectangulaire' });
      if (k === 'Longueur') { cloud.arc = await ctx.getDistance('Longueur d’arc', { default: cloud.arc }); continue; }
      if (k === 'Objet') {
        const pick = await ctx.getEntity('Choisissez une polyligne fermée ou un cercle');
        const e = doc.get(pick.id);
        const outline = e && (e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed)) ? curvePoints(e)?.pts : null;
        if (!outline) { ctx.print('Il faut une polyligne fermée ou un cercle.'); continue; }
        const c = revisionCloud(outline, cloud.arc);
        if (!c) { ctx.print('Objet trop petit pour cette longueur d’arc.'); return; }
        const { c: _c, r: _r, a0: _a0, a1: _a1, ...rest } = e; // un cercle devient polyligne
        doc.update({ ...rest, ...c, type: 'LWPOLYLINE', z: 0, width: 0 });
        return;
      }
      const c1 = await ctx.getPoint('Premier coin');
      const rect = (q) => [[c1[0], c1[1]], [q[0], c1[1]], [q[0], q[1]], [c1[0], q[1]]];
      const mk = (q) => { const c = revisionCloud(rect(q), cloud.arc); return c ? [newEntity(doc, { type: 'LWPOLYLINE', ...c, z: 0, width: 0 })] : []; };
      const c2 = await ctx.getPoint('Coin opposé', { preview: mk });
      const ent = mk(c2)[0];
      if (!ent) { ctx.print('Rectangle trop petit pour cette longueur d’arc.'); return; }
      doc.add(ent);
      return;
    }
  }, { aliases: ['REVCLOUD', 'NUAGE'], label: 'NUAGEREV' });

  // ALIGNER : déplace (1 paire de points), puis fait pivoter et éventuellement met à l'échelle (2 paires).
  ed.register('ALIGNER', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const s1 = await ctx.getPoint('Premier point source');
    const d1 = await ctx.getPoint('Premier point de destination', { base: s1 });
    const s2 = await ctx.getPoint('Deuxième point source (Entrée : déplacement seul)', { allowNone: true });
    let m = G.translation(d1[0] - s1[0], d1[1] - s1[1]);
    if (s2) {
      const d2 = await ctx.getPoint('Deuxième point de destination', { base: d1 });
      const a = G.angleOf(d1, d2) - G.angleOf(s1, s2);
      m = G.compose(G.rotation(a, d1[0], d1[1]), m);
      const k = G.dist(s1, s2) > 1e-12 ? G.dist(d1, d2) / G.dist(s1, s2) : 1;
      const scale = await ctx.getKeyword('Mettre à l’échelle les objets selon les points d’alignement', ['Oui', 'Non'], { default: 'Non' });
      if (scale === 'Oui' && Math.abs(k - 1) > 1e-12) m = G.compose(G.scaling(k, k, d1[0], d1[1]), m);
    }
    for (const id of ids) doc.update(transformEntity(doc.get(id), m));
    ctx.print(`${ids.length} objet(s) aligné(s).`);
  }, { aliases: ['AL', 'ALIGN'], label: 'ALIGNER' });

  // MODIFTEXTE : texte, texte multiligne ou valeurs d'attributs d'un bloc.
  ed.register('MODIFTEXTE', async (ctx) => {
    const { doc } = ctx;
    while (true) {
      const pick = await ctx.getEntity('Choisissez un texte ou un bloc avec attributs', { allowNone: true });
      if (pick === null) return;
      const e = doc.get(pick.id);
      if (e?.type === 'TEXT' || e?.type === 'MTEXT' || e?.type === 'ATTDEF') {
        const t = await ctx.getString('Nouveau texte', { default: e.text ?? '' });
        // Texte modifié à la main : le champ devient un texte ordinaire (inchangé : champ gardé).
        if (t !== e.text) { const x = { ...e, text: t }; delete x.field; doc.update(x); }
      } else if (e?.type === 'INSERT' && e.attribs?.length) {
        const attribs = [];
        for (const a of e.attribs) {
          const t = await ctx.getString(a.tag || 'Valeur', { default: a.text ?? '' });
          const x = { ...a, text: t };
          if (t !== a.text) delete x.field;
          attribs.push(x);
        }
        doc.update({ ...e, attribs });
      } else ctx.print('Ce n’est ni un texte ni un bloc avec attributs.');
    }
  }, { aliases: ['DDEDIT', 'ED', 'TEXTEDIT', 'ATTEDIT', 'EATTEDIT'], label: 'MODIFTEXTE' });

  // DROITE / DEMIDROITE (XLINE / RAY) : droites de construction par un point et des points de passage.
  const xlineCommand = (ray) => async (ctx) => {
    const { doc } = ctx;
    const p = await ctx.getPoint(ray ? 'Point de départ' : 'Point de la droite');
    const mk = (q) => {
      const d = G.sub(q, p), L = Math.hypot(d[0], d[1]);
      return L > 1e-12 ? newEntity(doc, { type: 'XLINE', p: [p[0], p[1], 0], dir: [d[0] / L, d[1] / L], ray }) : null;
    };
    while (true) {
      const q = await ctx.getPoint('Point de passage', { base: p, allowNone: true, preview: (x) => [mk(x)].filter(Boolean) });
      if (q === null) return;
      const e = mk(q);
      if (e) doc.add(e);
    }
  };
  ed.register('DROITE', xlineCommand(false), { aliases: ['XLINE', 'XL'], label: 'DROITE' });
  ed.register('DEMIDROITE', xlineCommand(true), { aliases: ['RAY'], label: 'DEMIDROITE' });

  // VPCALQUE : geler / libérer des calques dans une fenêtre de présentation.
  ed.register('VPCALQUE', async (ctx) => {
    const { doc } = ctx;
    if ((doc.currentSpace || 'model') === 'model') { ctx.print('Commande de présentation : passez dans une présentation.'); return; }
    const pick = await ctx.getEntity('Choisissez le cadre de la fenêtre');
    const v = doc.get(pick.id);
    if (v?.type !== 'VIEWPORT') { ctx.print('Ce n’est pas une fenêtre.'); return; }
    const k = await ctx.getKeyword(`Calques gelés : ${(v.frozen || []).join(', ') || 'aucun'}`, ['Geler', 'Liberer', 'Tout'], { default: 'Geler' });
    if (k === 'Tout') { const { frozen, ...rest } = v; doc.update(rest); ctx.print('Tous les calques libérés dans la fenêtre.'); return; }
    const names = (await ctx.getString('Calques (séparés par des virgules ; * en fin de nom = préfixe)')).split(',').map((x) => x.trim()).filter(Boolean);
    const match = (n) => names.some((p) => (p.endsWith('*') ? n.toUpperCase().startsWith(p.slice(0, -1).toUpperCase()) : n.toUpperCase() === p.toUpperCase()));
    const layers = [...doc.layers.keys()].filter(match);
    if (!layers.length) { ctx.print('Aucun calque ne correspond.'); return; }
    const cur = new Set(v.frozen || []);
    for (const n of layers) { if (k === 'Geler') cur.add(n); else cur.delete(n); }
    const { frozen, ...rest } = v;
    doc.update(cur.size ? { ...rest, frozen: [...cur] } : rest);
    ctx.print(`${layers.length} calque(s) ${k === 'Geler' ? 'gelé(s)' : 'libéré(s)'} dans la fenêtre.`);
  }, { aliases: ['VPLAYER', 'VPFREEZE', 'GELFENETRE'], label: 'VPCALQUE' });

  // GROUPE / DEGROUPER : objets sélectionnés ensemble (conservés en DXF).
  ed.register('GROUPE', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection('Objets du groupe');
    if (ids.length < 2) { ctx.print('Un groupe contient au moins deux objets.'); return; }
    const used = new Set([...doc.entities.values()].map((e) => e.group).filter(Boolean));
    let k = 1;
    while (used.has(`GROUPE${k}`)) k++;
    let name = (await ctx.getString('Nom du groupe', { default: `GROUPE${k}` })).trim().toUpperCase() || `GROUPE${k}`;
    if (used.has(name)) { ctx.print(`Le groupe ${name} existe déjà : les objets y sont ajoutés.`); }
    for (const id of ids) { const e = doc.get(id); if (e) doc.update({ ...e, group: name }); }
    ctx.print(`Groupe ${name} : ${ids.length} objet(s).`);
  }, { aliases: ['G', 'GROUP', 'GROUPER'], label: 'GROUPE' });

  ed.register('DEGROUPER', async (ctx) => {
    const { doc } = ctx;
    const pick = await ctx.getEntity('Choisissez un objet du groupe');
    const name = doc.get(pick.id)?.group;
    if (!name) { ctx.print('Cet objet n’appartient à aucun groupe.'); return; }
    let n = 0;
    for (const e of [...doc.entities.values()]) if (e.group === name) { const { group, ...rest } = e; doc.update(rest); n++; }
    ctx.print(`Groupe ${name} dissous (${n} objet(s)).`);
  }, { aliases: ['UNGROUP', 'DEGROUPE'], label: 'DEGROUPER' });

  ed.register('ID', async (ctx) => {
    const p = await ctx.getPoint('Désignez un point');
    ctx.print(`X = ${fmt(p[0])}   Y = ${fmt(p[1])}   Z = ${fmt(p[2] || 0)}`);
  }, { aliases: ['IDPOINT'], label: 'ID', transaction: false });

  ed.register('REGEN', (ctx) => {
    ctx.editor.r.dropModelView?.();
    ctx.editor.r.rebuildAll(false);
    ctx.print('Dessin régénéré.');
  }, { aliases: ['RE', 'REGENALL', 'REGENTOUT'], label: 'REGEN', transaction: false });

  // RESEAU : copies en lignes et colonnes, autour d'un centre ou le long d'une trajectoire. Réseau non
  // associatif (copies indépendantes), comme AutoCAD avec ARRAYASSOCIATIVITY = 0.
  const arr = { kind: 'Rectangulaire', cols: 4, rows: 3, dx: 0, dy: 0, n: 6, fill: 360, rotate: 'Oui', pathN: 5, align: 'Oui' };
  ed.register('RESEAU', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection();
    if (!ids.length) return;
    const ents = ids.map((id) => doc.get(id)).filter(Boolean);
    // Emprise de la sélection (géométrie affichée), pour les entraxes et le centre par défaut.
    let b = G.emptyBox();
    for (const id of ids) {
      const eb = ctx.editor.r.cache?.get(id)?.box;
      if (eb && G.boxValid(eb)) { G.growBox(b, eb.minX, eb.minY); G.growBox(b, eb.maxX, eb.maxY); }
    }
    if (!G.boxValid(b)) b = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const count = (v) => Math.max(1, Math.round(Number(v) || 1));
    arr.kind = await ctx.getKeyword('Type de réseau', ['Rectangulaire', 'Polaire', 'Trajectoire'], { default: arr.kind });
    const mats = [];
    if (arr.kind === 'Rectangulaire') {
      arr.cols = count(await ctx.getDistance('Nombre de colonnes', { default: arr.cols }));
      arr.rows = count(await ctx.getDistance('Nombre de lignes', { default: arr.rows }));
      // Entraxes par défaut : taille de la sélection + 50 %.
      const w = (b.maxX - b.minX) || 1, h = (b.maxY - b.minY) || 1;
      if (arr.cols > 1) arr.dx = await ctx.getDistance('Entraxe des colonnes', { default: arr.dx || w * 1.5 });
      if (arr.rows > 1) arr.dy = await ctx.getDistance('Entraxe des lignes', { default: arr.dy || h * 1.5 });
      for (let r = 0; r < arr.rows; r++) for (let c = 0; c < arr.cols; c++) if (r || c) mats.push(G.translation(c * arr.dx, r * arr.dy));
    } else if (arr.kind === 'Polaire') {
      const center = await ctx.getPoint('Centre du réseau');
      arr.n = count(await ctx.getDistance('Nombre d’éléments (sélection comprise)', { default: arr.n }));
      arr.fill = await ctx.getDistance('Angle à remplir (+ anti-horaire, − horaire)', { default: arr.fill });
      arr.rotate = await ctx.getKeyword('Faire pivoter les éléments', ['Oui', 'Non'], { default: arr.rotate });
      const full = Math.abs(Math.abs(arr.fill) - 360) < 1e-9;
      const step = (arr.fill * Math.PI) / 180 / (full ? arr.n : Math.max(1, arr.n - 1));
      const ref = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
      for (let i = 1; i < arr.n; i++) {
        const a = step * i;
        if (arr.rotate === 'Oui') mats.push(G.rotation(a, center[0], center[1]));
        else {
          const q = G.apply(G.rotation(a, center[0], center[1]), ref[0], ref[1]);
          mats.push(G.translation(q[0] - ref[0], q[1] - ref[1]));
        }
      }
    } else {
      const pick = await ctx.getEntity('Choisissez la trajectoire');
      const path = doc.get(pick.id);
      const w = path && walker(path);
      if (!w || !(w.length > 0)) { ctx.print('Trajectoire non valide (ligne, arc, cercle, polyligne, spline…).'); return; }
      const base = await ctx.getPoint('Point de base des objets', { default: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] });
      arr.pathN = count(await ctx.getDistance('Nombre d’éléments le long de la trajectoire', { default: arr.pathN }));
      arr.align = await ctx.getKeyword('Aligner les éléments sur la trajectoire', ['Oui', 'Non'], { default: arr.align });
      const closed = G.dist(w.at(0).p, w.at(w.length).p) < 1e-9;
      const gap = w.length / (closed ? arr.pathN : Math.max(1, arr.pathN - 1));
      const start = w.at(0);
      for (let i = 0; i < arr.pathN; i++) {
        const { p: q, dir } = w.at(Math.min(w.length, i * gap));
        let m = G.translation(q[0] - base[0], q[1] - base[1]);
        if (arr.align === 'Oui') m = G.compose(G.rotation(dir - start.dir, q[0], q[1]), m);
        mats.push(m);
      }
    }
    let n = 0;
    for (const m of mats) for (const e of ents) { doc.add(stripId(transformEntity(e, m))); n++; }
    ctx.print(`Réseau ${arr.kind.toLowerCase()} : ${mats.length} copie(s), ${n} objet(s) créé(s).`);
  }, { aliases: ['AR', 'ARRAY', 'ARRAYRECT', 'ARRAYPOLAR', 'ARRAYPATH', 'RES'], label: 'RESEAU' });

  // --- PRÉSENTATIONS ----------------------------------------------------------------------
  const unitMmOfDoc = (doc) => ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 })[doc.header?.insunits] ?? 1;
  // Emprise de l'espace objet (points caractéristiques des objets) ; null s'il est vide.
  const modelBox = (doc) => {
    const b = G.emptyBox();
    for (const e of doc.entities.values()) {
      if (e.space !== 'model') continue;
      for (const k of ['p1', 'p2', 'c', 'p']) if (e[k]) G.growBox(b, e[k][0], e[k][1]);
      for (const q of e.pts || []) G.growBox(b, q[0], q[1]);
    }
    return G.boxValid(b) ? b : null;
  };
  ed.register('PRESENTATION', async (ctx) => {
    const { doc } = ctx;
    const n = doc.spaces.filter((s) => s.id !== 'model').length + 1;
    let label = (await ctx.getString('Nom de la présentation', { default: `Présentation${n}` })).trim() || `Présentation${n}`;
    if (doc.spaces.some((s) => s.label.toLowerCase() === label.toLowerCase())) label = `${label} (${n})`;
    const fmt0 = await ctx.getKeyword('Format', Object.keys(allFormats()), { default: 'A3' });
    const plot = makePlot(fmt0, true);
    let k = 1;
    while (doc.spaces.some((s) => s.id === `*Paper_Space_CV${k}`)) k++;
    const id = `*Paper_Space_CV${k}`;
    doc.setSpaces([...doc.spaces, { id, label, order: doc.spaces.length, plot }]);
    // Fenêtre automatique, comme AutoCAD : 10 mm du bord de la feuille, l'espace objet entier à la plus
    // grande échelle normalisée qui tient.
    const box = modelBox(doc);
    let msg = '';
    if (box) {
      const w = plot.w - 20, h = plot.h - 20;
      const unitMm = unitMmOfDoc(doc);
      const scale = fittingScale(box.maxX - box.minX, box.maxY - box.minY, w, h, unitMm);
      doc.add(newEntity(doc, {
        type: 'VIEWPORT', space: id, c: [plot.w / 2, plot.h / 2, 0], w, h, vc: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2],
        vh: (h * scale) / unitMm, twist: 0, target: [0, 0], off: false,
      }));
      msg = ` avec une fenêtre au 1:${scale}`;
    }
    ctx.editor.ui.onSpaces?.(id);
    ctx.print(`Présentation « ${label} » (${fmt0} paysage) créée${msg}. Mise en page : clic droit sur l’onglet ou MISEENPAGE ; autres fenêtres : FMULT.`);
  }, { aliases: ['LAYOUT', 'PRES'], label: 'PRESENTATION' });

  // Réglages du dessin (onglet Format) : la boîte est fournie par l'interface (ui.openSettings).
  for (const [name, tab, aliases] of [
    ['REGLAGES', 'unites', ['DESSINREGLAGES', 'PARAMETRES']], ['REGUNITES', 'unites', ['DDUNITS']], ['FORMATS', 'formats', []],
    ['TYPELIGNE', 'lignes', ['LINETYPE', 'LT', 'TYPESLIGNE']], ['EPAISSEUR', 'lignes', ['LWEIGHT', 'LW', 'EPAISSEURS']],
    ['STYLEPOINT', 'points', ['DDPTYPE', 'PTYPE']], ['STYLETEXTE', 'textes', ['STYLE', 'ST']], ['STYLECOTE', 'cotes', ['DIMSTYLE', 'D', 'DST']],
    ['PREFERENCES', 'preferences', ['OPTIONS', 'OP']],
  ]) {
    ed.register(name, (ctx) => {
      if (ctx.editor.ui.openSettings) ctx.editor.ui.openSettings(tab);
      else ctx.print('Réglages du dessin indisponibles ici.');
    }, { aliases, label: name, transaction: false });
  }

  // Affichage des épaisseurs dans les présentations (enregistré dans le dessin, comme LWDISPLAY).
  ed.register('LWDISPLAY', (ctx) => {
    const on = !ctx.editor.r.lwDisplay;
    ctx.editor.r.setLwDisplay(on);
    ctx.doc.header.lwdisplay = on;
    ctx.editor.ui.onState?.();
    ctx.print(`<Affichage des épaisseurs ${on ? 'activé' : 'désactivé'}>${on && (ctx.doc.currentSpace || 'model') === 'model' ? ' (visible dans les présentations)' : ''}`);
  }, { aliases: ['AFFEPAISSEUR', 'LWD'], label: 'LWDISPLAY', transaction: false });

  ed.register('MISEENPAGE', (ctx) => {
    const id = ctx.doc.currentSpace || 'model';
    if (id === 'model') { ctx.print('Mise en page d’une présentation : passez d’abord dans une présentation (onglets sous le dessin).'); return; }
    if (ctx.editor.ui.pageSetup) ctx.editor.ui.pageSetup(id);
  }, { aliases: ['PAGESETUP', 'MISEPAGE'], label: 'MISEENPAGE', transaction: false });

  // Fenêtre de présentation (comme MVIEW / FMULT) : cadre, puis échelle ou ajustement.
  let lastVpScale = 100;
  ed.register('FMULT', async (ctx) => {
    const { doc } = ctx;
    const space = doc.currentSpace || 'model';
    if (space === 'model') { ctx.print('Passez dans une présentation (onglets sous le dessin, ou PRESENTATION) pour créer une fenêtre.'); return; }
    const rect = (a, b) => [newEntity(doc, { type: 'LWPOLYLINE', pts: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], bulges: [0, 0, 0, 0], closed: true, z: 0 })];
    // Fenêtre rectangulaire, polygonale ou faite d'un objet fermé (comme MVIEW).
    let c1 = await ctx.getPoint('Premier coin de la fenêtre', { keywords: ['Polygonale', 'Objet'] });
    let c2, clip = null, srcId = null;
    if (c1 === 'Polygonale' || c1 === 'Objet') {
      const { askPolygon, askClosed } = await import('./xclip.js');
      if (c1 === 'Polygonale') clip = await askPolygon(ctx, doc.currentLayer);
      else { const r = await askClosed(ctx); if (r) { clip = r.pts; srcId = r.id; } }
      if (!clip) return;
      const bb = G.emptyBox();
      for (const q of clip) G.growBox(bb, q[0], q[1]);
      c1 = [bb.minX, bb.minY]; c2 = [bb.maxX, bb.maxY];
    } else c2 = await ctx.getPoint('Coin opposé', { preview: (p) => rect(c1, p) });
    const w = Math.abs(c2[0] - c1[0]), h = Math.abs(c2[1] - c1[1]);
    if (!(w > 0 && h > 0)) { ctx.print('Fenêtre vide.'); return; }
    // Emprise de l'espace objet (points caractéristiques des objets).
    const b = G.emptyBox();
    for (const e of doc.entities.values()) {
      if (e.space !== 'model') continue;
      for (const k of ['p1', 'p2', 'c', 'p']) if (e[k]) G.growBox(b, e[k][0], e[k][1]);
      for (const q of e.pts || []) G.growBox(b, q[0], q[1]);
    }
    const box = G.boxValid(b) ? b : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    const vc = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
    const r = await ctx.getDistance('Échelle 1:N (ou Ajuster)', { keywords: ['Ajuster'], default: lastVpScale });
    let vh;
    if (r === 'Ajuster') vh = Math.max(box.maxY - box.minY, ((box.maxX - box.minX) * h) / w) * 1.05 || h;
    else {
      lastVpScale = r;
      // Papier en mm ; l'espace objet dans son unité (mm par défaut).
      const unitMm = ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 })[doc.header?.insunits] ?? 1;
      vh = (h * r) / unitMm;
    }
    doc.add(newEntity(doc, {
      type: 'VIEWPORT', c: [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2, 0], w, h, vc, vh, twist: 0, target: [0, 0], off: false,
      ...(clip ? { clip } : {}),
    }));
    if (srcId != null) doc.remove(srcId); // l'objet devient le cadre de la fenêtre
    ctx.print(`Fenêtre créée (1:${Math.round(vh / h)}). Échelle et centre de vue modifiables dans Propriétés.`);
  }, { aliases: ['MVIEW', 'MV', 'FENETRE'], label: 'FMULT' });

  // --- OUTILS ------------------------------------------------------------------------

  // Dessine un objet semblable à l'objet choisi (mêmes calque, couleur, type de ligne, épaisseur ; même
  // réseau, section et altitude pour les réseaux MEP ; même bloc et mêmes données pour un symbole).
  ed.register('AJOUTSELECT', async (ctx) => {
    const { doc } = ctx;
    let id = [...ed.selection][0];
    if (id == null) {
      const pick = await ctx.getEntity('Choisissez l’objet à reproduire', { allowNone: true });
      if (!pick) return;
      id = pick.id;
    }
    const e = doc.get(id);
    ed.setSelection([]);
    if (!e) return;
    // Module qui ne fournit que le libellé (draw absent) : objet reproduit comme un bloc ci-dessous.
    for (const h of ed.addSelected || []) if (h.draw && h.label(e)) { await h.draw(ctx, e); return; }
    if (e.type === 'INSERT') {
      // Même bloc, mêmes échelle, données et attributs ; posé point par point (R : rotation).
      let rot = e.rot || 0, n = 0;
      const at = (q) => {
        const c = stripId(e);
        const turned = rot === (e.rot || 0) ? c : transformEntity(c, G.rotation(rot - (e.rot || 0), e.p[0], e.p[1]));
        return transformEntity(turned, G.translation(q[0] - e.p[0], q[1] - e.p[1]));
      };
      for (;;) {
        const q = await ctx.getPoint(`Bloc « ${e.name} » : point d’insertion`, { keywords: ['Rotation'], allowNone: true, preview: (q) => [at(q)] });
        if (q == null) break;
        if (q === 'Rotation') { rot = await ctx.getAngle('Rotation (degrés)'); continue; }
        doc.add(at(q));
        n++;
      }
      if (n) ctx.print(`${n} bloc(s) « ${e.name} » posé(s).`);
      return;
    }
    const base = ADD_SELECTED_BASE[e.type];
    if (!base) { ctx.print('Ce type d’objet ne peut pas être reproduit : utilisez COPIER.'); return; }
    // Réglages courants pris de l'objet le temps de la commande (comme AutoCAD), puis rétablis.
    const h = doc.header || (doc.header = {});
    const saved = { layer: doc.currentLayer, cecolor: h.cecolor, celtype: h.celtype, celweight: h.celweight };
    doc.currentLayer = e.layer || '0';
    h.cecolor = e.color ?? 256;
    h.celtype = e.ltype || 'ByLayer';
    h.celweight = e.lweight ?? -1;
    try {
      await ed.commands.get(base[1]).fn(ctx);
    } finally {
      doc.currentLayer = saved.layer;
      Object.assign(h, { cecolor: saved.cecolor, celtype: saved.celtype, celweight: saved.celweight });
    }
  }, { aliases: ['ADDSELECTED', 'SEMBLABLE'], label: 'AJOUTSELECT' });

  ed.register('U', (ctx) => {
    const name = ctx.doc.undo();
    ctx.print(name ? `Annulé : ${name}` : 'Rien à annuler.');
  }, { aliases: ['ANNULER', 'UNDO'], label: 'ANNULER', transaction: false });

  ed.register('REDO', (ctx) => {
    const name = ctx.doc.redo();
    ctx.print(name ? `Rétabli : ${name}` : 'Rien à rétablir.');
  }, { aliases: ['RETABLIR'], label: 'RETABLIR', transaction: false });

  ed.register('ZOOM', async (ctx) => {
    const r = await ctx.getPoint('Spécifiez le coin de la fenêtre', { keywords: ['Étendu'], default: 'Étendu' });
    if (r === 'Étendu') { ed.r.fit(); return; }
    const b = await ctx.getPoint('Spécifiez le coin opposé', { base: r });
    ed.r.fit({ minX: Math.min(r[0], b[0]), maxX: Math.max(r[0], b[0]), minY: Math.min(r[1], b[1]), maxY: Math.max(r[1], b[1]) });
  }, { aliases: ['Z'], label: 'ZOOM', transaction: false });

  ed.register('DISTANCE', async (ctx) => {
    const a = await ctx.getPoint('Spécifiez le premier point');
    const b = await ctx.getPoint('Spécifiez le deuxième point', { base: a });
    const d = G.dist(a, b);
    ctx.print(`Distance = ${fmt(d)}, angle = ${fmt(deg(G.normAngle(G.angleOf(a, b))))}°, ΔX = ${fmt(b[0] - a[0])}, ΔY = ${fmt(b[1] - a[1])}`);
  }, { aliases: ['DI', 'DIST'], label: 'DISTANCE', transaction: false });

  ed.register('LISTE', async (ctx) => {
    const ids = await ctx.getSelection();
    for (const id of ids.slice(0, 20)) ctx.print(describe(ctx.doc.get(id)));
    if (ids.length > 20) ctx.print(`… et ${ids.length - 20} autre(s).`);
  }, { aliases: ['LI', 'LIST'], label: 'LISTE', transaction: false });
}

export function describe(e) {
  const head = `${e.type} — calque « ${e.layer} »`;
  switch (e.type) {
    case 'LINE': return `${head}, longueur ${fmt(G.dist(e.p1, e.p2))}, de (${fmt(e.p1[0])}, ${fmt(e.p1[1])}) à (${fmt(e.p2[0])}, ${fmt(e.p2[1])})`;
    case 'CIRCLE': return `${head}, centre (${fmt(e.c[0])}, ${fmt(e.c[1])}), rayon ${fmt(e.r)}`;
    case 'ARC': return `${head}, centre (${fmt(e.c[0])}, ${fmt(e.c[1])}), rayon ${fmt(e.r)}, de ${fmt(deg(e.a0))}° à ${fmt(deg(e.a1))}°`;
    case 'LWPOLYLINE': {
      const len = pathOf(e).curves.reduce((s, c) => s + (c.k === 'seg' ? G.dist(c.a, c.b) : Math.abs(c.sw) * c.r), 0);
      return `${head}, ${e.pts.length} sommets, ${e.closed ? 'fermée' : 'ouverte'}, longueur ${fmt(len)}`;
    }
    case 'INSERT': return `${head}, bloc « ${e.name} » en (${fmt(e.p[0])}, ${fmt(e.p[1])}), rotation ${fmt(deg(e.rot))}°`;
    case 'TEXT': case 'MTEXT': return `${head}, « ${e.text.slice(0, 60)} », hauteur ${fmt(e.h)}`;
    default: return head;
  }
}

// DECOMPOS : une entité composée → ses composants (null si non décomposable).
export function explode(doc, e) {
  if (e.type === 'LWPOLYLINE' && e.mep) return mepToEntities(e).map((x) => { delete x.space; return x; });
  if (e.type === 'LWPOLYLINE') {
    const { curves, z } = pathOf(e);
    return curves.map((c) => {
      const base = { layer: e.layer, color: e.color, rgb: e.rgb, ltype: e.ltype };
      if (c.k === 'seg') return { ...base, type: 'LINE', p1: [c.a[0], c.a[1], z], p2: [c.b[0], c.b[1], z] };
      const a0 = c.sw >= 0 ? c.s : c.s + c.sw;
      return { ...base, type: 'ARC', c: [c.c[0], c.c[1], z], r: c.r, a0: G.normAngle(a0), a1: G.normAngle(a0 + Math.abs(c.sw)) };
    });
  }
  if (e.type === 'INSERT' || e.type === 'BLOCKREF') {
    const block = e.type === 'INSERT' ? blockForInsert(doc, e) : doc.blocks.get(e.name);
    if (!block) return null;
    const out = [];
    const cells = e.type === 'INSERT' ? (e.cols || 1) * (e.rows || 1) : 1;
    for (let k = 0; k < cells; k++) {
      const m = e.type === 'INSERT' ? insertMatrix(e, block.base, k % (e.cols || 1), Math.floor(k / (e.cols || 1))) : e.m;
      for (const child of block.entities) {
        const c = transformEntity(child, m);
        delete c.id;
        if (c.layer === '0') c.layer = e.layer;
        if (c.color === 0) { c.color = e.color; if (e.rgb != null) c.rgb = e.rgb; }
        out.push(c);
      }
    }
    if (e.type === 'INSERT') for (const a of e.attribs || []) if (!a.invisible && !a.dynHidden) { const t = stripId(a); delete t.dynHidden; out.push(t); }
    return out;
  }
  return null;
}
