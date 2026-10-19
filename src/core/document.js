// SPDX-License-Identifier: GPL-3.0-or-later
// Document de dessin : calques, blocs, entités, et historique annuler / rétablir.
//
// Les entités sont des objets simples, traités comme immuables : une modification
// remplace l'objet (doc.update / doc.modify), ce qui rend l'historique trivial
// (on garde l'objet « avant » et l'objet « après »).

import { renameInState } from './layerstates.js';

export const BYLAYER = 256;
export const BYBLOCK = 0;

export function cloneEntity(e) {
  return structuredClone(e);
}

// Épaisseur de ligne effective d'un objet en centièmes de mm (DuCalque résolu), ou -3 pour « Défaut ».
export function lineweightOf(doc, e) {
  let v = e.lweight;
  if (v == null || v === -1) v = doc.layers.get(e.layer)?.lweight;
  return v == null || v < 0 ? -3 : v;
}

// Épaisseur d'une part tessellée (jeton lw, voir tessellate.js) : DuCalque → calque de la part, 'L:<calque>'
// → ce calque, DuBloc hors bloc et défaut → -3.
export function partLineweight(doc, part) {
  let v = part.lw;
  if (typeof v === 'string') v = doc.layers.get(v.slice(2))?.lweight;
  else if (v == null || v === -1) v = doc.layers.get(part.layer)?.lweight;
  return v == null || v < 0 ? -3 : v;
}

export function defaultStyle(props = {}) {
  return { name: 'Standard', font: 'arial.ttf', bigFont: '', widthFactor: 1, oblique: 0, height: 0, ...props };
}

export function defaultLayer(name, props = {}) {
  return { name, color: 7, rgb: undefined, on: true, frozen: false, locked: false, ltype: 'Continuous', lweight: -3, ...props };
}

export class Document {
  constructor() {
    this.layers = new Map([['0', defaultLayer('0')]]);
    this.blocks = new Map();      // nom → { name, base: [x, y, z], entities: [...], flags, xref }
    this.entities = new Map();    // id → entité (ordre d'insertion = ordre de tracé)
    this.spaces = [{ id: 'model', label: 'Objet' }];
    this.header = { insunits: 0 };
    // Styles de texte (nom en majuscules → { name, font, bigFont, widthFactor, oblique (radians), height }).
    this.styles = new Map([['STANDARD', defaultStyle()]]);
    // États de calques (nom en majuscules → { name, desc, mask, current, layers }, voir layerstates.js).
    this.layerStates = new Map();
    // SCU nommés (nom en majuscules → { name, origin, angle }, voir ucs.js).
    this.ucsTable = new Map();
    this.currentLayer = '0';
    this.nextId = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.listeners = new Set();
    this.blockVersion = 0;        // incrémenté quand une définition de bloc change
    this.commitHooks = [];        // (change, ops) => … avant la fin de chaque transaction (cotes associatives, raccordements MEP)
  }

