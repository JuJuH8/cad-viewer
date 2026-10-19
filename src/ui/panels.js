// SPDX-License-Identifier: GPL-3.0-or-later
// Panneaux latéraux : gestionnaire de calques et palette Propriétés.
import { plotStyleNames } from '../plot/styles.js';
import * as G from '../core/geom.js';
import { aciToColor, toCss } from '../colors.js';
import { pathOf } from '../core/path.js';
import { fmt } from '../editor/editor.js';
import { SYSTEMS, KIND_LABELS, EMBED_LABELS, conduitLtype, kindLabel, systemByCode, ensureSystemLayer, slopeText } from '../mep/systems.js';
import { mepLength, labelHeight, filletedAxis, elbowRadius } from '../mep/geometry.js';
import { TRAY_MAKERS, catalogRadius } from '../mep/trays.js';
import { velocity, sectionMm, unitMmOf } from '../mep/network.js';
import { insertMatrix, transformEntity } from '../core/entities.js';
import { SYMBOLS, CATEGORIES, refreshAttribs, attribsFor } from '../elec/symbols.js';
import { boards } from '../elec/circuits.js';
import { SCALES } from '../layout/sheet.js';
import { isDynamic, valueOf, withValue, choicesOf, CUSTOM_ROW, pointPosition, pointValueAt } from '../blocks/dynamic.js';
import { overrideCount } from '../layout/vplayers.js';
import { underlayRows, setUnderlayField } from '../underlay/commands.js';
import { hatchRows, setHatchField } from '../hatch/commands.js';
import { layerStateList, applyLayerState } from './layerstates.js';
import { stateMatches } from '../core/layerstates.js';
import { detailRows, selectionRows, setDetail, typeLabel, vertexCursor } from './props-info.js';

// Sections repliées de la palette Propriétés (titre de section), retenues dans le navigateur.
const COLLAPSED_KEY = 'cv-props-collapsed';
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch { return []; } })());
function applyCollapsed(box) {
  let hide = false;
  for (const el of box.children) {
    if (el.classList.contains('section')) { hide = collapsed.has(el.textContent.trim()); el.classList.toggle('collapsed', hide); continue; }
    el.classList.toggle('sec-hidden', hide);
  }
}

