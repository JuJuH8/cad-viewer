// SPDX-License-Identifier: GPL-3.0-or-later
// Géométrie vectorielle d'une page PDF (opérateurs de dessin lus par pdf.js) : tracés avec leur style et leur
// calque, et textes. Sert à l'accrochage sur les fonds PDF et à PDFIMPORT (conversion en objets).
//
// Coordonnées en page (s, t) : 0 → 1 de gauche à droite et de bas en haut (rotation de la page comprise).
// Un tracé : { subs: [{ pts:[[s,t]…], kinds:['L'|'C'…], ctrl:[[c1,c2]|null…], closed }], stroke, fill, width (mm),
//              dash, ocg (nom du calque PDF ou null), fillRule }
//   kinds[i] décrit le morceau qui va du point i au point i + 1 ; ctrl[i] : points de contrôle d'une courbe de Bézier.
import { pdfjs } from './pdfjs.js';
import { pdfPage } from './sources.js';

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const rgbOf = (a) => {
  if (a == null) return 0;
  if (typeof a === 'string') return parseInt(a.replace('#', ''), 16) || 0;
  const r = a[0] ?? 0, g = a[1] ?? 0, b = a[2] ?? 0;
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
};

// Extraction complète d'une page (mise en cache sur la page). Renvoie { paths, texts, ocgNames }.
export async function extractPage(src, pageNo = 1) {
  const rec = await pdfPage(src, pageNo);
  if (rec.vectors) return rec.vectors;
  rec.vectors = (async () => {
    const lib = await pdfjs();
    const O = lib.OPS;
    const page = rec.page;
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    // Point utilisateur → page (s, t).
    const names = new Map((src.ocg || []).map((g) => [g.id, g.name]));
    const ol = await page.getOperatorList({ annotationMode: 0 });
    const paths = [];
    let ctm = vp.transform.slice();
    const stack = [];
    let gs = { stroke: 0, fill: 0, width: 1, dash: null };
    const ocgStack = [];
    let cur = []; // sous-tracés en cours de construction
    let sub = null;
    // Textes : lus dans les opérateurs (ils gardent ainsi leur calque PDF).
    const texts = [];
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
    let ts = { size: 0, hscale: 1, char: 0, word: 0, leading: 0, rise: 0 };
    const translate = (m, tx, ty) => [m[0], m[1], m[2], m[3], m[0] * tx + m[2] * ty + m[4], m[1] * tx + m[3] * ty + m[5]];
    const show = (items) => {
      let str = '', adv = 0;
      for (const g of items || []) {
        if (typeof g === 'number') { adv -= (g / 1000) * ts.size * ts.hscale; continue; }
        if (!g) continue;
        if (g.unicode) str += g.unicode;
        adv += ((g.width || 0) / 1000 * ts.size + ts.char + (g.isSpace ? ts.word : 0)) * ts.hscale;
      }
      if (str.trim()) {
        // Repère du texte dans la page : origine (ligne de base), axe x, hauteur (taille de police).
        const m = mul(ctm, mul(tm, [ts.size * ts.hscale, 0, 0, ts.size, 0, ts.rise]));
        const o = [m[4], m[5]];
        const hx = m[2], hy = m[3];
        texts.push({
          text: str.replace(/\s+$/, ''), p: [o[0] / W, 1 - o[1] / H], h: (Math.hypot(hx, hy) * 25.4) / 72,
          rot: Math.atan2(-m[1], m[0]), w: (adv * Math.hypot(ctm[0] * tm[0] + ctm[2] * tm[1], ctm[1] * tm[0] + ctm[3] * tm[1]) * 25.4) / 72,
          ocg: ocgStack.length ? ocgStack[ocgStack.length - 1] : null,
        });
      }
      tm = translate(tm, adv / Math.max(ts.hscale, 1e-9) * ts.hscale, 0);
    };
    const toPage = (x, y) => {
      const px = ctm[0] * x + ctm[2] * y + ctm[4], py = ctm[1] * x + ctm[3] * y + ctm[5];
      return [px / W, 1 - py / H];
    };
    const scaleOf = () => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])); // px CSS par unité utilisateur
    const flushPath = (stroke, fill, closeAll, rule) => {
      if (sub) cur.push(sub);
      sub = null;
      if (!cur.length) return;
      if (closeAll) for (const s of cur) s.closed = true;
      const ocg = ocgStack.length ? ocgStack[ocgStack.length - 1] : null;
      paths.push({
        subs: cur.filter((s) => s.pts.length > 1 || s.rect),
        stroke: stroke ? gs.stroke : null,
        fill: fill ? gs.fill : null,
        width: (gs.width * scaleOf() * 25.4) / 72,
        dash: gs.dash,
        ocg,
        fillRule: rule,
      });
      cur = [];
    };
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], args = ol.argsArray[i];
      switch (fn) {
        case O.save: stack.push({ ctm: ctm.slice(), gs: { ...gs } }); break;
        case O.restore: { const s = stack.pop(); if (s) { ctm = s.ctm; gs = s.gs; } break; }
        case O.transform: ctm = mul(ctm, args); break;
        case O.paintFormXObjectBegin: stack.push({ ctm: ctm.slice(), gs: { ...gs } }); if (args?.[0]) ctm = mul(ctm, args[0]); break;
        case O.paintFormXObjectEnd: { const s = stack.pop(); if (s) { ctm = s.ctm; gs = s.gs; } break; }
        case O.setStrokeRGBColor: gs.stroke = rgbOf(args); break;
        case O.setFillRGBColor: gs.fill = rgbOf(args); break;
        case O.setStrokeGray: gs.stroke = rgbOf([args[0] * 255, args[0] * 255, args[0] * 255]); break;
        case O.setFillGray: gs.fill = rgbOf([args[0] * 255, args[0] * 255, args[0] * 255]); break;
        case O.setLineWidth: gs.width = args[0] || 0; break;
        case O.setDash: gs.dash = args?.[0]?.length ? args[0].map((d) => (d * scaleOf() * 25.4) / 72) : null; break;
        case O.beginMarkedContentProps:
          ocgStack.push(args?.[0] === 'OC' && args[1]?.id ? names.get(args[1].id) ?? null : ocgStack[ocgStack.length - 1] ?? null);
          break;
        case O.beginMarkedContent: ocgStack.push(ocgStack[ocgStack.length - 1] ?? null); break;
        case O.endMarkedContent: ocgStack.pop(); break;
        case O.constructPath: {
          const [ops, coords] = args;
          let k = 0;
          for (const op of ops) {
            if (op === O.moveTo) {
              if (sub) cur.push(sub);
              sub = { pts: [toPage(coords[k], coords[k + 1])], kinds: [], ctrl: [], closed: false, last: [coords[k], coords[k + 1]] };
              k += 2;
            } else if (op === O.lineTo) {
              if (!sub) sub = { pts: [toPage(coords[k], coords[k + 1])], kinds: [], ctrl: [], closed: false };
              else { sub.pts.push(toPage(coords[k], coords[k + 1])); sub.kinds.push('L'); sub.ctrl.push(null); }
              sub.last = [coords[k], coords[k + 1]];
              k += 2;
            } else if (op === O.curveTo || op === O.curveTo2 || op === O.curveTo3) {
              const lastPt = sub?.last || [coords[k], coords[k + 1]];
              let c1, c2, p;
              if (op === O.curveTo) { c1 = [coords[k], coords[k + 1]]; c2 = [coords[k + 2], coords[k + 3]]; p = [coords[k + 4], coords[k + 5]]; k += 6; }
              else if (op === O.curveTo2) { c1 = lastPt; c2 = [coords[k], coords[k + 1]]; p = [coords[k + 2], coords[k + 3]]; k += 4; }
              else { c1 = [coords[k], coords[k + 1]]; p = [coords[k + 2], coords[k + 3]]; c2 = p; k += 4; }
              if (!sub) sub = { pts: [toPage(...lastPt)], kinds: [], ctrl: [], closed: false };
              sub.pts.push(toPage(p[0], p[1]));
              sub.kinds.push('C');
              sub.ctrl.push([toPage(c1[0], c1[1]), toPage(c2[0], c2[1])]);
              sub.last = p;
            } else if (op === O.closePath) {
              if (sub) { sub.closed = true; cur.push(sub); sub = { pts: [sub.pts[0]], kinds: [], ctrl: [], closed: false, last: sub.last }; }
            } else if (op === O.rectangle) {
              if (sub) cur.push(sub);
              const [x, y, w, h] = [coords[k], coords[k + 1], coords[k + 2], coords[k + 3]];
              k += 4;
              cur.push({ pts: [toPage(x, y), toPage(x + w, y), toPage(x + w, y + h), toPage(x, y + h)], kinds: ['L', 'L', 'L', 'L'], ctrl: [null, null, null, null], closed: true });
              sub = null;
            }
          }
          break;
        }
        case O.stroke: flushPath(true, false, false); break;
        case O.closeStroke: flushPath(true, false, true); break;
        case O.fill: flushPath(false, true, true, 'nonzero'); break;
        case O.eoFill: flushPath(false, true, true, 'evenodd'); break;
        case O.fillStroke: flushPath(true, true, true, 'nonzero'); break;
        case O.eoFillStroke: flushPath(true, true, true, 'evenodd'); break;
        case O.closeFillStroke: flushPath(true, true, true, 'nonzero'); break;
        case O.closeEOFillStroke: flushPath(true, true, true, 'evenodd'); break;
        case O.endPath: cur = []; sub = null; break; // chemin de découpe : ignoré
        case O.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case O.setFont: ts.size = args?.[1] || 0; break;
        case O.setTextMatrix: tm = args.slice(0, 6); tlm = tm.slice(); break;
        case O.moveText: tlm = translate(tlm, args[0], args[1]); tm = tlm.slice(); break;
        case O.setLeadingMoveText: ts.leading = -args[1]; tlm = translate(tlm, args[0], args[1]); tm = tlm.slice(); break;
        case O.nextLine: tlm = translate(tlm, 0, -ts.leading); tm = tlm.slice(); break;
        case O.setLeading: ts.leading = args[0]; break;
        case O.setHScale: ts.hscale = (args[0] ?? 100) / 100; break;
        case O.setCharSpacing: ts.char = args[0] || 0; break;
        case O.setWordSpacing: ts.word = args[0] || 0; break;
        case O.setTextRise: ts.rise = args[0] || 0; break;
        case O.showText: case O.showSpacedText: show(args?.[0]); break;
        case O.nextLineShowText: tlm = translate(tlm, 0, -ts.leading); tm = tlm.slice(); show(args?.[0]); break;
        case O.nextLineSetSpacingShowText: ts.word = args[0]; ts.char = args[1]; tlm = translate(tlm, 0, -ts.leading); tm = tlm.slice(); show(args?.[2]); break;
        default: break;
      }
    }
    // Un sous-tracé « vide » laissé par closePath (point seul) est retiré ; les segments des sous-tracés fermés
    // gardent la fermeture comme un dernier segment droit.
    for (const p of paths) {
      p.subs = p.subs.filter((s) => s.pts.length > 1);
      for (const s of p.subs) delete s.last;
    }
    // Repli : textes lus par pdf.js (sans calque) si les opérateurs n'en donnent aucun.
    const allTexts = texts.length ? texts : await pageTexts(page, vp, names);
    return { paths: paths.filter((p) => p.subs.length), texts: allTexts, size: [W, H] };
  })();
  return rec.vectors;
}

