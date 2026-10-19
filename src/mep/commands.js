// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes MEP : GAINE, CANALISATION, CHEMINCABLE, METRE.
import * as G from '../core/geom.js';
import { SYSTEMS, KIND_LABELS, EMBED_LABELS, conduitLtype, kindLabel, systemByCode, ensureSystemLayer, sectionLabel, planWidth, vertexZ } from './systems.js';
import { mepLength, filletedAxis, elbowRadius } from './geometry.js';
import { TRAY_MAKERS, DEFAULT_TRAY_MAKER, catalogRadius } from './trays.js';
import { findClashes } from './clash.js';
import { connectEnds } from './connect.js';
import { sectionEntities, sectionMarker } from './section.js';
import { numberRuns, billOfMaterials, bomCsv, fittings } from './fabrication.js';
import { findReservations, reservationEntities, reservationsCsv } from './reservations.js';
import { expandInserts } from '../editor/boundary.js';
import { installMepConnectivity } from './connectivity.js';
import { ensureSupportBlock, supportEntities, supportsOn, supportSummary, isSupport } from './supports.js';
import { ACCESSORIES, ensureAccessoryBlock, accessoryOn, isAccessory } from './accessories.js';
import { tableEntities } from './table.js';
import { TERMINALS, FIXTURES, EMITTERS, ensureTerminalBlock, terminalSize } from './terminals.js';
import { joinEntities, offsetSigned } from '../core/path.js';
import { buildNetwork, computeFlows, resizeNetwork, flowSections, pressureDrops, designFlow, simultaneity, SANITARY, hydronicFlow, UNIT_TO_M, unitMmOf, slopeNetwork, nearestOnAxis, sizeFor } from './network.js';
import { Cancel, fmt } from '../editor/editor.js';

const last = {
  duct: { system: 'SOUF', w: 400, h: 200, d: 0, shape: 'rect', z: 2700 },
  pipe: { system: 'EF', d: 32, z: 2500 },
  conduit: { system: 'TUB-CFO', d: 20, embed: 'dalle', z: { dalle: 2800, sol: 0, mur: 1100, fauxplancher: 100, fauxplafond: 2900, cdc: 2900, apparent: 2500 } },
  tray: { system: 'CFO', w: 300, h: 60, z: 2900, elbow: DEFAULT_TRAY_MAKER },
};

