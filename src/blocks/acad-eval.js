// SPDX-License-Identifier: GPL-3.0-or-later
// Évaluation des blocs dynamiques relus d'AutoCAD (block.dyn.acad = 2) : comme dans AutoCAD, les actions
// transforment leurs objets ET les paramètres de leur jeu de sélection (une rotation de tout le symbole fait aussi
// tourner le paramètre linéaire qui l'étire), chaque paramètre gardant son état courant (points mis à jour, repère
// cumulé M). Les valeurs sont exprimées dans le repère propre du paramètre : distance, angle relatif à sa référence,
// déplacement d'un point, état d'inversion ; elles ne dépendent donc pas de l'ordre des modifications quand les jeux
// de sélection sont emboîtés (cas courant des bibliothèques de symboles : rotation de tout le symbole, échelle, étiquettes déplacées).
//
// Paramètres (en plus des champs du modèle de l'appli, voir dynamic.js) :
//   linéaire  { p1, p2, mid }        mid : point de base au milieu (les deux extrémités bougent)
//   rotation  { c, e, ref }          e : extrémité, ref : référence de l'angle nul (valeur = angle(e) − angle(ref))
//   point     { p }   inversion { p1, p2 }   consultation / visibilité { p } (position de la poignée)
// Actions, rangées dans l'ordre d'évaluation (les actions d'un même paramètre se suivent) :
//   { type: 'move' | 'stretch' | 'scale' | 'rotate' | 'flip', param, keys, params, conn: 'end' | 'base',
//     mult, angle, base: { param, which: 'base' | 'end' | 'pos', dep, off, pt }, verts: { clé: [indices] },
//     pverts: { paramètre: [indices] } }
import * as G from '../core/geom.js';
import { transformEntity } from '../core/entities.js';
import { stretchEntity } from '../core/path.js';
import { textWidth, plainText } from '../text.js';

const rot = (v, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};
const signedAngle = (a) => {
  let x = a % G.TAU;
  if (x > Math.PI) x -= G.TAU;
  if (x <= -Math.PI) x += G.TAU;
  return x;
};

// État initial d'un paramètre (coordonnées du bloc).
function initState(p) {
  switch (p.type) {
    case 'linear': return { B: p.p1, E: p.p2, M: G.IDENTITY };
    case 'rotation': return { B: p.c, E: p.e || G.polar(p.c, p.a0 || 0, p.r || 1), R: p.ref || G.polar(p.c, p.a0 || 0, p.r || 1), M: G.IDENTITY };
    case 'flip': return { B: p.p1, E: p.p2, F: 0, M: G.IDENTITY };
    default: return { X: p.p || [0, 0], M: G.IDENTITY };
  }
}

// Valeur courante d'un paramètre dans son repère (mesurée sur son état).
export function measure(p, s) {
  const sc = G.scaleOf(s.M) || 1, sg = G.isMirror(s.M) ? -1 : 1;
  if (p.type === 'linear') return G.dist(s.B, s.E) / sc;
  if (p.type === 'rotation') return sg * signedAngle(G.angleOf(s.B, s.E) - G.angleOf(s.B, s.R));
  if (p.type === 'flip') return s.F;
  return null;
}

function transformState(s, m) {
  const out = { ...s, M: G.compose(m, s.M) };
  for (const k of ['B', 'E', 'R', 'X']) if (s[k]) out[k] = G.applyPt(m, s[k]);
  return out;
}

// Texte inversé (symétrie) : comme AutoCAD, le texte reste lisible et occupe le cadre symétrique du cadre d'origine
// (texte d'une ligne justifié à gauche, au centre ou à droite ; hauteur du cadre = hauteur du texte, largeur estimée
// avec la police de l'appli).
function mirrorText(e, m) {
  const out = transformEntity(e, m);
  if (!['left', 'center', 'right'].includes(e.align || 'left')) return out;
  const L = (v) => G.norm(G.applyVec(m, v));
  const d = [Math.cos(e.rot || 0), Math.sin(e.rot || 0)];
  const d2 = [Math.cos(out.rot || 0), Math.sin(out.rot || 0)], u2 = G.perp(d2);
  const h = out.h || 0;
  let shift = [0, 0];
  if (G.dot(L(d), d2) > 0) {
    // Texte retourné haut / bas : décalage de la hauteur selon l'ancrage vertical.
    const c = { baseline: -h, bottom: -h, top: h }[e.valign || 'baseline'] || 0;
    shift = G.mul(u2, c);
  } else {
    // Texte retourné gauche / droite : décalage de la largeur selon la justification.
    const w = textWidth(plainText(e.text || e.tag || ''), h) * (e.wf || 1);
    const c = { left: -w, right: w }[e.align || 'left'] || 0;
    shift = G.mul(d2, c);
  }
  out.p = [out.p[0] + shift[0], out.p[1] + shift[1], out.p[2] || 0];
  return out;
}
const TEXTS = new Set(['TEXT', 'ATTDEF']);

