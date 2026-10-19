// SPDX-License-Identifier: GPL-3.0-or-later
// Barre d'outils de la vue 3D (affichée en 3D seulement) : boîte de coupe, plans de coupe (6 au plus), mesures
// (distance, angle 3 points, laser), filtres d'affichage, isolement de la sélection, réinitialisation.
import { Tools3D } from '../render/tools3d.js';
import { systemByCode } from '../mep/systems.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (d) => `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" opacity=".55"/>',
  plane: '<path d="M3 15l6-5h12l-6 5z"/><path d="M12 3v18" stroke-dasharray="2 2"/>',
  dist: '<path d="M4 18L18 4"/><circle cx="4" cy="18" r="2"/><circle cx="18" cy="4" r="2"/>',
  angle: '<path d="M20 19H5l9-13"/><path d="M10 19a5 5 0 0 0-1.6-3.7"/>',
  laser: '<path d="M4 20h16"/><path d="M12 20V6" stroke-dasharray="2 2"/><path d="M9 9l3-3 3 3"/><path d="M4 4h16"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  isolate: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
  clear: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const HINTS = {
  distance: 'Distance : cliquez deux points (volumes des réseaux ou traits du dessin).',
  angle: 'Angle : cliquez trois points, le sommet de l’angle en deuxième.',
  laser: 'Laser : cliquez une face ; la distance va perpendiculairement jusqu’au premier objet en face.',
};
const AXIS_LABELS = { z: 'Horizontal', x: 'Vertical (X)', y: 'Vertical (Y)' };

