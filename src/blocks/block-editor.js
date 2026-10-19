// SPDX-License-Identifier: GPL-3.0-or-later
// Éditeur de blocs (EDITBLOC), comme celui d'AutoCAD : la définition est ouverte dans un dessin de travail
// (ses objets, en coordonnées du bloc, avec leur propre historique d'annulation) ; on y dessine et modifie
// avec toutes les commandes, on y ajoute paramètres et actions dynamiques, puis on enregistre : la
// définition est remplacée en une étape annulable et toutes les insertions suivent (attributs synchronisés).
import * as G from '../core/geom.js';
import { Document } from '../core/document.js';
import { transformEntity, insertMatrix } from '../core/entities.js';
import { ensureKeys, cleanDyn, evaluate, isDynamic } from './dynamic.js';

// Dessin de travail d'une définition de bloc : objets (identifiant = clé dans le bloc), calques, types de
// ligne et blocs du dessin ; paramètres dynamiques dans l'en-tête (annulables avec les objets).
export function createBlockEditDoc(main, name) {
  const block = main.blocks.get(name);
  const tmp = new Document();
  tmp.layers = new Map([...main.layers].map(([n, l]) => [n, { ...l }]));
  tmp.ltypes = new Map(main.ltypes || []);
  tmp.blocks = new Map(main.blocks);
  tmp.blocks.delete(name); // un bloc ne peut pas s'insérer lui-même
  tmp.header = { ...(main.header || {}), blockDyn: structuredClone(block.dyn || { params: [], actions: [] }), blockBase: [...(block.base || [0, 0, 0])] };
  tmp.currentLayer = main.layers.has(main.currentLayer) ? main.currentLayer : '0';
  const ents = ensureKeys(block.entities.map((e) => structuredClone(e)));
  for (const e of ents) {
    const x = { ...e, id: e.k, space: 'model' };
    delete x.k;
    tmp.entities.set(x.id, x);
  }
  tmp.nextId = Math.max(0, ...ents.map((e) => e.k)) + 1;
  tmp.blockEdit = { name };
  return tmp;
}

// Définition reconstituée depuis le dessin de travail.
export function blockFromEditDoc(tmp, original) {
  const entities = [...tmp.entities.values()].filter((e) => (e.space || 'model') === 'model').map((e) => {
    const c = structuredClone(e);
    c.k = e.id;
    delete c.id;
    delete c.space;
    return c;
  });
  const dyn = cleanDyn(tmp.header.blockDyn, entities);
  const out = { ...original, base: [...(tmp.header.blockBase || [0, 0, 0])], entities };
  if (dyn) out.dyn = dyn; else delete out.dyn;
  return out;
}

// Attributs d'une insertion synchronisés avec les définitions d'attribut du bloc (comme ATTSYNC) : valeurs
// gardées par étiquette, positions et visibilité reprises des définitions, attributs ajoutés ou retirés.
export function syncInsertAttribs(doc, ins, block = doc.blocks.get(ins.name)) {
  if (!block) return ins;
  const defs = (isDynamic(block) ? evaluate(block, ins.dyn) : block.entities).filter((e) => e.type === 'ATTDEF');
  const old = new Map((ins.attribs || []).map((a) => [a.tag, a]));
  if (!defs.length && !old.size) return ins;
  const m = insertMatrix(ins, block.base || [0, 0]);
  const attribs = defs.map((d) => {
    const t = transformEntity({ ...d, type: 'TEXT' }, m);
    delete t.prompt; delete t.k; delete t.invisible;
    const prev = old.get(d.tag);
    return {
      ...t, type: 'TEXT', tag: d.tag, text: prev ? prev.text : d.text || '',
      layer: prev?.layer ?? (d.layer === '0' ? ins.layer : d.layer), color: prev?.color ?? t.color,
      ...(d.invisible ? { invisible: true } : {}),
    };
  });
  return { ...ins, attribs };
}

// Enregistre la définition dans le dessin principal (une étape annulable) : nouveaux calques et types de ligne
// repris, insertions mises à jour. Renvoie le nombre d'insertions.
export function saveBlockEdit(main, tmp) {
  const name = tmp.blockEdit.name;
  const block = blockFromEditDoc(tmp, main.blocks.get(name));
  let n = 0;
  main.transaction(`Modifier le bloc ${name}`, () => {
    for (const [ln, l] of tmp.layers) if (!main.layers.has(ln)) main.addLayer(ln, { ...l });
    for (const [tn, t] of tmp.ltypes || []) if (!main.ltypes?.has(tn)) main.setTableEntry('ltypes', tn, t);
    for (const [bn, b] of tmp.blocks) if (!main.blocks.has(bn)) main.setTableEntry('blocks', bn, b);
    main.setTableEntry('blocks', name, block);
    for (const e of [...main.entities.values()]) {
      if (e.type !== 'INSERT' || e.name !== name) continue;
      main.update(syncInsertAttribs(main, e, block));
      n++;
    }
    // Insertions dans d'autres blocs : leur géométrie suit (définition partagée) ; attributs non concernés.
  });
  return n;
}