// Points d'étirement d'un objet (ordre d'AutoCAD) : nombre, et déplacement de certains d'entre eux.
const ONE_POINT = new Set(['CIRCLE', 'TEXT', 'MTEXT', 'ATTDEF', 'INSERT', 'POINT', 'HATCH', 'ELLIPSE']);
function stretchCount(e) {
  if (e.type === 'LINE') return 2;
  if (e.type === 'LWPOLYLINE' || e.type === 'POLY3D' || e.type === 'SOLID') return e.pts.length;
  if (e.type === 'ARC') return 2;
  return ONE_POINT.has(e.type) ? 1 : 0;
}
function stretchVerts(e, idx, d) {
  const n = stretchCount(e);
  const set = new Set(idx);
  if (n && [...Array(n).keys()].every((i) => set.has(i))) return { ...transformEntity(e, G.translation(d[0], d[1])), k: e.k };
  const mv = (p) => (p.length > 2 ? [p[0] + d[0], p[1] + d[1], p[2]] : [p[0] + d[0], p[1] + d[1]]);
  if (e.type === 'LINE') return { ...e, p1: set.has(0) ? mv(e.p1) : e.p1, p2: set.has(1) ? mv(e.p2) : e.p2 };
  if (e.type === 'LWPOLYLINE' || e.type === 'POLY3D' || e.type === 'SOLID') return { ...e, pts: e.pts.map((p, i) => (set.has(i) ? mv(p) : p)) };
  return e; // étirement partiel non géré (la conversion vérifie la géométrie)
}

