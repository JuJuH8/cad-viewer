// SPDX-License-Identifier: GPL-3.0-or-later
// Polices SHX (polices à traits d'AutoCAD) : lecture des fichiers et dessin des caractères, écrits pour l'appli
// d'après la description publique des codes de forme (vecteurs longueur / direction, codes spéciaux 0 à 14) ;
// structure binaire des fichiers compilés relevée par observation, pour l'interopérabilité (aucune police fournie).
//
// Fichiers « shapes 1.0 » (anciennes polices, codes sur un octet), « unifont 1.0 » (Unicode, codes sur deux octets)
// et « bigfont 1.0 » (polices asiatiques). Une police : { kind, name, above (hauteur des majuscules en unités de la
// police), below, glyphs: Map(code → octets), unicode }.
// Un caractère : { strokes: [[[x, y]…]…] (traits, unités de la police), adv: [dx, dy] (avance du point courant) }.

const DIRS = [[1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [-0.5, 1], [-1, 1], [-1, 0.5],
  [-1, 0], [-1, -0.5], [-1, -1], [-0.5, -1], [0, -1], [0.5, -1], [1, -1], [1, -0.5]];
const OCT = Math.PI / 4;

const i8 = (b) => (b > 127 ? b - 256 : b);

export function parseShx(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = u8.indexOf(0x1a);
  if (p < 0 || p > 64) throw new Error('fichier SHX non reconnu');
  const head = new TextDecoder('latin1').decode(u8.subarray(0, p));
  p++;
  const m = head.match(/AutoCAD-86 (shapes|unifont|bigfont) 1\.[01]/);
  if (!m) throw new Error('fichier SHX non reconnu (police compilée attendue)');
  const kind = m[1];
  const font = { kind, name: '', above: 1, below: 0, modes: 0, glyphs: new Map(), cache: new Map(), unicode: kind === 'unifont' };
  const cstr = (bytes) => {
    const z = bytes.indexOf(0);
    return z < 0 ? bytes.length : z + 1; // longueur du nom (zéro compris)
  };
  if (kind === 'unifont') {
    const n = dv.getUint32(p, true);
    const deflen = dv.getUint16(p + 4, true);
    p += 6;
    const info = u8.subarray(p, p + deflen);
    const nl = cstr(info);
    font.name = new TextDecoder('latin1').decode(info.subarray(0, nl - 1));
    font.above = info[nl] || 1;
    font.below = info[nl + 1] || 0;
    font.modes = info[nl + 2] || 0;
    p += deflen;
    for (let k = 1; k < n && p + 4 <= u8.length; k++) {
      const code = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
      p += 4;
      const def = u8.subarray(p, p + len);
      p += len;
      font.glyphs.set(code, def.subarray(cstr(def)));
    }
  } else if (kind === 'shapes') {
    const count = dv.getUint16(p + 4, true);
    p += 6;
    const index = [];
    for (let k = 0; k < count; k++) index.push([dv.getUint16(p + 4 * k, true), dv.getUint16(p + 4 * k + 2, true)]);
    p += 4 * count;
    for (const [num, len] of index) {
      const def = u8.subarray(p, p + len);
      p += len;
      const spec = def.subarray(cstr(def));
      if (num === 0) { // informations de la police : au-dessus, au-dessous, modes
        font.name = new TextDecoder('latin1').decode(def.subarray(0, cstr(def) - 1));
        font.above = spec[0] || 1;
        font.below = spec[1] || 0;
        font.modes = spec[2] || 0;
      } else font.glyphs.set(num, spec);
    }
  } else {
    // Big font : nombre de formes, plages de codes d'échappement, index (code, longueur, position).
    const count = dv.getUint16(p + 2, true);
    const ranges = dv.getUint16(p + 4, true);
    p += 6 + ranges * 4;
    for (let k = 0; k < count && p + 8 <= u8.length; k++) {
      const code = dv.getUint16(p, true), len = dv.getUint16(p + 2, true), off = dv.getUint32(p + 4, true);
      p += 8;
      if (!len || off + len > u8.length) continue;
      const def = u8.subarray(off, off + len);
      const spec = def.subarray(cstr(def));
      if (code === 0) { font.above = spec[0] || 1; font.below = spec[1] || 0; font.modes = spec[2] || 0; } else font.glyphs.set(code, spec);
    }
  }
  return font;
}

// Taille (en octets) de la commande qui commence en i (pour sauter une commande « verticale », code 14).
function commandSize(b, i, wide) {
  const c = b[i];
  if (c > 0x0f) return 1;
  switch (c) {
    case 0: case 1: case 2: case 5: case 6: case 14: return 1;
    case 3: case 4: return 2;
    case 7: return wide ? 3 : 2;
    case 8: return 3;
    case 9: { let k = i + 1; while (k + 1 < b.length && (b[k] || b[k + 1])) k += 2; return k + 2 - i; }
    case 10: return 3;
    case 11: return 6;
    case 12: return 4;
    case 13: { let k = i + 1; while (k + 1 < b.length && (b[k] || b[k + 1])) k += 3; return k + 2 - i; }
    default: return 1;
  }
}

// Caractère (mis en cache) : traits et avance, en unités de la police (texte horizontal).
export function glyph(font, code, depth = 0) {
  const cached = font.cache.get(code);
  if (cached !== undefined) return cached;
  const b = font.glyphs.get(code);
  if (!b || depth > 8) { font.cache.set(code, null); return null; }
  const wide = font.kind !== 'shapes';
  const strokes = [];
  let x = 0, y = 0, pen = true, scale = 1;
  let cur = null;
  const stack = [];
  const lineTo = (nx, ny) => {
    if (pen) {
      if (!cur) { cur = [[x, y]]; strokes.push(cur); }
      cur.push([nx, ny]);
    }
    x = nx; y = ny;
  };
  const moveBy = (dx, dy) => {
    if (!pen) cur = null;
    lineTo(x + dx, y + dy);
  };
  const arc = (cx, cy, r, a0, sweep) => {
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    for (let k = 1; k <= n; k++) {
      const a = a0 + (sweep * k) / n;
      lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };
  const bulgeTo = (dx, dy, bulge) => {
    if (!bulge) { moveBy(dx, dy); return; }
    // Arc de corde (dx, dy) et de renflement b = 2 × flèche / corde (comme les polylignes).
    const d = Math.hypot(dx, dy);
    if (d < 1e-12) return;
    const sweep = 4 * Math.atan(bulge);
    const mx = x + dx / 2, my = y + dy / 2;
    // Centre sur la médiatrice de la corde (à gauche pour un arc dans le sens trigonométrique).
    const off = ((d / 2) * (1 - bulge * bulge)) / (2 * bulge);
    const cx = mx - (dy / d) * off, cy = my + (dx / d) * off;
    const r = Math.hypot(x - cx, y - cy);
    const a0 = Math.atan2(y - cy, x - cx);
    if (!pen) cur = null;
    arc(cx, cy, r, a0, sweep);
  };
  let i = 0;
  while (i < b.length) {
    const c = b[i++];
    if (c > 0x0f) {
      const [vx, vy] = DIRS[c & 0x0f];
      const len = (c >> 4) * scale;
      moveBy(vx * len, vy * len);
      continue;
    }
    if (c === 0) break;
    switch (c) {
      case 1: pen = true; cur = null; break;
      case 2: pen = false; cur = null; break;
      case 3: scale /= b[i++] || 1; break;
      case 4: scale *= b[i++] || 1; break;
      case 5: if (stack.length < 8) stack.push([x, y]); break;
      case 6: { const q = stack.pop(); if (q) { x = q[0]; y = q[1]; cur = null; } break; }
      case 7: {
        // Sous-forme : dessinée au point courant, à l'échelle courante ; le point courant suit son avance.
        const sub = wide ? (b[i] << 8) | b[i + 1] : b[i];
        i += wide ? 2 : 1;
        const g = glyph(font, sub, depth + 1);
        if (g) {
          for (const st of g.strokes) strokes.push(st.map(([sx, sy]) => [x + sx * scale, y + sy * scale]));
          x += g.adv[0] * scale; y += g.adv[1] * scale;
        }
        cur = null;
        break;
      }
      case 8: moveBy(i8(b[i]) * scale, i8(b[i + 1]) * scale); i += 2; break;
      case 9:
        while (i + 1 < b.length && (b[i] || b[i + 1])) { moveBy(i8(b[i]) * scale, i8(b[i + 1]) * scale); i += 2; }
        i += 2;
        break;
      case 10: { // arc d'octants : rayon, puis sens (bit de poids fort), octant de départ et nombre d'octants
        const r = b[i] * scale, o = b[i + 1];
        i += 2;
        const dir = o & 0x80 ? -1 : 1, v = o & 0x7f;
        const start = (v >> 4) & 7, n = (v & 7) || 8;
        const a0 = start * OCT;
        const cx = x - r * Math.cos(a0), cy = y - r * Math.sin(a0);
        if (!pen) cur = null;
        arc(cx, cy, r, a0, dir * n * OCT);
        break;
      }
      case 11: { // arc fractionnaire : décalages de début et de fin (1/256 d'octant), rayon sur deux octets
        const so = b[i], eo = b[i + 1], r = ((b[i + 2] << 8) | b[i + 3]) * scale, o = b[i + 4];
        i += 5;
        const dir = o & 0x80 ? -1 : 1, v = o & 0x7f;
        const start = (v >> 4) & 7, n = (v & 7) || 8;
        const a0 = (start + so / 256) * OCT;
        const endOct = start + dir * (n - 1);
        const a1 = eo ? (endOct + eo / 256) * OCT : (start + dir * n) * OCT;
        let sweep = a1 - a0;
        if (dir > 0 && sweep <= 0) sweep += 2 * Math.PI;
        if (dir < 0 && sweep >= 0) sweep -= 2 * Math.PI;
        const cx = x - r * Math.cos(a0), cy = y - r * Math.sin(a0);
        if (!pen) cur = null;
        arc(cx, cy, r, a0, sweep);
        break;
      }
      case 12: bulgeTo(i8(b[i]) * scale, i8(b[i + 1]) * scale, i8(b[i + 2]) / 127); i += 3; break;
      case 13:
        while (i + 1 < b.length && (b[i] || b[i + 1])) {
          bulgeTo(i8(b[i]) * scale, i8(b[i + 1]) * scale, i8(b[i + 2]) / 127);
          i += 3;
        }
        i += 2;
        break;
      case 14: i += commandSize(b, i, wide); break; // commande réservée au texte vertical : sautée
      default: break;
    }
  }
  const g = { strokes: strokes.filter((s) => s.length > 1), adv: [x, y] };
  font.cache.set(code, g);
  return g;
}

// Code du caractère dans la police (symboles d'AutoCAD des anciennes polices : ° 127, ± 128, Ø 129).
export function codeFor(font, ch) {
  const c = ch.codePointAt(0);
  if (font.glyphs.has(c)) return c;
  const alt = { 0x00b0: [127], 0x00b1: [128], 0x00d8: [0x2205, 129], 0x2205: [0x00d8, 129], 0x2300: [0x2205, 0x00d8, 129] }[c];
  for (const a of alt || []) if (font.glyphs.has(a)) return a;
  return font.glyphs.has(0x3f) ? 0x3f : null; // caractère absent : « ? », comme AutoCAD
}

// Largeur d'une ligne de texte pour une hauteur de 1 (hauteur des majuscules), sans facteur de largeur.
export function measure(font, str) {
  let w = 0;
  for (const ch of str) {
    const code = codeFor(font, ch);
    const g = code != null ? glyph(font, code) : null;
    w += g ? g.adv[0] : font.above * 0.6;
  }
  return w / font.above;
}

// Traits d'une ligne de texte, en coordonnées locales du texte (origine au point de base, hauteur 1) :
// facteur de largeur et angle d'oblique appliqués. Renvoie une liste de polylignes [[x, y]…].
export function lineStrokes(font, str, { widthFactor = 1, oblique = 0 } = {}) {
  const k = 1 / font.above, t = Math.tan(oblique || 0);
  const out = [];
  let x = 0;
  for (const ch of str) {
    const code = codeFor(font, ch);
    const g = code != null ? glyph(font, code) : null;
    if (!g) { x += font.above * 0.6; continue; }
    // Largeur d'abord, puis inclinaison : les verticales gardent l'angle d'oblique quel que soit le facteur de largeur.
    for (const s of g.strokes) out.push(s.map(([gx, gy]) => [((x + gx) * widthFactor + gy * t) * k, gy * k]));
    x += g.adv[0];
  }
  return out;
}
