// SPDX-License-Identifier: GPL-3.0-or-later
// Traitement d'une base architecte avant de l'attacher en fond de plan : mêmes opérations et même
// rapport que le module AutoCAD LT « Traitement de plans » (profils partagés, voir profiles.js).
// Le document traité est un dessin fraîchement importé : il est modifié directement (pas d'historique).

import { wcmatch, sourceMatches } from './layertable.js';
import { BYLAYER, BYBLOCK, defaultLayer } from '../core/document.js';

const CURVES = new Set(['LINE', 'LWPOLYLINE', 'ARC', 'CIRCLE', 'POLY3D', 'ELLIPSE', 'SPLINE']);
const TEXTS = new Set(['TEXT', 'MTEXT']);

// Codes de mise en forme des textes multilignes retirés par l'option MTEXT :
// couleurs, polices, souligné, surligné, barré. Hauteurs, largeurs et empilements sont conservés.
const FMT_MTEXT = new Set(['C', 'c', 'f', 'F', 'L', 'l', 'O', 'o', 'K', 'k']);
const FMT_ALL = new Set([...FMT_MTEXT, 'H', 'W', 'Q', 'T', 'A', 'p', 'S']);

// Retire les codes listés ; all = retirer aussi les accolades. \P, \~, \\, \{, \} et \U+ restent.
export function unformatMtext(s, codes = FMT_MTEXT, all = false) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      if (!codes.has(n)) { out += c + n; continue; }
      if ('LlOoKk'.includes(n)) continue;
      if (n === 'S') {
        while (i + 1 < s.length && s[i + 1] !== ';') { const x = s[++i]; out += x === '^' || x === '#' ? '/' : x; }
        i++;
        continue;
      }
      while (i + 1 < s.length && s[i + 1] !== ';') i++;
      i++;
      continue;
    }
    if (all && (c === '{' || c === '}')) continue;
    out += c;
  }
  return out;
}

const WS = /^[\s ]+|[\s ]+$/g;

export function mtextPlain(s) {
  return unformatMtext(s, FMT_ALL, true).replace(/\\[P~]/g, ' ').replace(/\\[\\{}]/g, (m) => m[1]);
}

// Espaces et \P superflus au début et à la fin d'un texte multiligne.
export function trimMtext(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(WS, '');
    while (/^\\[P~]/.test(s)) s = s.slice(2);
    while (/\\[P~]$/.test(s) && !/\\\\[P~]$/.test(s)) s = s.slice(0, -2);
  } while (s !== prev);
  return s;
}

function blankText(e) {
  return (e.type === 'MTEXT' ? mtextPlain(e.text || '') : String(e.text ?? '')).replace(WS, '') === '';
}

// Longueur (cordes) d'une courbe, arrêtée dès que la limite est dépassée.
function shorterThan(e, lim) {
  const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], (p[2] || 0) - (q[2] || 0));
  switch (e.type) {
    case 'LINE': return d2(e.p1, e.p2) < lim;
    case 'CIRCLE': return 2 * Math.PI * e.r < lim;
    case 'ARC': {
      let a = e.a1 - e.a0;
      while (a <= 0) a += 2 * Math.PI;
      return e.r * a < lim;
    }
    case 'ELLIPSE': return Math.hypot(e.major[0], e.major[1]) * 4 < lim;
    case 'LWPOLYLINE': case 'POLY3D': {
      // somme des cordes (les arcs de polyligne sont plus longs, mais une corde nulle reste un arc nul)
      let len = 0;
      for (let i = 1; i < e.pts.length && len < lim; i++) len += d2(e.pts[i - 1], e.pts[i]);
      if (e.closed && e.pts.length > 1 && len < lim) len += d2(e.pts[e.pts.length - 1], e.pts[0]);
      return len < lim;
    }
    case 'SPLINE': {
      const pts = e.ctrl?.length ? e.ctrl : e.fit || [];
      let len = 0;
      for (let i = 1; i < pts.length && len < lim; i++) len += d2(pts[i - 1], pts[i]);
      return pts.length > 0 && len < lim;
    }
    default: return false;
  }
}