  // --- événements ---------------------------------------------------------------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(change) {
    for (const fn of this.listeners) fn(change);
  }

  // --- transactions -------------------------------------------------------------

  begin(name) {
    if (this.tx) { this.tx.depth++; return; }
    this.tx = { name, ops: [], depth: 1, change: newChange() };
  }

  commit() {
    if (!this.tx) return;
    if (this.tx.depth === 1 && this.commitHooks.length && !this.inHooks) {
      // Dernière chance d'ajouter des opérations à la transaction (même étape d'annulation).
      this.inHooks = true;
      // Un crochet en erreur ne doit pas laisser la transaction ouverte (plus rien ne serait annulable).
      try {
        for (const h of this.commitHooks) {
          try { h(this.tx.change, this.tx.ops); } catch (err) { console.error('Crochet de fin de transaction en erreur :', err); }
        }
      } finally { this.inHooks = false; }
    }
    if (--this.tx.depth > 0) return;
    const tx = this.tx;
    this.tx = null;
    if (tx.ops.length) {
      this.undoStack.push({ name: tx.name, ops: tx.ops });
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit(tx.change);
  }

  rollback() {
    if (!this.tx) return;
    const tx = this.tx;
    this.tx = null;
    const change = newChange();
    for (let i = tx.ops.length - 1; i >= 0; i--) this.revert(tx.ops[i], change);
    this.emit(change);
  }

  // Commande en plusieurs étapes : affiche ce qui a déjà été fait (objets ajoutés, modifiés, supprimés depuis le
  // dernier affichage) sans terminer la transaction — la commande reste une seule étape d'annulation.
  flush() {
    const tx = this.tx;
    if (!tx || (tx.flushed || 0) >= tx.ops.length) return;
    const c = newChange();
    for (const op of tx.ops.slice(tx.flushed || 0)) {
      const id = op.after?.id ?? op.before?.id;
      if (id == null || !['add', 'remove', 'modify'].includes(op.op)) continue;
      (op.op === 'add' ? c.added : op.op === 'remove' ? c.removed : c.modified).add(id);
    }
    tx.flushed = tx.ops.length;
    if (c.added.size || c.removed.size || c.modified.size) this.emit(c);
  }

  transaction(name, fn) {
    this.begin(name);
    try {
      const r = fn();
      this.commit();
      return r;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  record(op) {
    if (this.tx) {
      this.tx.ops.push(op);
      return this.tx.change;
    }
    // Hors transaction : opération isolée, annulable seule.
    this.undoStack.push({ name: op.op, ops: [op] });
    this.redoStack = [];
    return null;
  }

  // En-tête du dessin (unités, échelles…) : modification annulable ; la vue est reconstruite (types de ligne),
  // sauf réglage « léger » (SCU, icône) qui ne touche pas la géométrie.
  setHeader(props, { light = false } = {}) {
    const before = { ...(this.header || {}) };
    const after = { ...before, ...props };
    this.header = after;
    const change = this.record({ op: 'header', before, after, light });
    if (change) { if (light) change.view = true; else change.reset = true; }
    else this.emit({ ...newChange(), ...(light ? { view: true } : { reset: true }) });
  }

  // Présentations (liste, noms, ordre, mises en page) : remplacées d'un bloc, annulable.
  setSpaces(spaces) {
    const copy = (list) => list.map((sp) => structuredClone(sp));
    const before = copy(this.spaces);
    this.spaces = copy(spaces);
    const change = this.record({ op: 'spaces', before, after: copy(this.spaces) });
    if (change) change.spaces = true;
    else this.emit({ ...newChange(), spaces: true });
  }

  updateSpace(id, props) {
    this.setSpaces(this.spaces.map((sp) => (sp.id === id ? { ...sp, ...props } : sp)));
  }

  noteChange(change, kind, id) {
    if (change) change[kind].add(id);
    else {
      const c = newChange();
      c[kind].add(id);
      this.emit(c);
    }
  }

  // --- entités --------------------------------------------------------------------

  add(entity) {
    const e = { space: 'model', layer: this.currentLayer, color: BYLAYER, ...entity };
    // Nouvel objet : au-dessus de tous dans l'ordre de tracé (une copie ne garde pas la clé de l'original).
    if (e.id == null) { delete e.order; e.id = this.nextId++; }
    else this.nextId = Math.max(this.nextId, e.id + 1);
    this.entities.set(e.id, e);
    const change = this.record({ op: 'add', after: e });
    this.noteChange(change, 'added', e.id);
    return e;
  }

  // Ajout massif sans historique (import d'un fichier).
  load(entities) {
    for (const entity of entities) {
      const e = { space: 'model', color: BYLAYER, ...entity, id: this.nextId++ };
      this.entities.set(e.id, e);
    }
    this.emit({ ...newChange(), reset: true });
  }

  remove(id) {
    const before = this.entities.get(id);
    if (!before) return;
    this.entities.delete(id);
    const change = this.record({ op: 'remove', before });
    this.noteChange(change, 'removed', id);
  }

  update(entity) {
    const before = this.entities.get(entity.id);
    if (!before) throw new Error(`entité ${entity.id} introuvable`);
    this.entities.set(entity.id, entity);
    const change = this.record({ op: 'modify', before, after: entity });
    this.noteChange(change, 'modified', entity.id);
    return entity;
  }

  // Modification sans historique (vue d'une fenêtre pendant un zoom à la molette) ; voir commitQuiet.
  updateQuiet(entity) {
    this.entities.set(entity.id, entity);
    const c = newChange();
    c.modified.add(entity.id);
    this.emit(c);
  }

  // Une seule étape d'annulation pour le passage de `before` à l'état actuel de l'objet.
  commitQuiet(before, label) {
    const after = this.entities.get(before.id);
    if (!after || after === before) return;
    this.transaction(label, () => this.noteChange(this.record({ op: 'modify', before, after }), 'modified', after.id));
  }

  modify(id, fn) {
    const e = cloneEntity(this.entities.get(id));
    const r = fn(e);
    return this.update(r || e);
  }

  get(id) {
    return this.entities.get(id);
  }

  // --- calques -------------------------------------------------------------------

  addLayer(name, props = {}) {
    if (this.layers.has(name)) return this.layers.get(name);
    const layer = defaultLayer(name, props);
    this.layers.set(name, layer);
    const change = this.record({ op: 'layer', name, before: null, after: layer });
    this.noteChange(change, 'layers', name);
    return layer;
  }

  setLayer(name, props) {
    const before = this.layers.get(name);
    if (!before) throw new Error(`calque ${name} introuvable`);
    const after = { ...before, ...props };
    this.layers.set(name, after);
    const change = this.record({ op: 'layer', name, before, after });
    this.noteChange(change, 'layers', name);
    return after;
  }

  layer(name) {
    return this.layers.get(name) || this.layers.get('0');
  }

  // Renomme un calque et met à jour toutes les entités (y compris dans les blocs).
  renameLayer(oldName, newName) {
    const l = this.layers.get(oldName);
    if (!l || oldName === '0' || !newName || this.layers.has(newName)) return false;
    this.transaction('Renommer le calque', () => {
      this.layers.set(newName, { ...l, name: newName });
      this.noteChange(this.record({ op: 'layer', name: newName, before: null, after: this.layers.get(newName) }), 'layers', newName);
      for (const e of [...this.entities.values()]) {
        if (e.layer === oldName) this.modify(e.id, (x) => { x.layer = newName; });
      }
      for (const b of this.blocks.values()) for (const e of b.entities) if (e.layer === oldName) e.layer = newName;
      this.blockVersion++;
      this.layers.delete(oldName);
      this.noteChange(this.record({ op: 'layer', name: oldName, before: l, after: null }), 'layers', oldName);
      if (this.currentLayer === oldName) this.currentLayer = newName;
      // Les états de calques suivent le calque renommé.
      for (const [k, st] of [...(this.layerStates || [])]) {
        const next = renameInState(st, oldName, newName);
        if (next) this.setTableEntry('layerStates', k, next);
      }
    });
    return true;
  }

  // Supprime un calque inutilisé (ni entité, ni bloc, ni calque courant, ni « 0 »).
  deleteLayer(name) {
    const l = this.layers.get(name);
    if (!l || name === '0' || name === this.currentLayer) return false;
    // Objets, objets des blocs, et attributs des insertions (qui ont leur propre calque).
    const uses = (e) => e.layer === name || (e.attribs || []).some((a) => a.layer === name);
    for (const e of this.entities.values()) if (uses(e)) return false;
    for (const b of this.blocks.values()) if (b.entities.some(uses)) return false;
    this.layers.delete(name);
    this.noteChange(this.record({ op: 'layer', name, before: l, after: null }), 'layers', name);
    return true;
  }

  // Définition de bloc, type de ligne, style de texte ou état de calques (table 'blocks', 'ltypes', 'styles',
  // 'layerStates') ; value null = suppression. Annulable.
  setTableEntry(table, name, value) {
    if (!this[table]) this[table] = new Map();
    const map = this[table];
    const before = map.get(name) || null;
    if (value) map.set(name, value); else map.delete(name);
    if (table === 'blocks') this.blockVersion++;
    const change = this.record({ op: 'table', table, name, before, after: value || null });
    // Style de texte : les textes sont redessinés (police, largeur, oblique).
    if (table === 'styles') { if (change) change.reset = true; else this.emit({ ...newChange(), reset: true }); }
  }

  // --- annuler / rétablir ---------------------------------------------------------

  revert(op, change) {
    switch (op.op) {
      case 'add':
        this.entities.delete(op.after.id);
        change.removed.add(op.after.id);
        break;
      case 'remove':
        this.entities.set(op.before.id, op.before);
        change.added.add(op.before.id);
        break;
      case 'modify':
        this.entities.set(op.before.id, op.before);
        change.modified.add(op.before.id);
        break;
      case 'layer':
        if (op.before) this.layers.set(op.name, op.before); else this.layers.delete(op.name);
        change.layers.add(op.name);
        break;
      case 'table': {
        const map = this[op.table] || (this[op.table] = new Map());
        if (op.before) map.set(op.name, op.before); else map.delete(op.name);
        if (op.table === 'blocks') this.blockVersion++;
        if (op.table === 'styles') change.reset = true;
        break;
      }
      case 'header':
        this.header = { ...op.before };
        if (op.light) change.view = true; else change.reset = true;
        break;
      case 'spaces':
        this.spaces = op.before.map((sp) => structuredClone(sp));
        change.spaces = true;
        break;
    }
  }

  replay(op, change) {
    switch (op.op) {
      case 'add':
        this.entities.set(op.after.id, op.after);
        change.added.add(op.after.id);
        break;
      case 'remove':
        this.entities.delete(op.before.id);
        change.removed.add(op.before.id);
        break;
      case 'modify':
        this.entities.set(op.after.id, op.after);
        change.modified.add(op.after.id);
        break;
      case 'layer':
        if (op.after) this.layers.set(op.name, op.after); else this.layers.delete(op.name);
        change.layers.add(op.name);
        break;
      case 'table': {
        const map = this[op.table] || (this[op.table] = new Map());
        if (op.after) map.set(op.name, op.after); else map.delete(op.name);
        if (op.table === 'blocks') this.blockVersion++;
        if (op.table === 'styles') change.reset = true;
        break;
      }
      case 'header':
        this.header = { ...op.after };
        if (op.light) change.view = true; else change.reset = true;
        break;
      case 'spaces':
        this.spaces = op.after.map((sp) => structuredClone(sp));
        change.spaces = true;
        break;
    }
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    const change = newChange();
    for (let i = step.ops.length - 1; i >= 0; i--) this.revert(step.ops[i], change);
    this.redoStack.push(step);
    this.emit(change);
    return step.name;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    const change = newChange();
    for (const op of step.ops) this.replay(op, change);
    this.undoStack.push(step);
    this.emit(change);
    return step.name;
  }
}

function newChange() {
  return { added: new Set(), removed: new Set(), modified: new Set(), layers: new Set() };
}
