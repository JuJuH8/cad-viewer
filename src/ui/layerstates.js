// SPDX-License-Identifier: GPL-3.0-or-later
// Gestionnaire des états de calques (ETATCALQUE / LAYERSTATE, comme AutoCAD) : enregistrer les propriétés des calques
// sous un nom, les restaurer (propriétés choisies), renommer, supprimer, importer / exporter (.las d'AutoCAD, ou
// états d'un autre dessin DXF / DWG). -ETATCALQUE : mêmes opérations en ligne de commande.
import {
  captureState, restoreState, stateMatches, keyOf, MASK, parseLas, writeLas, encodeLas, decodeLas, scanLayerStates,
} from '../core/layerstates.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Propriétés à restaurer (bits du masque d'AutoCAD).
const PROPS = [
  ['on', 'Activé / désactivé'], ['frozen', 'Gelé / libéré'], ['locked', 'Verrouillé / déverrouillé'], ['plot', 'Tracer / ne pas tracer'],
  ['newVp', 'Gelé dans les nouvelles fenêtres'], ['color', 'Couleur'], ['ltype', 'Type de ligne'], ['lweight', 'Épaisseur de ligne'],
  ['transparency', 'Transparence'],
];

export const layerStateList = (doc) => [...(doc.layerStates?.values() || [])].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
export const findLayerState = (doc, name) => doc.layerStates?.get(keyOf(name)) || null;

export function saveLayerState(doc, name, { desc, mask } = {}) {
  const old = findLayerState(doc, name);
  const st = captureState(doc, old?.name || name, { desc: desc ?? old?.desc ?? '', mask: mask ?? old?.mask });
  doc.transaction(old ? 'Mettre à jour l’état de calques' : 'Nouvel état de calques', () => doc.setTableEntry('layerStates', keyOf(name), st));
  return st;
}

export function applyLayerState(doc, name, opts = {}) {
  const st = findLayerState(doc, name);
  if (!st) return null;
  return doc.transaction('Restaurer l’état de calques', () => restoreState(doc, st, opts));
}

export function deleteLayerState(doc, name) {
  if (!findLayerState(doc, name)) return false;
  doc.transaction('Supprimer l’état de calques', () => doc.setTableEntry('layerStates', keyOf(name), null));
  return true;
}

export function editLayerState(doc, name, { newName, desc, mask } = {}) {
  const st = findLayerState(doc, name);
  if (!st) return false;
  const to = newName?.trim() || st.name;
  if (keyOf(to) !== keyOf(name) && findLayerState(doc, to)) return false;
  const next = { ...st, name: to, desc: desc ?? st.desc, mask: mask ?? st.mask };
  doc.transaction('Modifier l’état de calques', () => {
    if (keyOf(to) !== keyOf(name)) doc.setTableEntry('layerStates', keyOf(name), null);
    doc.setTableEntry('layerStates', keyOf(to), next);
  });
  return true;
}

// Ajoute des états lus ailleurs ; un état du même nom est remplacé. → nombre d'états ajoutés.
export function addLayerStates(doc, states) {
  const list = states.filter((s) => s?.name);
  if (list.length) doc.transaction('Importer des états de calques', () => { for (const s of list) doc.setTableEntry('layerStates', keyOf(s.name), structuredClone(s)); });
  return list.length;
}

// États contenus dans un fichier : .las (AutoCAD), .dxf (texte), .dwg (lu par loadDocument).
export async function layerStatesFromFile(name, buffer, loadDocument) {
  const bytes = new Uint8Array(buffer);
  if (/\.las$/i.test(name)) return parseLas(decodeLas(bytes));
  if (/\.dxf$/i.test(name)) return scanLayerStates(new TextDecoder('latin1').decode(bytes));
  if (/\.dwg$/i.test(name) && loadDocument) return [...((await loadDocument(buffer, name)).layerStates?.values() || [])];
  return [];
}