const z0 = (p) => (p && p.length > 2 && p[2] !== 0 ? [p[0], p[1], 0] : p);

function flatten(e) {
  let changed = false;
  const fix = (k) => { const v = z0(e[k]); if (v !== e[k]) { e[k] = v; changed = true; } };
  switch (e.type) {
    case 'LINE': fix('p1'); fix('p2'); break;
    case 'CIRCLE': case 'ARC': case 'ELLIPSE': fix('c'); break;
    case 'POINT': case 'TEXT': case 'MTEXT': case 'ATTDEF': case 'INSERT': case 'XLINE': fix('p'); break;
    case 'POLY3D':
      if (e.pts.some((p) => p[2])) { e.pts = e.pts.map(z0); changed = true; }
      break;
    case 'SPLINE':
      if ((e.ctrl || []).some((p) => p[2]) || (e.fit || []).some((p) => p[2])) {
        e.ctrl = (e.ctrl || []).map(z0); e.fit = (e.fit || []).map(z0); changed = true;
      }
      break;
    case 'LWPOLYLINE': case 'SOLID': case 'HATCH':
      if (e.z) { e.z = 0; changed = true; }
      break;
  }
  if (e.attribs?.length) for (const a of e.attribs) if (flatten(a)) changed = true;
  return changed;
}

function setColor(e, c) {
  if ((e.color ?? BYLAYER) === c && e.rgb == null) return false;
  e.color = c;
  delete e.rgb;
  return true;
}