// --- session -------------------------------------------------------------------------------------

// Session d'édition : remplace le dessin affiché par le dessin de travail, puis le rétablit.
// opts : { editor, renderer, getDoc(), setDoc(doc, info) } (setDoc : l'appli met à jour ses panneaux).
export class BlockEditorSession {
  constructor({ editor, renderer, getDoc, setDoc }) {
    Object.assign(this, { editor, renderer, getDoc, setDoc });
    this.active = null;
  }

  get editing() { return !!this.active; }
  get doc() { return this.active?.tmp; }
  get name() { return this.active?.name; }

  open(name) {
    const main = this.getDoc();
    const block = main.blocks.get(name);
    if (!block) throw new Error(`bloc « ${name} » introuvable`);
    if (block.xref || block.fond) throw new Error('une référence externe se modifie dans son propre fichier');
    if (name.startsWith('*')) throw new Error('bloc anonyme (cote, tableau…) : non modifiable');
    const tmp = createBlockEditDoc(main, name);
    this.active = {
      main, tmp, name, space: main.currentSpace || 'model', view: { center: { ...this.renderer.center }, scale: this.renderer.scale },
      selection: [...this.editor.selection], visParam: null, visStates: {}, showHidden: false, saved: tmp.undoStack.length,
    };
    this.setDoc(tmp, { blockEditor: true });
    this.renderer.overlayDrawers = [(ctx, view) => drawBlockOverlay(ctx, view, this)];
    this.applyVisibility();
    this.renderer.fit();
    // Les paramètres sont dans l'en-tête : leur annulation remet la visibilité à jour.
    tmp.on((change) => { if (change.reset) this.applyVisibility(); });
  }

  modified() {
    return !!this.active && this.active.tmp.undoStack.length !== this.active.saved;
  }

  save() {
    const a = this.active;
    const n = saveBlockEdit(a.main, a.tmp);
    a.saved = a.tmp.undoStack.length;
    return n;
  }

  close() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.renderer.overlayDrawers = [];
    this.setDoc(a.main, { blockEditor: false, space: a.space, view: a.view, selection: a.selection });
  }

  // Paramètres dynamiques du bloc en cours (copie) ; setDyn les remplace (annulable).
  dyn() { return structuredClone(this.active.tmp.header.blockDyn || { params: [], actions: [] }); }

  setDyn(dyn, label = 'Paramètres du bloc') {
    const tmp = this.active.tmp;
    tmp.transaction(label, () => tmp.setHeader({ blockDyn: dyn }));
    this.applyVisibility();
  }

  // Paramètres de visibilité du bloc ; l'un d'eux est « actif » (barre, commandes BVCACHER…).
  visibilities() {
    return (this.active?.tmp.header.blockDyn?.params || []).filter((p) => p.type === 'visibility');
  }

  visibility(id = this.active?.visParam) {
    const all = this.visibilities();
    return all.find((p) => p.id === id) || all[0] || null;
  }

  setVisParam(id) {
    this.active.visParam = id;
    this.renderer.requestRender();
  }

  // État affiché d'un paramètre de visibilité (le premier par défaut).
  visState(id) {
    const v = this.visibility(id);
    if (!v) return null;
    const st = this.active.visStates[v.id];
    return v.states.includes(st) ? st : v.states[0];
  }

  // Les objets cachés dans l'état affiché de chaque paramètre sont masqués (sauf « tout afficher »).
  setVisState(state, id) {
    const v = this.visibility(id);
    if (!v) return;
    this.active.visStates[v.id] = state;
    this.applyVisibility();
  }

  applyVisibility() {
    const a = this.active;
    if (!a) return;
    let hidden = null;
    if (!a.showHidden) {
      hidden = new Set();
      for (const v of this.visibilities()) for (const k of v.hidden?.[this.visState(v.id)] || []) if (a.tmp.entities.has(k)) hidden.add(k);
    }
    const cur = this.renderer.hiddenIds;
    const same = (!hidden?.size && !cur) || (hidden && cur && hidden.size === cur.size && [...hidden].every((k) => cur.has(k)));
    if (!same) this.renderer.setHidden(hidden?.size ? hidden : null);
    this.renderer.requestRender();
  }
}

// --- affichage des paramètres dans l'éditeur ----------------------------------------------------------