// Textes de la page : { text, p:[s,t] (point de base), h (hauteur en mm du papier), rot (radians), w (largeur en
// mm), ocg }.
async function pageTexts(page, vp, names) {
  let content;
  try { content = await page.getTextContent({ includeMarkedContent: true }); } catch { return []; }
  const out = [];
  const ocgStack = [];
  const W = vp.width, H = vp.height;
  for (const it of content.items) {
    if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') {
      ocgStack.push(it.tag === 'OC' && it.id ? names.get(it.id) ?? null : ocgStack[ocgStack.length - 1] ?? null);
      continue;
    }
    if (it.type === 'endMarkedContent') { ocgStack.pop(); continue; }
    if (!it.str || !it.str.trim()) continue;
    const m = mul(vp.transform, it.transform);
    // Repère du texte dans la page : origine (x, y) vers le bas ; axe des x = (m0, m1), hauteur = |(m2, m3)|.
    const h = Math.hypot(m[2], m[3]);
    const rot = Math.atan2(-m[1], m[0]);
    out.push({
      text: it.str,
      p: [m[4] / W, 1 - m[5] / H],
      h: (h * 25.4) / 72,
      rot,
      w: ((it.width || 0) * Math.hypot(vp.transform[0], vp.transform[1]) * 25.4) / 72,
      ocg: ocgStack.length ? ocgStack[ocgStack.length - 1] : null,
      font: it.fontName,
    });
  }
  return out;
}