export function installToolbar3d({ renderer, editor, unitM }) {
  const view = document.getElementById('view');
  const bar = document.createElement('div');
  bar.className = 'tools3d';
  bar.hidden = true;
  view.appendChild(bar);
  let open = null; // panneau ouvert : 'planes' | 'filters' | null
  const tools = new Tools3D(renderer, { unitM, onChange: () => render() });
  renderer.tools3d = tools;

  function systems() {
    const set = new Set();
    for (const e of editor.doc?.entities.values() || []) if (e.mep && e.type === 'LWPOLYLINE') set.add(e.mep.system);
    return [...set].sort();
  }
  const hasIfc = () => [...(editor.doc?.blocks.values() || [])].some((b) => b.fond?.ifc);

  function render() {
    const t = tools;
    const btn = (act, icon, label, on = false, extra = '') => `<button class="t3-btn ${on ? 'on' : ''}" data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}" ${extra}>${ico(icon)}</button>`;
    let panel = '';
    if (open === 'planes') {
      panel = `<div class="t3-panel"><div class="t3-title">Plans de coupe (${t.planes.length} / 6)</div>
        ${t.planes.map((p, i) => `<div class="t3-row"><select data-plane="${i}" data-k="axis">${Object.entries(AXIS_LABELS).map(([k, l]) => `<option value="${k}" ${k === p.axis ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn small" data-plane="${i}" data-k="flip" title="Garder l’autre côté">Inverser</button>
          <button class="btn small" data-plane="${i}" data-k="del" title="Supprimer ce plan">${ico(I.clear)}</button></div>`).join('')}
        <div class="t3-row"><button class="btn small" data-act="add-plane" ${t.planes.length >= 6 ? 'disabled' : ''}>+ Plan de coupe</button></div>
        <p class="t3-hint">Glissez la poignée bleue d’un plan pour le déplacer.</p></div>`;
    } else if (open === 'filters') {
      const sys = systems();
      panel = `<div class="t3-panel"><div class="t3-title">Afficher</div>
        <label class="t3-check"><input type="checkbox" data-f="drawing" ${t.filter.drawing ? 'checked' : ''}> Dessin 2D (traits)</label>
        <label class="t3-check"><input type="checkbox" data-f="underlays" ${t.filter.underlays ? 'checked' : ''}> Fonds de plan</label>
        <label class="t3-check"><input type="checkbox" data-f="grid" ${t.filter.grid ? 'checked' : ''}> Grille</label>
        ${hasIfc() ? `<div class="t3-title">Maquette IFC</div>
          <label class="t3-check"><input type="checkbox" data-f="ifc" ${t.filter.ifc ? 'checked' : ''}> Volumes (dalles, murs…)</label>
          <label class="t3-check"><input type="checkbox" data-f="ifcAll" ${t.filter.ifcAll ? 'checked' : ''} ${t.filter.ifc ? '' : 'disabled'}> Tous les niveaux <span class="muted">(sinon le niveau du plan)</span></label>` : ''}
        ${sys.length ? `<div class="t3-title">Réseaux</div>${sys.map((c) => `<label class="t3-check"><input type="checkbox" data-sys="${esc(c)}" ${t.filter.hiddenSystems.has(c) ? '' : 'checked'}> ${esc(c)} <span class="muted">${esc(systemByCode(c)?.label || '')}</span></label>`).join('')}` : ''}
      </div>`;
    } else if (t.tool) {
      panel = `<div class="t3-panel t3-hintbox">${esc(HINTS[t.tool])}${t.pending.length ? ` (${t.pending.length} point${t.pending.length > 1 ? 's' : ''})` : ''}</div>`;
    } else if (t.box) {
      panel = '<div class="t3-panel t3-hintbox">Boîte de coupe : glissez les poignées rouges pour ajuster ses faces.</div>';
    }
    bar.innerHTML = `<div class="t3-bar">
        ${btn('box', I.box, t.box ? 'Retirer la boîte de coupe' : 'Boîte de coupe (autour de la sélection, sinon de tout le dessin)', !!t.box)}
        ${btn('planes', I.plane, 'Plans de coupe (6 au plus)', open === 'planes' || t.planes.length > 0)}
        <span class="t3-sep"></span>
        ${btn('distance', I.dist, 'Mesure point à point', t.tool === 'distance')}
        ${btn('angle', I.angle, 'Angle par 3 points', t.tool === 'angle')}
        ${btn('laser', I.laser, 'Mesure laser (perpendiculaire à une face)', t.tool === 'laser')}
        ${t.measures.length ? btn('clear-measures', I.clear, 'Effacer les mesures') : ''}
        <span class="t3-sep"></span>
        ${btn('filters', I.filter, 'Filtres d’affichage', open === 'filters' || !t.filter.drawing || !t.filter.underlays || !t.filter.ifc || t.filter.hiddenSystems.size > 0)}
        ${btn('isolate', I.isolate, t.isolate ? 'Tout afficher' : 'Isoler la sélection', !!t.isolate)}
        ${btn('reset', I.reset, 'Réinitialiser la vue 3D (coupes, mesures, filtres)')}
      </div>${panel}`;
  }

  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const sel = [...editor.selection];
    if (act === 'box') tools.toggleBox(sel);
    else if (act === 'planes') { open = open === 'planes' ? null : 'planes'; if (open && !tools.planes.length) tools.addPlane('z'); }
    else if (act === 'add-plane') tools.addPlane('z');
    else if (act === 'filters') open = open === 'filters' ? null : 'filters';
    else if (act === 'distance' || act === 'angle' || act === 'laser') { open = null; tools.setTool(act); }
    else if (act === 'clear-measures') tools.clearMeasures();
    else if (act === 'isolate') tools.setIsolate(tools.isolate ? null : sel);
    else if (act === 'reset') { open = null; tools.clearAll(); renderer.frame3d(); }
    const pl = e.target.closest('[data-plane]');
    if (pl && e.target.closest('button')) {
      const i = +pl.dataset.plane;
      if (pl.dataset.k === 'flip') tools.flipPlane(i);
      if (pl.dataset.k === 'del') tools.removePlane(i);
    }
    render();
  });
  bar.addEventListener('change', (e) => {
    const f = e.target.dataset.f, sys = e.target.dataset.sys, pl = e.target.dataset.plane;
    if (f) { tools.filter[f] = e.target.checked; tools.applyFilter(); }
    if (sys) { if (e.target.checked) tools.filter.hiddenSystems.delete(sys); else tools.filter.hiddenSystems.add(sys); tools.applyFilter(); }
    if (pl != null && e.target.dataset.k === 'axis') tools.setPlaneAxis(+pl, e.target.value);
    render();
  });
  // Échap : quitte l'outil de mesure en cours.
  window.addEventListener('keydown', (e) => {
    if (renderer.mode === '3d' && e.key === 'Escape' && tools.tool) { tools.setTool(null); render(); }
  }, true);
  renderer.onModeChange = (mode) => {
    bar.hidden = mode !== '3d';
    if (mode !== '3d') { tools.setTool(null); open = null; }
    render();
  };
  render();
  return tools;
}
