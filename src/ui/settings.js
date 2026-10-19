// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages du dessin (onglet « Format » du ruban), comme les boîtes Unités, Type de ligne, Épaisseur, Style de
// point, Style de texte, Style de cote et Options d'AutoCAD, réunies en onglets :
//   Unités · Formats · Lignes · Points · Textes · Cotes · Préférences.
// Les réglages du dessin vont dans l'en-tête (annulables, enregistrés dans le DXF) ; les formats de papier et
// les préférences d'affichage sont propres à l'utilisateur (navigateur).
import { POINT_MODES, pointSymbol, pointSize, annoScaleOf, DIM_DEFAULTS, ARROWS, dimStyleOf, STANDARD_LTYPES, dashSvg } from '../core/drawing-settings.js';
import { dimSizes, linearDimension } from '../core/dimension.js';
import { FORMATS, userFormats, saveUserFormats } from '../layout/sheet.js';
import { defaultStyle } from '../core/document.js';
import { isShx, fontStatus, shxFont, setFontFolder } from '../fonts/registry.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => String(Math.round(v * 10000) / 10000).replace('.', ',');
const parse = (v) => parseFloat(String(v).replace(',', '.'));

export const TABS = { unites: 'Unités', formats: 'Formats', lignes: 'Lignes', points: 'Points', textes: 'Textes', cotes: 'Cotes', preferences: 'Préférences' };
const UNITS = [[0, 'Sans unité'], [4, 'Millimètres'], [5, 'Centimètres'], [14, 'Décimètres'], [6, 'Mètres'], [1, 'Pouces'], [2, 'Pieds']];
const LWS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwText = (v) => `${(v / 100).toFixed(2).replace('.', ',')} mm`;
const COLORS = [[256, 'DuCalque'], [0, 'DuBloc'], [1, 'Rouge'], [2, 'Jaune'], [3, 'Vert'], [4, 'Cyan'], [5, 'Bleu'], [6, 'Magenta'], [7, 'Blanc / noir'], [8, 'Gris 8'], [9, 'Gris 9']];

// Préférences d'affichage (par utilisateur) : tailles en pixels.
const PREFS_KEY = 'cadviewer.prefs';
export const PREF_DEFAULTS = { cursor: 22, pickbox: 5, grip: 5, aperture: 10, fontFolder: '' };
export function loadPrefs() {
  try { return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...PREF_DEFAULTS }; }
}
export function applyPrefs(editor, prefs = loadPrefs()) {
  for (const k of Object.keys(PREF_DEFAULTS)) if (prefs[k] > 0) editor.settings[k] = prefs[k];
  setFontFolder(prefs.fontFolder || null); // dossier de polices SHX supplémentaire
  editor.r.requestRender();
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ }
}

// Aperçu SVG d'un style de point.
function pointSvg(mode) {
  const parts = pointSymbol([0, 0], mode, 1).map((pl) => `<polyline points="${pl.map(([x, y]) => `${x},${-y}`).join(' ')}"/>`);
  if ((mode & 7) === 0) parts.push('<circle cx="0" cy="0" r="0.06" fill="currentColor" stroke="none"/>');
  return `<svg viewBox="-0.75 -0.75 1.5 1.5" width="34" height="34" fill="none" stroke="currentColor" stroke-width="0.06">${parts.join('')}</svg>`;
}

// Aperçu SVG d'une cote avec le style (valeurs papier).
function dimSvg(style) {
  const sizes = dimSizes(1, style);
  const r = linearDimension({ p1: [0, 0], p2: [40, 0], loc: [0, 10], rotation: 0, sizes });
  const parts = [];
  for (const e of r?.entities || []) {
    if (e.type === 'LINE') parts.push(`<line x1="${e.p1[0]}" y1="${-e.p1[1]}" x2="${e.p2[0]}" y2="${-e.p2[1]}"/>`);
    else if (e.type === 'SOLID') parts.push(`<polygon class="f" points="${[e.pts[0], e.pts[1], e.pts[3] || e.pts[2], e.pts[2]].map((p) => `${p[0]},${-p[1]}`).join(' ')}"/>`);
    else if (e.type === 'HATCH') parts.push(`<polygon class="f" points="${e.loops[0].map((p) => `${p[0]},${-p[1]}`).join(' ')}"/>`);
    else if (e.type === 'TEXT') parts.push(`<text x="${e.p[0]}" y="${-e.p[1]}" font-size="${e.h}" text-anchor="middle" dominant-baseline="central">${esc(e.text)}</text>`);
  }
  parts.push('<line x1="0" y1="2" x2="0" y2="-2" class="obj"/><line x1="40" y1="2" x2="40" y2="-2" class="obj"/>');
  return `<svg class="dim-preview" viewBox="-6 -20 52 26" width="260" height="130">${parts.join('')}</svg>`;
}

