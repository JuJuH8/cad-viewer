// SPDX-License-Identifier: GPL-3.0-or-later
// Gestionnaire des propriétés des calques (CALQUE / LA, comme AutoCAD) : état, couleur, type et
// épaisseur de ligne, impression — modifiables en tableau, chaque changement est annulable.
import { LW_CHOICES } from './panels.js';
import { plotStyleNames } from '../plot/styles.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACI = [[1, 'Rouge'], [2, 'Jaune'], [3, 'Vert'], [4, 'Cyan'], [5, 'Bleu'], [6, 'Magenta'], [7, 'Blanc / noir'], [8, 'Gris'], [9, 'Gris clair'], [30, 'Orange'], [140, 'Bleu ciel']];

export function showLayerManager(doc, onChange) {
  let dlg = document.getElementById('layers-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'layers-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const ltNames = ['Continuous', ...[...(doc.ltypes?.values() || [])].map((t) => t.name).filter((n) => !/^(bylayer|byblock|continuous)$/i.test(n))];
  const render = () => {
    const layers = [...doc.layers.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const colorSel = (l) => {
      const opts = ACI.some(([v]) => v === l.color) ? ACI : [...ACI, [l.color, `Index ${l.color}`]];
      return `<select data-k="color">${opts.map(([v, n]) => `<option value="${v}" ${v === l.color ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    };
    const ltSel = (l) => `<select data-k="ltype">${ltNames.map((n) => `<option value="${esc(n)}" ${n.toLowerCase() === String(l.ltype || 'Continuous').toLowerCase() ? 'selected' : ''}>${esc(n === 'Continuous' ? 'Continu' : n)}</option>`).join('')}</select>`;
    const lwSel = (l) => `<select data-k="lweight">${LW_CHOICES.filter(([v]) => v !== -1 && v !== -2)
      .map(([v, n]) => `<option value="${v}" ${v === (l.lweight ?? -3) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    const chk = (k, on) => `<input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}>`;
    // Dessin en styles de tracé nommés : style de chaque calque.
    const named = doc.header?.pstylemode === 0;
    const psNames = named ? plotStyleNames(doc) : [];
    const psSel = (l) => `<select data-k="pstyle">${psNames.map((n) => `<option value="${esc(n)}" ${n.toLowerCase() === String(l.pstyle || 'Normal').toLowerCase() ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    dlg.innerHTML = `<h2>Gestionnaire des propriétés des calques (${layers.length})</h2>
      <div class="qto-scroll"><table class="layers-table"><thead><tr><th>Nom</th><th>Actif</th><th>Gelé</th><th>Verrouillé</th>
      <th>Couleur</th><th>Type de ligne</th><th>Épaisseur</th>${named ? '<th>Style de tracé</th>' : ''}<th>Tracer</th></tr></thead><tbody>
      ${layers.map((l) => `<tr data-name="${esc(l.name)}"><td>${l.name === doc.currentLayer ? '<b>' : ''}${esc(l.name)}${l.name === doc.currentLayer ? '</b> (courant)' : ''}</td>
        <td>${chk('on', l.on !== false)}</td><td>${chk('frozen', !!l.frozen)}</td><td>${chk('locked', !!l.locked)}</td>
        <td>${colorSel(l)}</td><td>${ltSel(l)}</td><td>${lwSel(l)}</td>${named ? `<td>${psSel(l)}</td>` : ''}<td>${chk('plot', l.plot !== false)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };
  dlg.onchange = (e) => {
    const tr = e.target.closest('tr[data-name]');
    const k = e.target.dataset.k;
    if (!tr || !k) return;
    const name = tr.dataset.name;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'color') v = parseInt(v, 10);
    if (k === 'lweight') v = parseInt(v, 10);
    if (k === 'frozen' && v && name === doc.currentLayer) { e.target.checked = false; return; }
    const props = { [k]: v };
    if (k === 'color') props.rgb = undefined;
    doc.transaction('Propriétés du calque', () => doc.setLayer(name, props));
    onChange?.();
  };
  dlg.onclick = (e) => { if (e.target.dataset.act === 'close') dlg.close(); };
  render();
  if (!dlg.open) dlg.showModal();
  return dlg;
}
