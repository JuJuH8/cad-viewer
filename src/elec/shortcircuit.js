// SPDX-License-Identifier: GPL-3.0-or-later
// Courants de court-circuit (méthode des impédances simplifiée, d'après la CEI 60909) : Ik3 maximal au jeu de
// barres de chaque tableau (contrôle du pouvoir de coupure), Ik1 minimal phase-neutre / phase-PE au bout de chaque
// départ (contrôle du déclenchement magnétique en schéma TN). Valeurs générales : à vérifier par le projeteur.
//
// Source : impédance déduite des Ik du point de raccordement (données électriques), X/R = 10.
// Câbles : R = ρ·L/S (ρ à 20 °C pour Ik max, 1,5·ρ20 pour Ik min, conducteur chaud), X = λ·L ; boucle de défaut =
// conducteur de phase + neutre / PE de même section. Facteurs de tension c max = 1,1 et c min = 0,95.

export const C_MAX = 1.1;
export const C_MIN = 0.95;
export const RHO20 = { Cu: 0.018, Al: 0.029 }; // Ω·mm²/m
export const LAMBDA_SC = 0.00008;              // réactance linéique (Ω/m)
// Seuil de déclenchement instantané (multiple de In) : disjoncteurs B / C / D ; fusibles gG en 5 s (valeur générale).
export const TRIP_FACTOR = { B: 5, C: 10, D: 20, gG: 5 };

const add = (a, b) => ({ r: a.r + b.r, x: a.x + b.x });
const mod = (z) => Math.hypot(z.r, z.x);
const scale = (z, k) => ({ r: z.r * k, x: z.x * k });

// Impédances de la source : phase (pour Ik3 max) et boucle phase-neutre (pour Ik1 min). net : données « réseau ».
export function sourceImpedance(net) {
  const zq = (C_MAX * net.un) / (Math.sqrt(3) * net.ik3 * 1000);
  const zl = (C_MIN * net.u0) / (net.ik1 * 1000);
  const split = (z) => ({ r: z / Math.sqrt(101), x: (10 * z) / Math.sqrt(101) }); // X/R = 10
  return { phase: split(zq), loop: split(zl) };
}

// Impédance d'un conducteur (Ω) : longueur (m), section (mm²), résistivité.
export const conductor = (len, s, rho) => ({ r: (rho * (len || 0)) / (s || 1), x: LAMBDA_SC * (len || 0) });

// Ajoute un câble (longueur, section) aux impédances amont { phase, loop }.
export function throughCable(z, len, s, material = 'Cu') {
  const rho = RHO20[material] ?? RHO20.Cu;
  return {
    phase: add(z.phase, conductor(len, s, rho)),
    loop: add(z.loop, scale(conductor(len, s, rho * 1.5), 2)),
  };
}

// Courants (A) : Ik3 max et Ik1 min pour des impédances { phase, loop }.
export function currents(z, net) {
  return { ik3: (C_MAX * net.un) / (Math.sqrt(3) * mod(z.phase)), ik1: (C_MIN * net.u0) / mod(z.loop) };
}

export const tripCurrent = (curve, rating) => (TRIP_FACTOR[curve] ?? TRIP_FACTOR.B) * rating;
