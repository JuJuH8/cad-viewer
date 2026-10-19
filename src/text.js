// SPDX-License-Identifier: GPL-3.0-or-later
// Textes : décodage des codes de formatage AutoCAD (TEXT / MTEXT),
// mise en page (alignement, retour à la ligne) et dessin sur le calque 2D.

// Rapport hauteur des majuscules / taille de police : la hauteur d'un texte
// AutoCAD correspond à la hauteur des majuscules, pas à la taille « em ».
export const CAP_RATIO = 0.716;
const FONT_FAMILY = 'Arial, Helvetica, sans-serif';

// Contexte de mesure créé au premier besoin : le module reste importable dans un Web Worker (lecture des DWG).
let measureCtx = null;

function emWidth(str) {
  if (!measureCtx) {
    measureCtx = (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)).getContext('2d');
    measureCtx.font = `100px ${FONT_FAMILY}`;
  }
  return measureCtx.measureText(str).width / 100;
}

// Largeur affichée d'un texte d'une ligne de hauteur h (police de l'application).
export const textWidth = (str, h) => (emWidth(str) * h) / CAP_RATIO;

function decodeSpecials(s) {
  return s
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n))
    .replace(/%%%/g, '%')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+\d[0-9A-Fa-f]{4}/g, '');
}

export function plainText(s) {
  return decodeSpecials(typeof s === 'string' ? s : '');
}

// MTEXT → lignes de texte brut.
export function parseMText(s) {
  if (typeof s !== 'string' || !s) return [''];
  let t = s
    .replace(/\\\\/g, '\u0001')
    .replace(/\\\{/g, '\u0002')
    .replace(/\\\}/g, '\u0003');
  t = decodeSpecials(t)
    .replace(/\\[PN]/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, '$1/$2')
    .replace(/\\[fFHWQTACcpa][^;]*;/g, '')
    .replace(/\\[LlOoKkX]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '\\')
    .replace(/\u0002/g, '{')
    .replace(/\u0003/g, '}');
  return t.split('\n');
}

function wrap(lines, maxWidth, em, measure = emWidth) {
  if (!(maxWidth > 0)) return lines;
  const out = [];
  for (const line of lines) {
    const words = line.split(' ');
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (cur && measure(cand) * em > maxWidth * 1.02) {
        out.push(cur);
        cur = w;
      } else {
        cur = cand;
      }
    }
    out.push(cur);
  }
  return out;
}

// Construit un élément texte prêt à dessiner.
// pos : position monde ; rot : angle monde ; h : hauteur monde.
// measure (facultatif) : largeur d'une ligne pour une hauteur 1 (police SHX) ; sinon police de l'application.
export function makeText({ pos, rot, h, widthFactor = 1, lines, align, vAnchor, lineSpacing = 1, wrapWidth, color, layer, measure = null }) {
  const em = h / CAP_RATIO;
  const unit = measure ? (s) => measure(s) * CAP_RATIO : emWidth; // largeur en « em » de la police de l'appli
  const wrapped = wrap(lines, wrapWidth, em * widthFactor, unit);
  const pitch = h * (5 / 3) * (lineSpacing || 1);
  const n = wrapped.length;
  const total = h + (n - 1) * pitch;
  let first;
  switch (vAnchor) {
    case 'top': first = h; break;
    case 'middle': first = n > 1 ? h - total / 2 : h / 2; break;
    case 'bottom': first = n > 1 ? h - total : -0.3 * h; break;
    case 'mtext-bottom': first = h - total; break;
    default: first = 0;
  }
  const width = Math.max(...wrapped.map((l) => unit(l))) * em * widthFactor;
  return {
    x: pos[0], y: pos[1], z: pos[2] || 0,
    rot, h, em, widthFactor, align, lines: wrapped, first, pitch,
    w: width, total,
    radius: Math.hypot(width, total + h) + h,
    color, layer,
  };
}

// Dessine les textes visibles sur le contexte 2D superposé à la vue WebGL.
// Le point (px, py) est-il dans le cadre du texte ? (tolérance en unités du dessin)
export function textHit(t, px, py, tol = 0) {
  const dx = px - t.x, dy = py - t.y;
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  const lx = dx * c + dy * s;
  const down = -(-dx * s + dy * c);
  const x0 = t.align === 'left' ? 0 : t.align === 'right' ? -t.w : -t.w / 2;
  const n = t.lines.length;
  return lx >= x0 - tol && lx <= x0 + t.w + tol
    && down >= t.first - t.h - tol && down <= t.first + (n - 1) * t.pitch + 0.3 * t.h + tol;
}

export function drawTexts(ctx, texts, view, resolveCss, isLayerVisible) {
  const { width, height } = ctx.canvas;
  let lastFont = '', lastFill = '';
  for (const t of texts) {
    if (t.shx || !isLayerVisible(t.layer)) continue; // police SHX : dessinée en traits (géométrie)
    const fontPx = t.em * view.scale;
    if (fontPx < 1.5) continue;
    const [sx, sy] = view.toScreen(t.x, t.y);
    const r = t.radius * view.scale;
    if (sx + r < 0 || sy + r < 0 || sx - r > width || sy - r > height) continue;
    const font = `${Math.round(fontPx * 2) / 2}px ${FONT_FAMILY}`;
    if (font !== lastFont) { ctx.font = font; lastFont = font; }
    const fill = resolveCss(t.color);
    if (fill !== lastFill) { ctx.fillStyle = fill; lastFill = fill; }
    ctx.textAlign = t.align;
    ctx.setTransform(1, 0, 0, 1, sx, sy);
    const rot = (t.rot || 0) + (view.rot || 0); // view.rot : torsion d'une fenêtre de présentation
    if (rot) ctx.rotate(-rot);
    if (t.widthFactor !== 1) ctx.scale(t.widthFactor, 1);
    // Champ : fond gris (affiché, jamais tracé), comme AutoCAD.
    if (t.field) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = 'rgba(128,128,128,0.35)';
      for (let i = 0; i < t.lines.length; i++) {
        const w = ctx.measureText(t.lines[i]).width;
        const x = t.align === 'right' ? -w : t.align === 'center' || t.align === 'middle' ? -w / 2 : 0;
        ctx.fillRect(x, (t.first + i * t.pitch - t.em * 0.8) * view.scale, w, t.em * 1.05 * view.scale);
      }
      ctx.fillStyle = prev;
    }
    for (let i = 0; i < t.lines.length; i++) {
      ctx.fillText(t.lines[i], 0, (t.first + i * t.pitch) * view.scale);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
