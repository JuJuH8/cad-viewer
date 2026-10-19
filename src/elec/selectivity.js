// SPDX-License-Identifier: GPL-3.0-or-later
// Sélectivité entre la protection d'arrivée d'un tableau (amont) et chacun de ses départs (aval), règles générales :
// - ampèremétrique : rapport des calibres In amont / In aval ≥ rapport minimal (disjoncteurs 2, fusible amont 1,6) ;
// - magnétique (disjoncteur amont) : totale si l'Ik3 max juste après le départ (jeu de barres du tableau) reste sous
//   le seuil magnétique bas de l'amont (B 3 In, C 5 In, D 10 In), sinon partielle jusqu'à ce seuil.
// Sélectivité garantie au-delà : tables du fabricant (à fournir plus tard dans les données électriques).

export const MAG_LOW = { B: 3, C: 5, D: 10 };

const label = (p) => (p.curve === 'gG' ? `gG ${p.rating} A` : `${p.curve}${p.rating}`);

// up, down : { curve, rating } ; ik : Ik3 max au jeu de barres du tableau (A) ; eq : données « matériels ».
// Renvoie { kind: 'totale' | 'partielle' | 'non', ratio, need, limit (A, partielle), text }.
export function selectivity(up, down, ik, eq) {
  const fuseUp = up.curve === 'gG';
  const ratio = up.rating / down.rating;
  const need = fuseUp ? eq.selRatioFuse : eq.selRatio;
  const fmt = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
  if (ratio + 1e-9 < need) {
    return { kind: 'non', ratio, need, text: `sélectivité non assurée avec ${label(up)} en amont (rapport des calibres ${fmt(ratio)} < ${fmt(need)})` };
  }
  if (fuseUp) return { kind: 'totale', ratio, need, text: 'totale (rapport des calibres)' };
  const limit = (MAG_LOW[up.curve] ?? MAG_LOW.C) * up.rating;
  if (ik <= limit) return { kind: 'totale', ratio, need, limit, text: 'totale' };
  return { kind: 'partielle', ratio, need, limit, text: `partielle jusqu’à ${fmt(limit / 1000)} kA` };
}
