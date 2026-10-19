// SPDX-License-Identifier: GPL-3.0-or-later
// Informations détaillées de la palette Propriétés (comme AutoCAD) : géométrie complète par type d'objet (Z, deltas,
// points de début / fin, longueurs, aires, sommets de polyligne), textes (style, justification, largeur, inclinaison),
// cotes (mesure, texte imposé, style), et résumé d'une sélection multiple (objets par type, longueur et aire totales).
import * as G from '../core/geom.js';
import { pathOf } from '../core/path.js';
import { curvePoints } from '../core/tessellate.js';
import { splineWorldPoints } from '../core/entities.js';
import { UNIT_TO_M } from '../mep/network.js';

// Longueur / aire en unités du dessin, suivies des mètres / m² quand les unités du dessin sont connues.
const unitM = (doc) => UNIT_TO_M[doc?.header?.insunits];
const nice = (v, d) => v.toLocaleString('fr-CH', { maximumFractionDigits: d, minimumFractionDigits: d });
export function fmtLength(v, doc, fmt) {
  const k = unitM(doc);
  return k && k !== 1 ? `${fmt(v)} (${nice(v * k, 2)} m)` : fmt(v);
}
export function fmtArea(v, doc, fmt) {
  const k = unitM(doc);
  return k && k !== 1 ? `${fmt(v)} (${nice(v * k * k, 2)} m²)` : fmt(v);
}

export const TYPE_LABELS = {
  LINE: 'Ligne', CIRCLE: 'Cercle', ARC: 'Arc', LWPOLYLINE: 'Polyligne', POLY3D: 'Polyligne 3D', ELLIPSE: 'Ellipse',
  SPLINE: 'Spline', TEXT: 'Texte', MTEXT: 'Texte multiligne', INSERT: 'Référence de bloc', POINT: 'Point', HATCH: 'Hachure',
  SOLID: 'Solide 2D', XLINE: 'Droite', VIEWPORT: 'Fenêtre', UNDERLAY: 'Fond de plan', WIPEOUT: 'Masque', IMAGE: 'Image',
  BLOCKREF: 'Cote', ATTDEF: 'Définition d’attribut',
};
export const typeLabel = (e) => (e.type === 'XLINE' && e.ray ? 'Demi-droite' : e.type === 'BLOCKREF' && e.kind !== 'DIMENSION' ? 'Objet composé' : TYPE_LABELS[e.type] || e.type);

const deg = (r) => (r * 180) / Math.PI;
const polyArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const polyLength = (pts, closed) => { let s = 0; for (let i = 1; i < pts.length; i++) s += G.dist(pts[i - 1], pts[i]); return closed && pts.length > 2 ? s + G.dist(pts[pts.length - 1], pts[0]) : s; };

// Aire d'une polyligne avec arcs (fermée par sa corde si elle est ouverte, comme AutoCAD) : polygone des sommets +
// segments circulaires des arcs.
export function lwpolyArea(e) {
  const n = e.pts.length;
  if (n < 2) return 0;
  let a = polyArea(e.pts);
  const count = e.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const b = e.bulges?.[i] || 0;
    if (!b) continue;
    const c = G.dist(e.pts[i], e.pts[(i + 1) % n]);
    const th = 4 * Math.atan(b);
    const r = c / (2 * Math.sin(Math.abs(th) / 2));
    a += Math.sign(b) * (r * r / 2) * (Math.abs(th) - Math.sin(Math.abs(th)));
  }
  return Math.abs(a);
}

export const lwpolyLength = (e) => pathOf(e).curves.reduce((s, c) => s + (c.k === 'seg' ? G.dist(c.a, c.b) : Math.abs(c.sw) * c.r), 0);

