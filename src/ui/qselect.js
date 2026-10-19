// SPDX-License-Identifier: GPL-3.0-or-later
// Sélection rapide (SELECTRAPIDE, comme QSELECT) : filtre par type d'objet, calque, couleur et
// système MEP, avec le nombre d'objets trouvés mis à jour en direct.
const TYPE_LABELS = {
  LINE: 'Ligne', LWPOLYLINE: 'Polyligne', POLY3D: 'Polyligne 3D', ARC: 'Arc', CIRCLE: 'Cercle', ELLIPSE: 'Ellipse',
  SPLINE: 'Spline', TEXT: 'Texte', MTEXT: 'Texte multiligne', INSERT: 'Bloc', BLOCKREF: 'Cote / tableau', HATCH: 'Hachure',
  SOLID: 'Solide 2D', POINT: 'Point', MEP: 'Réseau MEP',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Type affiché d'une entité (les réseaux MEP sont regroupés).
export const typeOf = (e) => (e.mep && e.type === 'LWPOLYLINE' ? 'MEP' : e.type);

// Filtre pur (testé) : critères { type, layer, color, system } ('*' = tous).
export function quickSelect(entities, crit) {
  return entities.filter((e) => (crit.type === '*' || typeOf(e) === crit.type)
    && (crit.layer === '*' || e.layer === crit.layer)
    && (crit.color === '*' || String(e.color ?? 256) === crit.color)
    && (crit.system === '*' || e.mep?.system === crit.system)).map((e) => e.id);
}

export function showQuickSelect(doc, editor) {
  const ents = [...doc.entities.values()].filter((e) => e.space === editor.r.space && editor.r.layerVisible(e.layer));
  const count = (key) => {
    const m = new Map();
    for (const e of ents) { const k = key(e); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
    return [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const types = count(typeOf), layers = count((e) => e.layer), colors = count((e) => String(e.color ?? 256));
  const systems = count((e) => e.mep?.system ?? null);
  const colorName = (c) => (c === '256' ? 'DuCalque' : c === '0' ? 'DuBloc' : `Couleur ${c}`);
  const select = (name, label, list, fmt = (k) => k) => `<label class="qs-row"><span>${label}</span><select data-k="${name}">
    <option value="*">Tous</option>${list.map(([k, n]) => `<option value="${esc(k)}">${esc(fmt(k))} (${n})</option>`).join('')}</select></label>`;
  let dlg = document.getElementById('qselect-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'qselect-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<h2>Sélection rapide</h2>
    ${select('type', 'Type d’objet', types, (k) => TYPE_LABELS[k] || k)}
    ${select('layer', 'Calque', layers)}
    ${select('color', 'Couleur', colors, colorName)}
    ${systems.length ? select('system', 'Système MEP', systems) : ''}
    <p class="qs-count"></p>
    <div class="qto-actions"><button class="btn primary" data-act="ok">Sélectionner</button><button class="btn" data-act="add">Ajouter à la sélection</button><button class="btn" data-act="close">Fermer</button></div>`;
  const crit = () => {
    const c = { type: '*', layer: '*', color: '*', system: '*' };
    for (const s of dlg.querySelectorAll('select')) c[s.dataset.k] = s.value;
    return c;
  };
  const refresh = () => { dlg.querySelector('.qs-count').textContent = `${quickSelect(ents, crit()).length} objet(s) correspondant(s)`; };
  dlg.onchange = refresh;
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act !== 'close') {
      const ids = quickSelect(ents, crit());
      editor.setSelection(act === 'add' ? [...editor.selection, ...ids] : ids);
      editor.print(`${ids.length} objet(s) sélectionné(s).`);
    }
    dlg.close();
  };
  refresh();
  if (!dlg.open) dlg.showModal();
  return dlg;
}
