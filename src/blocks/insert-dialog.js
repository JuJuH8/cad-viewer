// SPDX-License-Identifier: GPL-3.0-or-later
// Boîte « Insérer un bloc » (INSERER), comme la palette Blocs d'AutoCAD : aperçu de chaque bloc du dessin,
// recherche, échelle, rotation (ou à l'écran), décomposer, insertion répétée ; bloc depuis un fichier DWG / DXF ;
// accès à l'éditeur de blocs.
import { blockSvg } from './preview.js';
import { isDynamic } from './dynamic.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (v) => parseFloat(String(v).replace(',', '.'));

// Blocs proposés : ni anonymes, ni références externes, ni objets internes (réseaux, symboles électriques).
export function insertableBlocks(doc) {
  return [...doc.blocks.values()]
    .filter((b) => !b.name.startsWith('*') && !b.xref && !b.fond && !b.name.startsWith('CV_MEP_') && !b.name.includes('|') && !b.name.includes('§'))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
}

// Bloc créé depuis un autre dessin (son espace objet), avec ses calques et ses blocs qui manquent. Renvoie le nom.
export function blockFromDrawing(doc, xdoc, wanted) {
  let name = wanted.replace(/[<>/\\":;?*|,=`]/g, '_') || 'Bloc';
  if (doc.blocks.has(name)) { let i = 2; while (doc.blocks.has(`${name}_${i}`)) i++; name = `${name}_${i}`; }
  doc.transaction(`Bloc depuis un fichier (${name})`, () => {
    for (const [ln, l] of xdoc.layers) if (!doc.layers.has(ln)) doc.addLayer(ln, { ...l });
    for (const [tn, t] of xdoc.ltypes || []) if (!doc.ltypes?.has(tn)) doc.setTableEntry('ltypes', tn, t);
    for (const [bn, b] of xdoc.blocks) if (!doc.blocks.has(bn) && !bn.startsWith('*Paper')) doc.setTableEntry('blocks', bn, b);
    const entities = [...xdoc.entities.values()].filter((e) => (e.space || 'model') === 'model').map((e) => {
      const c = structuredClone(e);
      delete c.id; delete c.space; delete c.handle;
      return c;
    });
    doc.setTableEntry('blocks', name, { name, base: [0, 0, 0], flags: 0, xref: false, entities });
  });
  return name;
}

let dlg = null;
const state = { filter: '', name: null, scale: 1, rot: 0, rotDeg: 0, rotOnScreen: true, explode: false, repeat: false };

// hooks : { loadDocument(buffer, fileName) → Document, editBlock(name) }
export function openInsertDialog(editor, hooks = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'insert-block';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const doc = () => editor.doc;
  const grid = () => {
    const f = state.filter.trim().toLowerCase();
    const list = insertableBlocks(doc()).filter((b) => !f || b.name.toLowerCase().includes(f));
    if (!list.length) return '<p class="muted">Aucun bloc. « Nouveau bloc » (BLOC) ou « Depuis un fichier… ».</p>';
    return list.slice(0, 500).map((b) => `<button class="elec-sym ${b.name === state.name ? 'sel' : ''}" data-block="${esc(b.name)}" title="${esc(b.name)}${isDynamic(b) ? ' — bloc dynamique' : ''}">
      ${blockSvg(doc(), b.name, 56)}<span>${esc(b.name)}${isDynamic(b) ? ' <b class="dyn-badge" title="Bloc dynamique">⚡</b>' : ''}</span></button>`).join('');
  };
  const render = () => {
    dlg.innerHTML = `<h2>Insérer un bloc</h2>
      <div class="fond-row"><input type="search" data-k="filter" placeholder="Rechercher un bloc" value="${esc(state.filter)}" style="flex:1">
        <button class="btn" data-act="file" title="Insérer un dessin DWG / DXF comme bloc">Depuis un fichier…</button>
        <button class="btn" data-act="new" title="Créer un bloc à partir d’objets du dessin (BLOC)">Nouveau bloc</button></div>
      <div class="elec-syms lib insert-grid" data-grid>${grid()}</div>
      <div class="fond-row">
        <label>Échelle <input data-k="scale" value="${String(state.scale).replace('.', ',')}" size="5"></label>
        <label><input type="checkbox" data-k="rotOnScreen" ${state.rotOnScreen ? 'checked' : ''}> Rotation à l’écran</label>
        <label>Rotation (°) <input data-k="rot" value="${String(state.rotDeg).replace('.', ',')}" size="5" ${state.rotOnScreen ? 'disabled' : ''}></label>
        <label><input type="checkbox" data-k="explode" ${state.explode ? 'checked' : ''}> Décomposer</label>
        <label><input type="checkbox" data-k="repeat" ${state.repeat ? 'checked' : ''}> Insertion répétée</label>
      </div>
      <p class="muted">Cliquez un bloc puis son point d’insertion (Échap pour finir une insertion répétée). ⚡ : bloc dynamique (poignées de paramètres une fois inséré).</p>
      <div class="qto-actions"><button class="btn" data-act="edit" ${state.name ? '' : 'disabled'} title="Ouvrir le bloc choisi dans l’éditeur de blocs">Modifier le bloc…</button><button class="btn" data-act="close">Fermer</button></div>`;
  };
  const place = (name) => {
    state.name = name;
    editor.insertState = { ...state };
    editor.cancel?.();
    editor.run('POSERBLOC');
    dlg.querySelector('[data-grid]').innerHTML = grid();
    dlg.querySelector('[data-act="edit"]').disabled = false;
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest('[data-block]')?.dataset.block;
    if (b) { place(b); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'new') { dlg.close(); editor.run('BLOC'); }
    if (act === 'edit' && state.name) { dlg.close(); hooks.editBlock?.(state.name); }
    if (act === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.dwg,.dxf';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f || !hooks.loadDocument) return;
        try {
          editor.print(`Lecture de ${f.name}…`);
          const xdoc = await hooks.loadDocument(await f.arrayBuffer(), f.name);
          const name = blockFromDrawing(doc(), xdoc, f.name.replace(/\.(dwg|dxf)$/i, ''));
          editor.print(`Bloc « ${name} » créé depuis ${f.name}.`);
          render();
          place(name);
        } catch (err) { editor.print(`Impossible de lire ${f.name} : ${err.message}`); }
      };
      input.click();
    }
  };
  dlg.onchange = (e) => {
    const k = e.target.dataset.k;
    if (k === 'scale') { const n = parse(e.target.value); state.scale = n > 0 ? n : 1; }
    if (k === 'rot') { const n = parse(e.target.value); state.rotDeg = Number.isFinite(n) ? n : 0; state.rot = (state.rotDeg * Math.PI) / 180; }
    if (k === 'rotOnScreen') { state.rotOnScreen = e.target.checked; render(); }
    if (k === 'explode') state.explode = e.target.checked;
    if (k === 'repeat') state.repeat = e.target.checked;
    editor.insertState = { ...state };
  };
  dlg.oninput = (e) => {
    if (e.target.dataset.k !== 'filter') return;
    state.filter = e.target.value;
    dlg.querySelector('[data-grid]').innerHTML = grid();
  };
  render();
  if (!dlg.open) dlg.show();
}