// Longueur et aire d'un objet (null quand elles n'ont pas de sens) ; sert aussi au résumé d'une sélection.
export function measures(e) {
  switch (e.type) {
    case 'LINE': return { length: Math.hypot(e.p2[0] - e.p1[0], e.p2[1] - e.p1[1], (e.p2[2] || 0) - (e.p1[2] || 0)), area: null }; // longueur 3D, comme AutoCAD
    case 'CIRCLE': return { length: 2 * Math.PI * e.r, area: Math.PI * e.r * e.r };
    case 'ARC': { const sw = G.sweep(e.a0, e.a1); return { length: e.r * sw, area: (e.r * e.r / 2) * (sw - Math.sin(sw)) }; }
    case 'LWPOLYLINE': return { length: lwpolyLength(e), area: lwpolyArea(e) };
    case 'POLY3D': return { length: polyLength(e.pts, e.closed), area: e.closed ? Math.abs(polyArea(e.pts)) : null };
    case 'ELLIPSE': case 'SPLINE': {
      const c = curvePoints(e);
      if (!c?.pts?.length) return { length: null, area: null };
      return { length: polyLength(c.pts, c.closed), area: Math.abs(polyArea(c.pts)) };
    }
    case 'SOLID': { const [a, b, c, d = c] = e.pts; return { length: null, area: Math.abs(polyArea([a, b, d, c])) }; }
    default: return { length: null, area: null };
  }
}

// Sommet courant de la polyligne affichée (navigation ◀ ▶ dans la palette).
export const vertexCursor = new Map();

