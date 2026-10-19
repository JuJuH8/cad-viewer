// SPDX-License-Identifier: GPL-3.0-or-later
// Calques d'une fenêtre de présentation, comme les colonnes « Fenêtre » du gestionnaire de calques
// d'AutoCAD : gel dans la fenêtre, couleur, épaisseur et transparence propres à la fenêtre (les autres
// fenêtres et l'espace objet ne changent pas). Enregistré dans la fenêtre : frozen, layerOvr.
import { aciToColor, toCss } from '../colors.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COLORS = [[1, 'Rouge'], [2, 'Jaune'], [3, 'Vert'], [4, 'Cyan'], [5, 'Bleu'], [6, 'Magenta'], [7, 'Noir / blanc'], [8, 'Gris 8'], [9, 'Gris 9'],
  [30, 'Orange'], [40, 'Orange 40'], [140, 'Bleu ciel'], [150, 'Bleu 150'], [250, 'Gris foncé'], [253, 'Gris clair'], [254, 'Gris très clair']];
const WEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

// Nouvelle fenêtre (copie) avec le réglage d'un calque : field = frozen | color | lweight | transparency.
export function setViewportLayer(v, layer, field, value) {
  const out = structuredClone(v);
  if (field === 'frozen') {
    const set = new Set(out.frozen || []);
    if (value) set.add(layer); else set.delete(layer);
    if (set.size) out.frozen = [...set]; else delete out.frozen;
    return out;
  }
  const ovr = { ...(out.layerOvr || {}) };
  const cur = { ...(ovr[layer] || {}) };
  if (value == null || value === '' || Number.isNaN(value)) delete cur[field]; else cur[field] = value;
  if (Object.keys(cur).length) ovr[layer] = cur; else delete ovr[layer];
  if (Object.keys(ovr).length) out.layerOvr = ovr; else delete out.layerOvr;
  return out;
}

// Nombre de calques réglés dans la fenêtre (gel ou propriété imposée).
export function overrideCount(v) {
  return new Set([...(v.frozen || []), ...Object.keys(v.layerOvr || {})]).size;
}

let dlg = null;
export function openViewportLayers(doc, id, { foreground = 0x000000 } = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'vp-layers';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  let filter = '';
  const render = () => {
    const v = doc.get(id);
    if (!v) { dlg.close(); return; }
    const frozen = new Set(v.frozen || []);
    const names = [...doc.layers.keys()].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
      .filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
    const rows = names.map((n) => {
      const l = doc.layers.get(n);
      const ov = v.layerOvr?.[n] || {};
      const base = toCss(typeof l.rgb === 'number' ? l.rgb : aciToColor(l.color), foreground);
      const vc = ov.color != null ? toCss(aciToColor(ov.color), foreground) : base;
      return `<tr data-layer="${esc(n)}" class="${frozen.has(n) || Object.keys(ov).length ? 'ovr' : ''}">
        <td><span class="swatch" style="background:${vc}"></span>${esc(n)}</td>
        <td class="c"><input type="checkbox" data-f="frozen" ${frozen.has(n) ? 'checked' : ''}></td>
        <td><select data-f="color"><option value="">Calque</option>${COLORS.map(([c, lab]) => `<option value="${c}" ${ov.color === c ? 'selected' : ''}>${lab}</option>`).join('')}${ov.color != null && !COLORS.some(([c]) => c === ov.color) ? `<option value="${ov.color}" selected>Index ${ov.color}</option>` : ''}</select></td>
        <td><select data-f="lweight"><option value="">Calque</option><option value="-3" ${ov.lweight === -3 ? 'selected' : ''}>Défaut</option>${WEIGHTS.map((w) => `<option value="${w}" ${ov.lweight === w ? 'selected' : ''}>${(w / 100).toFixed(2).replace('.', ',')} mm</option>`).join('')}</select></td>
        <td><input data-f="transparency" value="${ov.transparency ?? ''}" placeholder="0" size="3"> %</td></tr>`;
    }).join('');
    dlg.innerHTML = `<h2>Calques de la fenêtre</h2>
      <p class="muted">Réglages valables dans cette fenêtre seulement : gel, couleur, épaisseur (visible avec l’affichage des épaisseurs, et au tracé) et transparence.</p>
      <div class="fond-row"><input type="search" data-k="filter" placeholder="Filtrer les calques" value="${esc(filter)}">
        <button class="btn" data-act="reset">Tout réinitialiser</button></div>
      <div class="qto-scroll"><table class="vp-layers"><thead><tr><th>Calque</th><th>Gel</th><th>Couleur</th><th>Épaisseur</th><th>Transparence</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };
  const apply = (fn, label = 'Calques de la fenêtre') => {
    const v = doc.get(id);
    if (!v) return;
    doc.transaction(label, () => doc.update(fn(v)));
    render();
  };
  dlg.onchange = (e) => {
    const tr = e.target.closest('tr[data-layer]');
    const f = e.target.dataset.f;
    if (!tr || !f) return;
    const layer = tr.dataset.layer;
    let value;
    if (f === 'frozen') value = e.target.checked;
    else if (f === 'transparency') { const n = parseInt(e.target.value, 10); value = n > 0 ? Math.min(90, n) : null; }
    else value = e.target.value === '' ? null : parseInt(e.target.value, 10);
    apply((v) => setViewportLayer(v, layer, f, value));
  };
  dlg.oninput = (e) => {
    if (e.target.dataset.k !== 'filter') return;
    filter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = dlg.querySelector('[data-k="filter"]');
    input.focus();
    input.setSelectionRange(pos, pos);
  };
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'reset') apply((v) => { const { frozen, layerOvr, ...rest } = v; return rest; }, 'Réinitialiser les calques de la fenêtre');
  };
  render();
  if (!dlg.open) dlg.showModal();
}