// Types de ligne utilisés (objets, calques, blocs) : ceux-là ne peuvent pas être supprimés.
function usedLtypes(doc) {
  const used = new Set();
  const add = (n) => n && used.add(String(n).toUpperCase());
  for (const l of doc.layers.values()) add(l.ltype);
  for (const e of doc.entities.values()) add(e.ltype);
  for (const b of doc.blocks.values()) for (const e of b.entities) add(e.ltype);
  add(doc.header?.celtype);
  return used;
}

let dlg = null;
// editor : l'éditeur (document, rendu) ; hooks : { setPrecision(n), toggleLwDisplay() }.
export function openSettings(editor, tab = 'unites', hooks = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'drawing-settings';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  let cur = TABS[tab] ? tab : 'unites';
  const doc = () => editor.doc;
  // Polices proposées : TrueType courantes, puis les SHX trouvées par le serveur (dossier Fonts d'AutoCAD…).
  let fontList = ['arial.ttf', 'romans.shx', 'simplex.shx', 'isocp.shx', 'txt.shx'];
  const folder = loadPrefs().fontFolder;
  fetch(`/__polices${folder ? `?dossier=${encodeURIComponent(folder)}` : ''}`).then((r) => (r.ok ? r.json() : [])).then((list) => {
    if (list.length) fontList = ['arial.ttf', ...list];
    if (cur === 'textes' && dlg.open) render();
  }).catch(() => {});
  const header = (props, label = 'Réglages du dessin') => {
    doc().transaction(label, () => doc().setHeader(props));
    if ('luprec' in props) hooks.setPrecision?.(props.luprec);
  };

  const bodies = {
    unites() {
      const h = doc().header || {};
      const prec = (sel, max = 8) => Array.from({ length: max + 1 }, (_, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${i ? `0.${'0'.repeat(i)}` : '0'}</option>`).join('');
      return `<div class="ps-grid">
        <label>Unité du dessin <select data-h="insunits">${UNITS.map(([v, n]) => `<option value="${v}" ${v === (h.insunits ?? 0) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Précision des longueurs <select data-h="luprec">${prec(h.luprec ?? 4)}</select></label>
        <label>Précision des angles (degrés) <select data-h="auprec">${prec(h.auprec ?? 0)}</select></label>
        <label>Échelle des annotations (1:N) <input data-h="annoScale" value="${num(annoScaleOf(doc()))}" size="7"></label>
      </div>
      <p class="muted">L’unité du dessin sert aux échelles des fenêtres, aux fonds de plan et aux calculs MEP. L’échelle des annotations fixe la taille des textes, cotes et symboles : 2,5 mm sur le papier = ${num(2.5 * annoScaleOf(doc()))} unités dans le dessin.</p>`;
    },
    formats() {
      const user = userFormats();
      const iso = Object.entries(FORMATS).map(([k, [w, h]]) => `<tr><td>${k}</td><td class="num">${w} × ${h} mm</td><td class="muted">ISO</td><td></td></tr>`).join('');
      const custom = Object.entries(user).map(([k, [w, h]]) => `<tr data-fmt="${esc(k)}"><td>${esc(k)}</td><td class="num">${num(w)} × ${num(h)} mm</td><td class="muted">ajouté</td><td><button class="btn small" data-act="fmt-del">Supprimer</button></td></tr>`).join('');
      return `<table class="settings-table"><thead><tr><th>Format</th><th>Taille (paysage)</th><th></th><th></th></tr></thead><tbody>${iso}${custom}</tbody></table>
        <div class="section-title">Ajouter un format</div>
        <div class="ps-grid"><label>Nom <input data-k="fmt-name" placeholder="A1 allongé"></label>
          <label>Largeur (mm) <input data-k="fmt-w" placeholder="1189"></label><label>Hauteur (mm) <input data-k="fmt-h" placeholder="594"></label>
          <label>&nbsp;<button class="btn" data-act="fmt-add">Ajouter</button></label></div>
        <p class="muted">Les formats ajoutés sont proposés dans la mise en page des présentations et par PRESENTATION (orientation au choix).</p>`;
    },
    lignes() {
      const d = doc(), h = d.header || {};
      const used = usedLtypes(d);
      const loaded = [...(d.ltypes?.values() || [])].filter((t) => !/^(bylayer|byblock|continuous)$/i.test(t.name));
      const names = new Set(loaded.map((t) => t.name.toUpperCase()));
      const rows = loaded.map((t) => `<tr data-lt="${esc(t.name)}"><td>${esc(t.name)}</td><td class="lt-prev">${dashSvg(t.dashes)}</td><td class="muted">${esc(t.description || '')}</td>
        <td>${used.has(t.name.toUpperCase()) ? '<span class="muted">utilisé</span>' : '<button class="btn small" data-act="lt-del">Supprimer</button>'}</td></tr>`).join('');
      const avail = STANDARD_LTYPES.filter((t) => !names.has(t.name));
      const ltOpts = ['ByLayer', 'ByBlock', 'Continuous', ...loaded.map((t) => t.name)].map((n) => `<option value="${esc(n)}" ${n.toUpperCase() === String(h.celtype || 'ByLayer').toUpperCase() ? 'selected' : ''}>${esc({ ByLayer: 'DuCalque', ByBlock: 'DuBloc', Continuous: 'Continu' }[n] || n)}</option>`).join('');
      return `<div class="section-title">Types de ligne du dessin</div>
        ${loaded.length ? `<table class="settings-table"><tbody>${rows}</tbody></table>` : '<p class="muted">Aucun type de ligne chargé (seulement Continu).</p>'}
        ${avail.length ? `<div class="section-title">Charger un type de ligne standard</div><table class="settings-table"><tbody>${avail.map((t) => `<tr data-std="${t.name}"><td>${t.name}</td><td class="lt-prev">${dashSvg(t.dashes)}</td><td class="muted">${esc(t.description)}</td><td><button class="btn small" data-act="lt-load">Charger</button></td></tr>`).join('')}</tbody></table>
          <div class="qto-actions" style="justify-content:flex-start"><button class="btn" data-act="lt-load-all">Tout charger</button></div>` : ''}
        <div class="section-title">Objets créés et affichage</div>
        <div class="ps-grid">
          <label>Type de ligne courant <select data-h="celtype">${ltOpts}</select></label>
          <label>Échelle globale des types de ligne <input data-h="ltscale" value="${num(h.ltscale || 1)}" size="6"></label>
          <label>Couleur courante <select data-h="cecolor">${COLORS.map(([v, n]) => `<option value="${v}" ${v === (h.cecolor ?? 256) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Épaisseur courante <select data-h="celweight"><option value="-1" ${(h.celweight ?? -1) === -1 ? 'selected' : ''}>DuCalque</option><option value="-2" ${h.celweight === -2 ? 'selected' : ''}>DuBloc</option><option value="-3" ${h.celweight === -3 ? 'selected' : ''}>Défaut</option>${LWS.map((v) => `<option value="${v}" ${v === h.celweight ? 'selected' : ''}>${lwText(v)}</option>`).join('')}</select></label>
          <label>Épaisseur « Défaut » <select data-h="lwdefault">${LWS.filter((v) => v > 0).map((v) => `<option value="${v}" ${v === (h.lwdefault || 18) ? 'selected' : ''}>${lwText(v)}</option>`).join('')}</select></label>
          <label>Affichage des épaisseurs <span><input type="checkbox" data-act="lwdisplay" ${editor.r.lwDisplay ? 'checked' : ''}> dans les présentations</span></label>
        </div>
        <p class="muted">Couleur, type de ligne et épaisseur courants s’appliquent aux objets dessinés ensuite (DuCalque : ceux du calque).</p>`;
    },
    points() {
      const h = doc().header || {};
      const mode = h.pdmode | 0;
      const rel = !(h.pdsize > 0);
      return `<div class="point-grid">${POINT_MODES.map((m) => `<button class="point-mode ${m === mode ? 'sel' : ''}" data-pdmode="${m}" title="Style ${m}">${pointSvg(m)}</button>`).join('')}</div>
        <div class="ps-grid">
          <label>Taille <select data-k="pd-kind"><option value="rel" ${rel ? 'selected' : ''}>Relative : mm sur le papier</option><option value="abs" ${rel ? '' : 'selected'}>Absolue : unités du dessin</option></select></label>
          <label>Valeur <input data-k="pd-size" value="${num(rel ? (h.pdsize < 0 ? -h.pdsize : 2.5) : h.pdsize)}" size="6"></label>
        </div>
        <p class="muted">Taille actuelle dans le dessin : ${num(pointSize(doc()))} unités. Le style s’applique à tous les points (POINT, DIVISER, MESURER).</p>`;
    },
    textes() {
      const d = doc(), h = d.header || {};
      const count = new Map();
      for (const e of d.entities.values()) if (e.type === 'TEXT' || e.type === 'MTEXT') { const k = String(e.style || 'Standard').toUpperCase(); count.set(k, (count.get(k) || 0) + 1); }
      const def = h.textsize > 0 ? h.textsize : 2.5 * annoScaleOf(d);
      const styles = [...(d.styles?.values() || [])].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      const fonts = [...new Set([...fontList, ...styles.map((s) => s.font).filter(Boolean)])];
      const state = (f) => {
        if (!isShx(f)) return '<span class="muted">TrueType (police de l’appli)</span>';
        shxFont(f);
        const st = fontStatus(f);
        return st === 'ok' ? '<span class="ok">SHX chargée</span>' : st === 'missing' ? '<span class="del">SHX introuvable</span>' : '<span class="muted">lecture…</span>';
      };
      const cur = String(h.textstyle || 'Standard').toUpperCase();
      return `<div class="ps-grid">
          <label>Hauteur par défaut (unités du dessin) <input data-h="textsize" value="${num(def)}" size="8"></label>
          <label>Sur le papier <span class="muted">${num(def / annoScaleOf(d))} mm au 1:${num(annoScaleOf(d))}</span></label>
          <label>Style courant (nouveaux textes) <select data-k="textstyle">${styles.map((s) => `<option value="${esc(s.name)}" ${s.name.toUpperCase() === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        </div>
        <div class="section-title">Styles de texte du dessin</div>
        <table class="settings-table"><thead><tr><th>Style</th><th>Police</th><th>État</th><th class="num">Largeur</th><th class="num">Oblique (°)</th><th class="num">Textes</th><th></th></tr></thead><tbody>
          ${styles.map((s) => `<tr data-style="${esc(s.name)}"><td>${esc(s.name)}</td>
            <td><select data-st="font">${fonts.map((f) => `<option ${f.toLowerCase() === String(s.font).toLowerCase() ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></td>
            <td>${state(s.font)}</td>
            <td class="num"><input data-st="widthFactor" value="${num(s.widthFactor || 1)}" size="4"></td>
            <td class="num"><input data-st="oblique" value="${num(((s.oblique || 0) * 180) / Math.PI)}" size="4"></td>
            <td class="num">${count.get(s.name.toUpperCase()) || 0}</td>
            <td>${/^standard$/i.test(s.name) || count.get(s.name.toUpperCase()) ? '' : '<button class="btn small" data-act="st-del">Supprimer</button>'}</td></tr>`).join('')}
        </tbody></table>
        <div class="fond-row"><input data-k="st-name" placeholder="Nom du nouveau style" size="18"><button class="btn small" data-act="st-add">Nouveau style</button></div>
        <div class="section-title">Polices SHX</div>
        <div class="ps-grid"><label class="wide">Dossier de polices supplémentaire (en plus du dossier Fonts d’AutoCAD)
          <span class="fond-row"><input data-k="font-folder" value="${esc(loadPrefs().fontFolder || '')}" placeholder="C:\\Polices\\SHX" size="40"></span></label></div>
        <p class="muted">Les polices SHX (romans, simplex, isocp…) sont lues là où elles sont — dossier Fonts d’AutoCAD, dossiers de support, dossier ci-dessus — et les textes sont dessinés en traits comme dans AutoCAD (écran et PDF). Polices TrueType et SHX introuvables : police de l’appli. Hauteur par défaut : TEXTE, TEXTMULT et DEFATT.</p>`;
    },
    cotes() {
      const st = dimStyleOf(doc());
      const f = (k, label) => `<label>${label} <input data-dim="${k}" value="${num(st[k])}" size="6"></label>`;
      return `<div class="dim-layout"><div class="ps-grid">
          ${f('DIMTXT', 'Hauteur du texte (mm)')}${f('DIMASZ', 'Taille des flèches (mm)')}
          <label>Extrémités <select data-dim="DIMBLK">${Object.entries(ARROWS).map(([k, l]) => `<option value="${k}" ${k === st.DIMBLK ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${f('DIMEXE', 'Dépassement des lignes d’attache (mm)')}${f('DIMEXO', 'Décalage depuis l’origine (mm)')}${f('DIMGAP', 'Écart du texte (mm)')}
          <label>Décimales <select data-dim="DIMDEC">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<option value="${i}" ${i === st.DIMDEC ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
          ${f('DIMLFAC', 'Facteur des mesures')}
          <label>Suffixe <input data-dim="DIMPOST" value="${esc(st.DIMPOST)}" placeholder="ex. « mm »" size="6"></label>
        </div><div>${dimSvg(st)}</div></div>
        <p class="muted">Tailles sur le papier, multipliées par l’échelle des annotations (1:${num(annoScaleOf(doc()))}). Facteur des mesures : 0,001 pour coter en mètres un dessin en millimètres. Valeurs ISO-25 : <button class="btn small" data-act="dim-reset">Rétablir</button></p>`;
    },
    preferences() {
      const p = loadPrefs();
      const f = (k, label, max) => `<label>${label} <input type="range" min="1" max="${max}" data-pref="${k}" value="${p[k]}"> <span>${p[k]} px</span></label>`;
      return `<div class="ps-grid">${f('cursor', 'Taille du réticule', 100)}${f('pickbox', 'Boîte de sélection', 20)}${f('grip', 'Poignées', 15)}${f('aperture', 'Zone d’accrochage', 30)}</div>
        <p class="muted">Préférences de cet ordinateur (tous les dessins). <button class="btn small" data-act="prefs-reset">Valeurs par défaut</button></p>`;
    },
  };

  const render = () => {
    if (!doc()) return;
    dlg.innerHTML = `<h2>Réglages du dessin</h2>
      <div class="elec-cats settings-tabs">${Object.entries(TABS).map(([k, l]) => `<button class="btn ${k === cur ? 'primary' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="settings-body">${bodies[cur]()}</div>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };

  dlg.onclick = (e) => {
    const t = e.target.closest('[data-tab]')?.dataset.tab;
    if (t) { cur = t; render(); return; }
    const pm = e.target.closest('[data-pdmode]')?.dataset.pdmode;
    if (pm != null) { header({ pdmode: +pm }, 'Style de point'); render(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    const d = doc();
    if (act === 'close') dlg.close();
    if (act === 'fmt-add') {
      const name = dlg.querySelector('[data-k="fmt-name"]').value.trim();
      const w = parse(dlg.querySelector('[data-k="fmt-w"]').value), h = parse(dlg.querySelector('[data-k="fmt-h"]').value);
      if (!name || !(w > 10) || !(h > 10)) { editor.print('Format : nom, largeur et hauteur (mm) requis.'); return; }
      const list = Object.entries(userFormats()).filter(([k]) => k !== name).map(([k, [a, b]]) => ({ name: k, w: a, h: b }));
      list.push({ name, w, h });
      saveUserFormats(list);
      render();
    }
    if (act === 'fmt-del') {
      const name = e.target.closest('[data-fmt]').dataset.fmt;
      saveUserFormats(Object.entries(userFormats()).filter(([k]) => k !== name).map(([k, [a, b]]) => ({ name: k, w: a, h: b })));
      render();
    }
    if (act === 'lt-load' || act === 'lt-load-all') {
      const names = act === 'lt-load' ? [e.target.closest('[data-std]').dataset.std] : STANDARD_LTYPES.map((t) => t.name);
      d.transaction('Charger des types de ligne', () => {
        for (const n of names) {
          const t = STANDARD_LTYPES.find((x) => x.name === n);
          if (t && !d.ltypes?.has(n)) d.setTableEntry('ltypes', n, structuredClone(t));
        }
      });
      render();
    }
    if (act === 'lt-del') {
      const name = e.target.closest('[data-lt]').dataset.lt;
      d.transaction('Supprimer le type de ligne', () => d.setTableEntry('ltypes', name.toUpperCase(), null));
      render();
    }
    if (act === 'lwdisplay') { hooks.toggleLwDisplay?.(); return; }
    if (act === 'dim-reset') { header({ dimstyle: { ...DIM_DEFAULTS } }, 'Style de cote'); render(); }
    if (act === 'prefs-reset') { savePrefs({ ...PREF_DEFAULTS }); applyPrefs(editor); render(); }
    if (act === 'st-add') {
      const name = dlg.querySelector('[data-k="st-name"]').value.trim();
      if (!name || d.styles.has(name.toUpperCase())) { editor.print(name ? `Le style « ${name} » existe déjà.` : 'Nom du style ?'); return; }
      d.transaction('Nouveau style de texte', () => d.setTableEntry('styles', name.toUpperCase(), defaultStyle({ name, font: 'romans.shx' })));
      render();
    }
    if (act === 'st-del') {
      const name = e.target.closest('[data-style]').dataset.style;
      d.transaction('Supprimer le style de texte', () => d.setTableEntry('styles', name.toUpperCase(), null));
      render();
    }
  };

  dlg.onchange = (e) => {
    const el = e.target, d = doc();
    if (el.dataset.st) {
      const name = el.closest('[data-style]').dataset.style;
      const st = d.styles.get(name.toUpperCase());
      if (!st) return;
      const k = el.dataset.st;
      let v = k === 'font' ? el.value : parse(el.value);
      if (k === 'oblique') v = (Math.max(-85, Math.min(85, v || 0)) * Math.PI) / 180;
      if (k === 'widthFactor' && !(v > 0)) { render(); return; }
      d.transaction('Style de texte', () => d.setTableEntry('styles', name.toUpperCase(), { ...st, [k]: v }));
      render();
      return;
    }
    if (el.dataset.k === 'textstyle') { header({ textstyle: el.value }, 'Style de texte courant'); render(); return; }
    if (el.dataset.k === 'font-folder') {
      const p = loadPrefs();
      p.fontFolder = el.value.trim().replace(/^"|"$/g, '');
      savePrefs(p);
      applyPrefs(editor, p);
      editor.r.refreshTexts?.();
      render();
      return;
    }
    const hk = el.dataset.h;
    if (hk) {
      const v = el.value;
      if (hk === 'celtype') header({ celtype: v === 'ByLayer' ? undefined : v }, 'Type de ligne courant');
      else if (['insunits', 'luprec', 'auprec', 'cecolor', 'celweight', 'lwdefault'].includes(hk)) header({ [hk]: parseInt(v, 10) });
      else {
        const n = parse(v);
        if (n > 0) header({ [hk]: n });
      }
      render();
      return;
    }
    if (el.dataset.dim) {
      const k = el.dataset.dim;
      const v = k === 'DIMBLK' || k === 'DIMPOST' ? el.value : k === 'DIMDEC' ? parseInt(el.value, 10) : parse(el.value);
      if (typeof v === 'number' && !(v >= 0)) { render(); return; }
      header({ dimstyle: { ...(d.header?.dimstyle || {}), [k]: v } }, 'Style de cote');
      render();
      return;
    }
    if (el.dataset.k === 'pd-kind' || el.dataset.k === 'pd-size') {
      const kind = dlg.querySelector('[data-k="pd-kind"]').value;
      const n = parse(dlg.querySelector('[data-k="pd-size"]').value);
      if (n > 0) header({ pdsize: kind === 'abs' ? n : -n }, 'Taille des points');
      render();
    }
  };

  dlg.oninput = (e) => {
    const k = e.target.dataset.pref;
    if (!k) return;
    const p = loadPrefs();
    p[k] = +e.target.value;
    savePrefs(p);
    applyPrefs(editor, p);
    e.target.nextElementSibling.textContent = `${p[k]} px`;
  };

  render();
  if (!dlg.open) dlg.showModal();
}