// Évalue les actions : ents = objets visibles (clé k), val(p) = valeur d'un paramètre.
// → { entities (ordre d'origine), states: Map(id → état final) }.
export function evaluateAcad(dyn, ents, val) {
  const params = new Map(dyn.params.map((p) => [p.id, p]));
  const st = new Map(dyn.params.map((p) => [p.id, initState(p)]));
  const out = new Map(ents.map((e) => [e.k, e]));
  const fired = new Map(); // paramètre → effet de sa valeur (déplacements, facteur, angle)
  const fire = (p) => {
    const s = st.get(p.id);
    const v = val(p);
    const sc = G.scaleOf(s.M) || 1, sg = G.isMirror(s.M) ? -1 : 1;
    let fx = {};
    if (p.type === 'linear') {
      const d = G.dist(s.B, s.E);
      const u = d > 1e-12 ? G.norm(G.sub(s.E, s.B)) : G.norm(G.applyVec(s.M, G.sub(p.p2, p.p1)));
      const target = v * sc, delta = target - d;
      const endD = G.mul(u, p.mid ? delta / 2 : delta), baseD = p.mid ? G.mul(u, -delta / 2) : [0, 0];
      fx = { endD, baseD, k: d > 1e-12 ? target / d : 1 };
      st.set(p.id, { ...s, B: G.add(s.B, baseD), E: G.add(s.E, endD) });
    } else if (p.type === 'rotation') {
      const da = sg * signedAngle(v - measure(p, s));
      fx = { da };
      st.set(p.id, { ...s, E: G.applyPt(G.rotation(da, s.B[0], s.B[1]), s.E) });
    } else if (p.type === 'point') {
      const d = G.applyVec(s.M, v);
      fx = { endD: d };
      st.set(p.id, { ...s, X: G.add(s.X, d) });
    } else if (p.type === 'flip') {
      const f = v ? 1 : 0;
      fx = { flip: f !== s.F };
      st.set(p.id, { ...s, F: f });
    }
    fired.set(p.id, fx);
    return fx;
  };
  const basePoint = (a, p) => {
    const b = a.base || {};
    const q = params.get(b.param) ? b.param : p.id;
    const s = st.get(q);
    if (b.dep === false && b.pt) return G.applyPt(st.get(p.id).M, b.pt);
    const at = b.which === 'end' ? s.E : b.which === 'pos' ? s.X : s.B || s.X;
    return b.off ? G.add(at, G.applyVec(s.M, b.off)) : at;
  };
  const applyTo = (a, p, m) => {
    const mir = G.isMirror(m);
    for (const k of a.keys || []) {
      const e = out.get(k);
      if (e) out.set(k, { ...(mir && TEXTS.has(e.type) ? mirrorText(e, m) : transformEntity(e, m)), k });
    }
    for (const id of a.params || []) if (id !== p.id && st.has(id)) st.set(id, transformState(st.get(id), m));
  };
  for (const a of dyn.actions || []) {
    const p = params.get(a.param);
    if (!p) continue;
    const fx = fired.get(p.id) || fire(p);
    const s = st.get(p.id);
    const sg = G.isMirror(s.M) ? -1 : 1;
    let disp = a.conn === 'base' ? fx.baseD : fx.endD;
    if (disp && (a.mult != null && a.mult !== 1 || a.angle)) disp = rot(G.mul(disp, a.mult ?? 1), sg * (a.angle || 0));
    if (a.type === 'rotate') {
      if (!fx.da) continue;
      const c = basePoint(a, p);
      applyTo(a, p, G.rotation(fx.da, c[0], c[1]));
    } else if (a.type === 'scale') {
      if (fx.k == null || Math.abs(fx.k - 1) < 1e-15) continue;
      const c = basePoint(a, p);
      applyTo(a, p, G.scaling(fx.k, fx.k, c[0], c[1]));
    } else if (a.type === 'flip') {
      if (fx.flip) applyTo(a, p, G.mirroring(s.B, s.E));
    } else if (a.type === 'move') {
      if (disp && (disp[0] || disp[1])) applyTo(a, p, G.translation(disp[0], disp[1]));
    } else if (a.type === 'stretch') {
      if (!disp || !(disp[0] || disp[1])) continue;
      if (!a.verts && a.frame?.length) {
        // Étirement ajouté dans l'appli (cadre, sans points d'étirement d'AutoCAD).
        const box = G.emptyBox();
        for (const q of a.frame) G.growBox(box, q[0], q[1]);
        for (const k of a.keys || []) { const e = out.get(k); const s2 = e && stretchEntity(e, box, disp[0], disp[1]); if (s2) out.set(k, { ...s2, k }); }
        continue;
      }
      for (const [k, idx] of Object.entries(a.verts || {})) {
        const e = out.get(Number(k));
        if (e) out.set(e.k, stretchVerts(e, idx, disp));
      }
      // Paramètres étirés : seuls les points cités bougent (0 base, 1 extrémité ; la référence d'une rotation reste,
      // comme dans AutoCAD).
      for (const [id, idx] of Object.entries(a.pverts || {})) {
        const q = params.get(id), s2 = st.get(id);
        if (!q || !s2 || id === p.id) continue;
        const pts = q.type === 'point' || q.type === 'lookup' || q.type === 'visibility' ? ['X'] : ['B', 'E'];
        const n = { ...s2 };
        idx.forEach((i) => { if (pts[i] && n[pts[i]]) n[pts[i]] = G.add(n[pts[i]], disp); });
        st.set(id, n);
      }
    }
  }
  // Paramètres sans action : leur état suit quand même leur valeur (poignées).
  for (const p of dyn.params) if (!fired.has(p.id) && ['linear', 'rotation', 'point', 'flip'].includes(p.type)) fire(p);
  return { entities: ents.map((e) => out.get(e.k)), states: st };
}

// Poignées d'un paramètre d'après son état final (coordonnées du bloc) : { p, shape, dir }.
export function acadGrip(p, s) {
  if (!s) return null;
  if (p.type === 'linear') return { p: s.E, shape: 'arrow', dir: G.angleOf(s.B, s.E) };
  if (p.type === 'rotation') return { p: s.E, shape: 'circle' };
  if (p.type === 'point') return { p: s.X, shape: 'square' };
  if (p.type === 'flip') return { p: G.mid(s.B, s.E), shape: 'flip', click: true, dir: G.angleOf(s.B, s.E) };
  return { p: s.X, shape: 'menu', click: true };
}

// Valeur d'un paramètre pour sa poignée amenée en b (coordonnées du bloc), v = valeur actuelle.
export function acadValueFromPoint(p, s, b, v) {
  if (!s) return null;
  const sc = G.scaleOf(s.M) || 1, sg = G.isMirror(s.M) ? -1 : 1;
  if (p.type === 'linear') {
    const u = G.norm(G.sub(s.E, s.B));
    const from = p.mid ? G.mid(s.B, s.E) : s.B;
    return (G.dot(G.sub(b, from), u) * (p.mid ? 2 : 1)) / sc;
  }
  if (p.type === 'rotation') return v + sg * signedAngle(G.angleOf(s.B, b) - G.angleOf(s.B, s.E));
  if (p.type === 'point') {
    const inv = G.invert([s.M[0], s.M[1], s.M[2], s.M[3], 0, 0]);
    return G.add(v, G.applyVec(inv, G.sub(b, s.X)));
  }
  return null;
}