// Morceaux droits d'une page pour l'accrochage, indexés en grille : { lines: Float64Array [s0,t0,s1,t1…]
// (vrais segments), curves: Float64Array (courbes découpées), grid }.
export async function snapGeometry(src, pageNo = 1) {
  const rec = await pdfPage(src, pageNo);
  if (rec.snap) return rec.snap;
  rec.snap = (async () => {
    const { paths, size } = await extractPage(src, pageNo);
    const lines = [], curves = [], lineOcg = [], curveOcg = [];
    const ocgNames = [null];
    const ocgIndex = new Map([[null, 0]]);
    const aspect = size[1] / size[0];
    for (const p of paths) {
      let oi = ocgIndex.get(p.ocg);
      if (oi === undefined) { oi = ocgNames.length; ocgNames.push(p.ocg); ocgIndex.set(p.ocg, oi); }
      for (const s of p.subs) {
        const n = s.pts.length;
        const count = s.closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
          const a = s.pts[i], b = s.pts[(i + 1) % n];
          if (i < n - 1 && s.kinds[i] === 'C') {
            const before = curves.length;
            flattenCubic(a, s.ctrl[i][0], s.ctrl[i][1], b, curves, aspect);
            for (let k = before; k < curves.length; k += 4) curveOcg.push(oi);
          } else if (a[0] !== b[0] || a[1] !== b[1]) { lines.push(a[0], a[1], b[0], b[1]); lineOcg.push(oi); }
        }
      }
    }
    const L = Float64Array.from(lines), C = Float64Array.from(curves);
    return { lines: L, curves: C, lineOcg: Uint16Array.from(lineOcg), curveOcg: Uint16Array.from(curveOcg), ocgNames, grid: buildGrid(L, C) };
  })();
  return rec.snap;
}

