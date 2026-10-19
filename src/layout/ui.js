// SPDX-License-Identifier: GPL-3.0-or-later
// Présentations, comme AutoCAD : onglets « Objet | Présentation1 | … | + » sous le dessin (renommer par
// double-clic, menu par clic droit), et dialogue de mise en page (format, orientation, marges, style de tracé).
import { allFormats, CUSTOM, makePlot, formatOf, isLandscape, sheetOf, describePlot } from './sheet.js';
import { allTables } from '../plot/styles.js';

// Table de styles de tracé d'une mise en page (les anciennes n'avaient qu'un choix noir / couleurs).
const ctbOf = (p) => (p.ctb !== undefined ? p.ctb : p.mono === false ? '' : 'monochrome.ctb');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
const parse = (v) => parseFloat(String(v).replace(',', '.'));

// --- onglets -------------------------------------------------------------------------------

// handlers : { switchTo(id), create(), rename(id, label), remove(id), pageSetup(id), move(id, delta) }
export function renderSpaceTabs(el, doc, current, handlers) {
  const tabs = doc.spaces.map((sp) => `<button class="space-tab ${sp.id === current ? 'active' : ''}" data-space="${esc(sp.id)}" title="${sp.id === 'model' ? 'Espace objet' : `${esc(sp.label)} — double-clic : renommer, clic droit : options`}">${esc(sp.id === 'model' ? 'Objet' : sp.label)}</button>`).join('');
  el.innerHTML = `${tabs}<button class="space-tab add" data-act="new" title="Nouvelle présentation">+</button>`;
  if (el.dataset.bound) { el._handlers = handlers; return; }
  el.dataset.bound = '1';
  el._handlers = handlers;
  el.addEventListener('click', (e) => {
    const h = el._handlers;
    if (e.target.closest('[data-act="new"]')) { h.create(); return; }
    const id = e.target.closest('[data-space]')?.dataset.space;
    if (id) h.switchTo(id);
  });
  el.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('[data-space]');
    if (!tab || tab.dataset.space === 'model') return;
    startRename(el, tab);
  });
  el.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('[data-space]');
    e.preventDefault();
    if (!tab) return;
    showTabMenu(el, tab, e.clientX, e.clientY);
  });
}