// Traite le document ; renvoie { lignes du rapport, nombres par libellé }.
export function cleanDocument(doc, cfg, { table = null } = {}) {
  const rep = new Map();
  const warns = new Set();
  const note = (label, n = 1) => { if (n) rep.set(label, (rep.get(label) || 0) + n); };
  const t0 = performance.now();
  const layerOf = (name) => doc.layers.get(name);
  const isHidden = (l) => l && (l.frozen || l.on === false);
  const lay0 = new Map([...doc.layers].map(([n, l]) => [n, { ...l }]));

  // Calques exclus du traitement (verrouillés / gelés / désactivés, selon les options)
  const skip = new Set();
  if (!cfg.LIBERER) {
    for (const l of lay0.values()) {
      if ((l.locked && !cfg.VERROUILLES) || (l.frozen && !cfg.GELES) || (l.on === false && !cfg.DESACTIVES)) skip.add(l.name);
    }
  }

  // Destination de chaque calque : 'KEEP', 'DEL' ou nouveau nom (mémorisé).
  const targets = new Map();
  const conv = cfg.CONV_CALQUES && table?.length ? table : null;
  const target = (name) => {
    if (targets.has(name)) return targets.get(name);
    let r = 'KEEP';
    const up = name.toUpperCase();
    const protectedLayer = up === '0' || up === 'DEFPOINTS';
    if (!protectedLayer && cfg.CALQUES_SUPPR && (cfg.CALQUES_FILTRE || []).some((p) => wcmatch(name, p))) r = 'DEL';
    if (!protectedLayer && cfg.CALQUES_CACHES && isHidden(lay0.get(name))) r = 'DEL';
    if (r === 'KEEP' && conv) {
      const row = conv.find((t) => sourceMatches(name, t.source));
      if (row) {
        if (/^(supprimer|-)$/i.test(row.target)) r = protectedLayer ? 'KEEP' : 'DEL';
        else if (row.target) {
          r = row.target;
          const l = doc.layers.get(r) || defaultLayer(r, { ...(lay0.get(name) || {}), name: r });
          if (row.color != null) { l.color = row.color; delete l.rgb; }
          if (row.ltype) l.ltype = row.ltype;
          if (row.lweight != null) l.lweight = row.lweight;
          doc.layers.set(r, l);
        }
      }
    }
    targets.set(name, r);
    return r;
  };
  if (cfg.CALQUES_CACHES) for (const l of lay0.values()) if (isHidden(l)) target(l.name);
  const layerOps = cfg.CALQUES_SUPPR || cfg.CALQUES_CACHES || conv || cfg.COTES_CALQUE || cfg.HACH_CALQUE;

  // Couleurs : table de conversion
  const mapColor = (c) => {
    const t = cfg.COUL_TABLE || [];
    const hit = t.find(([s]) => s === c) || t.find(([s]) => s === 256);
    return hit ? hit[1] : null;
  };
  const ltMap = new Map((cfg.TYPESLIGNE ? cfg.TL_TABLE || [] : []).map(([s, d]) => [String(s).toUpperCase(), d]));
  const mtCodes = new Set([...(cfg.MTEXT ? FMT_MTEXT : []), ...(cfg.STYLES ? ['f', 'F'] : []),
    ...(cfg.DUCALQUE || cfg.COULEUR_UNIQUE ? ['C', 'c'] : [])]);

  // Raison de suppression (libellé du rapport) ou null.
  const delReason = (e, emptyBlocks) => {
    if (layerOps && target(e.layer) === 'DEL') return 'Objets des calques supprimés';
    if (CURVES.has(e.type)) return cfg.PETITS && shorterThan(e, cfg.TOL > 0 ? cfg.TOL : 1e-9) ? 'Objets trop petits supprimés' : null;
    if (TEXTS.has(e.type)) return cfg.TEXTES && blankText(e) ? 'Textes vides supprimés' : null;
    if (e.type === 'INSERT') return cfg.BLOCS_VIDES && emptyBlocks.has(e.name) ? 'Références de blocs vides supprimées' : null;
    if (e.type === 'HATCH' && cfg.HACH_SOLIDES && (e.solid || /^_?SOLID$/i.test(e.pattern || ''))) {
      if (/^PDF/i.test(e.layer)) { warns.add('Hachures pleines d’un import PDF conservées (elles dessinent aussi les textes).'); return null; }
      return 'Hachures pleines supprimées';
    }
    if (e.type === 'SOLID' && cfg.SOLIDES2D) return 'Solides 2D supprimés';
    return null;
  };

  // Modifications d'un objet (copie) ; ctx 'SPACE' (espace objet) ou 'BLOCK' (composant de bloc).
  const modify = (e0, ctx) => {
    const e = structuredClone(e0);
    let changed = false;
    if (layerOps) {
      const t = target(e.layer);
      if (typeof t === 'string' && t !== 'KEEP' && t !== 'DEL' && t !== e.layer) { e.layer = t; changed = true; }
      if (ctx === 'SPACE' && cfg.COTES_CALQUE && e.type === 'BLOCKREF' && e.kind === 'DIMENSION' && e.layer !== cfg.NOM_COTES) { e.layer = cfg.NOM_COTES; changed = true; }
      if (ctx === 'SPACE' && cfg.HACH_CALQUE && e.type === 'HATCH' && e.layer !== cfg.NOM_HACH) { e.layer = cfg.NOM_HACH; changed = true; }
      for (const a of e.attribs || []) { const t2 = target(a.layer); if (typeof t2 === 'string' && !['KEEP', 'DEL'].includes(t2)) { a.layer = t2; changed = true; } }
    }
    if (cfg.APLATIR && flatten(e)) changed = true;
    if (cfg.TEXTES && TEXTS.has(e.type) && typeof e.text === 'string') {
      const t = e.type === 'MTEXT' ? trimMtext(e.text) : e.text.replace(WS, '');
      if (t !== e.text) { e.text = t; changed = true; }
    }
    // Couleurs
    const c = e.color ?? BYLAYER;
    if (cfg.COULEURS) {
      let dst = null;
      if (cfg.COUL_FORCEES && c > 0 && c < 256) dst = mapColor(c);
      else if (cfg.COUL_DUCALQUE && c === BYLAYER && !(ctx === 'BLOCK' && e.layer === '0')) dst = mapColor(Math.abs(layerOf(e.layer)?.color ?? 7));
      if (dst != null && setColor(e, dst)) changed = true;
    }
    if (cfg.COULEUR_UNIQUE && cfg.CU_ENTITES && setColor(e, ctx === 'BLOCK' ? BYBLOCK : cfg.COUL_UNIQUE)) changed = true;
    if (cfg.DUCALQUE && ctx === 'SPACE' && setColor(e, BYLAYER)) changed = true;
    if (cfg.DUBLOC && ctx === 'BLOCK' && setColor(e, BYBLOCK)) changed = true;
    // Types et épaisseurs de ligne
    if (e.ltype && ltMap.has(e.ltype.toUpperCase())) { e.ltype = ltMap.get(e.ltype.toUpperCase()); changed = true; }
    if (cfg.TL_DUCALQUE && ctx === 'SPACE' && e.ltype) { delete e.ltype; changed = true; }
    if (cfg.TL_ECHELLE1 && e.ltscale != null && e.ltscale !== 1) { delete e.ltscale; changed = true; }
    if (cfg.EP_DUCALQUE && e.lweight != null) {
      if (ctx === 'SPACE' && e.lweight !== -1) { delete e.lweight; changed = true; }
      if (ctx === 'BLOCK' && e.lweight >= 0) { e.lweight = -2; changed = true; }
    }
    // Textes
    if (cfg.STYLES && (TEXTS.has(e.type) || e.type === 'ATTDEF') && e.style !== cfg.STYLE_NOM) { e.style = cfg.STYLE_NOM; changed = true; }
    if (mtCodes.size && e.type === 'MTEXT' && typeof e.text === 'string') {
      const t = unformatMtext(e.text, mtCodes, false);
      if (t !== e.text) { e.text = t; changed = true; }
    }
    return changed ? e : e0;
  };

  // Blocs utilisés par l'espace objet (transitivement)
  const usedBlocks = () => {
    const used = new Set();
    const visit = (ents) => {
      for (const e of ents) {
        if ((e.type === 'INSERT' || e.type === 'BLOCKREF') && !used.has(e.name)) {
          used.add(e.name);
          const b = doc.blocks.get(e.name);
          if (b) visit(b.entities);
        }
      }
    };
    visit([...doc.entities.values()].filter((e) => e.space === 'model'));
    return used;
  };
  const emptyBlocks = new Set([...doc.blocks.values()].filter((b) => !b.xref && !b.entities.length).map((b) => b.name));

  // 1. Présentations : seul l'espace objet sert au fond de plan
  if (cfg.PRESENTATIONS) {
    let n = 0;
    for (const [id, e] of doc.entities) if (e.space !== 'model') { doc.entities.delete(id); n++; }
    note('Objets d’espace papier supprimés avec les présentations', n);
    const layouts = doc.spaces.length - 1;
    doc.spaces = doc.spaces.filter((s) => s.id === 'model');
    note('Présentations supprimées', layouts);
  }

  // 2. Définitions de blocs (composants)
  const dimBlocks = new Set([...doc.entities.values()].filter((e) => e.type === 'BLOCKREF').map((e) => e.name));
  for (const b of doc.blocks.values()) {
    if (b.xref) continue;
    const out = [];
    let changed = false;
    for (const e of b.entities) {
      if (skip.has(e.layer)) { out.push(e); continue; }
      const why = delReason(e, emptyBlocks);
      if (why) { note(why); changed = true; continue; }
      let m = modify(e, 'BLOCK');
      if (cfg.COTES_DUBLOC && dimBlocks.has(b.name)) { // composants des cotes : couleur de la cote
        const c = m === e ? structuredClone(e) : m;
        if (setColor(c, BYBLOCK)) m = c;
      }
      if (m !== e) changed = true;
      out.push(m);
    }
    if (cfg.HACH_ARRIERE) out.sort((a, b2) => (a.type === 'HATCH' ? 0 : 1) - (b2.type === 'HATCH' ? 0 : 1));
    if (changed || cfg.HACH_ARRIERE) b.entities = out;
  }

  // 3. Objets de l'espace objet
  let modified = 0;
  const kept = [];
  for (const [id, e] of doc.entities) {
    if (e.space !== 'model' || skip.has(e.layer)) { kept.push([id, e]); continue; }
    const why = delReason(e, emptyBlocks);
    if (why) { note(why); continue; }
    const m = modify(e, 'SPACE');
    if (m !== e) modified++;
    kept.push([id, m]);
  }
  if (cfg.HACH_ARRIERE) kept.sort(([, a], [, b]) => (a.type === 'HATCH' ? 0 : 1) - (b.type === 'HATCH' ? 0 : 1));
  if (cfg.VERR_ARRIERE) kept.sort(([, a], [, b]) => (lay0.get(a.layer)?.locked ? 0 : 1) - (lay0.get(b.layer)?.locked ? 0 : 1));
  doc.entities = new Map(kept);
  note('Objets modifiés', modified);

  // 4. Calques : couleurs, types de ligne, libération
  let layersChanged = 0;
  for (const l of doc.layers.values()) {
    if (l.name.includes('|')) continue;
    let ch = false;
    if (cfg.COULEURS && cfg.COUL_CALQUES) {
      const d = mapColor(Math.abs(l.color ?? 7));
      if (d != null && (d !== Math.abs(l.color) || l.rgb != null)) { l.color = d; delete l.rgb; ch = true; }
    }
    if (cfg.COULEUR_UNIQUE && cfg.CU_CALQUES && (l.color !== cfg.COUL_UNIQUE || l.rgb != null)) { l.color = cfg.COUL_UNIQUE; delete l.rgb; ch = true; }
    if (l.ltype && ltMap.has(l.ltype.toUpperCase())) { l.ltype = ltMap.get(l.ltype.toUpperCase()); ch = true; }
    if (cfg.LIBERER && (l.frozen || l.locked || l.on === false)) { l.frozen = false; l.locked = false; l.on = true; ch = true; }
    if (ch) layersChanged++;
  }
  note('Calques modifiés', layersChanged);
  if (cfg.COTES_CALQUE && !doc.layers.has(cfg.NOM_COTES)) doc.layers.set(cfg.NOM_COTES, defaultLayer(cfg.NOM_COTES));
  if (cfg.HACH_CALQUE && !doc.layers.has(cfg.NOM_HACH)) doc.layers.set(cfg.NOM_HACH, defaultLayer(cfg.NOM_HACH));

  // 5. Purge : blocs et calques inutilisés (éléments imbriqués compris)
  if (cfg.PURGE) {
    const used = usedBlocks();
    let n = 0;
    for (const name of [...doc.blocks.keys()]) {
      if (!used.has(name)) { doc.blocks.delete(name); n++; }
    }
    const usedLayers = new Set(['0']);
    const mark = (e) => { usedLayers.add(e.layer); for (const a of e.attribs || []) usedLayers.add(a.layer); };
    for (const e of doc.entities.values()) mark(e);
    for (const b of doc.blocks.values()) for (const e of b.entities) mark(e);
    for (const name of [...doc.layers.keys()]) if (!usedLayers.has(name) && !/^defpoints$/i.test(name)) { doc.layers.delete(name); n++; }
    note('Éléments purgés (blocs, calques, styles)', n);
  }
  doc.blockVersion = (doc.blockVersion || 0) + 1;

  const secs = (performance.now() - t0) / 1000;
  const lines = [`Traitement de plans : terminé en ${secs.toFixed(1)} s`];
  for (const [k, v] of rep) lines.push(`  ${k} : ${v}`);
  if (!rep.size) lines.push('  Rien à modifier.');
  for (const w of warns) lines.push(`  ! ${w}`);
  return { lines, counts: Object.fromEntries(rep), warnings: [...warns] };
}
