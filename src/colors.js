// SPDX-License-Identifier: GPL-3.0-or-later
// Palette AutoCAD (ACI : AutoCAD Color Index) et résolution des couleurs DWG.
//
// Les couleurs sont représentées par un entier 0xRRGGBB, sauf la couleur 7
// (blanc/noir selon le fond), représentée par la valeur spéciale FOREGROUND.

export const FOREGROUND = 'fg';
// Couleur du fond (masques, WIPEOUT) : fond de l'écran, feuille blanche d'une présentation, papier au tracé.
export const BACKGROUND = 'bg';

const FIXED = {
  1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff,
  6: 0xff00ff, 8: 0x808080, 9: 0xc0c0c0,
  250: 0x333333, 251: 0x505050, 252: 0x696969, 253: 0x828282, 254: 0xbebebe, 255: 0xffffff,
};

// Indices 10 à 249 : 24 teintes (pas de 15°) × 5 luminosités × 2 saturations.
// Luminosités AutoCAD : FF, BD, 81, 68, 4F ; les indices impairs sont désaturés (2/3).
const VALUES = [255, 189, 129, 104, 79].map((v) => v / 255);

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255);
}

const ACI = new Array(256).fill(0xffffff);
for (let i = 10; i <= 249; i++) {
  const hue = Math.floor((i - 10) / 10) * 15;
  const shade = i % 10;
  ACI[i] = hsvToRgb(hue, shade % 2 === 0 ? 1 : 1 / 3, VALUES[Math.floor(shade / 2)]);
}
for (const [k, v] of Object.entries(FIXED)) ACI[k] = v;

export function aciToColor(index) {
  if (index === 7) return FOREGROUND;
  if (index >= 1 && index <= 255) return ACI[index];
  return FOREGROUND;
}

export function layerColor(layer) {
  if (!layer) return FOREGROUND;
  if (layer.colorIndex >= 1 && layer.colorIndex <= 255) return aciToColor(layer.colorIndex);
  if (typeof layer.color === 'number') return layer.color === 0xffffff ? FOREGROUND : layer.color;
  return FOREGROUND;
}

export function toCss(color, foreground) {
  const c = color === FOREGROUND ? foreground : color;
  return '#' + c.toString(16).padStart(6, '0');
}