function startRename(el, tab) {
  const id = tab.dataset.space;
  const input = document.createElement('input');
  input.className = 'space-tab-edit';
  input.value = tab.textContent;
  tab.replaceWith(input);
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (ok && v) el._handlers.rename(id, v);
    else el._handlers.refresh?.();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

let menu = null;
function showTabMenu(el, tab, x, y) {
  const id = tab.dataset.space;
  const h = el._handlers;
  menu?.remove();
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = id === 'model'
    ? [['new', 'Nouvelle présentation']]
    : [['setup', 'Mise en page…'], ['rename', 'Renommer'], ['left', 'Déplacer à gauche'], ['right', 'Déplacer à droite'], ['sep'], ['new', 'Nouvelle présentation'], ['delete', 'Supprimer']];
  menu.innerHTML = items.map(([k, l]) => (k === 'sep' ? '<hr>' : `<button data-k="${k}">${l}</button>`)).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.max(4, y - r.height)}px`;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!menu?.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  menu.addEventListener('click', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    close();
    if (k === 'new') h.create();
    if (k === 'setup') h.pageSetup(id);
    if (k === 'rename') { const t = el.querySelector(`[data-space="${CSS.escape(id)}"]`); if (t) startRename(el, t); }
    if (k === 'left') h.move(id, -1);
    if (k === 'right') h.move(id, 1);
    if (k === 'delete') h.remove(id);
  });
}

// --- mise en page -----------------------------------------------------------------------------

// Dialogue de mise en page d'une présentation ; onApply(plot) reçoit la nouvelle mise en page.
let dlg = null;
export function openPageSetup(sp, sheet, onApply) {
  const cur = { ...(sheet || makePlot()) };
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'page-setup';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const render = () => {
    const custom = cur.paper === CUSTOM;
    const land = isLandscape(cur);
    const m = cur.margins || [0, 0, 0, 0];
    dlg.innerHTML = `<h2>Mise en page — ${esc(sp.label)}</h2>
      <div class="ps-grid">
        <label>Format <select data-k="paper">${[...Object.keys(allFormats()), CUSTOM].map((k) => `<option ${k === cur.paper ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Orientation <select data-k="orient"><option value="L" ${land ? 'selected' : ''}>Paysage</option><option value="P" ${land ? '' : 'selected'}>Portrait</option></select></label>
        <label>Largeur (mm) <input data-k="w" value="${num(cur.w)}" ${custom ? '' : 'disabled'} size="7"></label>
        <label>Hauteur (mm) <input data-k="h" value="${num(cur.h)}" ${custom ? '' : 'disabled'} size="7"></label>
        <label>Origine X <input data-k="ox" value="${num(cur.origin[0])}" size="7" title="Coin inférieur gauche de la feuille dans l’espace papier"></label>
        <label>Origine Y <input data-k="oy" value="${num(cur.origin[1])}" size="7"></label>
      </div>
      <div class="section-title">Zone non imprimable (marges, mm)</div>
      <div class="ps-grid">
        <label>Gauche <input data-k="m0" value="${num(m[0])}" size="5"></label>
        <label>Bas <input data-k="m1" value="${num(m[1])}" size="5"></label>
        <label>Droite <input data-k="m2" value="${num(m[2])}" size="5"></label>
        <label>Haut <input data-k="m3" value="${num(m[3])}" size="5"></label>
      </div>
      <div class="section-title">Tracé</div>
      <div class="ps-grid">
        <label>Table de styles de tracé <select data-k="ctb"><option value="" ${!ctbOf(cur) ? 'selected' : ''}>Aucune (couleurs des objets)</option>${[...allTables().values()].map((t) => `<option ${t.name.toLowerCase() === ctbOf(cur).toLowerCase() ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label>Affichage <span><input type="checkbox" data-k="showStyles" ${cur.showStyles ? 'checked' : ''}> Afficher les styles de tracé à l’écran</span></label>
        <label>Épaisseurs <select data-k="lw"><option value="1" ${cur.lineweights !== false ? 'selected' : ''}>Épaisseurs des objets et calques</option><option value="0" ${cur.lineweights === false ? 'selected' : ''}>Tout en trait fin</option></select></label>
      </div>
      <p class="muted">Feuille : ${esc(describePlot(cur))}, tracée à l’échelle 1:1 (TRACER, PUBLIER). Les fenêtres gardent leur échelle.</p>
      <div class="qto-actions"><button class="btn primary" data-act="ok">OK</button><button class="btn" data-act="cancel">Annuler</button></div>`;
  };
  dlg.onchange = (e) => {
    const k = e.target.dataset.k;
    const v = e.target.value;
    if (k === 'paper') {
      if (v === CUSTOM) cur.paper = CUSTOM;
      else Object.assign(cur, makePlot(v, isLandscape(cur), { origin: cur.origin, margins: cur.margins, mono: cur.mono, lineweights: cur.lineweights, ctb: cur.ctb, showStyles: cur.showStyles }));
    }
    if (k === 'orient' && (v === 'L') !== isLandscape(cur)) [cur.w, cur.h] = [cur.h, cur.w];
    if (k === 'w' || k === 'h') { const n = parse(v); if (n > 10) cur[k] = n; cur.paper = formatOf(cur.w, cur.h); }
    if (k === 'ox' || k === 'oy') { const n = parse(v); if (Number.isFinite(n)) cur.origin = k === 'ox' ? [n, cur.origin[1]] : [cur.origin[0], n]; }
    if (/^m\d$/.test(k)) { const n = parse(v); if (n >= 0) { cur.margins = [...(cur.margins || [0, 0, 0, 0])]; cur.margins[+k[1]] = n; } }
    if (k === 'ctb') { cur.ctb = v; cur.mono = v === 'monochrome.ctb'; }
    if (k === 'showStyles') cur.showStyles = e.target.checked;
    if (k === 'lw') cur.lineweights = v === '1';
    render();
  };
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'cancel') dlg.close();
    if (act === 'ok') {
      dlg.close();
      const { derived, ...plot } = cur;
      onApply(plot);
    }
  };
  render();
  if (!dlg.open) dlg.showModal();
}

export { sheetOf };