// Lignes « Géométrie » détaillées ; null si le type n'est pas traité ici. h : outils de la palette { row, fmt, esc }.
export function detailRows(e, doc, { row, fmt, esc }) {
  const P = (label, key, p, i, editable = true) => row(label, editable ? `${key}${'xyz'[i]}` : '', fmt(p[i] ?? 0), editable ? {} : { ro: true });
  const XYZ = (label, key, p, editable = true) => P(`${label} X`, key, p, 0, editable) + P(`${label} Y`, key, p, 1, editable) + P(`${label} Z`, key, p, 2, editable);
  const RO = (label, v) => row(label, '', v, { ro: true });
  const m = measures(e);
  let h = '<div class="section">Géométrie</div>';
  switch (e.type) {
    case 'LINE': {
      const d = [e.p2[0] - e.p1[0], e.p2[1] - e.p1[1], (e.p2[2] || 0) - (e.p1[2] || 0)];
      h += XYZ('Départ', 'p1', e.p1) + XYZ('Fin', 'p2', e.p2)
        + RO('Delta X', fmt(d[0])) + RO('Delta Y', fmt(d[1])) + RO('Delta Z', fmt(d[2]))
        + RO('Longueur', fmtLength(m.length, doc, fmt)) + RO('Angle', `${fmt(deg(G.normAngle(G.angleOf(e.p1, e.p2))))}°`);
      return h;
    }
    case 'CIRCLE':
      h += XYZ('Centre', 'c', e.c) + row('Rayon', 'r', fmt(e.r)) + row('Diamètre', 'd', fmt(2 * e.r))
        + RO('Circonférence', fmtLength(m.length, doc, fmt)) + RO('Aire', fmtArea(m.area, doc, fmt));
      return h;
    case 'ARC': {
      const s = G.polar(e.c, e.a0, e.r), f = G.polar(e.c, e.a1, e.r);
      h += XYZ('Centre', 'c', e.c) + row('Rayon', 'r', fmt(e.r))
        + row('Angle de début', 'a0', fmt(deg(G.normAngle(e.a0)))) + row('Angle de fin', 'a1', fmt(deg(G.normAngle(e.a1))))
        + RO('Angle total', `${fmt(deg(G.sweep(e.a0, e.a1)))}°`)
        + RO('Début X', fmt(s[0])) + RO('Début Y', fmt(s[1])) + RO('Fin X', fmt(f[0])) + RO('Fin Y', fmt(f[1]))
        + RO('Longueur d’arc', fmtLength(m.length, doc, fmt)) + RO('Longueur de corde', fmt(G.dist(s, f))) + RO('Aire', fmtArea(m.area, doc, fmt));
      return h;
    }
    case 'LWPOLYLINE': {
      const n = e.pts.length;
      const i = Math.min(vertexCursor.get(e.id) ?? 0, n - 1);
      const v = e.pts[i];
      h += `<div class="row"><label>Sommet</label><span class="vtx-nav"><button class="btn small" data-act="vtx-prev" aria-label="Sommet précédent">◀</button><span class="ro">${i + 1} / ${n}</span><button class="btn small" data-act="vtx-next" aria-label="Sommet suivant">▶</button></span></div>`
        + row('Sommet X', 'vtxx', fmt(v[0])) + row('Sommet Y', 'vtxy', fmt(v[1]))
        + row('Courbure (bulge)', 'vtxb', fmt(e.bulges?.[i] || 0))
        + row('Fermée', 'closed', e.closed, { check: true })
        + row('Largeur globale', 'width', fmt(e.width || 0)) + row('Élévation', 'z', fmt(e.z || 0))
        + RO('Longueur', fmtLength(m.length, doc, fmt)) + RO(e.closed ? 'Aire' : 'Aire (fermée par la corde)', fmtArea(m.area, doc, fmt));
      return h;
    }
    case 'POLY3D':
      h += RO('Sommets', String(e.pts.length)) + RO('Fermée', e.closed ? 'oui' : 'non')
        + RO('Longueur', fmtLength(m.length, doc, fmt)) + (m.area != null ? RO('Aire (projetée)', fmtArea(m.area, doc, fmt)) : '');
      return h;
    case 'ELLIPSE': {
      const a = Math.hypot(e.major[0], e.major[1]);
      const full = Math.abs(G.sweep(e.a0, e.a1) - G.TAU) < 1e-9 || G.sweep(e.a0, e.a1) < 1e-12;
      h += XYZ('Centre', 'c', e.c, false) + RO('Grand rayon', fmt(a)) + RO('Petit rayon', fmt(a * e.ratio)) + RO('Rapport des rayons', fmt(e.ratio))
        + RO('Angle du grand axe', `${fmt(deg(G.normAngle(Math.atan2(e.major[1], e.major[0]))))}°`)
        + (full ? '' : RO('Angle de début', `${fmt(deg(e.a0))}°`) + RO('Angle de fin', `${fmt(deg(e.a1))}°`))
        + RO('Longueur', fmtLength(m.length, doc, fmt)) + RO('Aire', fmtArea(full ? Math.PI * a * a * e.ratio : m.area, doc, fmt));
      return h;
    }
    case 'SPLINE':
      h += RO('Degré', String(e.degree ?? 3)) + RO('Points de contrôle', String(e.ctrl?.length || 0)) + RO('Points d’ajustement', String(e.fit?.length || 0))
        + RO('Rationnelle', e.weights ? 'oui' : 'non') + RO('Fermée', e.closed ? 'oui' : 'non')
        + RO('Longueur', fmtLength(m.length, doc, fmt)) + (e.closed ? RO('Aire', fmtArea(m.area, doc, fmt)) : '');
      return h;
    case 'SOLID':
      h += e.pts.map((p, k) => RO(`Sommet ${k + 1}`, `${fmt(p[0])} ; ${fmt(p[1])}`)).join('') + RO('Élévation', fmt(e.z || 0)) + RO('Aire', fmtArea(m.area, doc, fmt));
      return h;
    case 'XLINE':
      h += XYZ('Point de base', 'p', e.p, false) + RO('Direction', `${fmt(deg(G.normAngle(Math.atan2(e.dir[1], e.dir[0]))))}°`);
      return h;
    case 'POINT':
      h += XYZ('Position', 'p', e.p);
      return h;
    case 'TEXT': case 'MTEXT': {
      const styles = [...(doc.styles?.keys?.() || [])];
      const style = e.style || 'Standard';
      const styleOpts = [...new Set([style, ...styles])].map((s) => `<option value="${esc(s)}" ${s === style ? 'selected' : ''}>${esc(s)}</option>`).join('');
      const just = e.type === 'TEXT' ? `${{ left: 'Gauche', center: 'Centre', right: 'Droite', middle: 'Milieu', aligned: 'Aligné', fit: 'Ajusté' }[e.align || 'left'] || e.align}${e.valign && e.valign !== 'baseline' ? ` / ${{ middle: 'milieu', top: 'haut', bottom: 'bas' }[e.valign] || e.valign}` : ''}`
        : ['', 'Haut gauche', 'Haut centre', 'Haut droite', 'Milieu gauche', 'Milieu centre', 'Milieu droite', 'Bas gauche', 'Bas centre', 'Bas droite'][e.attach || 1];
      h = '<div class="section">Texte</div>' + row('Contenu', 'text', e.text)
        + `<div class="row"><label>Style</label><select data-f="tstyle">${styleOpts}</select></div>`
        + RO('Justification', just) + row('Hauteur', 'h', fmt(e.h)) + row('Rotation', 'rot', fmt(deg(e.rot || 0)))
        + (e.type === 'TEXT' ? row('Facteur de largeur', 'wf', fmt(e.wf || 1)) + row('Inclinaison (°)', 'obl', fmt(deg(e.obl || 0)))
          : row('Largeur du cadre', 'mwidth', fmt(e.width || 0)) + row('Interligne', 'spacing', fmt(e.spacing || 1)))
        + '<div class="section">Géométrie</div>' + XYZ('Position', 'p', e.p);
      return h;
    }
    case 'BLOCKREF': {
      if (e.kind !== 'DIMENSION') return null;
      const meta = e.meta || {};
      const kinds = { linear: 'Linéaire', aligned: 'Alignée', radius: 'Rayon', diameter: 'Diamètre', angular: 'Angulaire', ordinate: 'Coordonnée' };
      h = '<div class="section">Cote</div>' + RO('Type de cote', kinds[meta.type] || meta.subclass || 'Cote')
        + RO('Mesure', meta.measurement != null ? fmt(meta.measurement) : '—')
        + RO('Texte imposé', meta.text && meta.text !== '<>' ? meta.text : 'aucun')
        + RO('Style de cote', meta.style || 'Standard')
        + RO('Associative', meta.assoc?.some(Boolean) ? 'oui' : 'non')
        + (meta.p1 ? RO('Point 1', `${fmt(meta.p1[0])} ; ${fmt(meta.p1[1])}`) : '') + (meta.p2 ? RO('Point 2', `${fmt(meta.p2[0])} ; ${fmt(meta.p2[1])}`) : '');
      return h;
    }
    default: return null;
  }
}