// Point de base, paramètres (cotes, points, arcs, axes, état de visibilité) et cadres d'étirement.
export function drawBlockOverlay(ctx, view, session) {
  const tmp = session.doc;
  if (!tmp) return;
  const dpr = view.dpr;
  const S = (p) => view.toScreen(p[0], p[1]);
  ctx.save();
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.lineWidth = 1.2 * dpr;
  const label = (p, text, color = '#0891b2') => {
    const w = ctx.measureText(text).width + 8 * dpr;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(p[0] - 2 * dpr, p[1] - 12 * dpr, w, 15 * dpr);
    ctx.fillStyle = color;
    ctx.fillText(text, p[0] + 2 * dpr, p[1]);
  };
  // Point de base du bloc.
  const b = S(tmp.header.blockBase || [0, 0]);
  ctx.strokeStyle = '#16a34a';
  ctx.beginPath();
  ctx.moveTo(b[0] - 12 * dpr, b[1]); ctx.lineTo(b[0] + 12 * dpr, b[1]);
  ctx.moveTo(b[0], b[1] - 12 * dpr); ctx.lineTo(b[0], b[1] + 12 * dpr);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(b[0], b[1], 5 * dpr, 0, Math.PI * 2); ctx.stroke();
  const dyn = tmp.header.blockDyn || { params: [], actions: [] };
  // Cadres d'étirement (pointillés).
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeStyle = '#d946ef';
  for (const a of dyn.actions || []) {
    if (a.type !== 'stretch' || !a.frame?.length) continue;
    const pts = a.frame.map(S);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#0891b2';
  ctx.fillStyle = '#0891b2';
  for (const p of dyn.params) {
    const acts = (dyn.actions || []).filter((a) => a.param === p.id).map((a) => a.type);
    const tag = `${p.name}${acts.length ? ` (${acts.length} action${acts.length > 1 ? 's' : ''})` : ''}`;
    if (p.type === 'linear') {
      const a = S(p.p1), c = S(p.p2);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
      for (const [q, s] of [[a, -1], [c, 1]]) {
        ctx.beginPath();
        ctx.moveTo(q[0], q[1]);
        ctx.lineTo(q[0] - s * Math.cos(ang - 0.4) * 9 * dpr, q[1] - s * Math.sin(ang - 0.4) * 9 * dpr);
        ctx.lineTo(q[0] - s * Math.cos(ang + 0.4) * 9 * dpr, q[1] - s * Math.sin(ang + 0.4) * 9 * dpr);
        ctx.closePath(); ctx.fill();
      }
      label([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - 4 * dpr], `${tag} = ${Math.round(G.dist(p.p1, p.p2) * 100) / 100}`);
    } else if (p.type === 'point') {
      const q = S(p.p);
      ctx.strokeRect(q[0] - 5 * dpr, q[1] - 5 * dpr, 10 * dpr, 10 * dpr);
      label([q[0] + 8 * dpr, q[1] - 6 * dpr], tag);
    } else if (p.type === 'rotation') {
      const c = S(p.c), r = (p.r || 1) * view.scale;
      ctx.beginPath(); ctx.arc(c[0], c[1], r, -(p.a0 || 0) - 0.6, -(p.a0 || 0) + 0.6); ctx.stroke();
      const q = S(G.polar(p.c, p.a0 || 0, p.r || 1));
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      label([q[0] + 6 * dpr, q[1] - 6 * dpr], tag);
    } else if (p.type === 'flip') {
      const a = S(p.p1), c = S(p.p2);
      ctx.setLineDash([10 * dpr, 3 * dpr, 2 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      ctx.setLineDash([]);
      label([(a[0] + c[0]) / 2 + 6 * dpr, (a[1] + c[1]) / 2 - 6 * dpr], tag);
    } else if (p.type === 'visibility') {
      const q = S(p.p || [0, 0]);
      ctx.beginPath(); ctx.moveTo(q[0] - 7 * dpr, q[1] - 4 * dpr); ctx.lineTo(q[0] + 7 * dpr, q[1] - 4 * dpr); ctx.lineTo(q[0], q[1] + 6 * dpr); ctx.closePath(); ctx.fill();
      const actif = session.visibility()?.id === p.id && session.visibilities().length > 1 ? ' ◂' : '';
      label([q[0] + 10 * dpr, q[1] + 2 * dpr], `${p.name} : ${session.visState(p.id) ?? ''}${session.active?.showHidden ? ' (tout affiché)' : ''}${actif}`);
    } else if (p.type === 'lookup') {
      const q = S(p.p || [0, 0]);
      ctx.beginPath(); ctx.moveTo(q[0] - 7 * dpr, q[1] - 4 * dpr); ctx.lineTo(q[0] + 7 * dpr, q[1] - 4 * dpr); ctx.lineTo(q[0], q[1] + 6 * dpr); ctx.closePath(); ctx.fill();
      label([q[0] + 10 * dpr, q[1] + 2 * dpr], `${p.name} (table : ${(p.rows || []).length} ligne(s))`);
    }
  }
  ctx.restore();
}

