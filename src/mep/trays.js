// SPDX-License-Identifier: GPL-3.0-or-later
// Chemins de câbles : rayon intérieur des coudes (mm, 90° horizontal) proposé selon le fabricant choisi.
// Valeurs par défaut de l'application, non issues d'un catalogue : à vérifier dans la documentation du fabricant ;
// modifiables par réseau dans les Propriétés (« Rayon intérieur »). Les noms de fabricants servent seulement à
// repérer le choix ; marques de leurs propriétaires. kw : mot-clé de la commande.
export const TRAY_MAKERS = {
  OBO: { kw: 'oBo', label: 'OBO Bettermann', ri: 150, note: 'rayon par défaut, à vérifier dans le catalogue du fabricant' },
  LANZ: { kw: 'Lanz', label: 'Lanz Oensingen', ri: 150, note: 'rayon par défaut, à vérifier dans le catalogue du fabricant' },
};

export const DEFAULT_TRAY_MAKER = 'OBO';

// Rayon intérieur du catalogue dans les unités du dessin (unitMm : mm par unité).
export function catalogRadius(maker, unitMm = 1) {
  const ri = TRAY_MAKERS[maker]?.ri ?? TRAY_MAKERS[DEFAULT_TRAY_MAKER].ri;
  return ri / (unitMm || 1);
}
