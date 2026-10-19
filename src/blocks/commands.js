// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes des blocs : éditeur de blocs (EDITBLOC, BENREG, BFERMER), paramètres et actions dynamiques
// (PARAMLIN, PARAMPOINT, PARAMROT, PARAMINV), états de visibilité (VISIBILITE, BVNOUVEAU, BVCOURANT, BVCACHER,
// BVMONTRER, BVMODE), point de base (BPOINTBASE), liste des paramètres (BPARAMETRES), synchronisation des
// attributs (SYNCATT).
import * as G from '../core/geom.js';
import { freeName, newId, PARAM_TYPES, ACTION_TYPES, defaultValue, describeValue } from './dynamic.js';
import { syncInsertAttribs } from './block-editor.js';

const rect = (a, b) => [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
  [Math.max(a[0], b[0]), Math.max(a[1], b[1])], [Math.min(a[0], b[0]), Math.max(a[1], b[1])]];
const P2 = (p) => [p[0], p[1]];

// session : BlockEditorSession ; l'interface peut fournir ui.openVisStates() et ui.openBlockParams().
export function registerBlockCommands(editor, session) {
  const need = (ctx) => {
    if (session.editing) return session;
    ctx.print('Commande de l’éditeur de blocs : ouvrez d’abord un bloc avec EDITBLOC.');
    return null;
  };
  const userBlocks = (doc) => [...doc.blocks.values()]
    .filter((b) => !b.name.startsWith('*') && !b.xref && !b.fond && !b.name.startsWith('CV_MEP_') && !b.name.startsWith('CV_ELEC_') && !b.name.includes('|'))
    .map((b) => b.name).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));

  editor.register('EDITBLOC', async (ctx) => {
    if (session.editing) { ctx.print(`Éditeur de blocs déjà ouvert (« ${session.name} ») : BFERMER pour en sortir.`); return; }
    const { doc } = ctx;
    const sel = [...ctx.editor.selection].map((id) => doc.get(id)).filter((e) => e?.type === 'INSERT');
    let name = sel.length === 1 ? sel[0].name : null;
    if (!name) {
      const names = userBlocks(doc);
      if (!names.length) { ctx.print('Aucun bloc à modifier (créez-en un avec BLOC).'); return; }
      ctx.print(`Blocs : ${names.slice(0, 30).join(', ')}${names.length > 30 ? '…' : ''}`);
      while (!name) {
        const t = (await ctx.getString('Bloc à modifier', { default: names[0] })).trim();
        name = names.find((n) => n.toLowerCase() === t.toLowerCase()) || null;
        if (!name) ctx.print(`Bloc « ${t} » introuvable.`);
      }
    }
    try {
      ctx.editor.setSelection([]);
      session.open(name);
      ctx.print(`Éditeur de blocs : « ${name} ». Dessinez et modifiez librement ; paramètres : PARAMLIN, PARAMPOINT, PARAMROT, PARAMINV, VISIBILITE ; BENREG pour enregistrer, BFERMER pour sortir.`);
    } catch (err) { ctx.print(`Impossible d’ouvrir le bloc : ${err.message}`); }
  }, { aliases: ['BEDIT', 'BE', 'MODIFBLOC'], label: 'EDITBLOC', transaction: false });

  editor.register('BENREG', (ctx) => {
    if (!need(ctx)) return;
    const n = session.save();
    ctx.print(`Bloc « ${session.name} » enregistré${n ? ` : ${n} insertion(s) mise(s) à jour` : ''}.`);
  }, { aliases: ['BSAVE', 'ENREGBLOC'], label: 'BENREG', transaction: false });

  editor.register('BFERMER', async (ctx) => {
    if (!need(ctx)) return;
    if (session.modified()) {
      const k = await ctx.getKeyword(`Enregistrer les modifications du bloc « ${session.name} »`, ['Oui', 'Non', 'Annuler'], { default: 'Oui' });
      if (k === 'Annuler') return;
      if (k === 'Oui') { const n = session.save(); ctx.print(`Bloc enregistré${n ? ` (${n} insertion(s) mise(s) à jour)` : ''}.`); }
    }
    const name = session.name;
    session.close();
    editor.print(`Éditeur de blocs fermé (« ${name} »).`);
  }, { aliases: ['BCLOSE', 'FERMERBLOC'], label: 'BFERMER', transaction: false });

  editor.register('BPOINTBASE', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const p = await ctx.getPoint('Nouveau point de base du bloc', { default: s.doc.header.blockBase });
    ctx.doc.setHeader({ blockBase: [p[0], p[1], 0] });
    ctx.print('Point de base modifié (les insertions gardent leur position : le bloc se décale par rapport à elles).');
  }, { aliases: ['BBASE', 'BASEBLOC'], label: 'BPOINTBASE' });

  // --- paramètres et actions -------------------------------------------------------------------

  // Action associée à un paramètre (objets choisis, cadre pour un étirement) ; null : aucune.
  async function askAction(ctx, kind, param, dyn) {
    const id = newId(dyn, 'A');
    if (kind === 'Etirer') {
      const c1 = await ctx.getPoint('Premier coin du cadre d’étirement (les sommets dedans se déplacent)');
      const c2 = await ctx.getPoint('Coin opposé', {
        preview: (q) => [{ type: 'LWPOLYLINE', layer: '0', color: 6, pts: rect(c1, q), bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 }],
      });
      const keys = await ctx.getSelection('Objets à étirer');
      return keys.length ? { id, type: 'stretch', param, frame: rect(c1, c2), keys } : null;
    }
    const type = { Deplacer: 'move', Echelle: 'scale', Rotation: 'rotate', Inversion: 'flip' }[kind];
    if (!type) return null;
    const keys = await ctx.getSelection(`Objets de l’action « ${ACTION_TYPES[type]} »`);
    return keys.length ? { id, type, param, keys } : null;
  }

  async function addParam(ctx, s, param, actionChoices, label) {
    const dyn = s.dyn();
    param.id = newId(dyn, 'P');
    param.name = (await ctx.getString('Nom du paramètre', { default: freeName(dyn, param.name) })).trim() || freeName(dyn, param.name);
    let action = null;
    if (actionChoices.length) {
      const k = await ctx.getKeyword('Action associée', [...actionChoices, 'Aucune'], { default: actionChoices[0] });
      action = await askAction(ctx, k, param.id, dyn);
    }
    dyn.params.push(param);
    if (action) dyn.actions.push(action);
    s.setDyn(dyn, label);
    ctx.print(`Paramètre « ${param.name} » (${PARAM_TYPES[param.type].toLowerCase()})${action ? ` avec l’action « ${ACTION_TYPES[action.type]} » (${action.keys.length} objet(s))` : ''}. BPARAMETRES pour régler valeurs, bornes et pas.`);
  }

  editor.register('PARAMLIN', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const p1 = await ctx.getPoint('Origine du paramètre linéaire');
    const p2 = await ctx.getPoint('Extrémité (longueur par défaut)', { base: p1 });
    if (G.dist(p1, p2) < 1e-9) { ctx.print('Longueur nulle.'); return; }
    await addParam(ctx, s, { type: 'linear', name: 'Distance', p1: P2(p1), p2: P2(p2) }, ['Etirer', 'Deplacer', 'Echelle'], 'Paramètre linéaire');
  }, { aliases: ['BPARAMLIN', 'PARAMLINEAIRE'], label: 'PARAMLIN' });

  editor.register('PARAMPOINT', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const p = await ctx.getPoint('Position du paramètre point');
    await addParam(ctx, s, { type: 'point', name: 'Position', p: P2(p) }, ['Deplacer', 'Etirer'], 'Paramètre point');
  }, { aliases: ['BPARAMPOINT'], label: 'PARAMPOINT' });

  editor.register('PARAMROT', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const c = await ctx.getPoint('Centre de rotation');
    const q = await ctx.getPoint('Rayon et angle de base (position de la poignée)', { base: c });
    if (G.dist(c, q) < 1e-9) { ctx.print('Rayon nul.'); return; }
    await addParam(ctx, s, { type: 'rotation', name: 'Angle', c: P2(c), r: G.dist(c, q), a0: G.angleOf(c, q) }, ['Rotation'], 'Paramètre de rotation');
  }, { aliases: ['BPARAMROT', 'PARAMROTATION'], label: 'PARAMROT' });

  editor.register('PARAMINV', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const p1 = await ctx.getPoint('Début de l’axe d’inversion');
    const p2 = await ctx.getPoint('Fin de l’axe', { base: p1 });
    if (G.dist(p1, p2) < 1e-9) { ctx.print('Axe nul.'); return; }
    await addParam(ctx, s, { type: 'flip', name: 'Inversion', p1: P2(p1), p2: P2(p2) }, ['Inversion'], 'Paramètre d’inversion');
  }, { aliases: ['BPARAMINV', 'PARAMINVERSION'], label: 'PARAMINV' });

  // --- visibilité ----------------------------------------------------------------------------------

  async function ensureVisibility(ctx, s) {
    let vis = s.visibility();
    if (vis) return vis;
    const p = await ctx.getPoint('Position de la poignée de visibilité');
    const dyn = s.dyn();
    vis = { id: newId(dyn, 'P'), type: 'visibility', name: 'Visibilité', p: P2(p), states: ['État1'], hidden: {} };
    dyn.params.push(vis);
    s.setDyn(dyn, 'Paramètre de visibilité');
    s.setVisState('État1');
    ctx.print('Paramètre de visibilité créé (état « État1 »). BVNOUVEAU pour ajouter des états, BVCACHER / BVMONTRER pour choisir les objets de chaque état.');
    return vis;
  }

  editor.register('VISIBILITE', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    await ensureVisibility(ctx, s);
    if (ctx.editor.ui.openVisStates) ctx.editor.ui.openVisStates();
    else ctx.print(`États : ${s.visibility().states.join(', ')} (courant : ${s.visState()}).`);
  }, { aliases: ['BVSTATE', 'ETATSVIS', 'BVETAT'], label: 'VISIBILITE' });

  // Paramètre de visibilité supplémentaire (variantes indépendantes : équipement, orientation du symbole…).
  editor.register('BVPARAM', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const p = await ctx.getPoint('Position de la poignée du nouveau paramètre de visibilité');
    const dyn = s.dyn();
    const name = (await ctx.getString('Nom du paramètre', { default: freeName(dyn, 'Visibilité') })).trim() || freeName(dyn, 'Visibilité');
    const vis = { id: newId(dyn, 'P'), type: 'visibility', name, p: P2(p), states: ['État1'], hidden: {} };
    dyn.params.push(vis);
    s.setDyn(dyn, 'Paramètre de visibilité');
    s.setVisParam(vis.id);
    ctx.print(`Paramètre de visibilité « ${name} » créé et rendu actif : ses états sont indépendants des autres.`);
  }, { aliases: ['NOUVELLEVIS', 'VISPARAM'], label: 'BVPARAM' });

  editor.register('BVACTIF', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const all = s.visibilities();
    if (all.length < 2) { ctx.print(all.length ? 'Un seul paramètre de visibilité.' : 'Pas de paramètre de visibilité (VISIBILITE).'); return; }
    const t = (await ctx.getString(`Paramètre de visibilité actif (${all.map((v) => v.name).join(', ')})`, { default: s.visibility().name })).trim();
    const v = all.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (!v) { ctx.print(`« ${t} » introuvable.`); return; }
    s.setVisParam(v.id);
    ctx.print(`Paramètre actif : « ${v.name} ».`);
  }, { aliases: ['VISACTIF'], label: 'BVACTIF', transaction: false });

  // Table de consultation : une liste de choix nommés qui règlent d'un coup les autres paramètres.
  editor.register('PARAMCONSULT', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const others = s.dyn().params.filter((x) => x.type !== 'lookup' && x.type !== 'point');
    if (!others.length) { ctx.print('Ajoutez d’abord les paramètres à piloter (linéaire, rotation, inversion, visibilité).'); return; }
    const p = await ctx.getPoint('Position de la poignée de la table');
    const dyn = s.dyn();
    const name = (await ctx.getString('Nom de la table', { default: freeName(dyn, 'Type') })).trim() || freeName(dyn, 'Type');
    const id = newId(dyn, 'P');
    dyn.params.push({ id, type: 'lookup', name, p: P2(p), rows: [] });
    s.setDyn(dyn, 'Table de consultation');
    if (ctx.editor.ui.openLookup) ctx.editor.ui.openLookup(id);
    else ctx.print(`Table « ${name} » créée : ajoutez ses lignes (BPARAMETRES → Table…).`);
  }, { aliases: ['BLOOKUP', 'CONSULTATION', 'PARAMTABLE'], label: 'PARAMCONSULT' });

  // Nouvel état, avec la visibilité de l'état courant.
  editor.register('BVNOUVEAU', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const vis = await ensureVisibility(ctx, s);
    let i = vis.states.length + 1;
    while (vis.states.includes(`État${i}`)) i++;
    const name = (await ctx.getString('Nom du nouvel état', { default: `État${i}` })).trim();
    if (!name || vis.states.includes(name)) { ctx.print('Nom vide ou déjà utilisé.'); return; }
    const dyn = s.dyn();
    const v = dyn.params.find((p) => p.id === vis.id);
    v.states.push(name);
    v.hidden = { ...(v.hidden || {}), [name]: [...(v.hidden?.[s.visState()] || [])] };
    s.setDyn(dyn, 'Nouvel état de visibilité');
    s.setVisState(name);
    ctx.print(`État « ${name} » créé (mêmes objets visibles que l’état précédent) et rendu courant.`);
  }, { aliases: ['BVNEW', 'NOUVELETAT'], label: 'BVNOUVEAU' });

  editor.register('BVCOURANT', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const vis = s.visibility();
    if (!vis) { ctx.print('Pas de paramètre de visibilité (VISIBILITE).'); return; }
    const k = await ctx.getKeyword('État courant', vis.states, { default: s.visState() });
    s.setVisState(k);
    ctx.print(`État « ${k} ».`);
  }, { aliases: ['ETATCOURANT'], label: 'BVCOURANT', transaction: false });

  editor.register('BVCACHER', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const vis = await ensureVisibility(ctx, s);
    const keys = await ctx.getSelection(`Objets à cacher dans l’état « ${s.visState()} »`);
    if (!keys.length) return;
    const dyn = s.dyn();
    const v = dyn.params.find((p) => p.id === vis.id);
    const st = s.visState();
    v.hidden = { ...(v.hidden || {}), [st]: [...new Set([...(v.hidden?.[st] || []), ...keys])] };
    s.setDyn(dyn, 'Cacher dans l’état');
    ctx.print(`${keys.length} objet(s) caché(s) dans l’état « ${st} ».`);
  }, { aliases: ['BVHIDE', 'CACHERETAT'], label: 'BVCACHER' });

  editor.register('BVMONTRER', async (ctx) => {
    const s = need(ctx);
    if (!s) return;
    const vis = s.visibility();
    if (!vis) { ctx.print('Pas de paramètre de visibilité (VISIBILITE).'); return; }
    const was = s.active.showHidden;
    s.active.showHidden = true;
    s.applyVisibility();
    try {
      const keys = await ctx.getSelection(`Objets à montrer dans l’état « ${s.visState()} » (objets cachés affichés)`);
      if (!keys.length) return;
      const dyn = s.dyn();
      const v = dyn.params.find((p) => p.id === vis.id);
      const st = s.visState();
      const set = new Set(keys);
      v.hidden = { ...(v.hidden || {}), [st]: (v.hidden?.[st] || []).filter((k) => !set.has(k)) };
      s.setDyn(dyn, 'Montrer dans l’état');
      ctx.print(`${keys.length} objet(s) visible(s) dans l’état « ${st} ».`);
    } finally {
      s.active.showHidden = was;
      s.applyVisibility();
    }
  }, { aliases: ['BVSHOW', 'MONTRERETAT'], label: 'BVMONTRER' });

  editor.register('BVMODE', (ctx) => {
    const s = need(ctx);
    if (!s) return;
    s.active.showHidden = !s.active.showHidden;
    s.applyVisibility();
    ctx.print(s.active.showHidden ? 'Objets cachés de l’état affichés.' : 'Objets cachés de l’état masqués.');
  }, { label: 'BVMODE', transaction: false });

  // --- liste des paramètres -------------------------------------------------------------------------

  editor.register('BPARAMETRES', (ctx) => {
    const s = need(ctx);
    if (!s) return;
    if (ctx.editor.ui.openBlockParams) { ctx.editor.ui.openBlockParams(); return; }
    const dyn = s.dyn();
    if (!dyn.params.length) { ctx.print('Aucun paramètre.'); return; }
    for (const p of dyn.params) {
      const acts = dyn.actions.filter((a) => a.param === p.id).map((a) => `${ACTION_TYPES[a.type]} (${a.keys.length})`);
      ctx.print(`${p.name} — ${PARAM_TYPES[p.type]}, défaut ${describeValue(p, defaultValue(p))}${acts.length ? ` — ${acts.join(', ')}` : ''}`);
    }
  }, { aliases: ['PARAMETRESBLOC', 'BPARAM'], label: 'BPARAMETRES', transaction: false });

  // --- attributs ---------------------------------------------------------------------------------------

  editor.register('SYNCATT', async (ctx) => {
    const { doc } = ctx;
    const sel = [...ctx.editor.selection].map((id) => doc.get(id)).find((e) => e?.type === 'INSERT');
    const names = userBlocks(doc);
    const t = (await ctx.getString('Bloc dont synchroniser les attributs', { default: sel?.name || names[0] || '' })).trim();
    const name = names.find((n) => n.toLowerCase() === t.toLowerCase());
    if (!name) { ctx.print(`Bloc « ${t} » introuvable.`); return; }
    let n = 0;
    for (const e of [...doc.entities.values()]) if (e.type === 'INSERT' && e.name === name) { doc.update(syncInsertAttribs(doc, e)); n++; }
    ctx.print(`${n} insertion(s) de « ${name} » synchronisée(s) avec les définitions d’attribut.`);
  }, { aliases: ['ATTSYNC'], label: 'SYNCATT' });

  return { userBlocks };
}
