// SPDX-License-Identifier: GPL-3.0-or-later
// Rendu d'une zone d'un fond dans un canevas : page PDF (pdf.js) ou image. La zone est donnée en coordonnées
// de page { s0, t0, s1, t1 } (0 → 1, t vers le haut) ; le canevas mesure w × h pixels.
// Les réglages d'affichage (estompage, contraste, monochrome, fond sombre, blanc transparent) sont appliqués
// à l'écran par le nuanceur (layer3d.js) et au tracé par applyLook ci-dessous (mêmes formules).
import { pdfPage } from './sources.js';

export const MAX_SIDE = 8192;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Configuration des calques du PDF (calques masqués par nom).
async function ocgConfig(src, off) {
  if (!off?.length || !src.ocg?.length) return null;
  const cfg = await src.pdf.getOptionalContentConfig();
  const hidden = new Set(off);
  for (const g of src.ocg) cfg.setVisibility(g.id, !hidden.has(g.name));
  return cfg;
}

// opts : { page, ocgOff, signal (AbortSignal : annule le rendu en cours) }. Renvoie le canevas, ou null si annulé.
export async function renderRegion(src, region, w, h, opts = {}) {
  const { s0, t0, s1, t1 } = region;
  const out = canvas(Math.min(w, MAX_SIDE), Math.min(h, MAX_SIDE));
  const ctx = out.getContext('2d');
  if (src.kind === 'image') {
    const W = src.width, H = src.height;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.bitmap, s0 * W, (1 - t1) * H, (s1 - s0) * W, (t1 - t0) * H, 0, 0, out.width, out.height);
    return out;
  }
  const { page } = await pdfPage(src, opts.page || 1);
  if (opts.signal?.aborted) return null;
  const base = page.getViewport({ scale: 1 });
  const scale = out.width / Math.max((s1 - s0) * base.width, 1e-9);
  const viewport = page.getViewport({ scale });
  const x0 = s0 * viewport.width, y0 = (1 - t1) * viewport.height;
  const params = {
    canvasContext: ctx,
    viewport,
    transform: [1, 0, 0, 1, -x0, -y0],
    background: 'rgba(0,0,0,0)',
    annotationMode: 0, // annotations (liens, formulaires) ignorées, comme AutoCAD
  };
  const cfg = await ocgConfig(src, opts.ocgOff);
  if (cfg) params.optionalContentConfigPromise = Promise.resolve(cfg);
  const task = page.render(params);
  const abort = () => task.cancel();
  opts.signal?.addEventListener('abort', abort);
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException' || opts.signal?.aborted) return null;
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', abort);
  }
  return out;
}

// Réglages d'affichage d'un fond : { fade 0–1, contrast 0–1, mono, adjust (fond sombre), whiteOff, bg:[r,g,b] 0–1 }.
export function lookOf(e, { dark = false, bg = 0xffffff } = {}) {
  return {
    fade: Math.min(0.8, Math.max(0, (e.fade || 0) / 100)),
    contrast: Math.min(1, Math.max(0, (e.contrast ?? 100) / 100)),
    mono: !!e.mono,
    adjust: e.adjust !== false && dark,
    whiteOff: e.whiteOff !== false,
    bg: [((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255],
  };
}

// Même calcul que le nuanceur, sur un pixel (r, g, b, a de 0 à 1) → [r, g, b, a].
export function lookPixel(r, g, b, a, L) {
  const mn = Math.min(r, g, b);
  if (L.whiteOff) a *= 1 - smoothstep(0.92, 0.985, mn);
  r = 0.5 + (r - 0.5) * L.contrast; g = 0.5 + (g - 0.5) * L.contrast; b = 0.5 + (b - 0.5) * L.contrast;
  if (L.mono) { const y = 0.299 * r + 0.587 * g + 0.114 * b; r = g = b = y; }
  if (L.adjust) {
    const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2, d = 1 - 2 * l;
    r = clamp01(r + d); g = clamp01(g + d); b = clamp01(b + d);
  }
  r += (L.bg[0] - r) * L.fade; g += (L.bg[1] - g) * L.fade; b += (L.bg[2] - b) * L.fade;
  return [r, g, b, a];
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Applique les réglages à un canevas (tracé).
export function applyLook(cv, L) {
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b, a] = lookPixel(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255, L);
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export const NUANCEUR = /* glsl */ `
  uniform sampler2D map;
  uniform vec4 region;
  uniform vec4 hole;
  uniform float fade;
  uniform float contrast;
  uniform float mono;
  uniform float adjust;
  uniform float whiteOff;
  uniform vec3 bg;
  uniform float opacity;
  varying vec2 vST;
  void main() {
    // Texture de base : rien sous la texture de détail (zone « hole »), sinon son flou ferait un halo.
    if (vST.x > hole.x && vST.y > hole.y && vST.x < hole.z && vST.y < hole.w) discard;
    vec2 uv = (vST - region.xy) / (region.zw - region.xy);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    vec4 c = texture2D(map, uv);
    if (c.a < 0.004) discard;
    vec3 col = c.rgb;
    float a = c.a;
    float mn = min(col.r, min(col.g, col.b));
    a *= 1.0 - whiteOff * smoothstep(0.92, 0.985, mn);
    if (a < 0.004) discard;
    col = vec3(0.5) + (col - vec3(0.5)) * contrast;
    float y = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(y), mono);
    float l = (max(col.r, max(col.g, col.b)) + min(col.r, min(col.g, col.b))) * 0.5;
    col = mix(col, clamp(col + (1.0 - 2.0 * l), 0.0, 1.0), adjust);
    col = mix(col, bg, fade);
    gl_FragColor = vec4(col, a * opacity);
  }
`;