// Icônes des calques (trait = couleur du texte).
const ico = (d) => `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const LAYER_ICONS = {
  eye: ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: ico('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  snow: ico('<path d="M12 2v20M4.9 7l14.2 10M4.9 17L19.1 7"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>'),
  lock: ico('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: ico('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
  x: ico('<path d="M6 6l12 12M18 6L6 18"/>'),
};


const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// Épaisseurs de ligne normalisées (centièmes de mm) ; -1 DuCalque, -2 DuBloc, -3 Défaut.
export const LW_CHOICES = [[-1, 'DuCalque'], [-2, 'DuBloc'], [-3, 'Défaut'], ...[0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211]
  .map((v) => [v, `${(v / 100).toFixed(2).replace('.', ',')} mm`])];
export const lwLabel = (v) => (LW_CHOICES.find(([k]) => k === v) || [0, `${v}`])[1];

const COLOR_CHOICES = [
  [256, 'DuCalque'], [0, 'DuBloc'], [1, 'Rouge'], [2, 'Jaune'], [3, 'Vert'], [4, 'Cyan'],
  [5, 'Bleu'], [6, 'Magenta'], [7, 'Blanc / noir'], [8, 'Gris 8'], [9, 'Gris 9'],
  [30, 'Orange 30'], [40, 'Orange 40'], [140, 'Bleu ciel 140'], [150, 'Bleu 150'], [250, 'Gris foncé 250'],
];

function layerCss(layer, fg) {
  const c = typeof layer.rgb === 'number' ? layer.rgb : aciToColor(layer.color);
  return toCss(c, fg);
}

// --- calques -----------------------------------------------------------------------

export class LayerPanel {
  constructor({ getDoc, renderer, onCurrent, onSelectLayer, onManageStates }) {
    this.getDoc = getDoc;
    this.r = renderer;
    this.onCurrent = onCurrent;
    this.onSelectLayer = onSelectLayer;
    // États de calques : la liste restaure l'état choisi (comme la liste du ruban d'AutoCAD).
    $('layer-state').addEventListener('change', (e) => {
      const doc = this.getDoc();
      const name = e.target.value;
      if (doc && name) applyLayerState(doc, name);
      this.onCurrent?.();
      this.render();
    });
    $('layer-state-manage').addEventListener('click', () => onManageStates?.());
    this.counts = new Map();
    $('layer-filter').addEventListener('input', () => this.render());
    $('layers-empty').addEventListener('change', () => this.render());
    $('layers-all').addEventListener('click', () => this.setAll(true));
    $('layers-none').addEventListener('click', () => this.setAll(false));
    $('layer-add').addEventListener('click', () => this.addLayer());
    $('layer-list').addEventListener('click', (e) => this.click(e));
    $('layer-list').addEventListener('dblclick', (e) => this.rename(e));
    $('layer-list').addEventListener('contextmenu', (e) => {
      const name = e.target.closest('li')?.dataset.layer;
      if (name == null) return;
      e.preventDefault();
      this.onSelectLayer?.(name);
    });
  }

  recount() {
    const doc = this.getDoc();
    this.counts = new Map();
    this.inBlocks = new Set();
    if (!doc) return;
    for (const e of doc.entities.values()) this.counts.set(e.layer, (this.counts.get(e.layer) || 0) + 1);
    // Calques utilisés seulement à l'intérieur des blocs (références externes, symboles) : affichés aussi.
    for (const b of doc.blocks.values()) for (const e of b.entities) this.inBlocks.add(e.layer);
  }

  renderStates(doc) {
    const sel = $('layer-state');
    const list = doc ? layerStateList(doc) : [];
    const same = list.find((s) => stateMatches(doc, s));
    sel.innerHTML = `<option value="">${list.length ? (same ? '' : 'État non enregistré') : 'Aucun état de calques'}</option>${list.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}`;
    sel.value = same ? same.name : '';
    if (same) sel.options[0].hidden = true;
    sel.disabled = !list.length;
  }

  render() {
    const doc = this.getDoc();
    this.renderStates(doc);
    if (!doc) { $('layer-list').innerHTML = ''; return; }
    const filter = $('layer-filter').value.trim().toLowerCase();
    const showEmpty = $('layers-empty').checked;
    const fg = this.r.theme.foreground;
    const layers = [...doc.layers.values()]
      .filter((l) => (showEmpty || this.counts.get(l.name) || this.inBlocks?.has(l.name) || l.name === doc.currentLayer || l.name === '0') && l.name.toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    $('layer-list').innerHTML = layers.map((l) => {
      const n = this.counts.get(l.name) || 0;
      const cls = [l.name === doc.currentLayer ? 'current' : '', n || this.inBlocks?.has(l.name) ? '' : 'empty'].join(' ');
      return `<li class="${cls}" data-layer="${esc(l.name)}">
        <button class="cur" data-act="current" title="Rendre courant" aria-label="Rendre le calque ${esc(l.name)} courant"></button>
        <span class="name" data-act="current" title="${esc(l.name)} (${n} objet${n > 1 ? 's' : ''})">
          <button class="swatch" data-act="color" style="background:${layerCss(l, fg)}" title="Couleur ${typeof l.rgb === 'number' ? 'RVB' : l.color}" aria-label="Couleur du calque"></button>
          <span>${esc(l.name)}</span>
        </span>
        <button class="ico ${l.on ? 'on' : ''}" data-act="on" title="${l.on ? 'Activé' : 'Désactivé'}" aria-label="Activer ou désactiver">${LAYER_ICONS[l.on ? 'eye' : 'eyeOff']}</button>
        <button class="ico ${l.frozen ? 'alert' : ''}" data-act="frozen" title="${l.frozen ? 'Gelé' : 'Libéré'}" aria-label="Geler ou libérer">${LAYER_ICONS.snow}</button>
        <button class="ico ${l.locked ? 'alert' : ''}" data-act="locked" title="${l.locked ? 'Verrouillé' : 'Déverrouillé'}" aria-label="Verrouiller ou déverrouiller">${LAYER_ICONS[l.locked ? 'lock' : 'unlock']}</button>
        ${n || this.inBlocks?.has(l.name) || l.name === '0' || l.name === doc.currentLayer ? '<span></span>' : `<button class="ico del" data-act="delete" title="Supprimer ce calque vide" aria-label="Supprimer le calque">${LAYER_ICONS.x}</button>`}
      </li>`;
    }).join('');
  }

  click(ev) {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    const name = ev.target.closest('li')?.dataset.layer;
    const doc = this.getDoc();
    if (!act || name == null || !doc) return;
    const l = doc.layers.get(name);
    if (act === 'current') {
      if (l.frozen) return; // un calque gelé ne peut pas être courant
      doc.currentLayer = name;
      this.onCurrent?.(name);
      this.render();
      return;
    }
    if (act === 'color') {
      openColorPicker(ev.target, l.color, (n) => doc.transaction('Couleur de calque', () => doc.setLayer(name, { color: n, rgb: undefined })));
      return;
    }
    if (act === 'delete') {
      doc.transaction('Supprimer le calque', () => doc.deleteLayer(name));
      this.render();
      return;
    }
    if (act === 'frozen' && name === doc.currentLayer && !l.frozen) return; // on ne gèle pas le calque courant
    doc.transaction('Calque', () => doc.setLayer(name, { [act]: !l[act] }));
  }

  // Double-clic sur un nom : champ de saisie pour renommer (Entrée valide, Échap annule).
  rename(ev) {
    const span = ev.target.closest('.name span');
    const li = ev.target.closest('li');
    const doc = this.getDoc();
    if (!span || !li || !doc || li.dataset.layer === '0') return;
    const old = li.dataset.layer;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = old;
    span.replaceWith(input);
    input.focus();
    input.select();
    const done = (ok) => {
      const v = input.value.trim();
      if (ok && v && v !== old) {
        if (/[<>/\\":;?*|,=`]/.test(v)) { alert('Caractères interdits dans un nom de calque.'); }
        else if (!doc.renameLayer(old, v)) { alert('Ce nom est déjà utilisé.'); }
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => done(true), { once: true });
  }

  setAll(on) {
    const doc = this.getDoc();
    if (!doc) return;
    doc.transaction(on ? 'Tout afficher' : 'Tout masquer', () => {
      for (const l of doc.layers.values()) if (l.on !== on && (on || l.name !== doc.currentLayer)) doc.setLayer(l.name, { on });
    });
  }

  addLayer(name) {
    const doc = this.getDoc();
    if (!doc) return null;
    if (!name) {
      let i = 1;
      while (doc.layers.has(`Calque${i}`)) i++;
      name = `Calque${i}`;
    }
    if (!doc.layers.has(name)) doc.transaction('Nouveau calque', () => doc.addLayer(name, { color: 7 }));
    doc.currentLayer = name;
    this.onCurrent?.(name);
    this.render();
    return name;
  }
}

// --- propriétés --------------------------------------------------------------------

export class PropertiesPanel {
  constructor({ getDoc, getSelection, onAction }) {
    this.getDoc = getDoc;
    this.getSelection = getSelection;
    this.onAction = onAction; // boutons du panneau (data-act), ex. calques d'une fenêtre
    $('props').addEventListener('change', (e) => this.change(e));
    $('props').addEventListener('click', (e) => {
      // Titre de section : replier / déplier.
      const sec = e.target.closest('.section');
      if (sec) {
        const k = sec.textContent.trim();
        if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* navigation privée */ }
        applyCollapsed($('props'));
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      // Sommet courant d'une polyligne (◀ ▶).
      if (act === 'vtx-prev' || act === 'vtx-next') {
        const ent = this.getDoc()?.get(this.getSelection()[0]);
        if (ent?.pts) {
          const n = ent.pts.length;
          vertexCursor.set(ent.id, ((vertexCursor.get(ent.id) ?? 0) + (act === 'vtx-next' ? 1 : -1) + n) % n);
          this.render();
        }
        return;
      }
      if (act) this.onAction?.(act, this.getSelection());
    });
  }