// Courbe de Bézier découpée en morceaux droits (assez fins pour l'accrochage « proche » et l'intersection).
function flattenCubic(a, c1, c2, b, out, aspect) {
  const len = Math.hypot(c1[0] - a[0], (c1[1] - a[1]) * aspect) + Math.hypot(c2[0] - c1[0], (c2[1] - c1[1]) * aspect) + Math.hypot(b[0] - c2[0], (b[1] - c2[1]) * aspect);
  const n = Math.max(4, Math.min(64, Math.ceil(len * 400)));
  let px = a[0], py = a[1];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0];
    const y = u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1];
    out.push(px, py, x, y);
    px = x; py = y;
  }
}

const CELLS = 128;
function buildGrid(lines, curves) {
  const cells = new Map();
  const add = (arr, tag) => {
    for (let i = 0; i < arr.length; i += 4) {
      const x0 = Math.min(arr[i], arr[i + 2]), x1 = Math.max(arr[i], arr[i + 2]);
      const y0 = Math.min(arr[i + 1], arr[i + 3]), y1 = Math.max(arr[i + 1], arr[i + 3]);
      const cx0 = clampCell(x0), cx1 = clampCell(x1), cy0 = clampCell(y0), cy1 = clampCell(y1);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) continue; // segment immense (cadre) : testé à part
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = cy * CELLS + cx;
          let c = cells.get(k);
          if (!c) cells.set(k, (c = []));
          c.push(tag + i);
        }
      }
    }
  };
  add(lines, 0);
  add(curves, 1e9);
  // Segments très longs, toujours examinés.
  const big = [];
  for (const [arr, tag] of [[lines, 0], [curves, 1e9]]) {
    for (let i = 0; i < arr.length; i += 4) {
      const w = Math.abs(arr[i + 2] - arr[i]) * CELLS, h = Math.abs(arr[i + 3] - arr[i + 1]) * CELLS;
      if ((Math.floor(w) + 2) * (Math.floor(h) + 2) > 400) big.push(tag + i);
    }
  }
  return { cells, big };
}
const clampCell = (v) => Math.max(0, Math.min(CELLS - 1, Math.floor(v * CELLS)));

// Segments (en page) dans une boîte (s, t) : { lines: [s0,t0,s1,t1…], curves: […] } ; hidden : calques du PDF
// masqués (leurs traits sont ignorés).
export function segmentsIn(snap, box, hidden = null) {
  const lines = [], curves = [];
  const seen = new Set();
  const take = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const arr = id >= 1e9 ? snap.curves : snap.lines, i = id >= 1e9 ? id - 1e9 : id;
    if (hidden?.size && hidden.has(snap.ocgNames[(id >= 1e9 ? snap.curveOcg : snap.lineOcg)[i / 4]])) return;
    const x0 = Math.min(arr[i], arr[i + 2]), x1 = Math.max(arr[i], arr[i + 2]);
    const y0 = Math.min(arr[i + 1], arr[i + 3]), y1 = Math.max(arr[i + 1], arr[i + 3]);
    if (x1 < box.minX || x0 > box.maxX || y1 < box.minY || y0 > box.maxY) return;
    (id >= 1e9 ? curves : lines).push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
  };
  const cx0 = clampCell(box.minX), cx1 = clampCell(box.maxX), cy0 = clampCell(box.minY), cy1 = clampCell(box.maxY);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const c = snap.grid.cells.get(cy * CELLS + cx);
      if (c) for (const id of c) take(id);
    }
  }
  for (const id of snap.grid.big) take(id);
  return { lines, curves };
}