// Résumé d'une sélection de plusieurs objets : nombre par type, longueur et aire totales des objets mesurables.
export function selectionRows(ents, { row, fmt, doc = null }) {
  const byType = new Map();
  let length = 0, nl = 0, area = 0, na = 0;
  for (const e of ents) {
    const k = typeLabel(e);
    byType.set(k, (byType.get(k) || 0) + 1);
    const m = measures(e);
    if (m.length != null) { length += m.length; nl++; }
    if (m.area != null && (e.type !== 'LWPOLYLINE' || e.closed) && e.type !== 'ARC') { area += m.area; na++; }
  }
  let h = '<div class="section">Sélection</div>';
  for (const [k, n] of [...byType].sort((a, b) => b[1] - a[1])) h += row(k, '', String(n), { ro: true });
  if (nl) h += row('Longueur totale', '', `${fmtLength(length, doc, fmt)} · ${nl} objet${nl > 1 ? 's' : ''}`, { ro: true });
  if (na) h += row('Aire totale', '', `${fmtArea(area, doc, fmt)} · ${na} objet${na > 1 ? 's' : ''}`, { ro: true });
  return h;
}

// Champs ajoutés (Z, sommet courant, texte) ; renvoie vrai si l'objet a changé, null si le champ n'est pas d'ici.
export function setDetail(e, f, v) {
  const num = () => parseFloat(String(v).replace(',', '.'));
  const zf = { p1z: 'p1', p2z: 'p2', cz: 'c', pz: 'p' }[f];
  if (zf) { const n = num(); if (!Number.isFinite(n) || !e[zf]) return false; e[zf] = [e[zf][0], e[zf][1], n]; return true; }
  if (f === 'vtxx' || f === 'vtxy' || f === 'vtxb') {
    if (e.type !== 'LWPOLYLINE') return false;
    const n = num();
    if (!Number.isFinite(n)) return false;
    const i = Math.min(vertexCursor.get(e.id) ?? 0, e.pts.length - 1);
    if (f === 'vtxb') { e.bulges = e.pts.map((_, k) => (k === i ? n : e.bulges?.[k] || 0)); return true; }
    e.pts = e.pts.map((p, k) => (k === i ? (f === 'vtxx' ? [n, p[1]] : [p[0], n]) : p));
    return true;
  }
  if (f === 'tstyle') { if (!v) return false; e.style = String(v); return true; }
  if (f === 'wf') { const n = num(); if (!(n > 0)) return false; e.wf = n; return true; }
  if (f === 'obl') { const n = num(); if (!Number.isFinite(n) || Math.abs(n) > 85) return false; if (n) e.obl = (n * Math.PI) / 180; else delete e.obl; return true; }
  if (f === 'mwidth') { const n = num(); if (!(n >= 0)) return false; e.width = n; return true; }
  if (f === 'spacing') { const n = num(); if (!(n > 0)) return false; e.spacing = n; return true; }
  if (f === 'ltscale') { const n = num(); if (!(n > 0)) return false; if (n === 1) delete e.ltscale; else e.ltscale = n; return true; }
  return null;
}