  render() {
    const doc = this.getDoc();
    const ids = this.getSelection();
    const box = $('props');
    $('sel-count').textContent = ids.length ? `${ids.length} sélectionné(s)` : '';
    if (!doc) { box.innerHTML = ''; return; }
    if (!ids.length) {
      box.innerHTML = `<div class="hint">Aucune sélection. Cliquez un objet, ou tracez une fenêtre
        (gauche → droite : objets entièrement dedans ; droite → gauche : objets touchés).</div>
        <div class="section">Dessin</div>
        <div class="row"><label>Calque courant</label><span class="ro">${esc(doc.currentLayer)}</span></div>
        <div class="row"><label>Objets</label><span class="ro">${doc.entities.size}</span></div>
        <div class="row"><label>Calques</label><span class="ro">${doc.layers.size}</span></div>
        <div class="row"><label>Blocs</label><span class="ro">${doc.blocks.size}</span></div>`;
      return;
    }
    const ents = ids.map((id) => doc.get(id)).filter(Boolean);
    const common = (f) => {
      const v = f(ents[0]);
      return ents.every((e) => f(e) === v) ? v : undefined;
    };
    const types = [...new Set(ents.map((e) => e.type))];
    const layer = common((e) => e.layer);
    const color = common((e) => (typeof e.rgb === 'number' ? -1 : e.color ?? 256));
    const layerOpts = [...doc.layers.keys()].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
      .map((n) => `<option value="${esc(n)}" ${n === layer ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const colorOpts = COLOR_CHOICES.map(([v, l]) => `<option value="${v}" ${v === color ? 'selected' : ''}>${l}</option>`).join('')
      + (color === -1 ? '<option value="-1" selected>Couleur RVB</option>' : '')
      + (color != null && color !== -1 && !COLOR_CHOICES.some(([v]) => v === color) ? `<option value="${color}" selected>Index ${color}</option>` : '');
    // Type et épaisseur de ligne (absents = DuCalque).
    const ltype = common((e) => e.ltype || 'ByLayer');
    const lweight = common((e) => e.lweight ?? -1);
    const ltNames = ['ByLayer', 'ByBlock', 'Continuous', ...[...(doc.ltypes?.values() || [])].map((t) => t.name).filter((n) => !/^(bylayer|byblock|continuous)$/i.test(n))];
    const ltLabel = (n) => ({ ByLayer: 'DuCalque', ByBlock: 'DuBloc', Continuous: 'Continu' }[n] || n);
    const ltOpts = ltNames.map((n) => `<option value="${esc(n)}" ${n.toLowerCase() === String(ltype).toLowerCase() ? 'selected' : ''}>${esc(ltLabel(n))}</option>`).join('');
    const lwOpts = LW_CHOICES.map(([v, l]) => `<option value="${v}" ${v === lweight ? 'selected' : ''}>${l}</option>`).join('');
    // Dessin en styles de tracé nommés : style de l'objet (DuCalque par défaut).
    const pstyle = common((e) => e.pstyle || '');
    const psRow = doc.header?.pstylemode === 0
      ? `<div class="row"><label>Style de tracé</label><select data-f="pstyle">${pstyle === undefined ? '<option selected>*DIVERS*</option>' : ''}${['', ...plotStyleNames(doc)].map((n) => `<option value="${esc(n)}" ${n === pstyle ? 'selected' : ''}>${esc(n || 'DuCalque')}</option>`).join('')}</select></div>` : '';
    const ltscale = common((e) => e.ltscale || 1);
    const one = ents.length === 1 ? ents[0] : null;
    let html = `<div class="section">Général</div>
      <div class="row"><label>Type</label><span class="ro">${types.length === 1 ? `${esc(typeLabel(ents[0]))} <span class="muted">(${esc(types[0])})</span>` : `${types.length} types`}</span></div>
      ${one ? `<div class="row"><label>Identifiant</label><span class="ro">${esc(one.handle ?? one.id)}</span></div>` : ''}
      <div class="row"><label>Calque</label><select data-f="layer">${layer === undefined ? '<option selected>*DIVERS*</option>' : ''}${layerOpts}</select></div>
      <div class="row"><label>Couleur</label><select data-f="color">${color === undefined ? '<option selected>*DIVERS*</option>' : ''}${colorOpts}</select></div>
      <div class="row"><label>Type de ligne</label><select data-f="ltype">${ltype === undefined ? '<option selected>*DIVERS*</option>' : ''}${ltOpts}</select></div>
      <div class="row"><label>Épaisseur</label><select data-f="lweight">${lweight === undefined ? '<option selected>*DIVERS*</option>' : ''}${lwOpts}</select></div>${psRow}
      <div class="row"><label>Échelle type de ligne</label><input data-f="ltscale" value="${ltscale === undefined ? '' : esc(fmt(ltscale))}"${ltscale === undefined ? ' placeholder="*DIVERS*"' : ''}></div>`;
    if (ents.length === 1) html += geometryRows(ents[0], doc);
    else {
      if (ents.every((e) => e.mep && e.type === 'LWPOLYLINE' && e.mep.kind === ents[0].mep.kind)) html += multiMepRows(ents);
      html += selectionRows(ents, { row, fmt, doc });
    }
    box.innerHTML = html;
    applyCollapsed(box);
  }

  change(ev) {
    const f = ev.target.dataset.f;
    if (!f) return;
    const doc = this.getDoc();
    const ids = this.getSelection();
    const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    const renamed = f === 'elecName' ? ids.map((id) => doc.get(id)?.elec?.board).filter(Boolean) : [];
    doc.transaction('Propriétés', () => {
      // Tableau renommé : ses appareils et ses tableaux secondaires suivent.
      for (const old of renamed) {
        const nv = String(v).trim();
        if (!nv || nv === old) continue;
        for (const x of [...doc.entities.values()]) {
          if (!x.elec || ids.includes(x.id)) continue;
          if (x.elec.board === old && x.elec.kind !== 'board') doc.modify(x.id, (y) => { y.elec = { ...y.elec, board: nv }; refreshAttribs(y); });
          if (x.elec.kind === 'board' && x.elec.parent === old) doc.modify(x.id, (y) => { y.elec = { ...y.elec, parent: nv }; refreshAttribs(y); });
        }
      }
      for (const id of ids) {
        const e = structuredClone(doc.get(id));
        if (!e) continue;
        if (f === 'layer') {
          if (!doc.layers.has(v)) continue;
          e.layer = v;
        } else if (f === 'color') {
          const n = parseInt(v, 10);
          if (n === -1 || Number.isNaN(n)) continue;
          e.color = n;
          delete e.rgb;
        } else if (f === 'ltype') {
          if (v === '*DIVERS*') continue;
          if (/^bylayer$/i.test(v)) delete e.ltype; else e.ltype = v;
        } else if (f === 'lweight') {
          const n = parseInt(v, 10);
          if (Number.isNaN(n)) continue;
          if (n === -1) delete e.lweight; else e.lweight = n;
        } else if (f === 'pstyle') {
          if (v === '*DIVERS*') continue;
          if (v) e.pstyle = v; else delete e.pstyle;
        } else if (f === 'mepSystem') {
          const sys = systemByCode(v);
          if (!sys || !e.mep) continue;
          e.mep.system = sys.code;
          e.layer = ensureSystemLayer(doc, sys);
        } else if (!setGeometry(e, f, v, doc)) continue;
        doc.update(e);
      }
    });
    this.render();
  }
}

function row(label, field, value, opts = {}) {
  if (opts.ro) return `<div class="row"><label>${label}</label><span class="ro">${esc(value)}</span></div>`;
  if (opts.check) return `<div class="row"><label>${label}</label><input type="checkbox" data-f="${field}" ${value ? 'checked' : ''}></div>`;
  const ph = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
  return `<div class="row"><label>${label}</label><input data-f="${field}" value="${esc(value)}"${ph}></div>`;
}

// Plusieurs réseaux de même nature : valeurs communes, *DIVERS* sinon ; une saisie s'applique à tous.
function multiMepRows(ents) {
  const kind = ents[0].mep.kind;
  const common = (f) => { const v = f(ents[0].mep); return ents.every((e) => f(e.mep) === v) ? v : undefined; };
  const val = (f) => { const v = common(f); return v === undefined ? '' : fmt(v); };
  const sys = common((m) => m.system);
  const opts = SYSTEMS.filter((s) => s.kind === kind)
    .map((s) => `<option value="${s.code}" ${s.code === sys ? 'selected' : ''}>${esc(s.code)} — ${esc(s.label)}</option>`).join('');
  let h = `<div class="section">${KIND_LABELS[kind] || 'Réseaux'} — ${ents.length} objets</div>
    <div class="row"><label>Système</label><select data-f="mepSystem">${sys === undefined ? '<option selected>*DIVERS*</option>' : ''}${opts}</select></div>`;
  const D = { placeholder: '*DIVERS*' };
  const round = ents.every((e) => e.mep.kind === 'pipe' || e.mep.shape === 'round');
  const rect = ents.every((e) => e.mep.kind !== 'pipe' && e.mep.shape !== 'round');
  if (round) h += row('Diamètre', 'mepD', val((m) => m.d), D);
  if (rect) h += row('Largeur', 'mepW', val((m) => m.w), D) + row('Hauteur', 'mepH', val((m) => m.h), D);
  h += row('Altitude', 'mepZ', val((m) => m.z || 0), D) + row('Calorifuge (mm)', 'mepIns', val((m) => m.ins || 0), D)
    + row('Longueur totale', '', fmt(ents.reduce((s, e) => s + mepLength(e), 0)), { ro: true });
  return h;
}

function terminalRows(e) {
  const m = e.mep;
  const opts = SYSTEMS.filter((s) => s.kind === (m.water || m.hydro ? 'pipe' : 'duct') && !s.conduit)
    .map((s) => `<option value="${s.code}" ${s.code === m.system ? 'selected' : ''}>${esc(s.code)} — ${esc(s.label)}</option>`).join('');
  return `<div class="section">Terminal</div>
    <div class="row"><label>Système</label><select data-f="mepSystem">${opts}</select></div>`
    + row('Type', '', m.terminal, { ro: true })
    + row('Dimensions', '', m.d && !m.w ? `Ø${fmt(m.d)}` : `${fmt(m.w)}×${fmt(m.h)}`, { ro: true })
    + row(m.water || m.hydro ? 'Débit (l/s)' : 'Débit (m³/h)', 'mepQ', fmt(m.q || 0))
    + (m.hydro ? row('Puissance', '', `${fmt(m.power || 0)} W (ΔT ${fmt(m.dt || 0)} K)`, { ro: true }) : '')
    + row('Altitude', 'mepZ', fmt(m.z || 0))
    + row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1]));
}

function supportRows(e) {
  const m = e.mep;
  const acc = m.kind === 'accessory';
  return `<div class="section">${acc ? 'Accessoire' : 'Support'}</div>`
    + row('Type', '', acc ? m.label || m.type : m.type, { ro: true }) + row('Système', '', m.system, { ro: true })
    + row('Section du réseau', '', m.section, { ro: true }) + (acc ? '' : row('Entraxe maximal (m)', '', fmt(m.spacing || 0), { ro: true }))
    + row('Altitude du réseau', '', fmt(m.z || 0), { ro: true })
    + row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1]));
}

// Coudes d'une gaine (à rayon / à onglet) ou d'un chemin de câbles (fabricant du catalogue / à onglet).
function elbowRows(e) {
  const m = e.mep;
  const miter = m.elbow === 'miter';
  const choices = m.kind === 'tray'
    ? [...Object.entries(TRAY_MAKERS).map(([k, x]) => [k, `À rayon — ${x.label}`]), ['miter', 'À onglet']]
    : [['radius', 'À rayon'], ['miter', 'À onglet']];
  const cur = miter ? 'miter' : m.kind === 'tray' ? (TRAY_MAKERS[m.maker] ? m.maker : '') : 'radius';
  const opts = (cur ? '' : '<option value="" selected>À rayon (largeur)</option>')
    + choices.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  let h = `<div class="row"><label>Coudes</label><select data-f="mepElbow">${opts}</select></div>`;
  if (m.kind === 'tray' && !miter) {
    h += row('Rayon intérieur', 'mepRi', fmt(m.ri > 0 ? m.ri : m.w / 2));
    const short = filletedAxis(e, elbowRadius(e)).short?.length || 0;
    if (short) h += row('Coudes à onglet (place)', '', `${short} — tronçons trop courts`, { ro: true });
  }
  return h;
}

function mepRows(e, doc) {
  if (e.type === 'INSERT') return e.mep.kind === 'support' || e.mep.kind === 'accessory' ? supportRows(e) : terminalRows(e);
  const m = e.mep;
  const v = () => velocity(m.q, sectionMm(m, unitMmOf(doc))).toFixed(2).replace('.', ','); // sections du dessin → mm
  const opts = SYSTEMS.filter((s) => s.kind === m.kind && !!s.conduit === !!m.conduit)
    .map((s) => `<option value="${s.code}" ${s.code === m.system ? 'selected' : ''}>${esc(s.code)} — ${esc(s.label)}</option>`).join('');
  let h = `<div class="section">${kindLabel(m)}</div>
    <div class="row"><label>Système</label><select data-f="mepSystem">${opts}</select></div>`;
  if (m.kind === 'pipe' || m.shape === 'round') h += row('Diamètre', 'mepD', fmt(m.d));
  else h += row('Largeur', 'mepW', fmt(m.w)) + row('Hauteur', 'mepH', fmt(m.h));
  if (m.kind !== 'pipe') h += elbowRows(e);
  if (m.conduit) h += `<div class="row"><label>Pose</label><select data-f="mepEmbed">${Object.entries(EMBED_LABELS).map(([k, l]) => `<option value="${k}" ${k === m.embed ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  h += row(m.z1 != null ? 'Altitude début' : 'Altitude', 'mepZ', fmt(m.z || 0)) + row('Altitude fin', 'mepZ1', fmt(m.z1 ?? m.z ?? 0))
    + (m.z1 != null ? row('Pente', '', slopeText(e) || '0 %', { ro: true }) : '')
    + row('Calorifuge (mm)', 'mepIns', fmt(m.ins || 0)) + row('Hauteur texte', 'mepTh', fmt(labelHeight(e)))
    + row('Tronçons', '', String(e.pts.length - 1), { ro: true }) + row('Longueur', '', fmt(mepLength(e)), { ro: true });
  if (m.kind === 'pipe' && m.q) {
    h += row('Débit probable (l/s)', '', fmt(m.q), { ro: true })
      + row('Vitesse (m/s)', '', v(), { ro: true });
  }
  if (m.kind === 'duct' && m.q) {
    h += row('Débit (m³/h)', '', fmt(m.q), { ro: true })
      + row('Vitesse (m/s)', '', v(), { ro: true });
  }
  return h;
}

// Appareil ou tableau électrique : tableau, circuit, puissance, phases, désignation.
function elecRows(e, doc) {
  const m = e.elec, s = SYMBOLS[m.sym];
  let h = `<div class="section">${esc(m.label || s?.label || 'Appareil électrique')}</div>` + row('Catégorie', '', CATEGORIES[m.cat]?.label || m.cat || '', { ro: true })
    + (m.block ? row('Bloc', '', m.block, { ro: true }) : '');
  const opts = (list, cur) => list.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
  if (m.kind === 'board') {
    const others = boards(doc).filter((b) => b.id !== e.id).map((b) => b.elec.board);
    h += row('Nom du tableau', 'elecName', m.board || '')
      + `<div class="row"><label>Alimenté par</label><select data-f="elecParent"><option value="">—</option>${opts(others, m.parent)}</select></div>`
      + row('Circuits réglés', '', String((m.circuits || []).length), { ro: true });
  } else {
    const bs = boards(doc).map((b) => b.elec.board);
    h += `<div class="row"><label>Tableau</label><select data-f="elecBoard"><option value="">—</option>${opts(bs, m.board)}</select></div>`
      + row('Circuit', 'elecCircuit', m.circuit || '')
      + row('Puissance (W)', 'elecP', fmt(m.p || 0))
      + `<div class="row"><label>Alimentation</label><select data-f="elecPh"><option value="1" ${m.ph !== 3 ? 'selected' : ''}>Mono 230 V</option><option value="3" ${m.ph === 3 ? 'selected' : ''}>Tri 400 V</option></select></div>`
      + row('Désignation', 'elecDesc', m.desc || '', { placeholder: 'affichée à la place de la puissance' })
      + row('Hauteur de pose (m)', 'elecH', m.h != null ? fmt(m.h) : '');
  }
  return h + row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1])) + row('Rotation', 'rot', fmt(deg(e.rot || 0)));
}

// Propriétés « Personnalisé » d'un bloc dynamique : une ligne par paramètre (valeur de l'insertion).
function dynamicRows(e, doc) {
  const block = doc?.blocks.get(e.name);
  if (!isDynamic(block)) return '';
  let h = `<div class="section">Personnalisé</div>`;
  for (const p of block.dyn.params) {
    const v = valueOf(p, e.dyn);
    const label = esc(p.name || p.id);
    if (p.type === 'visibility' || p.type === 'lookup') {
      const choices = choicesOf(p);
      h += `<div class="row"><label>${label}</label><select data-f="dyn:${esc(p.id)}">${p.type === 'lookup' && v === CUSTOM_ROW ? `<option selected>${CUSTOM_ROW}</option>` : ''}${choices.map((st) => `<option ${st === v ? 'selected' : ''}>${esc(st)}</option>`).join('')}</select></div>`;
    } else if (p.type === 'linear') {
      h += p.list?.length
        ? `<div class="row"><label>${label}</label><select data-f="dyn:${esc(p.id)}">${p.list.map((x) => `<option value="${x}" ${Math.abs(x - v) < 1e-9 ? 'selected' : ''}>${fmt(x)}</option>`).join('')}</select></div>`
        : row(label, `dyn:${p.id}`, fmt(v));
    } else if (p.type === 'rotation') h += row(`${label} (°)`, `dyn:${p.id}`, fmt(deg(v)));
    else if (p.type === 'flip') h += row(label, `dyn:${p.id}`, !!v, { check: true });
    else if (p.type === 'point') {
      // Bloc d'AutoCAD : position dans le bloc (comme AutoCAD) ; bloc de l'appli : déplacement.
      const q = p.acad ? pointPosition(doc, e, p) : v;
      h += row(`${label} X`, `dynx:${p.id}`, fmt(q[0])) + row(`${label} Y`, `dyny:${p.id}`, fmt(q[1]));
    }
  }
  return h;
}

export function geometryRows(e, doc) {
  if (e.elec && e.type === 'INSERT') return elecRows(e, doc);
  if (e.mep) return mepRows(e, doc);
  if (e.type === 'UNDERLAY') return underlayRows(e, doc, { row, fmt, esc });
  if (e.type === 'HATCH') return hatchRows(e, doc, { row, fmt });
  const detail = detailRows(e, doc, { row, fmt, esc });
  if (detail) return detail;
  let h = '<div class="section">Géométrie</div>';
  switch (e.type) {
    case 'LINE':
      h += row('Départ X', 'p1x', fmt(e.p1[0])) + row('Départ Y', 'p1y', fmt(e.p1[1]))
        + row('Fin X', 'p2x', fmt(e.p2[0])) + row('Fin Y', 'p2y', fmt(e.p2[1]))
        + row('Longueur', '', fmt(G.dist(e.p1, e.p2)), { ro: true })
        + row('Angle', '', `${fmt(deg(G.normAngle(G.angleOf(e.p1, e.p2))))}°`, { ro: true });
      break;
    case 'CIRCLE':
      h += row('Centre X', 'cx', fmt(e.c[0])) + row('Centre Y', 'cy', fmt(e.c[1])) + row('Rayon', 'r', fmt(e.r))
        + row('Diamètre', 'd', fmt(2 * e.r)) + row('Circonférence', '', fmt(2 * Math.PI * e.r), { ro: true });
      break;
    case 'ARC':
      h += row('Centre X', 'cx', fmt(e.c[0])) + row('Centre Y', 'cy', fmt(e.c[1])) + row('Rayon', 'r', fmt(e.r))
        + row('Angle début', 'a0', fmt(deg(G.normAngle(e.a0)))) + row('Angle fin', 'a1', fmt(deg(G.normAngle(e.a1))))
        + row('Longueur', '', fmt(e.r * G.sweep(e.a0, e.a1)), { ro: true });
      break;
    case 'LWPOLYLINE': {
      const len = pathOf(e).curves.reduce((s, c) => s + (c.k === 'seg' ? G.dist(c.a, c.b) : Math.abs(c.sw) * c.r), 0);
      h += row('Sommets', '', String(e.pts.length), { ro: true }) + row('Fermée', 'closed', e.closed, { check: true })
        + row('Largeur globale', 'width', fmt(e.width || 0)) + row('Élévation', 'z', fmt(e.z || 0))
        + row('Longueur', '', fmt(len), { ro: true });
      break;
    }
    case 'TEXT':
    case 'MTEXT':
      h += row('Contenu', 'text', e.text) + row('Hauteur', 'h', fmt(e.h)) + row('Rotation', 'rot', fmt(deg(e.rot || 0)))
        + row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1]));
      break;
    case 'INSERT':
      // Bloc dynamique d'AutoCAD resté sur sa représentation anonyme : nom effectif, paramètres figés.
      h += row('Nom du bloc', '', e.effName ? `${e.effName} (représentation AutoCAD figée)` : e.name, { ro: true }) + row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1]))
        + row('Position Z', 'pz', fmt(e.p[2] || 0))
        + row('Échelle X', 'sx', fmt(e.sx)) + row('Échelle Y', 'sy', fmt(e.sy)) + row('Échelle Z', '', fmt(e.sz ?? 1), { ro: true }) + row('Rotation', 'rot', fmt(deg(e.rot || 0)))
        + ((e.cols || 1) > 1 || (e.rows || 1) > 1 ? row('Réseau (colonnes × rangées)', '', `${e.cols || 1} × ${e.rows || 1}`, { ro: true }) : '')
        + row('Objets du bloc', '', String(doc.blocks.get(e.name)?.entities?.length ?? '—'), { ro: true })
        + (doc.blocks.get(e.name)?.xref || doc.blocks.get(e.name)?.fond ? row('Référence externe', '', doc.blocks.get(e.name).path || 'oui', { ro: true }) : '')
        + `<div class="row"><label>Découpe</label><span class="fond-row"><span class="ro">${!e.clip ? 'aucune' : e.clip.off ? 'désactivée' : e.clip.invert ? 'inversée' : 'active'}</span><button class="btn small" data-act="xclip">Découper…</button></span></div>`;
      h += dynamicRows(e, doc);
      if (e.attribs?.length) {
        h += '<div class="section">Attributs</div>';
        e.attribs.forEach((a, i) => { h += row(esc(a.tag || `Attribut ${i + 1}`) + (a.invisible ? ' (invisible)' : ''), `attr:${i}`, a.text ?? ''); });
      }
      break;
    case 'POINT':
      h += row('Position X', 'px', fmt(e.p[0])) + row('Position Y', 'py', fmt(e.p[1]));
      break;
    case 'VIEWPORT': {
      // Échelle normalisée (liste) ou libre ; papier en mm, objet dans les unités du dessin.
      const n = (e.vh / e.h) * unitMmOf(doc);
      const std = SCALES.find((k) => Math.abs(k - n) / k < 1e-6);
      const opts = SCALES.map((k) => `<option value="${k}" ${k === std ? 'selected' : ''}>1:${k}</option>`).join('');
      const nOvr = overrideCount(e);
      h += '<div class="section">Fenêtre</div>'
        + `<div class="row"><label>Échelle standard</label><select data-f="vpStd">${std ? '' : '<option selected>Personnalisée</option>'}${opts}</select></div>`
        + row('Échelle 1:', 'vpScale', fmt(n))
        + row('Affichage verrouillé', 'vpLock', !!e.locked, { check: true })
        + row('Désactivée', 'off', !!e.off, { check: true })
        + row('Transparence des hachures (%)', 'vpHatch', e.hatchAlpha || 0)
        + `<div class="row"><label>Calques de la fenêtre</label><button class="btn small" data-act="vplayers">${nOvr ? `${nOvr} calque(s) réglé(s)…` : 'Régler…'}</button></div>`
        + row('Calques gelés', 'vpFrozen', (e.frozen || []).join(', '), { placeholder: 'noms séparés par des virgules' })
        + row('Largeur', 'vpW', fmt(e.w)) + row('Hauteur', 'vpH', fmt(e.h))
        + row('Centre de vue X', 'vcx', fmt(e.vc[0])) + row('Centre de vue Y', 'vcy', fmt(e.vc[1]))
        + row('Rotation de vue', 'twist', fmt(deg(e.twist || 0)));
      break;
    }
    default:
      h += row('Modifiable', '', 'par commandes (déplacer, copier…)', { ro: true });
  }
  return h;
}

export function setGeometry(e, f, v, doc = null) {
  if (f === 'closed') { e.closed = !!v; return true; }
  const detail = setDetail(e, f, v); // Z, sommet de polyligne, champs de texte, échelle du type de ligne
  if (detail !== null) return detail;
  if (e.type === 'UNDERLAY' && f.startsWith('ul')) return setUnderlayField(e, f, v, doc);
  if (e.type === 'HATCH' && ['hScale', 'hAngle', 'hBg', 'hAssoc'].includes(f)) return setHatchField(e, f, v);
  // Paramètre d'un bloc dynamique.
  if (/^dyn[xy]?:/.test(f) && doc) {
    const [kind, id] = [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)];
    const p = doc.blocks.get(e.name)?.dyn?.params.find((x) => x.id === id);
    if (!p) return false;
    let value = v;
    if (p.type === 'linear') value = parseFloat(String(v).replace(',', '.'));
    if (p.type === 'rotation') value = (parseFloat(String(v).replace(',', '.')) * Math.PI) / 180;
    if (p.type === 'flip') value = v ? 1 : 0;
    if (p.type === 'point') {
      const cur = p.acad ? pointPosition(doc, e, p) : valueOf(p, e.dyn);
      const n = parseFloat(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) return false;
      value = kind === 'dynx' ? [n, cur[1]] : [cur[0], n];
      if (p.acad) value = pointValueAt(doc, e, p, value);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    Object.assign(e, withValue(doc, e, id, value));
    return true;
  }
  if (f === 'off') { e.off = !!v; return true; }
  if (f === 'vpLock') { if (v) e.locked = true; else delete e.locked; return true; }
  if (f === 'vpStd' || f === 'vpScale') {
    const n = parseFloat(String(v).replace(',', '.'));
    if (!(n > 0)) return false;
    e.vh = (e.h * n) / unitMmOf(doc); // papier en mm, objet dans les unités du dessin
    return true;
  }
  if (f === 'vpHatch') {
    const n = parseInt(v, 10);
    if (!(n >= 0)) return false;
    if (n > 0) e.hatchAlpha = Math.min(90, n); else delete e.hatchAlpha;
    return true;
  }
  if (f === 'vpFrozen') {
    const names = String(v).split(',').map((x) => x.trim()).filter(Boolean);
    if (names.length) e.frozen = [...new Set(names)]; else delete e.frozen;
    return true;
  }
  if (f === 'mepEmbed' && e.mep?.conduit) {
    if (!EMBED_LABELS[v]) return false;
    e.mep.embed = v;
    e.ltype = conduitLtype(v); // type de ligne de la pose (légende)
    ensureSystemLayer(doc, systemByCode(e.mep.system) || { code: e.mep.system, domain: 'ELEC', color: 7, ltype: 'Continuous' });
    return true;
  }
  if (f === 'mepElbow' && e.mep) {
    if (v === 'miter') e.mep.elbow = 'miter';
    else if (TRAY_MAKERS[v] && e.mep.kind === 'tray') Object.assign(e.mep, { elbow: 'radius', maker: v, ri: catalogRadius(v, unitMmOf(doc)) });
    else if (v === 'radius' || v === '') e.mep.elbow = 'radius';
    else return false;
    return true;
  }
  if (f.startsWith('mep') && e.mep) {
    const n = parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return false;
    if (f === 'mepZ') { e.mep.z = n; if (e.type === 'LWPOLYLINE') e.z = n; return true; }
    if (f === 'mepZ1') { if (Math.abs(n - (e.mep.z || 0)) < 1e-9) delete e.mep.z1; else e.mep.z1 = n; return true; } // pente
    if (f === 'mepIns') { if (n < 0) return false; e.mep.ins = n; return true; }
    if (f === 'mepQ') { if (n < 0) return false; e.mep.q = n; return true; }
    if (!(n > 0)) return false;
    if (f === 'mepW') e.mep.w = n;
    else if (f === 'mepH') e.mep.h = n;
    else if (f === 'mepD') e.mep.d = n;
    else if (f === 'mepTh') e.mep.th = n;
    else if (f === 'mepRi') e.mep.ri = n;
    else return false;
    return true;
  }
  if (f.startsWith('elec') && e.elec) {
    const m = (e.elec = { ...e.elec });
    const str = String(v).trim();
    if (f === 'elecBoard') m.board = str || undefined;
    else if (f === 'elecCircuit') m.circuit = str || undefined;
    else if (f === 'elecDesc') m.desc = str || undefined;
    else if (f === 'elecPh') m.ph = str === '3' ? 3 : 1;
    else if (f === 'elecParent') m.parent = str;
    else if (f === 'elecName') { if (!str) return false; m.board = str; }
    else if (f === 'elecP' || f === 'elecH') {
      const n = parseFloat(str.replace(',', '.'));
      if (f === 'elecH' && !str) delete m.h;
      else if (!(n >= 0)) return false;
      else if (f === 'elecP') m.p = n; else m.h = n;
    } else return false;
    refreshAttribs(e);
    return true;
  }
  if (f === 'text') { e.text = String(v); return true; }
  if (f.startsWith('attr:')) {
    const a = e.attribs?.[+f.slice(5)];
    if (!a) return false;
    a.text = String(v);
    return true;
  }
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return false;
  // Insertion avec attributs : les textes d'attributs (en coordonnées du dessin) suivent la position,
  // l'échelle et la rotation du bloc.
  // Symbole électrique intégré : étiquettes toujours horizontales, à droite du symbole (les blocs de
  // bibliothèque gardent la disposition de leurs attributs).
  if (e.type === 'INSERT' && e.elec && SYMBOLS[e.elec.sym] && !e.elec.block && ['px', 'py', 'rot'].includes(f)) {
    if (!setNumber(e, f, n)) return false;
    e.attribs = attribsFor(e, e.elec, e.attribs?.[0]?.layer || CATEGORIES[SYMBOLS[e.elec.sym].cat].text);
    return true;
  }
  if (e.type === 'INSERT' && e.attribs?.length && ['px', 'py', 'sx', 'sy', 'rot'].includes(f)) {
    const before = insertMatrix(e);
    if (!setNumber(e, f, n)) return false;
    const m = G.compose(insertMatrix(e), G.invert(before));
    e.attribs = e.attribs.map((a) => transformEntity(a, m));
    return true;
  }
  return setNumber(e, f, n);
}

function setNumber(e, f, n) {
  switch (f) {
    case 'p1x': e.p1[0] = n; return true;
    case 'p1y': e.p1[1] = n; return true;
    case 'p2x': e.p2[0] = n; return true;
    case 'p2y': e.p2[1] = n; return true;
    case 'vpW': if (n > 0) { e.w = n; return true; } return false;
    case 'vpH': if (n > 0) { e.vh *= n / e.h; e.h = n; return true; } return false; // échelle conservée
    case 'vcx': e.vc[0] = n; return true;
    case 'vcy': e.vc[1] = n; return true;
    case 'twist': e.twist = (n * Math.PI) / 180; return true;
    case 'cx': e.c[0] = n; return true;
    case 'cy': e.c[1] = n; return true;
    case 'r': if (n > 0) { e.r = n; return true; } return false;
    case 'd': if (n > 0) { e.r = n / 2; return true; } return false;
    case 'a0': e.a0 = rad(n); return true;
    case 'a1': e.a1 = rad(n); return true;
    case 'width': e.width = Math.max(0, n); return true;
    case 'z': e.z = n; return true;
    case 'h': if (n > 0) { e.h = n; return true; } return false;
    case 'rot': e.rot = rad(n); return true;
    case 'px': e.p[0] = n; return true;
    case 'py': e.p[1] = n; return true;
    case 'sx': if (n !== 0) { e.sx = n; return true; } return false;
    case 'sy': if (n !== 0) { e.sy = n; return true; } return false;
  }
  return false;
}

// --- palette de couleurs AutoCAD (index 1 à 255) -------------------------------------

let picker = null;

export function openColorPicker(anchor, current, onPick) {
  closeColorPicker();
  picker = document.createElement('div');
  picker.className = 'color-picker';
  const cell = (i) => {
    const c = aciToColor(i);
    const css = c === 'fg' ? '#ffffff' : toCss(c, 0);
    return `<button data-aci="${i}" title="Couleur ${i}" style="background:${css}" class="${i === current ? 'sel' : ''}"></button>`;
  };
  let grid = '';
  for (let row = 0; row < 10; row++) {
    for (let hue = 0; hue < 24; hue++) grid += cell(10 + hue * 10 + row);
  }
  picker.innerHTML = `<div class="cp-std">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(cell).join('')}</div>
    <div class="cp-grid">${grid}</div>
    <div class="cp-std">${[250, 251, 252, 253, 254, 255].map(cell).join('')}</div>`;
  document.body.appendChild(picker);
  const r = anchor.getBoundingClientRect();
  picker.style.left = `${Math.min(r.left, window.innerWidth - picker.offsetWidth - 8)}px`;
  picker.style.top = `${Math.min(r.bottom + 4, window.innerHeight - picker.offsetHeight - 8)}px`;
  picker.addEventListener('click', (e) => {
    const n = parseInt(e.target.dataset.aci, 10);
    if (n) { onPick(n); closeColorPicker(); }
  });
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
}

function outside(e) {
  if (picker && !picker.contains(e.target)) closeColorPicker();
}

export function closeColorPicker() {
  document.removeEventListener('pointerdown', outside);
  picker?.remove();
  picker = null;
}