// « 400x200 », « 400*200 » → rectangulaire ; « Ø250 », « D250 », « d 250 » → circulaire.
export function parseSection(text) {
  const t = String(text).trim().replace(',', '.');
  let m = t.match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { shape: 'rect', w: +m[1], h: +m[2] };
  m = t.match(/^(?:ø|Ø|d|diam(?:ètre)?)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { shape: 'round', d: +m[1] };
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return { shape: 'round', d: +m[1] };
  return null;
}

function mepEntity(doc, layer, mep, pts) {
  return {
    type: 'LWPOLYLINE', layer, color: 256, space: doc.currentSpace || 'model',
    pts: pts.map((p) => [p[0], p[1]]), bulges: pts.map(() => 0), closed: false, z: mep.z || 0, width: 0, mep: { ...mep },
  };
}

// Ajoute un réseau en raccordant ses extrémités posées sur un autre réseau (piquage).
function addConnected(ctx, ent) {
  const r = ctx.editor.r;
  const ids = new Set([...r.near(ent.pts[0], 1), ...r.near(ent.pts[ent.pts.length - 1], 1)]);
  const others = [...ids].map((id) => ctx.doc.get(id)).filter((o) => o?.mep);
  ent.pts = connectEnds(ent, others);
  return ctx.doc.add(ent);
}

// Réglage des coudes d'un chemin de câbles : fabricant (rayon intérieur du catalogue) ou onglet.
export function trayElbow(doc, maker) {
  return maker ? { elbow: 'radius', maker, ri: catalogRadius(maker, unitMmOf(doc)) } : { elbow: 'miter' };
}

// Coudes du catalogue qui ne tiennent pas entre deux changements de direction : dessinés à onglet, signalés.
export function reportShortElbows(ctx, e) {
  const n = e?.mep?.kind === 'tray' ? filletedAxis(e, elbowRadius(e)).short?.length || 0 : 0;
  if (n) ctx.print(`${n} coude(s) à onglet faute de place pour le coude du catalogue (rayon intérieur ${fmt(e.mep.ri ?? planWidth(e.mep) / 2)}) : allongez les tronçons ou choisissez un autre coude.`);
  return n;
}

// Saisie de l'axe point par point (comme POLYLIGN, tronçons droits).
// opts.keywords / opts.onKeyword : options proposées avec le point de départ (ex. « Coudes ») ;
// opts.more : un tronçon est déjà dessiné (Entrée au point de départ termine : renvoie null).
// Renvoie { pts, escaped } ; escaped : tronçon terminé par Échap (la commande s'arrête après lui).
async function drawAxis(ctx, build, opts = {}) {
  const prompt = opts.more ? 'Point de départ du réseau suivant (Entrée pour terminer)' : 'Point de départ du réseau';
  const ask = () => ctx.getPoint(prompt, { ...(opts.keywords ? { keywords: opts.keywords } : {}), allowNone: true });
  let first = await ask();
  while (typeof first === 'string') {
    await opts.onKeyword(first);
    first = await ask();
  }
  if (first == null) return null;
  const pts = [first];
  try {
    while (true) {
      const base = pts[pts.length - 1];
      const r = await ctx.getPoint('Point suivant', {
        base, keywords: ['annUler'], allowNone: true, preview: (p) => [build([...pts, p])],
      });
      if (r === null) break;
      if (r === 'annUler') { if (pts.length > 1) pts.pop(); continue; }
      if (G.dist(base, r) < 1e-9) continue;
      pts.push(r);
    }
  } catch (err) {
    if (!(err instanceof Cancel)) throw err;
    if (pts.length >= 2) return { pts, escaped: true };
    throw err;
  }
  return { pts, escaped: false };
}

// Dessin en continu : un tronçon terminé par Entrée, on en commence un autre avec les mêmes réglages ; Entrée au point
// de départ (deux fois Entrée) ou Échap termine la commande. add(pts) crée l'objet de chaque tronçon.
async function drawRuns(ctx, build, add, opts = {}) {
  let n = 0;
  for (;;) {
    let r;
    try {
      r = await drawAxis(ctx, build, { ...opts, more: n > 0 });
    } catch (err) {
      if (err instanceof Cancel && n > 0) return n; // Échap entre deux tronçons : ce qui est dessiné reste
      throw err;
    }
    if (!r) return n;
    if (r.pts.length >= 2) { add(r.pts); n++; }
    if (r.escaped) return n;
  }
}

async function chooseSystem(ctx, kind) {
  const list = SYSTEMS.filter((s) => s.kind === kind && !s.conduit); // tubes électriques : commande TUBE
  const codes = list.map((s) => s.code);
  ctx.print(list.map((s) => `${s.code} = ${s.label}`).join(' · '));
  const r = await ctx.getKeyword('Système', codes, { default: last[kind].system });
  return systemByCode(r);
}

export function registerMepCommands(ed) {
  // Raccordements maintenus quand un réseau bouge (piquages et prolongements suivent).
  (ed.docHooks ||= []).push((doc) => installMepConnectivity(doc));
  if (ed.doc) installMepConnectivity(ed.doc);

  // « Dessiner une canalisation EF Ø32… » (clic droit, AJOUTSELECT) : même réseau, section, altitude et coudes,
  // sans question ; les valeurs deviennent celles proposées par GAINE, CANALISATION, TUBE et CHEMINCABLE.
  (ed.addSelected ||= []).push({
    label(e) {
      const m = e.type === 'LWPOLYLINE' && e.mep;
      if (!m || !['duct', 'pipe', 'tray'].includes(m.kind)) return null;
      const sec = sectionLabel(m).replace(/^CDC /, '');
      if (m.conduit) return `un tube ${m.system} ${sec}${m.embed ? ` ${EMBED_LABELS[m.embed] || ''}` : ''}`.trim();
      if (m.kind === 'tray') return `un chemin de câbles ${m.system} ${sec}`;
      return `${m.kind === 'duct' ? 'une gaine' : 'une canalisation'} ${m.system} ${sec}`;
    },
    async draw(ctx, e) {
      const { doc } = ctx;
      const m = structuredClone(e.mep);
      for (const k of ['z1', 'num', 'flow', 'q']) delete m[k]; // pente, numéro, sens, débit calculé : propres à l'original
      m.z = e.mep.z ?? e.z ?? 0;
      const sys = systemByCode(m.system);
      const layer = sys ? ensureSystemLayer(doc, sys) : e.layer;
      if (m.conduit) {
        Object.assign(last.conduit, { system: m.system, d: m.d, embed: m.embed || 'dalle' });
        last.conduit.z[m.embed || 'dalle'] = m.z;
      } else if (m.kind === 'tray') Object.assign(last.tray, { system: m.system, w: m.w, h: m.h, z: m.z, elbow: m.elbow === 'miter' ? 'miter' : m.maker || last.tray.elbow });
      else Object.assign(last[m.kind], { system: m.system, z: m.z, ...(m.kind === 'pipe' ? { d: m.d } : { shape: m.shape, w: m.w, h: m.h, d: m.d }) });
      ctx.print(`${kindLabel(m)} ${m.system} ${sectionLabel(m)}, altitude ${fmt(m.z)}.`);
      const make = (q) => ({ ...mepEntity(doc, layer, m, q), ...(m.conduit ? { ltype: conduitLtype(m.embed) } : {}) });
      await drawRuns(ctx, make, (pts) => {
        const ent = make(pts);
        if (m.kind === 'pipe') doc.add(ent);
        else reportShortElbows(ctx, addConnected(ctx, ent));
      });
    },
  }, {
    // Bouches, appareils sanitaires, émetteurs : libellé seulement, reproduits comme des blocs (mêmes données).
    label(e) {
      const m = e.type === 'INSERT' && e.mep?.kind === 'terminal' && e.mep;
      const t = m && (TERMINALS[m.terminal] || FIXTURES[m.terminal] || EMITTERS[m.terminal]);
      return t ? `« ${t.label} » ${m.system || ''}`.trim() : null;
    },
    draw: null,
  });

  ed.register('GAINE', async (ctx) => {
    const { doc } = ctx;
    const sys = await chooseSystem(ctx, 'duct');
    const L = last.duct;
    const def = L.shape === 'round' ? `Ø${L.d}` : `${L.w}x${L.h}`;
    let sec = null;
    while (!sec) {
      const t = await ctx.getString('Section (LxH en mm, ou Ø diamètre)', { default: def });
      sec = parseSection(t);
      if (!sec) ctx.print('Section non reconnue : tapez par exemple 400x200 ou Ø250.');
    }
    const z = await ctx.getDistance('Altitude de l’axe', { default: L.z });
    Object.assign(L, { system: sys.code, z, ...sec });
    const layer = ensureSystemLayer(doc, sys);
    const mep = { kind: 'duct', system: sys.code, shape: sec.shape, w: sec.w || 0, h: sec.h || 0, d: sec.d || 0, z };
    await drawRuns(ctx, (p) => mepEntity(doc, layer, mep, p), (pts) => {
      addConnected(ctx, mepEntity(doc, layer, mep, pts));
      ctx.print(`Gaine ${sys.label} ${sectionLabel(mep)} : ${pts.length - 1} tronçon(s).`);
    });
  }, { aliases: ['GA', 'DUCT'], label: 'GAINE' });

  ed.register('CANALISATION', async (ctx) => {
    const { doc } = ctx;
    const sys = await chooseSystem(ctx, 'pipe');
    const L = last.pipe;
    const d = await ctx.getDistance('Diamètre nominal (mm)', { default: L.d });
    const z = await ctx.getDistance('Altitude de l’axe', { default: L.z });
    Object.assign(L, { system: sys.code, d, z });
    const layer = ensureSystemLayer(doc, sys);
    const mep = { kind: 'pipe', system: sys.code, shape: 'round', d, z };
    await drawRuns(ctx, (p) => mepEntity(doc, layer, mep, p), (pts) => doc.add(mepEntity(doc, layer, mep, pts)));
  }, { aliases: ['CA', 'CANA', 'PIPE', 'TUYAU'], label: 'CANALISATION' });

  // Tube électrique (noyé en dalle, en mur, ou apparent) : cheminement des câbles comme les chemins de câbles.
  ed.register('TUBE', async (ctx) => {
    const { doc } = ctx;
    const list = SYSTEMS.filter((s) => s.conduit);
    ctx.print(list.map((s) => `${s.code} = ${s.label}`).join(' · '));
    const L = last.conduit;
    const sys = systemByCode(await ctx.getKeyword('Système', list.map((s) => s.code), { default: L.system }));
    const d = await ctx.getDistance('Diamètre du tube (M16, M20, M25, M32, M40)', { default: L.d });
    // Une lettre par pose : Dalle (noyé plafond), Sol, Mur, Plancher (faux-plancher), Faux-plafond, Cdc, Apparent.
    const kws = { Dalle: 'dalle', Sol: 'sol', Mur: 'mur', Plancher: 'fauxplancher', Fauxplafond: 'fauxplafond', Cdc: 'cdc', Apparent: 'apparent' };
    const kw = await ctx.getKeyword('Pose', Object.keys(kws), { default: Object.keys(kws).find((k) => kws[k] === L.embed) || 'Dalle' });
    const embed = kws[kw];
    const z = await ctx.getDistance('Altitude de l’axe', { default: L.z[embed] });
    Object.assign(L, { system: sys.code, d, embed });
    L.z[embed] = z;
    const layer = ensureSystemLayer(doc, sys);
    const mep = { kind: 'pipe', conduit: true, embed, system: sys.code, shape: 'round', d, z };
    const make = (p) => ({ ...mepEntity(doc, layer, mep, p), ltype: conduitLtype(embed) });
    const n = await drawRuns(ctx, make, (pts) => doc.add(make(pts)));
    if (n) ctx.print(`${n} tube(s) M${d} ${EMBED_LABELS[embed]} (${sys.code}).`);
  }, { aliases: ['TUBEELEC', 'CONDUIT'], label: 'TUBE' });

  ed.register('CHEMINCABLE', async (ctx) => {
    const { doc } = ctx;
    const sys = await chooseSystem(ctx, 'tray');
    const L = last.tray;
    let sec = null;
    while (!sec || sec.shape !== 'rect') {
      sec = parseSection(await ctx.getString('Largeur x hauteur (mm)', { default: `${L.w}x${L.h}` }));
      if (!sec || sec.shape !== 'rect') ctx.print('Tapez par exemple 300x60.');
    }
    const z = await ctx.getDistance('Altitude du dessous', { default: L.z });
    Object.assign(L, { system: sys.code, w: sec.w, h: sec.h, z });
    const layer = ensureSystemLayer(doc, sys);
    const mep = { kind: 'tray', system: sys.code, shape: 'rect', w: sec.w, h: sec.h, z, ...trayElbow(doc, L.elbow === 'miter' ? null : L.elbow) };
    ctx.print(`Coudes : ${mep.elbow === 'miter' ? 'à onglet' : `${TRAY_MAKERS[mep.maker].label}, rayon intérieur ${fmt(mep.ri)} par défaut, à vérifier dans le catalogue`} (option « Coudes » pour changer).`);
    // Option « Coudes » : à rayon selon le catalogue du fabricant, ou à onglet (retenu pour les suivants).
    const onKeyword = async () => {
      const makers = Object.values(TRAY_MAKERS).map((x) => x.kw);
      const kw = await ctx.getKeyword('Coudes', [...makers, 'Onglet'], { default: L.elbow === 'miter' ? 'Onglet' : TRAY_MAKERS[L.elbow]?.kw || makers[0] });
      L.elbow = kw === 'Onglet' ? 'miter' : Object.keys(TRAY_MAKERS).find((k) => TRAY_MAKERS[k].kw === kw);
      for (const k of ['elbow', 'maker', 'ri']) delete mep[k];
      Object.assign(mep, trayElbow(doc, L.elbow === 'miter' ? null : L.elbow));
    };
    await drawRuns(ctx, (p) => mepEntity(doc, layer, mep, p), (pts) => reportShortElbows(ctx, addConnected(ctx, mepEntity(doc, layer, mep, pts))), { keywords: ['Coudes'], onKeyword });
  }, { aliases: ['CDC', 'TRAY'], label: 'CHEMINCABLE' });

  ed.register('CONVMEP', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection('Choisissez les lignes / polylignes à convertir en réseau');
    const ents = ids.map((id) => doc.get(id)).filter((e) => e && !e.mep && ['LINE', 'LWPOLYLINE', 'POLY3D'].includes(e.type));
    if (!ents.length) { ctx.print('Aucune ligne ou polyligne dans la sélection.'); return; }
    const kw = await ctx.getKeyword('Type de réseau', ['Gaine', 'Canalisation', 'Chemin'], { default: 'Gaine' });
    const kind = kw === 'Gaine' ? 'duct' : kw === 'Canalisation' ? 'pipe' : 'tray';
    const sys = await chooseSystem(ctx, kind);
    const L = last[kind];
    let mep;
    if (kind === 'pipe') {
      const d = await ctx.getDistance('Diamètre nominal (mm)', { default: L.d });
      mep = { kind, system: sys.code, shape: 'round', d };
    } else {
      let sec = null;
      const def = kind === 'tray' ? `${L.w}x${L.h}` : L.shape === 'round' ? `Ø${L.d}` : `${L.w}x${L.h}`;
      while (!sec || (kind === 'tray' && sec.shape !== 'rect')) {
        sec = parseSection(await ctx.getString('Section (LxH ou Ø)', { default: def }));
        if (!sec) ctx.print('Section non reconnue.');
      }
      mep = { kind, system: sys.code, shape: sec.shape, w: sec.w || 0, h: sec.h || 0, d: sec.d || 0 };
    }
    mep.z = await ctx.getDistance(kind === 'tray' ? 'Altitude du dessous' : 'Altitude de l’axe', { default: L.z });
    Object.assign(L, mep);
    if (kind === 'tray') Object.assign(mep, trayElbow(doc, L.elbow === 'miter' ? null : L.elbow || DEFAULT_TRAY_MAKER));
    const layer = ensureSystemLayer(doc, sys);
    // Les morceaux qui se touchent bout à bout deviennent un seul réseau.
    let remaining = ents.map((e) => (e.type === 'POLY3D'
      ? { ...e, type: 'LWPOLYLINE', pts: e.pts.map((p) => [p[0], p[1]]), bulges: e.pts.map(() => 0), z: 0 } : e));
    const avg = remaining.reduce((sum, e) => sum + (e.type === 'LINE' ? G.dist(e.p1, e.p2) : 0), 0) / remaining.length;
    const tol = Math.max(1e-6, (avg || 1) * 1e-3);
    let made = 0;
    while (remaining.length) {
      const closed = remaining.find((e) => e.type === 'LWPOLYLINE' && e.closed);
      let pts, bulges, used;
      if (closed) {
        pts = [...closed.pts, closed.pts[0]].map((p) => [p[0], p[1]]);
        bulges = [...(closed.bulges || closed.pts.map(() => 0)), 0];
        used = [closed.id];
      } else {
        const r = joinEntities(remaining, tol);
        if (!r) break;
        pts = r.entity.pts; bulges = r.entity.bulges; used = r.used;
        if (r.entity.closed) { pts = [...pts, pts[0]]; bulges = [...bulges, 0]; }
      }
      for (const id of used) doc.remove(id);
      const ent = mepEntity(doc, layer, mep, pts);
      ent.bulges = bulges.slice(0, pts.length);
      while (ent.bulges.length < pts.length) ent.bulges.push(0);
      doc.add(ent);
      made++;
      remaining = remaining.filter((e) => !used.includes(e.id));
    }
    // Piquages : les réseaux convertis dont une extrémité touche un autre réseau s'arrêtent sur sa paroi.
    const all = [...doc.entities.values()].filter((x) => x.mep && x.type === 'LWPOLYLINE');
    for (const x of all) {
      if (x.mep.system !== sys.code || x.mep.kind !== kind) continue;
      const pts = connectEnds(x, all);
      if (pts !== x.pts && JSON.stringify(pts) !== JSON.stringify(x.pts)) doc.modify(x.id, (y) => { y.pts = pts; });
    }
    ctx.print(`${ents.length} objet(s) convertis en ${made} réseau(x) ${sys.label} ${sectionLabel(mep)}.`);
  }, { aliases: ['CONV', 'CONVERTIR'], label: 'CONVMEP' });

  // Étiquette d'un réseau : ligne de rappel depuis `anchor` jusqu'à `p`, palier et texte.
  function tagEntities(doc, e, anchor, p, h) {
    const unit = UNIT_TO_M[doc.header?.insunits] ?? 0.001;
    const zf = (v) => { const z = v * unit; return `${z >= 0 ? '+' : ''}${z.toFixed(2).replace('.', ',')}`; };
    // Réseau en pente : altitudes des deux extrémités.
    const zs = e.mep.z1 != null ? `${zf(e.mep.z || 0)} → ${zf(e.mep.z1)}` : zf(e.mep.z || 0);
    const label = `${e.mep.system} ${sectionLabel(e.mep)} — Z ${zs} m`;
    const right = p[0] >= anchor[0];
    const shoulder = [p[0] + (right ? 1 : -1) * h * 0.8, p[1]];
    const dir = G.norm(G.sub(anchor, p));
    const ah = h * 0.9, aw = h * 0.25;
    const back = G.sub(anchor, G.mul(dir, ah));
    const n = G.perp(dir);
    return {
      label,
      entities: [
        { type: 'LWPOLYLINE', layer: e.layer, color: 256, pts: [[anchor[0], anchor[1]], [p[0], p[1]], shoulder], bulges: [0, 0, 0], closed: false, z: 0, width: 0 },
        { type: 'SOLID', layer: e.layer, color: 256, pts: [anchor, G.add(back, G.mul(n, aw)), G.sub(back, G.mul(n, aw)), G.sub(back, G.mul(n, aw))], z: 0 },
        {
          type: 'TEXT', layer: e.layer, color: 256, p: [shoulder[0] + (right ? 1 : -1) * h * 0.4, shoulder[1], 0], h, rot: 0,
          text: label, align: right ? 'left' : 'right', valign: 'middle', wf: 1,
        },
      ],
    };
  }

  ed.register('ETIQMEP', async (ctx) => {
    const { doc, editor } = ctx;
    const scale = doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    const h = 2.5 * scale;
    const space = doc.currentSpace || 'model';
    while (true) {
      const pick = await ctx.getEntity('Choisissez un réseau à étiqueter', { allowNone: true, keywords: ['Tous'] });
      if (pick === null) return;
      if (pick === 'Tous') {
        // Tous les réseaux visibles : étiquette au milieu du plus long tronçon, décalée sur le côté.
        let n = 0;
        for (const e of [...doc.entities.values()]) {
          if (!e.mep || e.type !== 'LWPOLYLINE' || e.space !== space || !editor.r.layerVisible(e.layer) || e.pts.length < 2) continue;
          let bi = 1, best = 0;
          for (let i = 1; i < e.pts.length; i++) { const d = G.dist(e.pts[i - 1], e.pts[i]); if (d > best) { best = d; bi = i; } }
          const a = e.pts[bi - 1], b = e.pts[bi];
          const anchor = G.lerp(a, b, 0.35);
          const off = (planWidth(e.mep) / 2 || 0) + h * 4;
          const p = G.add(anchor, G.mul(G.perp(G.norm(G.sub(b, a))), off));
          for (const x of tagEntities(doc, e, anchor, p, h).entities) doc.add({ ...x, space });
          n++;
        }
        ctx.print(`${n} réseau(x) étiqueté(s).`);
        return;
      }
      const e = doc.get(pick.id);
      if (!e?.mep || e.type !== 'LWPOLYLINE') { ctx.print('Ce n’est pas un réseau MEP.'); continue; }
      // Point d'attache : projection du clic sur l'axe du réseau.
      let anchor = pick.p, bd = Infinity;
      for (let i = 1; i < e.pts.length; i++) {
        const r = G.closestOnSegment(pick.p, e.pts[i - 1], e.pts[i]);
        if (r.d < bd) { bd = r.d; anchor = r.point; }
      }
      const sys = systemByCode(e.mep.system);
      const at = await ctx.getPoint('Position de l’étiquette', { base: anchor, preview: (q) => tagEntities(doc, e, anchor, q, h).entities });
      const tag = tagEntities(doc, e, anchor, at, h);
      for (const x of tag.entities) doc.add({ ...x, space });
      ctx.print(`Étiquette : ${tag.label}${sys ? ` (${sys.label})` : ''}`);
    }
  }, { aliases: ['ETIQ', 'TAG'], label: 'ETIQMEP' });

  ed.register('SENS', async (ctx) => {
    const { doc } = ctx;
    while (true) {
      const pick = await ctx.getEntity('Choisissez un réseau (flèches : aucune → sens du tracé → inverse)', { allowNone: true });
      if (pick === null) return;
      const e = doc.get(pick.id);
      if (!e?.mep || e.type !== 'LWPOLYLINE') { ctx.print('Ce n’est pas un réseau MEP.'); continue; }
      const next = !e.mep.flow ? 1 : e.mep.flow > 0 ? -1 : 0;
      doc.modify(e.id, (x) => { x.mep.flow = next; });
      ctx.print(next ? `Sens ${next > 0 ? 'du tracé' : 'inverse'}.` : 'Flèches masquées.');
    }
  }, { aliases: ['FLOW', 'FLECHE'], label: 'SENS' });

  const lastTerm = { type: 'DIFF', w: 600, h: 600, d: 200, z: 2700, q: 150 };
  ed.register('BOUCHE', async (ctx) => {
    const { doc } = ctx;
    const air = Object.entries(TERMINALS).filter(([, t]) => !t.water && !t.hydro);
    ctx.print(air.map(([k, t]) => `${k} = ${t.label}`).join(' · '));
    const type = await ctx.getKeyword('Type de terminal', air.map(([k]) => k), { default: lastTerm.type });
    const defSys = type === 'GRILLE' ? 'REP' : type === 'BOUCHE' ? 'EXT' : 'SOUF';
    const list = SYSTEMS.filter((s) => s.kind === 'duct');
    const sys = systemByCode(await ctx.getKeyword('Système', list.map((s) => s.code), { default: defSys }));
    const spec = { w: lastTerm.w, h: lastTerm.h, d: lastTerm.d };
    if (TERMINALS[type].round) {
      spec.d = await ctx.getDistance('Diamètre (mm)', { default: lastTerm.d });
    } else {
      let sec = null;
      while (!sec || sec.shape !== 'rect') {
        sec = parseSection(await ctx.getString('Dimensions (LxH en mm)', { default: `${lastTerm.w}x${lastTerm.h}` }));
        if (!sec || sec.shape !== 'rect') ctx.print('Tapez par exemple 600x600.');
      }
      spec.w = sec.w; spec.h = sec.h;
    }
    const z = await ctx.getDistance('Altitude', { default: lastTerm.z });
    const q = await ctx.getDistance('Débit (m³/h)', { default: lastTerm.q });
    Object.assign(lastTerm, { type, z, q, ...spec });
    const layer = ensureSystemLayer(doc, sys);
    const name = ensureTerminalBlock(doc, type, spec);
    const mk = (p) => ({
      type: 'INSERT', name, p: [p[0], p[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], layer, color: 256,
      space: doc.currentSpace || 'model', mep: { kind: 'terminal', terminal: type, system: sys.code, ...spec, z, q },
    });
    let n = 0;
    while (true) {
      const p = await ctx.getPoint('Position du terminal', { allowNone: true, preview: (q) => [mk(q)] });
      if (p === null) break;
      doc.add(mk(p));
      n++;
    }
    ctx.print(`${n} ${TERMINALS[type].label.toLowerCase()}(s) ${terminalSize(type, spec)} placé(s).`);
  }, { aliases: ['BO', 'TERMINAL', 'DIFFUSEUR'], label: 'BOUCHE' });

  // --- Débits et dimensionnement ---------------------------------------------------
  const networkOf = (ctx, kind = 'duct') => buildNetwork([...ctx.doc.entities.values()].filter((e) => e.space === ctx.editor.r.space), kind);
  const qText = (q, kind) => (kind === 'pipe' ? `${q.toFixed(q < 1 ? 3 : 2).replace('.', ',')} l/s` : `${Math.round(q)} m³/h`);

  // Origine du réseau : l'extrémité de la gaine (ou de la canalisation) choisie la plus proche du clic.
  async function pickSource(ctx, kinds, prompt = null) {
    const what = kinds.includes('pipe') ? (kinds.includes('duct') ? 'la gaine ou la canalisation' : 'la canalisation') : 'la gaine';
    while (true) {
      const pick = await ctx.getEntity(prompt || `Choisissez ${what} de départ, près de son extrémité côté production`);
      const e = ctx.doc.get(pick.id);
      if (!e?.mep || e.type !== 'LWPOLYLINE' || !kinds.includes(e.mep.kind) || e.pts.length < 2) { ctx.print(`Choisissez ${what}.`); continue; }
      const net = networkOf(ctx, e.mep.kind);
      const L = net.st.get(e.id).at(-1);
      const s = G.dist(pick.p, e.pts[0]) <= G.dist(pick.p, e.pts[e.pts.length - 1]) ? 0 : L;
      return { net, id: e.id, s, system: e.mep.system, kind: e.mep.kind };
    }
  }
  const hasRuns = (ctx, kinds) => [...ctx.doc.entities.values()].some((e) => e.mep && e.type === 'LWPOLYLINE' && kinds.includes(e.mep.kind));

  function flowReport(ctx, net, flows, src) {
    const terms = [...flows.values()].flatMap((f) => f.taps.filter((t) => t.terminal));
    const noFlow = terms.filter((t) => !t.q).length;
    const lost = net.unconnected.filter((id) => ctx.doc.get(id)?.mep?.system === src.system);
    const info = flows.get(src.id);
    const what = src.kind === 'pipe' ? 'appareil(s)' : 'bouche(s)';
    const head = src.kind === 'pipe' && !SANITARY.has(src.system)
      ? `Débit à l’origine : ${qText(info.q, 'pipe')} (${info.n} émetteur(s))`
      : src.kind === 'pipe'
      ? `Débit probable à l’origine : ${qText(designFlow(info, 'pipe', src.system), 'pipe')} (somme ${qText(info.q, 'pipe')}, ${info.n} appareils, y = ${simultaneity(info.n).toFixed(2).replace('.', ',')})`
      : `Débit à l’origine : ${qText(info.q, 'duct')}`;
    ctx.print(`${head} — ${flows.size} tronçon(s), ${terms.length} ${what} raccordé(s)${noFlow ? `, dont ${noFlow} sans débit` : ''}.`);
    if (lost.length) {
      ctx.print(`${lost.length} ${what} ${src.system} trop loin d’un réseau : non comptés (sélectionnés).`);
      ctx.editor.setSelection(lost);
    }
  }

  ed.register('DEBITS', async (ctx) => {
    const { doc } = ctx;
    if (!hasRuns(ctx, ['duct', 'pipe'])) { ctx.print('Aucune gaine ni canalisation dans le dessin.'); return; }
    const src = await pickSource(ctx, ['duct', 'pipe']);
    const flows = computeFlows(src.net, src.id, src.s);
    for (const [id, info] of flows) {
      const q = src.kind === 'pipe' ? Math.round(designFlow(info, 'pipe', src.system) * 10000) / 10000 : Math.round(info.q);
      if (doc.get(id).mep.q !== q) doc.modify(id, (x) => { x.mep.q = q; });
    }
    flowReport(ctx, src.net, flows, src);
    const multi = [...flows.values()].filter((f) => flowSections(f).length > 1).length;
    if (multi) ctx.print(`${multi} tronçon(s) changent de débit le long de leur tracé : DIMENSIONNER les découpe après chaque piquage.`);
  }, { aliases: ['DEBIT', 'FLOWS'], label: 'DEBITS' });

  const lastV = { duct: 4, pipe: 1.5 };
  ed.register('DIMENSIONNER', async (ctx) => {
    const { doc } = ctx;
    if (!hasRuns(ctx, ['duct', 'pipe'])) { ctx.print('Aucune gaine ni canalisation dans le dessin.'); return; }
    const src = await pickSource(ctx, ['duct', 'pipe']);
    const vmax = await ctx.getDistance(src.kind === 'pipe' ? 'Vitesse maximale de l’eau (m/s)' : 'Vitesse maximale de l’air (m/s)', { default: lastV[src.kind] });
    if (!(vmax > 0)) { ctx.print('Vitesse non valide.'); return; }
    lastV[src.kind] = vmax;
    const flows = computeFlows(src.net, src.id, src.s);
    if (!flows.get(src.id).q) { ctx.print(`Débit nul : indiquez le débit des ${src.kind === 'pipe' ? 'appareils (APPAREIL' : 'bouches (BOUCHE'}, ou panneau Propriétés).`); return; }
    const unitMm = (UNIT_TO_M[doc.header?.insunits] ?? 0.001) * 1000;
    const res = resizeNetwork(src.net, flows, { vmax, unitMm });
    let added = 0;
    for (const { id, pieces } of res) {
      for (const p of pieces) {
        if (p.id === id) doc.update(p);
        else { const { handle, ...rest } = p; doc.add(rest); added++; }
      }
    }
    flowReport(ctx, src.net, flows, src);
    ctx.print(`${res.length} ${src.kind === 'pipe' ? 'canalisation(s)' : 'gaine(s)'} dimensionnée(s) à ${String(vmax).replace('.', ',')} m/s, ${added} réduction(s) créée(s).`);
  }, { aliases: ['DIMRES', 'SIZING'], label: 'DIMENSIONNER' });

  let lastTerminalDp = 20;
  const lastTerminalKpa = { sanitary: 100, hydronic: 15 };
  ed.register('PERTESCHARGE', async (ctx) => {
    const { doc, editor } = ctx;
    if (!hasRuns(ctx, ['duct', 'pipe'])) { ctx.print('Aucune gaine ni canalisation dans le dessin.'); return; }
    const src = await pickSource(ctx, ['duct', 'pipe']);
    const net = src.net;
    const water = src.kind === 'pipe';
    const sanitary = SANITARY.has(src.system);
    let terminalDp;
    if (water) {
      const k = sanitary ? 'sanitary' : 'hydronic';
      lastTerminalKpa[k] = await ctx.getDistance(sanitary ? 'Pression nécessaire aux appareils (kPa)' : 'Perte de charge des émetteurs et robinets (kPa)', { default: lastTerminalKpa[k] });
      terminalDp = lastTerminalKpa[k] * 1000;
    } else {
      lastTerminalDp = await ctx.getDistance('Perte de charge des bouches (Pa)', { default: lastTerminalDp });
      terminalDp = lastTerminalDp;
    }
    const flows = computeFlows(net, src.id, src.s);
    if (!flows.get(src.id).q) { ctx.print(`Débit nul : indiquez le débit des ${water ? 'appareils' : 'bouches'} (panneau Propriétés).`); return; }
    const unitMm = (UNIT_TO_M[doc.header?.insunits] ?? 0.001) * 1000;
    const r = pressureDrops(net, flows, src.id, src.s, { terminalDp, unitMm, staticHead: water && sanitary });
    if (!r.critical) { ctx.print(`Aucun${water ? ' appareil' : 'e bouche'} raccordé${water ? '' : 'e'} à ce réseau.`); return; }
    const fmtDp = (v) => (water ? `${(v / 1000).toFixed(1).replace('.', ',')} kPa` : `${Math.round(v)} Pa`);
    ctx.print(water
      ? `Pression nécessaire à l’origine : ${fmtDp(r.max)} (${r.terminals.length} appareil(s)${sanitary ? ', hauteur statique comprise' : ''}).`
      : `Bouche la plus défavorisée : ${fmtDp(r.max)} depuis l'origine (${r.terminals.length} bouche(s), débit ${Math.round(flows.get(src.id).q)} m³/h).`);
    ctx.print('Chemin critique sélectionné ; la liste donne la perte à créer (organe de réglage) sur chaque terminal pour équilibrer.');
    editor.setSelection([...r.critical.path, r.critical.id]);
    showPressureDrops(r, doc, editor, water);
  }, { aliases: ['PDC', 'PRESSION'], label: 'PERTESCHARGE', transaction: false });

  // Émetteurs de chauffage / eau glacée : débit = puissance / (ρ·c·ΔT).
  const lastEm = { type: 'RADIATEUR', power: 1500, z: 200 };
  ed.register('EMETTEUR', async (ctx) => {
    const { doc } = ctx;
    ctx.print(Object.entries(EMITTERS).map(([k, f]) => `${k} = ${f.label}`).join(' · '));
    const type = await ctx.getKeyword('Émetteur', Object.keys(EMITTERS), { default: lastEm.type });
    const hydro = SYSTEMS.filter((s) => s.kind === 'pipe' && /^(CH|EG)-/.test(s.code));
    const sys = systemByCode(await ctx.getKeyword('Réseau', hydro.map((s) => s.code), { default: EMITTERS[type].system }));
    const power = await ctx.getDistance('Puissance (W)', { default: lastEm.power });
    const dt = await ctx.getDistance('Écart de température ΔT (K)', { default: sys.code.startsWith('EG') ? 5 : 10 });
    const q = Math.round(hydronicFlow(power, dt) * 10000) / 10000;
    if (!(q > 0)) { ctx.print('Puissance ou ΔT non valide.'); return; }
    const z = await ctx.getDistance('Altitude', { default: lastEm.z });
    Object.assign(lastEm, { type, power, z });
    const layer = ensureSystemLayer(doc, sys);
    const spec = { w: EMITTERS[type].w, h: EMITTERS[type].h };
    const name = ensureTerminalBlock(doc, type, spec);
    const mk = (p) => ({
      type: 'INSERT', name, p: [p[0], p[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], layer, color: 256,
      space: doc.currentSpace || 'model', mep: { kind: 'terminal', terminal: type, system: sys.code, ...spec, z, q, power, dt, hydro: true },
    });
    let n = 0;
    while (true) {
      const p = await ctx.getPoint('Position de l’émetteur (à l’extrémité ou le long de la canalisation)', { allowNone: true, preview: (pt) => [mk(pt)] });
      if (p === null) break;
      doc.add(mk(p));
      n++;
    }
    ctx.print(`${n} ${EMITTERS[type].label.toLowerCase()}(s) de ${power} W (${String(q).replace('.', ',')} l/s, ΔT ${dt} K) sur ${sys.code}.`);
  }, { aliases: ['EM', 'RADIATEUR', 'EMITTER'], label: 'EMETTEUR' });

  // Appareils sanitaires (terminaux des réseaux d'eau froide / chaude).
  const lastFix = { type: 'LAVABO', system: 'EF', z: 900 };
  ed.register('APPAREIL', async (ctx) => {
    const { doc } = ctx;
    ctx.print(Object.entries(FIXTURES).map(([k, f]) => `${k} = ${f.label} (${String(f.ef).replace('.', ',')} l/s)`).join(' · '));
    const type = await ctx.getKeyword('Appareil', Object.keys(FIXTURES), { default: lastFix.type });
    const water = SYSTEMS.filter((s) => s.kind === 'pipe' && ['EF', 'ECS'].includes(s.code));
    const sys = systemByCode(await ctx.getKeyword('Réseau', water.map((s) => s.code), { default: lastFix.system }));
    const q = FIXTURES[type][sys.code === 'ECS' ? 'ecs' : 'ef'];
    if (!q) { ctx.print(`${FIXTURES[type].label} : pas d’alimentation ${sys.code}.`); return; }
    const z = await ctx.getDistance('Altitude du raccordement', { default: lastFix.z });
    Object.assign(lastFix, { type, system: sys.code, z });
    const layer = ensureSystemLayer(doc, sys);
    const spec = { d: 150 };
    const name = ensureTerminalBlock(doc, type, spec);
    const mk = (p) => ({
      type: 'INSERT', name, p: [p[0], p[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], layer, color: 256,
      space: doc.currentSpace || 'model', mep: { kind: 'terminal', terminal: type, system: sys.code, ...spec, z, q, water: true },
    });
    let n = 0;
    while (true) {
      const p = await ctx.getPoint('Position de l’appareil (sur la canalisation ou à son extrémité)', { allowNone: true, preview: (pt) => [mk(pt)] });
      if (p === null) break;
      doc.add(mk(p));
      n++;
    }
    ctx.print(`${n} ${FIXTURES[type].label.toLowerCase()}(s) placé(s) sur le réseau ${sys.code} (${String(q).replace('.', ',')} l/s chacun).`);
  }, { aliases: ['APP', 'SANITAIRE', 'FIXTURE'], label: 'APPAREIL' });

  // Coupe des réseaux le long d'une ligne de coupe.
  let lastDepth = 3000, sectionCount = 0;
  ed.register('COUPE', async (ctx) => {
    const { doc } = ctx;
    const space = doc.currentSpace || 'model';
    const seg = (a, b) => ({ type: 'LINE', layer: doc.currentLayer, color: 256, space, p1: [a[0], a[1], 0], p2: [b[0], b[1], 0] });
    const p1 = await ctx.getPoint('Premier point de la ligne de coupe');
    const p2 = await ctx.getPoint('Deuxième point (la coupe regarde à gauche du tracé)', { base: p1, preview: (p) => [seg(p1, p)] });
    if (G.dist(p1, p2) < 1e-9) { ctx.print('Ligne de coupe nulle.'); return; }
    lastDepth = await ctx.getDistance('Profondeur de vue', { default: lastDepth });
    if (!doc.layers.has('MEP-COUPE')) doc.addLayer('MEP-COUPE', { color: 7 });
    const name = String.fromCharCode(65 + (sectionCount % 26));
    const scale = doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    const opts = { depth: lastDepth, unitM: UNIT_TO_M[doc.header?.insunits] ?? 0.001, textH: 2.5 * scale, layer: 'MEP-COUPE', title: `COUPE ${name}-${name}` };
    const ents = [...doc.entities.values()].filter((e) => e.space === space);
    // Murs coupés : calques MUR / WALL / CLOISON / VOILE / PAROI (xrefs et blocs compris).
    opts.walls = expandInserts(doc, ents.filter((e) => !e.mep && ctx.editor.r.layerVisible(e.layer))).filter((e) => /MUR|WALL|CLOISON|VOILE|PAROI/i.test(e.layer || ''));
    const build = (base) => sectionEntities(ents, p1, p2, { ...opts, base }).map((x) => ({ ...x, space }));
    const base = await ctx.getPoint('Point d’insertion de la coupe (niveau 0, début de la ligne)', { preview: (q) => build(q) });
    sectionCount++;
    const out = build(base);
    for (const x of [...out, ...sectionMarker(p1, p2, name, 'MEP-COUPE', 2.5 * scale).map((x) => ({ ...x, space }))]) doc.add(x);
    const cutCount = out.filter((x) => x.type === 'TEXT' && /^Z /.test(x.text)).length;
    ctx.print(`Coupe ${name}-${name} : ${cutCount} réseau(x) coupé(s), profondeur de vue ${fmt(lastDepth)}.`);
  }, { aliases: ['SECTION', 'CPE'], label: 'COUPE' });

  // Réseau de retour parallèle (départ → retour, ECS → bouclage, soufflage → reprise).
  const RETURN_OF = { 'CH-D': 'CH-R', 'EG-D': 'EG-R', ECS: 'BECS', SOUF: 'REP' };
  let lastReturnGap = 150;
  ed.register('RETOUR', async (ctx) => {
    const { doc } = ctx;
    const ids = await ctx.getSelection('Choisissez les réseaux aller');
    const runs = ids.map((id) => doc.get(id)).filter((e) => e?.mep && e.type === 'LWPOLYLINE');
    if (!runs.length) { ctx.print('Aucun réseau MEP dans la sélection.'); return; }
    lastReturnGap = await ctx.getDistance('Entraxe entre l’aller et le retour', { default: lastReturnGap });
    const side = await ctx.getPoint('Côté du retour');
    let n = 0;
    for (const e of runs) {
      // Côté : signe du produit vectoriel entre le premier tronçon et le point choisi (le plus proche tronçon).
      let best = { d: Infinity, s: 1 };
      for (let i = 1; i < e.pts.length; i++) {
        const r = G.closestOnSegment(side, e.pts[i - 1], e.pts[i]);
        if (r.d < best.d) best = { d: r.d, s: Math.sign(G.cross(G.sub(e.pts[i], e.pts[i - 1]), G.sub(side, e.pts[i - 1]))) || 1 };
      }
      const off = offsetSigned(e, best.s * lastReturnGap);
      if (!off || Array.isArray(off)) continue;
      const code = RETURN_OF[e.mep.system] || e.mep.system;
      const sys = systemByCode(code);
      const { id, handle, ...rest } = off;
      doc.add({ ...rest, layer: sys ? ensureSystemLayer(doc, sys) : e.layer, mep: { ...e.mep, system: code, q: undefined, flow: e.mep.flow ? -e.mep.flow : undefined } });
      n++;
    }
    ctx.print(`${n} réseau(x) de retour créé(s) à ${fmt(lastReturnGap)} d’entraxe.`);
  }, { aliases: ['RET', 'RETURN', 'PARALLELE'], label: 'RETOUR' });

  // Repérage des pièces (fabrication) et nomenclature.
  ed.register('NUMEROTER', async (ctx) => {
    const { doc, editor } = ctx;
    const space = doc.currentSpace || 'model';
    const k = await ctx.getKeyword('Repérer les réseaux visibles', ['Repérer', 'Effacer'], { default: 'Repérer' });
    const ents = [...doc.entities.values()].filter((e) => e.space === space && e.mep && e.type === 'LWPOLYLINE' && editor.r.layerVisible(e.layer));
    if (!ents.length) { ctx.print('Aucun réseau visible.'); return; }
    if (k === 'Effacer') {
      for (const e of ents) if (e.mep.num) doc.modify(e.id, (x) => { delete x.mep.num; });
      ctx.print('Repères effacés.');
      return;
    }
    const nums = numberRuns(ents);
    for (const [id, num] of nums) if (doc.get(id).mep.num !== num) doc.modify(id, (x) => { x.mep.num = num; });
    ctx.print(`${nums.size} pièce(s) repérée(s) ; NOMENCLATURE pour la liste et l’export CSV.`);
  }, { aliases: ['NUM', 'REPERER'], label: 'NUMEROTER' });

  ed.register('NOMENCLATURE', (ctx) => {
    const { doc } = ctx;
    const rows = billOfMaterials([...doc.entities.values()], UNIT_TO_M[doc.header?.insunits] ?? 0.001);
    if (!rows.length) { ctx.print('Aucune pièce repérée : lancez d’abord NUMEROTER.'); return; }
    const dlg = dialog('bom-dialog');
    const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const total = rows.reduce((s, r) => s + r.length, 0);
    dlg.innerHTML = `<h2>Nomenclature des pièces (${rows.length})</h2>
      <div class="qto-scroll"><table><thead><tr><th>Repère</th><th>Système</th><th>Type</th><th>Section</th><th>Longueur</th><th>Coudes</th><th>Calorifuge</th><th>Altitude</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><b>${esc(r.num)}</b></td><td>${esc(r.system)}</td><td>${esc(r.type)}</td><td>${esc(r.section)}</td>
        <td class="num">${r.length.toFixed(2)} m</td><td class="num">${r.elbows}</td><td class="num">${r.ins ? `${r.ins} mm` : ''}</td><td class="num">${r.z.toFixed(2)} m</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="num">${total.toFixed(2)} m</td><td colspan="3"></td></tr></tfoot></table></div>
      <div class="qto-actions"><button class="btn primary" data-act="csv">Exporter CSV</button><button class="btn" data-act="close">Fermer</button></div>`;
    dlg.onclick = (e) => {
      if (e.target.dataset.act === 'close') dlg.close();
      if (e.target.dataset.act === 'csv') download('nomenclature.csv', bomCsv(rows));
    };
    if (!dlg.open) dlg.showModal();
    ctx.print(`${rows.length} pièce(s), ${total.toFixed(2).replace('.', ',')} m au total.`);
  }, { aliases: ['BOM', 'NOMENC'], label: 'NOMENCLATURE', transaction: false });

  // Pentes d'évacuation : altitude fixée au point bas (rejet), le réseau remonte vers les appareils.
  const lastSlope = {};
  ed.register('PENTE', async (ctx) => {
    const { doc } = ctx;
    if (!hasRuns(ctx, ['pipe'])) { ctx.print('Aucune canalisation dans le dessin.'); return; }
    const src = await pickSource(ctx, ['pipe'], 'Choisissez la canalisation au point bas (rejet, chute), près de cette extrémité');
    const e = doc.get(src.id);
    const unit = UNIT_TO_M[doc.header?.insunits] ?? 0.001;
    const z0 = await ctx.getDistance('Altitude de l’axe au point bas', { default: src.s ? (e.mep.z1 ?? e.mep.z ?? 0) : (e.mep.z || 0) });
    const pct = await ctx.getDistance('Pente (%)', { default: lastSlope[src.system] ?? ({ EU: 1, EV: 2, EP: 1 }[src.system] ?? 1) });
    if (!(pct >= 0)) { ctx.print('Pente non valide.'); return; }
    lastSlope[src.system] = pct;
    const flows = computeFlows(src.net, src.id, src.s);
    const r = slopeNetwork(src.net, flows, src.id, src.s, z0, pct / 100);
    for (const [id, { z, z1 }] of r.z) {
      const cur = doc.get(id);
      const mep = { ...cur.mep, z };
      if (Math.abs(z1 - z) > 1e-9) mep.z1 = z1; else delete mep.z1;
      doc.update({ ...cur, z, mep });
    }
    const m = (v) => `${v * unit >= 0 ? '+' : ''}${(v * unit).toFixed(2).replace('.', ',')} m`;
    ctx.print(`${r.z.size} canalisation(s) ${src.system} en pente de ${String(pct).replace('.', ',')} % : point bas ${m(r.min)}, point haut ${m(r.max)}.`);
  }, { aliases: ['SLOPE', 'PENTES'], label: 'PENTE' });

  // RACCORDER : branchement de chaque bouche sur la gaine la plus proche de son système (piquage
  // perpendiculaire arrêté sur la paroi), circulaire, dimensionné sur le débit de la bouche.
  let lastBranchV = 3;
  ed.register('RACCORDER', async (ctx) => {
    const { doc, editor } = ctx;
    const space = doc.currentSpace || 'model';
    const k = await ctx.getKeyword('Bouches à raccorder', ['Toutes', 'Sélection'], { default: 'Toutes' });
    const isAirTerm = (e) => e?.type === 'INSERT' && e.mep?.kind === 'terminal' && systemByCode(e.mep.system)?.kind === 'duct';
    const terms = k === 'Sélection'
      ? (await ctx.getSelection('Choisissez les bouches')).map((id) => doc.get(id)).filter(isAirTerm)
      : [...doc.entities.values()].filter((e) => isAirTerm(e) && e.space === space);
    if (!terms.length) { ctx.print('Aucune bouche à raccorder.'); return; }
    lastBranchV = await ctx.getDistance('Vitesse dans les branchements (m/s)', { default: lastBranchV });
    const u = unitMmOf(doc);
    const ducts = [...doc.entities.values()].filter((e) => e.mep?.kind === 'duct' && e.type === 'LWPOLYLINE' && e.space === space && e.pts.length >= 2);
    let n = 0, skipped = 0;
    for (const t of terms) {
      let best = null;
      for (const d of ducts) {
        if (d.mep.system !== t.mep.system) continue;
        const r = nearestOnAxis(d, t.p);
        if (!best || r.d < best.d) best = { ...r, duct: d };
      }
      const hw = best ? planWidth(best.duct.mep) / 2 : 0;
      // Déjà sur la gaine (ou raccordée par un branchement existant) : rien à faire.
      const linked = ducts.some((d) => d.mep.system === t.mep.system && (G.dist(d.pts[0], t.p) < hw + 1 || G.dist(d.pts[d.pts.length - 1], t.p) < hw + 1));
      if (!best || best.d <= hw + 1e-6 || linked) { skipped++; continue; }
      const size = sizeFor(+t.mep.q || 0, { vmax: lastBranchV || 3, shape: 'round' });
      const mep = { kind: 'duct', system: t.mep.system, shape: 'round', d: Math.max(size.d, 100) / u, z: best.duct.mep.z || 0, q: +t.mep.q || 0 };
      const ent = mepEntity(doc, best.duct.layer, mep, [[t.p[0], t.p[1]], best.point]);
      ent.pts = connectEnds(ent, [best.duct]);
      const added = doc.add(ent);
      ducts.push(added);
      n++;
    }
    editor.setSelection([]);
    ctx.print(`${n} bouche(s) raccordée(s)${skipped ? `, ${skipped} déjà sur une gaine ou sans gaine de leur système` : ''}.`);
  }, { aliases: ['CONNECTER', 'RACCBOUCHES', 'CONNECTTERM'], label: 'RACCORDER' });

  // CALORIFUGEAUTO : calorifuge des canalisations selon le système et le diamètre (insulationFor).
  ed.register('CALORIFUGEAUTO', async (ctx) => {
    const { doc, editor } = ctx;
    const space = doc.currentSpace || 'model';
    const k = await ctx.getKeyword('Canalisations', ['Toutes', 'Sélection'], { default: 'Toutes' });
    const isPipe = (e) => e?.mep?.kind === 'pipe' && e.type === 'LWPOLYLINE';
    const pipes = k === 'Sélection'
      ? (await ctx.getSelection('Choisissez les canalisations')).map((id) => doc.get(id)).filter(isPipe)
      : [...doc.entities.values()].filter((e) => isPipe(e) && e.space === space);
    const u = unitMmOf(doc);
    let n = 0;
    for (const e of pipes) {
      const ins = insulationFor(e.mep.system, (e.mep.d || 0) * u) / u;
      if (!ins || ins === e.mep.ins) continue;
      doc.update({ ...e, mep: { ...e.mep, ins } });
      n++;
    }
    editor.setSelection([]);
    ctx.print(`${n} canalisation(s) calorifugée(s) (chauffage, ECS, eau glacée ; valeurs indicatives à adapter au CCTP).`);
  }, { aliases: ['CALOAUTO', 'INSULATE'], label: 'CALORIFUGEAUTO' });

  // HAUTEURLIBRE : contrôle de la hauteur libre sous les réseaux (faux plafond, passage).
  let lastHsp = null;
  ed.register('HAUTEURLIBRE', async (ctx) => {
    const { doc, editor } = ctx;
    const unit = UNIT_TO_M[doc.header?.insunits] ?? 0.001;
    const hm = await ctx.getDistance('Hauteur libre minimale sous les réseaux (m)', { default: lastHsp ?? 2.5 });
    if (!(hm > 0)) return;
    lastHsp = hm;
    const space = doc.currentSpace || 'model';
    const list = lowRuns([...doc.entities.values()].filter((e) => e.space === space && editor.r.layerVisible(e.layer)), hm / unit);
    if (!list.length) { ctx.print(`Aucun réseau sous ${String(hm).replace('.', ',')} m.`); return; }
    editor.setSelection(list.map((x) => x.id));
    const m = (v) => `${(v * unit).toFixed(2).replace('.', ',')} m`;
    ctx.print(`${list.length} réseau(x) sous ${String(hm).replace('.', ',')} m (sélectionnés) ; le plus bas : ${m(list[0].bottom)}.`);
    const dlg = dialog('hsp-dialog');
    const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    dlg.innerHTML = `<h2>Hauteur libre &lt; ${esc(String(hm).replace('.', ','))} m : ${list.length}</h2>
      <p class="muted">Cliquez une ligne pour zoomer sur le réseau.</p>
      <div class="qto-scroll"><table><thead><tr><th>Réseau</th><th>Dessous</th><th>Manque</th></tr></thead>
      <tbody>${list.map((x, i) => { const e = doc.get(x.id); return `<tr class="clickable" data-i="${i}"><td>${esc(`${e.mep.system} ${sectionLabel(e.mep)}`)}</td><td class="num">${m(x.bottom)}</td><td class="num">${Math.round(x.gap * unit * 1000)} mm</td></tr>`; }).join('')}</tbody></table></div>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
    dlg.onclick = (ev) => {
      if (ev.target.dataset.act === 'close') { dlg.close(); return; }
      const tr = ev.target.closest('tr[data-i]');
      if (!tr) return;
      const b = editor.r.cache.get(list[+tr.dataset.i].id)?.box;
      if (b) editor.r.fit({ minX: b.minX - 1000, minY: b.minY - 1000, maxX: b.maxX + 1000, maxY: b.maxY + 1000 });
      editor.setSelection([list[+tr.dataset.i].id]);
    };
    if (!dlg.open) dlg.show();
  }, { aliases: ['HSP', 'HAUTEURSOUSPLAFOND', 'CLEARANCE'], label: 'HAUTEURLIBRE', transaction: false });

  // Tableau du métré ou de la nomenclature inséré dans le dessin (bloc : se déplace d'un seul tenant).
  ed.register('TABLEMETRE', async (ctx) => {
    const { doc } = ctx;
    const num = (v) => v.toFixed(2).replace('.', ',');
    const kind = await ctx.getKeyword('Tableau', ['Metre', 'Nomenclature'], { default: 'Metre' });
    let head, rows, numeric, title;
    if (kind === 'Nomenclature') {
      const bom = billOfMaterials([...doc.entities.values()], UNIT_TO_M[doc.header?.insunits] ?? 0.001);
      if (!bom.length) { ctx.print('Aucune pièce repérée : lancez d’abord NUMEROTER.'); return; }
      head = ['Repère', 'Système', 'Type', 'Section', 'Longueur (m)', 'Coudes', 'Calorifuge (mm)', 'Altitude (m)'];
      rows = bom.map((r) => [r.num, r.system, r.type, r.section, num(r.length), r.elbows, r.ins || '', num(r.z)]);
      numeric = [4, 5, 6, 7];
      title = 'NOMENCLATURE DES PIÈCES';
    } else {
      const q = quantities(doc);
      if (!q.length) { ctx.print('Aucun réseau MEP dans le dessin.'); return; }
      head = ['Domaine', 'Système', 'Désignation', 'Section', 'Longueur (m)', 'Quantité'];
      rows = q.map((r) => [r.domain, r.system, r.type, r.section, r.count ? '' : num(r.length), r.count || '']);
      numeric = [4, 5];
      title = 'MÉTRÉ DES RÉSEAUX';
    }
    const paper = (doc.currentSpace || 'model') !== 'model';
    const scale = paper ? 1 : doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    const h = await ctx.getDistance('Hauteur de texte', { default: 2.5 * scale });
    if (!(h > 0)) return;
    const t = tableEntities(head, rows, { h, title, numeric });
    let k = 1;
    while (doc.blocks.has(`CV_TABLE_${k}`)) k++;
    const name = `CV_TABLE_${k}`;
    doc.blocks.set(name, { name, base: [0, 0, 0], flags: 0, xref: false, entities: t.entities });
    const mk = (q) => ({ type: 'INSERT', name, p: [q[0], q[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], layer: doc.currentLayer, color: 256 });
    const p = await ctx.getPoint('Coin supérieur gauche du tableau', { preview: (q) => [mk(q)] });
    doc.add({ ...mk(p), space: doc.currentSpace || 'model' });
    ctx.print(`Tableau de ${rows.length} ligne(s) inséré (${fmt(t.width)} × ${fmt(t.height)}).`);
  }, { aliases: ['TABMETRE', 'TABLEAUMETRE', 'QTOTABLE'], label: 'TABLEMETRE' });

  // Accessoires en ligne : registres, clapets coupe-feu, silencieux (gaines), vannes (canalisations) ;
  // option Murs : un clapet coupe-feu à chaque traversée de mur par une gaine.
  const ACC_KEYS = { Registre: 'registre', CoupeFeu: 'ccf', Silencieux: 'silencieux', Vanne: 'vanne' };
  let lastAcc = 'Registre';
  ed.register('ACCESSOIRE', async (ctx) => {
    const { doc, editor } = ctx;
    const u = unitMmOf(doc);
    const k = await ctx.getKeyword('Accessoire', [...Object.keys(ACC_KEYS), 'Murs'], { default: lastAcc });
    if (k === 'Murs') {
      const space = doc.currentSpace || 'model';
      const visible = [...doc.entities.values()].filter((e) => e.space === space && editor.r.layerVisible(e.layer));
      const walls = expandInserts(doc, visible.filter((e) => !e.mep)).filter((e) => /MUR|WALL|CLOISON|VOILE|PAROI/i.test(e.layer || ''));
      const ducts = visible.filter((e) => e.mep?.kind === 'duct' && e.type === 'LWPOLYLINE');
      if (!walls.length || !ducts.length) { ctx.print(!walls.length ? 'Aucun mur (calques MUR, WALL, CLOISON, VOILE).' : 'Aucune gaine.'); return; }
      ensureAccessoryBlock(doc, 'ccf');
      let n = 0;
      for (const r of findReservations(ducts, walls, { margin: 0 })) {
        const a = accessoryOn(doc.get(r.run), r.p, 'ccf', u);
        if (a) { doc.add({ ...a, space }); n++; }
      }
      ctx.print(`${n} clapet(s) coupe-feu posé(s) aux traversées de murs.`);
      return;
    }
    lastAcc = k;
    const type = ACC_KEYS[k];
    const spec = ACCESSORIES[type];
    ensureAccessoryBlock(doc, type);
    while (true) {
      const pick = await ctx.getEntity(`Désignez le réseau à l’emplacement du ${spec.label.toLowerCase()}`, { allowNone: true });
      if (pick === null) return;
      const run = doc.get(pick.id);
      if (!run?.mep || run.type !== 'LWPOLYLINE' || !spec.kinds.includes(run.mep.kind)) { ctx.print(type === 'vanne' ? 'Désignez une canalisation.' : 'Désignez une gaine.'); continue; }
      const a = accessoryOn(run, pick.p, type, u);
      if (a) doc.add({ ...a, space: run.space });
    }
  }, { aliases: ['ACC', 'ACCESSOIRES', 'REGISTRE', 'CLAPET', 'VANNE'], label: 'ACCESSOIRE' });

  // Supportage : supports à l'entraxe maximal de chaque réseau ; relancer la commande remplace les supports
  // déjà posés sur ces réseaux.
  let lastSpacing = 0;
  ed.register('SUPPORTS', async (ctx) => {
    const { doc, editor } = ctx;
    const space = doc.currentSpace || 'model';
    const isRunE = (e) => !!e?.mep && e.type === 'LWPOLYLINE' && e.pts.length >= 2;
    const k = await ctx.getKeyword('Réseaux à supporter', ['Tous', 'Sélection'], { default: 'Tous' });
    const runs = k === 'Sélection'
      ? (await ctx.getSelection('Choisissez les réseaux')).map((id) => doc.get(id)).filter(isRunE)
      : [...doc.entities.values()].filter((e) => isRunE(e) && e.space === space && editor.r.layerVisible(e.layer));
    if (!runs.length) { ctx.print('Aucun réseau à supporter.'); return; }
    lastSpacing = await ctx.getDistance('Entraxe maximal en m (0 = selon le réseau)', { default: lastSpacing });
    const u = unitMmOf(doc);
    ensureSupportBlock(doc);
    const old = supportsOn([...doc.entities.values()], runs);
    for (const s of old) doc.remove(s.id);
    const added = [];
    const all = [...doc.entities.values()].filter(isRunE);
    for (const e of runs) for (const s of supportEntities(e, u, lastSpacing, all)) added.push(doc.add({ ...s, space }));
    ctx.print(`${added.length} support(s) posé(s) sur ${runs.length} réseau(x)${old.length ? ` (${old.length} ancien(s) remplacé(s))` : ''}.`);
    for (const r of supportSummary(added)) ctx.print(`  ${r.system} ${r.section} — ${r.type} : ${r.count} (entraxe ≤ ${String(r.spacing).replace('.', ',')} m)`);
  }, { aliases: ['SUPPORT', 'SUPPORTAGE', 'HANGERS', 'SUP'], label: 'SUPPORTS' });

  // Réservations : traversées des murs (calques de murs automatiques ou choisis, xrefs et blocs compris).
  let lastMargin = 50;
  ed.register('RESERVATIONS', async (ctx) => {
    const { doc, editor } = ctx;
    const space = doc.currentSpace || 'model';
    const mode = await ctx.getKeyword('Calques de murs (Auto : noms contenant MUR, WALL, CLOISON, VOILE)', ['Auto', 'Choisir'], { default: 'Auto' });
    let isWall = (layer) => /MUR|WALL|CLOISON|VOILE|PAROI/i.test(layer || '');
    if (mode === 'Choisir') {
      const ids = await ctx.getSelection('Choisissez des objets sur les calques de murs');
      const layers = new Set(ids.map((id) => doc.get(id)?.layer).filter(Boolean));
      if (!layers.size) return;
      isWall = (layer) => layers.has(layer);
    }
    lastMargin = await ctx.getDistance('Jeu autour du réseau (de chaque côté)', { default: lastMargin });
    const visible = [...doc.entities.values()].filter((e) => e.space === space && editor.r.layerVisible(e.layer));
    const walls = expandInserts(doc, visible.filter((e) => !e.mep)).filter((e) => isWall(e.layer) && editor.r.layerVisible(e.layer));
    const runs = visible.filter((e) => e.mep && e.type === 'LWPOLYLINE');
    if (!walls.length || !runs.length) { ctx.print(!walls.length ? 'Aucun mur trouvé sur ces calques.' : 'Aucun réseau MEP.'); return; }
    const list = findReservations(runs, walls, { margin: lastMargin });
    if (!list.length) { ctx.print('Aucune traversée de mur.'); return; }
    if (!doc.layers.has('MEP-RESERVATIONS')) doc.addLayer('MEP-RESERVATIONS', { color: 1 });
    const scale = doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    for (const r of list) for (const x of reservationEntities(r, 'MEP-RESERVATIONS', 2 * scale)) doc.add({ ...x, space });
    ctx.print(`${list.length} réservation(s) dessinée(s) sur le calque MEP-RESERVATIONS (${walls.length} objets de murs analysés).`);
    const unitM = UNIT_TO_M[doc.header?.insunits] ?? 0.001;
    const dlg = dialog('resa-dialog');
    const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    dlg.innerHTML = `<h2>Réservations (${list.length})</h2>
      <p class="muted">Cliquez une ligne pour zoomer sur la réservation.</p>
      <div class="qto-scroll"><table><thead><tr><th>N°</th><th>Système</th><th>Réseau</th><th>Réservation</th><th>Mur</th><th>Altitude</th></tr></thead>
      <tbody>${list.map((r, i) => `<tr class="clickable" data-i="${i}"><td>${i + 1}</td><td>${esc(r.system)}</td><td>${esc(r.section)}</td>
        <td class="num">${Math.round(r.w)}×${Math.round(r.h)}</td><td class="num">${Math.round(r.thickness)}</td><td class="num">${(r.z * unitM).toFixed(2)} m</td></tr>`).join('')}</tbody></table></div>
      <div class="qto-actions"><button class="btn primary" data-act="csv">Exporter CSV</button><button class="btn" data-act="close">Fermer</button></div>`;
    dlg.onclick = (e) => {
      if (e.target.dataset.act === 'close') { dlg.close(); return; }
      if (e.target.dataset.act === 'csv') { download('reservations.csv', reservationsCsv(list, unitM)); return; }
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const r = list[+tr.dataset.i];
      const size = Math.max(r.w, 1000) * 3;
      editor.r.fit({ minX: r.p[0] - size, maxX: r.p[0] + size, minY: r.p[1] - size * 0.7, maxY: r.p[1] + size * 0.7 });
    };
    if (!dlg.open) dlg.show();
  }, { aliases: ['RESA', 'TREMIES'], label: 'RESERVATIONS' });

  let lastClearance = 0;
  ed.register('INTERFERENCES', async (ctx) => {
    const { doc, editor } = ctx;
    const clearance = await ctx.getDistance('Jeu minimal entre réseaux (mm)', { default: lastClearance });
    lastClearance = clearance;
    const r = editor.r;
    const ents = [...doc.entities.values()].filter((e) => e.mep && e.type === 'LWPOLYLINE' && e.space === r.space && r.layerVisible(e.layer));
    const t0 = performance.now();
    const clashes = findClashes(ents, { clearance });
    ctx.print(`${clashes.length} interférence(s) entre ${ents.length} objets MEP (${(performance.now() - t0).toFixed(0)} ms).`);
    if (clashes.length) showClashes(clashes, doc, editor);
  }, { aliases: ['CLASH', 'INTERF'], label: 'INTERFERENCES', transaction: false });

  // Relecture d'un fichier BCF (.bcfzip) : sujets, statuts, commentaires ; un clic zoome sur les éléments désignés.
  ed.register('OUVRIRBCF', async (ctx) => {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bcfzip,.bcf,.zip';
      input.onchange = () => resolve(input.files[0] || null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    if (!file) return;
    const { readBcf } = await import('../io/bcf.js');
    const bcf = await readBcf(await file.arrayBuffer());
    ctx.print(`${file.name} : BCF ${bcf.version || '?'}, ${bcf.topics.length} sujet(s).`);
    showBcf(bcf, ctx.doc, ctx.editor);
  }, { aliases: ['BCF', 'IMPORTBCF'], label: 'OUVRIRBCF', transaction: false });

  ed.register('METRE', (ctx) => {
    const rows = quantities(ctx.doc);
    if (!rows.length) { ctx.print('Aucun réseau MEP dans le dessin.'); return; }
    for (const r of rows) ctx.print(r.count ? `${r.domain} · ${r.system} · ${r.type} ${r.section} : ${r.count} u` : `${r.domain} · ${r.system} · ${r.type} ${r.section} : ${r.length.toFixed(2)} m (${r.runs} tronçon(s), ${r.elbows} coude(s))`);
    showQuantities(rows, ctx.doc);
  }, { aliases: ['MET', 'QTO', 'METRES'], label: 'METRE', transaction: false });
}

// --- BCF ------------------------------------------------------------------------
// Sujets d'un fichier BCF ; un clic sélectionne les objets désignés (GlobalId de l'export IFC de ce dessin) et zoome,
// ou à défaut zoome sur le point visé par la caméra.
export async function showBcf(bcf, doc, editor) {
  const { writeIfc } = await import('../io/ifc-writer.js');
  const owner = new Map();
  for (const [id, gs] of writeIfc(doc, { project: (doc.fileName || 'dessin').replace(/\.[^.]+$/, '') }).guids) for (const g of gs) owner.set(g, id);
  const dlg = dialog('bcf-dialog');
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const idsOf = (t) => [...new Set((t.viewpoint?.components || []).map((g) => owner.get(g)).filter((id) => doc.get(id)))];
  dlg.innerHTML = `<h2>BCF : ${bcf.topics.length} sujet(s)</h2>
    <p class="muted">Cliquez un sujet pour zoomer sur les objets désignés.</p>
    <div class="qto-scroll"><table><thead><tr><th>#</th><th>Sujet</th><th>Statut</th><th>Auteur</th><th>Commentaires</th><th>Objets</th></tr></thead>
    <tbody>${bcf.topics.map((t, i) => `<tr data-i="${i}" class="clickable" title="${esc(t.description)}"><td>${t.index ?? i + 1}</td><td>${esc(t.title)}</td><td>${esc(t.status)}</td>
      <td>${esc(t.author)}</td><td>${esc(t.comments.map((c) => `${c.author} : ${c.text}`).join(' — '))}</td><td class="num">${idsOf(t).length}</td></tr>`).join('')}</tbody></table></div>
    <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  dlg.onclick = (e) => {
    if (e.target.dataset.act === 'close') { dlg.close(); return; }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const t = bcf.topics[+tr.dataset.i];
    const ids = idsOf(t);
    const k = unitMmOf(doc) / 1000;
    const target = t.viewpoint?.target ? [t.viewpoint.target[0] / k, t.viewpoint.target[1] / k] : null;
    if (ids.length) editor.setSelection(ids);
    const c = target || (ids.length ? doc.get(ids[0]).pts[0] : null);
    if (c) { const size = 3 / k; editor.r.fit({ minX: c[0] - size, maxX: c[0] + size, minY: c[1] - size * 0.7, maxY: c[1] + size * 0.7 }); }
    for (const row of dlg.querySelectorAll('tr.sel')) row.classList.remove('sel');
    tr.classList.add('sel');
  };
  if (!dlg.open) dlg.show();
}

// --- interférences ---------------------------------------------------------------

function showClashes(clashes, doc, editor) {
  const dlg = dialog('clash-dialog');
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = (id) => {
    const e = doc.get(id);
    return e ? `${e.mep.system} ${sectionLabel(e.mep)} (z ${fmt(e.mep.z || 0)})` : '?';
  };
  dlg.innerHTML = `<h2>Interférences : ${clashes.length}</h2>
    <p class="muted">Cliquez une ligne pour zoomer sur le conflit et sélectionner les deux réseaux.</p>
    <div class="qto-scroll"><table><thead><tr><th>#</th><th>Réseau A</th><th>Réseau B</th><th>Pénétration</th><th>Position</th></tr></thead>
    <tbody>${clashes.map((c, i) => `<tr data-i="${i}" class="clickable"><td>${i + 1}</td><td>${esc(label(c.a))}</td><td>${esc(label(c.b))}</td>
      <td class="num">${fmt(Math.round(c.depth))} mm</td><td>${fmt(Math.round(c.p[0]))}, ${fmt(Math.round(c.p[1]))}</td></tr>`).join('')}</tbody></table></div>
    <div class="qto-actions"><button class="btn primary" data-act="csv">Exporter CSV</button><button class="btn" data-act="bcf">Exporter BCF</button><button class="btn" data-act="mark">Repérer dans le dessin</button><button class="btn" data-act="close">Fermer</button></div>`;
  dlg.onclick = async (e) => {
    if (e.target.dataset.act === 'close') { dlg.close(); return; }
    if (e.target.dataset.act === 'bcf') {
      const { writeBcf } = await import('../io/bcf.js');
      const project = (doc.fileName || 'dessin').replace(/\.[^.]+$/, '');
      const bytes = await writeBcf(doc, clashes, { project });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${project} - interférences.bcfzip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      editor.print(`BCF créé : ${clashes.length} sujet(s), points de vue sur les éléments de l’export IFC (EXPORTIFC).`);
      return;
    }
    if (e.target.dataset.act === 'csv') { download('interferences.csv', clashesCsv(clashes, label)); return; }
    if (e.target.dataset.act === 'mark') {
      const scale = doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
      doc.transaction('Repères d’interférences', () => {
        if (!doc.layers.has(CLASH_LAYER)) doc.addLayer(CLASH_LAYER, { color: 1 });
        for (const x of clashMarkers(clashes, 2.5 * scale)) doc.add({ ...x, space: doc.currentSpace || 'model' });
      });
      editor.print(`${clashes.length} repère(s) d’interférence sur le calque ${CLASH_LAYER}.`);
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const c = clashes[+tr.dataset.i];
    const ea = editor.r.cache.get(c.a)?.box, eb = editor.r.cache.get(c.b)?.box;
    const size = Math.max(2000, ...[ea, eb].filter(Boolean).map((b) => Math.min(b.maxX - b.minX, b.maxY - b.minY)));
    editor.r.fit({ minX: c.p[0] - size, maxX: c.p[0] + size, minY: c.p[1] - size * 0.7, maxY: c.p[1] + size * 0.7 });
    editor.setSelection([c.a, c.b]);
    for (const row of dlg.querySelectorAll('tr.sel')) row.classList.remove('sel');
    tr.classList.add('sel');
  };
  if (!dlg.open) dlg.show();
}

// Épaisseur de calorifuge (mm) d'une canalisation de diamètre d (mm) : valeurs courantes, indicatives (à
// adapter au CCTP) — chauffage / ECS / bouclage : 20 à 50 mm ; eau glacée (anti-condensation) : 19 à 32 mm.
export function insulationFor(system, d) {
  if (['CH-D', 'CH-R', 'ECS', 'BECS'].includes(system)) return d <= 22 ? 20 : d <= 42 ? 30 : d <= 89 ? 40 : 50;
  if (['EG-D', 'EG-R'].includes(system)) return d <= 42 ? 19 : d <= 89 ? 25 : 32;
  return 0;
}

// Hauteur libre : réseaux dont le dessous (calorifuge et pente compris) passe sous `limit` (unités du dessin).
// Renvoie [{ id, bottom, gap }] du plus bas au plus haut.
export function lowRuns(entities, limit) {
  const out = [];
  for (const e of entities) {
    if (!e.mep || e.type !== 'LWPOLYLINE' || e.pts.length < 2) continue;
    const m = e.mep, round = m.kind === 'pipe' || m.shape === 'round';
    const h = round ? m.d || 0 : m.h || (m.kind === 'tray' ? 60 : planWidth(m));
    const below = m.kind === 'tray' ? 0 : h / 2; // chemin de câbles : altitude du dessous
    const bottom = Math.min(...vertexZ(e)) - below - (m.ins || 0);
    if (bottom < limit - 1e-9) out.push({ id: e.id, bottom, gap: limit - bottom });
  }
  return out.sort((a, b) => a.bottom - b.bottom);
}

// Interférences : rapport pour Excel (une ligne par conflit, colonne Statut à remplir en réunion de synthèse)
// et repères dans le dessin (cercle numéroté au point de conflit).
export const CLASH_LAYER = 'MEP-INTERFERENCES';
export function clashesCsv(clashes, label) {
  const lines = ['N°;Réseau A;Réseau B;Pénétration (mm);Écart d’altitude (mm);X;Y;Statut'];
  clashes.forEach((c, i) => lines.push([i + 1, label(c.a), label(c.b), Math.round(c.depth), Math.round(-c.zGap), Math.round(c.p[0]), Math.round(c.p[1]), ''].join(';')));
  return `﻿${lines.join('\r\n')}\r\n`;
}
export function clashMarkers(clashes, h) {
  const out = [];
  clashes.forEach((c, i) => {
    out.push({ type: 'CIRCLE', layer: CLASH_LAYER, color: 256, c: [c.p[0], c.p[1], 0], r: h * 3 });
    out.push({ type: 'TEXT', layer: CLASH_LAYER, color: 256, p: [c.p[0], c.p[1], 0], h: h * 1.6, rot: 0, text: String(i + 1), align: 'center', valign: 'middle', wf: 1 });
  });
  return out;
}

// Tableau d'équilibrage pour Excel (séparateur « ; », virgule décimale, BOM UTF-8).
export function pressureCsv(r, label, water = false) {
  const num = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  const k = water ? 1000 : 1; // eau : kPa
  const lines = [water ? 'Terminal;Débit (l/s);Perte de charge (kPa);À équilibrer (kPa)' : 'Bouche;Débit (m³/h);Perte de charge (Pa);À équilibrer (Pa)'];
  r.terminals.forEach((t, i) => lines.push([label(t.id), water ? t.q.toFixed(2).replace('.', ',') : Math.round(t.q), num(t.dp / k), i ? num((r.max - t.dp) / k) : 'critique'].join(';')));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showPressureDrops(r, doc, editor, water = false) {
  const dlg = dialog('dp-dialog');
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = (id) => {
    const e = doc.get(id);
    return e ? `${TERMINALS[e.mep.terminal]?.label || 'Bouche'} ${terminalSize(e.mep.terminal, e.mep)}` : '?';
  };
  // Eau : kPa et l/s ; air : Pa et m³/h.
  const dp = (v) => (water ? `${(v / 1000).toFixed(1).replace('.', ',')} kPa` : `${Math.round(v)} Pa`);
  const q = (v) => (water ? `${v.toFixed(2).replace('.', ',')} l/s` : `${Math.round(v)} m³/h`);
  const what = water ? 'Terminal' : 'Bouche';
  dlg.innerHTML = `<h2>Pertes de charge — réseau ${esc(doc.get(r.critical.id)?.mep.system || '')}</h2>
    <p class="muted">${water ? 'Pression nécessaire à l’origine' : 'Bouche la plus défavorisée'} : <b>${dp(r.max)}</b>. Cliquez une ligne pour zoomer sur le terminal et voir son chemin.</p>
    <div class="qto-scroll"><table><thead><tr><th>#</th><th>${what}</th><th>Débit</th><th>Perte de charge</th><th>À équilibrer</th></tr></thead>
    <tbody>${r.terminals.map((t, i) => `<tr data-i="${i}" class="clickable"><td>${i + 1}</td><td>${esc(label(t.id))}</td>
      <td class="num">${q(t.q)}</td><td class="num">${dp(t.dp)}</td><td class="num">${i ? dp(r.max - t.dp) : 'critique'}</td></tr>`).join('')}</tbody></table></div>
    <div class="qto-actions"><button class="btn primary" data-act="csv">Exporter CSV</button><button class="btn" data-act="close">Fermer</button></div>`;
  dlg.onclick = (e) => {
    if (e.target.dataset.act === 'close') { dlg.close(); return; }
    if (e.target.dataset.act === 'csv') { download('equilibrage.csv', pressureCsv(r, label, water)); return; }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const t = r.terminals[+tr.dataset.i];
    const term = doc.get(t.id);
    if (term) {
      const size = 3000;
      editor.r.fit({ minX: term.p[0] - size, maxX: term.p[0] + size, minY: term.p[1] - size * 0.7, maxY: term.p[1] + size * 0.7 });
    }
    editor.setSelection([...t.path, t.id]);
    for (const row of dlg.querySelectorAll('tr.sel')) row.classList.remove('sel');
    tr.classList.add('sel');
  };
  if (!dlg.open) dlg.show();
}

function dialog(id) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = id;
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  return dlg;
}

// --- métré ---------------------------------------------------------------------


export function quantities(doc) {
  const k = UNIT_TO_M[doc.header?.insunits] ?? 0.001;
  const map = new Map();
  for (const e of doc.entities.values()) {
    if (isAccessory(e)) {
      const sys = systemByCode(e.mep.system);
      const key = `accessory|${e.mep.system}|${e.mep.type}|${e.mep.section}`;
      let r = map.get(key);
      if (!r) {
        r = { domain: sys?.domain || '', system: e.mep.system, systemLabel: sys?.label || e.mep.system,
          type: e.mep.label || e.mep.type, section: e.mep.section, length: 0, runs: 0, elbows: 0, count: 0 };
        map.set(key, r);
      }
      r.count++;
      continue;
    }
    if (isSupport(e)) {
      const sys = systemByCode(e.mep.system);
      const key = `support|${e.mep.system}|${e.mep.type}|${e.mep.section}`;
      let r = map.get(key);
      if (!r) {
        r = { domain: sys?.domain || '', system: e.mep.system, systemLabel: sys?.label || e.mep.system,
          type: `Support — ${e.mep.type}`, section: e.mep.section, length: 0, runs: 0, elbows: 0, count: 0 };
        map.set(key, r);
      }
      r.count++;
      continue;
    }
    if (e.mep?.kind === 'terminal' && e.type === 'INSERT') {
      const sys = systemByCode(e.mep.system);
      const size = terminalSize(e.mep.terminal, e.mep);
      const key = `terminal|${e.mep.system}|${e.mep.terminal}|${size}`;
      let r = map.get(key);
      if (!r) {
        r = { domain: sys?.domain || '', system: e.mep.system, systemLabel: sys?.label || e.mep.system,
          type: TERMINALS[e.mep.terminal]?.label || 'Terminal', section: size, length: 0, runs: 0, elbows: 0, count: 0 };
        map.set(key, r);
      }
      r.count++;
      continue;
    }
    if (!e.mep || e.type !== 'LWPOLYLINE') continue;
    const sys = systemByCode(e.mep.system);
    const key = `${e.mep.kind}|${e.mep.system}|${sectionLabel(e.mep)}`;
    let r = map.get(key);
    if (!r) {
      r = {
        domain: sys?.domain || '', system: e.mep.system, systemLabel: sys?.label || e.mep.system,
        type: kindLabel(e.mep), section: sectionLabel(e.mep), length: 0, runs: 0, elbows: 0, count: 0,
      };
      map.set(key, r);
    }
    r.length += mepLength(e) * k;
    r.runs += e.pts.length - 1;
    r.elbows += e.mep.conduit ? 0 : Math.max(0, e.pts.length - 2); // tube souple : cintré, sans coude
  }
  const rows = [...map.values()].sort((a, b) => a.domain.localeCompare(b.domain) || a.system.localeCompare(b.system) || a.section.localeCompare(b.section, 'fr', { numeric: true }));
  // Pièces de forme (coudes, réductions, piquages), après les réseaux de chaque système.
  const fit = fittings([...doc.entities.values()]);
  const out = [];
  for (const r of rows) {
    out.push(r);
    const last = rows.filter((x) => x.system === r.system).at(-1) === r;
    if (!last) continue;
    for (const f of fit.filter((x) => x.system === r.system)) {
      out.push({ domain: r.domain, system: r.system, systemLabel: r.systemLabel, type: f.type, section: f.section, length: 0, runs: 0, elbows: 0, count: f.count, fitting: true });
    }
  }
  return out;
}

export function quantitiesCsv(rows) {
  const head = ['Domaine', 'Système', 'Libellé', 'Type', 'Section', 'Longueur (m)', 'Tronçons', 'Coudes', 'Quantité'];
  const lines = [head, ...rows.map((r) => [r.domain, r.system, r.systemLabel, r.type, r.section,
    r.count ? '' : r.length.toFixed(2).replace('.', ','), r.count ? '' : r.runs, r.count ? '' : r.elbows, r.count || ''])];
  return '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

function showQuantities(rows, doc) {
  let dlg = document.getElementById('qto-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'qto-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const total = rows.reduce((s, r) => s + r.length, 0);
  dlg.innerHTML = `<h2>Métré des réseaux</h2>
    <table><thead><tr><th>Domaine</th><th>Système</th><th>Type</th><th>Section</th><th>Longueur</th><th>Tronçons</th><th>Coudes</th><th>Qté</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.domain)}</td><td title="${esc(r.systemLabel)}">${esc(r.system)}</td><td>${esc(r.type)}</td><td>${esc(r.section)}</td>
      <td class="num">${r.count ? '' : `${r.length.toFixed(2)} m`}</td><td class="num">${r.count ? '' : r.runs}</td><td class="num">${r.count ? '' : r.elbows}</td><td class="num">${r.count || ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">Total réseaux</td><td class="num">${total.toFixed(2)} m</td><td></td><td></td><td class="num">${rows.reduce((s, r) => s + (r.count || 0), 0) || ''}</td></tr></tfoot></table>
    <div class="qto-actions"><button class="btn primary" data-act="csv">Exporter CSV</button><button class="btn" data-act="close">Fermer</button></div>`;
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'csv') {
      const url = URL.createObjectURL(new Blob([quantitiesCsv(rows)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'metre-reseaux.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };
  if (!dlg.open) dlg.showModal();
}