export const lasBytes = (states) => encodeLas(writeLas(states));

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function pickStatesFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [h] = await window.showOpenFilePicker({ id: 'etats-calques', types: [{ description: 'États de calques (.las) ou dessins', accept: { 'application/octet-stream': ['.las', '.dxf', '.dwg'] } }] });
      return await h.getFile();
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.las,.dxf,.dwg';
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Boîte de dialogue « Gestionnaire des états de calques ».
export function showLayerStates(doc, { loadDocument, onChange, print = () => {} } = {}) {
  let dlg = document.getElementById('layerstates-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'layerstates-dialog';
    dlg.className = 'qto layerstates';
    document.body.appendChild(dlg);
  }
  let selected = layerStateList(doc)[0]?.name || null;
  let form = null; // { mode: 'new' | 'edit' }
  let offMissing = false;
  const render = () => {
    const list = layerStateList(doc);
    if (selected && !findLayerState(doc, selected)) selected = list[0]?.name || null;
    const st = selected ? findLayerState(doc, selected) : null;
    const rows = list.map((s) => `<tr data-name="${esc(s.name)}" class="${s.name === selected ? 'sel' : ''}">
        <td>${esc(s.name)}</td><td>${stateMatches(doc, s) ? 'Oui' : 'Non'}</td><td>${esc(s.desc || '')}</td></tr>`).join('');
    const mask = st?.mask ?? 0;
    dlg.innerHTML = `<h2>Gestionnaire des états de calques</h2>
      <div class="ls-body">
        <div class="qto-scroll"><table class="layers-table ls-table"><thead><tr><th>Nom</th><th>Identique</th><th>Description</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="muted">Aucun état enregistré.</td></tr>'}</tbody></table></div>
        <div class="ls-side">
          <button class="btn" data-act="new">Nouveau…</button>
          <button class="btn" data-act="update" ${st ? '' : 'disabled'} title="Remplacer l’état par les propriétés actuelles des calques">Mettre à jour</button>
          <button class="btn" data-act="edit" ${st ? '' : 'disabled'}>Modifier…</button>
          <button class="btn" data-act="delete" ${st ? '' : 'disabled'}>Supprimer</button>
          <button class="btn" data-act="import">Importer…</button>
          <button class="btn" data-act="export" ${list.length ? '' : 'disabled'} title="Exporter l’état choisi (ou tous) en fichier .las d’AutoCAD">Exporter…</button>
        </div>
      </div>
      ${form ? `<div class="ls-form">
        <label>Nom <input data-f="name" value="${esc(form.mode === 'edit' ? st?.name || '' : '')}" placeholder="Nom de l’état"></label>
        <label>Description <input data-f="desc" value="${esc(form.mode === 'edit' ? st?.desc || '' : '')}"></label>
        <button class="btn primary" data-act="form-ok">${form.mode === 'new' ? 'Enregistrer' : 'Valider'}</button>
        <button class="btn" data-act="form-cancel">Annuler</button>
        <span class="ls-error" data-f="error"></span></div>` : ''}
      <fieldset class="ls-props" ${st ? '' : 'disabled'}><legend>Propriétés à restaurer${st ? ` (${esc(st.name)})` : ''}</legend>
        ${PROPS.map(([k, label]) => `<label class="check"><input type="checkbox" data-mask="${MASK[k]}" ${mask & MASK[k] ? 'checked' : ''}> ${label}</label>`).join('')}
      </fieldset>
      <label class="check"><input type="checkbox" data-opt="offMissing" ${offMissing ? 'checked' : ''}> Désactiver les calques absents de l’état</label>
      <div class="qto-actions">
        <button class="btn primary" data-act="restore" ${st ? '' : 'disabled'}>Restaurer</button>
        <button class="btn" data-act="close">Fermer</button>
      </div>`;
    dlg.querySelector('[data-f="name"]')?.focus();
  };
  const restore = (name) => {
    const r = applyLayerState(doc, name, { offMissing });
    if (r) print(`État « ${name} » restauré (${r.changed} calque(s) modifié(s)).`);
    onChange?.();
    render();
  };
  const submit = () => {
    const name = dlg.querySelector('[data-f="name"]').value.trim();
    const desc = dlg.querySelector('[data-f="desc"]').value;
    const err = dlg.querySelector('[data-f="error"]');
    if (!name) { err.textContent = 'Nom requis.'; return; }
    if (/[<>/\\":;?*|,=`]/.test(name)) { err.textContent = 'Caractères interdits : < > / \\ " : ; ? * | , = `'; return; }
    if (form.mode === 'new') {
      if (findLayerState(doc, name) && !window.confirm(`L’état « ${name} » existe déjà. Le remplacer ?`)) return;
      saveLayerState(doc, name, { desc });
      selected = findLayerState(doc, name).name;
    } else if (!editLayerState(doc, selected, { newName: name, desc })) { err.textContent = 'Un autre état porte déjà ce nom.'; return; } else selected = name;
    form = null;
    render();
  };
  dlg.onclick = async (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (tr && !e.target.closest('button')) { selected = tr.dataset.name; render(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'new') { form = { mode: 'new' }; render(); return; }
    if (act === 'edit') { form = { mode: 'edit' }; render(); return; }
    if (act === 'form-cancel') { form = null; render(); return; }
    if (act === 'form-ok') { submit(); return; }
    if (act === 'update' && selected) { saveLayerState(doc, selected); render(); return; }
    if (act === 'delete' && selected) { deleteLayerState(doc, selected); render(); return; }
    if (act === 'restore' && selected) { restore(selected); return; }
    if (act === 'export') {
      const st = selected ? findLayerState(doc, selected) : null;
      const all = !st || e.shiftKey;
      const states = all ? layerStateList(doc) : [st];
      download(`${all ? 'Etats de calques' : st.name}.las`, lasBytes(states));
      print(`${states.length} état(s) exporté(s) en .las.`);
      return;
    }
    if (act === 'import') {
      const file = await pickStatesFile();
      if (!file) return;
      try {
        const states = await layerStatesFromFile(file.name, await file.arrayBuffer(), loadDocument);
        if (!states.length) { print(`Aucun état de calques dans ${file.name}.`); return; }
        const clash = states.filter((s) => findLayerState(doc, s.name)).map((s) => s.name);
        if (clash.length && !window.confirm(`Remplacer les états existants : ${clash.join(', ')} ?`)) return;
        addLayerStates(doc, states);
        selected = states[0].name;
        print(`${states.length} état(s) importé(s) de ${file.name}.`);
        render();
      } catch (err) { print(`Import impossible : ${err.message || err}`); }
    }
  };
  dlg.ondblclick = (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (tr) restore(tr.dataset.name);
  };
  dlg.onchange = (e) => {
    if (e.target.dataset.opt === 'offMissing') { offMissing = e.target.checked; return; }
    const bit = parseInt(e.target.dataset.mask, 10);
    const st = selected && findLayerState(doc, selected);
    if (!bit || !st) return;
    editLayerState(doc, st.name, { mask: e.target.checked ? st.mask | bit : st.mask & ~bit });
  };
  dlg.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.dataset.f) { e.preventDefault(); submit(); }
  };
  render();
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function registerLayerStateCommands(ed, { loadDocument } = {}) {
  ed.register('ETATCALQUE', (ctx) => {
    showLayerStates(ctx.doc, { loadDocument, print: (s) => ctx.print(s), onChange: () => ctx.editor.ui.onState?.() });
  }, { aliases: ['LAYERSTATE', 'LAS', 'ETATSCALQUES', 'GESTETATCALQUE'], label: 'ETATCALQUE', transaction: false });

  // Ligne de commande (scripts) : Liste, Enregistrer, Restaurer, Supprimer, Renommer, Exporter.
  ed.register('-ETATCALQUE', async (ctx) => {
    const { doc } = ctx;
    const kw = await ctx.getKeyword('Option d’état de calques', ['Liste', 'Enregistrer', 'Restaurer', 'Supprimer', 'Renommer', 'Description', 'Exporter'], { default: 'Liste' });
    if (kw === 'Liste') {
      const list = layerStateList(doc);
      ctx.print(list.length ? list.map((s) => `${s.name}${stateMatches(doc, s) ? ' (identique)' : ''}${s.desc ? ` — ${s.desc}` : ''}`).join('\n') : 'Aucun état de calques.');
      return;
    }
    const name = (await ctx.getString(kw === 'Enregistrer' ? 'Nom du nouvel état' : 'Nom de l’état'))?.trim();
    if (!name) return;
    if (kw === 'Enregistrer') { saveLayerState(doc, name); ctx.print(`État « ${name} » enregistré.`); return; }
    if (!findLayerState(doc, name)) { ctx.print(`État « ${name} » introuvable.`); return; }
    if (kw === 'Restaurer') {
      const r = applyLayerState(doc, name);
      ctx.print(`État « ${name} » restauré (${r.changed} calque(s) modifié(s)).`);
    } else if (kw === 'Supprimer') {
      deleteLayerState(doc, name);
      ctx.print(`État « ${name} » supprimé.`);
    } else if (kw === 'Renommer') {
      const to = (await ctx.getString('Nouveau nom'))?.trim();
      ctx.print(to && editLayerState(doc, name, { newName: to }) ? `État renommé en « ${to} ».` : 'Renommage impossible.');
    } else if (kw === 'Description') {
      const desc = await ctx.getString('Description');
      editLayerState(doc, name, { desc: desc ?? '' });
    } else if (kw === 'Exporter') {
      download(`${findLayerState(doc, name).name}.las`, lasBytes([findLayerState(doc, name)]));
    }
  }, { aliases: ['-LAYERSTATE', '-LAS'], label: '-ETATCALQUE', transaction: false });
}
