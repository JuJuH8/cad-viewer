// SPDX-License-Identifier: GPL-3.0-or-later
// EXTRACTATT : boîte d'extraction des données des blocs (source, blocs, colonnes, regroupement, aperçu) → CSV pour
// Excel, copie pour le presse-papiers, ou tableau dans le dessin. Le tableau garde ses réglages : MAJEXTRACTION le
// recalcule après des modifications du dessin (comme la mise à jour des liaisons de données d'AutoCAD).
import { collectInserts, inventory, extractTable, toCsv, PROPERTY_COLUMNS, columnLabel } from './extract.js';
import { tableEntities } from '../mep/table.js';
import { fmt } from '../editor/editor.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PREF = 'cv.extractatt';

function prefs() {
  try { return { columns: ['count', 'name'], combine: true, nested: false, attrOnly: true, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { columns: ['count', 'name'], combine: true, nested: false, attrOnly: true }; }
}
function savePrefs(p) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* stockage indisponible */ } }

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Réglages d'extraction → tableau (données actuelles du dessin).
export function runExtraction(doc, cfg) {
  const items = collectInserts(doc, { ids: cfg.ids || null, nested: !!cfg.nested });
  return extractTable(items, { blocks: cfg.blocks, columns: cfg.columns, combine: cfg.combine !== false, sort: cfg.sort || null });
}

// Entités du tableau dans le dessin (nombres à virgule, comme en français).
export function extractionEntities(table, { h, title }) {
  const rows = table.rows.map((r) => r.map((c, j) => (table.numeric.includes(j) ? String(c).replace('.', ',') : c)));
  return tableEntities(table.head, rows, { h, title, numeric: table.numeric });
}

// Choix dans la boîte → Promise de { action: 'table' | 'csv', cfg, table } ou null (fermée).
export function openExtractDialog(doc, { selection = [] } = {}) {
  let dlg = document.getElementById('extract-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'extract-dialog';
    dlg.className = 'qto extract';
    document.body.appendChild(dlg);
  }
  const p = prefs();
  const state = {
    scope: selection.length ? 'selection' : 'all', nested: p.nested, combine: p.combine, attrOnly: p.attrOnly,
    columns: [...p.columns], blocks: null, sort: null, title: 'EXTRACTION DES BLOCS',
  };
  let items = [], inv = null;
  const gather = () => {
    items = collectInserts(doc, { ids: state.scope === 'selection' ? selection : null, nested: state.nested });
    inv = inventory(items);
    const names = [...inv.blocks.keys()].filter((n) => !state.attrOnly || items.some((it) => it.name === n && Object.keys(it.attrs).length));
    // Blocs cochés : ceux d'avant encore présents, sinon tous ceux de la liste.
    const prev = state.blocks ? state.blocks.filter((n) => names.includes(n)) : null;
    state.blocks = prev?.length ? prev : names;
    state.names = names;
  };
  const available = () => {
    const chosen = new Set(state.blocks);
    const tags = [...inv.tags].filter(([, bl]) => [...bl].some((b) => chosen.has(b))).map(([t]) => `att:${t}`).sort();
    const dyn = [...inv.dyn].filter(([, bl]) => [...bl].some((b) => chosen.has(b))).map(([k]) => `dyn:${k}`).sort();
    return { props: PROPERTY_COLUMNS.map(([k]) => k), tags, dyn };
  };
  const cfg = () => {
    const av = available();
    const ok = new Set([...av.props, ...av.tags, ...av.dyn]);
    return {
      ids: state.scope === 'selection' ? [...selection] : null, nested: state.nested, combine: state.combine,
      blocks: [...state.blocks], columns: state.columns.filter((k) => ok.has(k)), sort: state.sort, title: state.title,
    };
  };
  const render = () => {
    const av = available();
    const c = cfg();
    const table = c.columns.length && c.blocks.length ? extractTable(items, c) : { head: [], rows: [], numeric: [], total: 0 };
    const colBox = (k) => `<label class="check"><input type="checkbox" data-col="${esc(k)}" ${state.columns.includes(k) ? 'checked' : ''}> ${esc(columnLabel(k))}</label>`;
    const shown = table.rows.slice(0, 200);
    dlg.innerHTML = `<h2>Extraction des attributs</h2>
      <div class="ex-source">
        <label class="check"><input type="radio" name="ex-scope" value="all" ${state.scope === 'all' ? 'checked' : ''}> Tout le dessin</label>
        <label class="check"><input type="radio" name="ex-scope" value="selection" ${state.scope === 'selection' ? 'checked' : ''} ${selection.length ? '' : 'disabled'}> Sélection (${selection.length} objet${selection.length > 1 ? 's' : ''})</label>
        <label class="check"><input type="checkbox" data-opt="nested" ${state.nested ? 'checked' : ''}> Blocs imbriqués</label>
        <label class="check"><input type="checkbox" data-opt="attrOnly" ${state.attrOnly ? 'checked' : ''}> Seulement les blocs à attributs</label>
      </div>
      <div class="ex-body">
        <fieldset class="ex-blocks"><legend>Blocs (${state.names.length})
          <button class="link" data-act="all-blocks">tous</button> <button class="link" data-act="no-blocks">aucun</button></legend>
          ${state.names.map((n) => `<label class="check"><input type="checkbox" data-block="${esc(n)}" ${state.blocks.includes(n) ? 'checked' : ''}> ${esc(n)} <span class="muted">(${inv.blocks.get(n)})</span></label>`).join('') || '<span class="muted">Aucun bloc.</span>'}
        </fieldset>
        <fieldset class="ex-cols"><legend>Colonnes</legend>
          <div class="ex-group">Propriétés</div>${av.props.map(colBox).join('')}
          ${av.tags.length ? `<div class="ex-group">Attributs</div>${av.tags.map(colBox).join('')}` : ''}
          ${av.dyn.length ? `<div class="ex-group">Paramètres dynamiques</div>${av.dyn.map(colBox).join('')}` : ''}
        </fieldset>
      </div>
      <div class="ex-options">
        <label class="check"><input type="checkbox" data-opt="combine" ${state.combine ? 'checked' : ''}> Regrouper les lignes identiques</label>
        <label>Titre du tableau <input data-opt="title" value="${esc(state.title)}"></label>
        <span class="muted">${table.rows.length} ligne(s), ${table.total} bloc(s)${table.rows.length > shown.length ? ` — aperçu des ${shown.length} premières` : ''}. Cliquez un en-tête pour trier.</span>
      </div>
      <div class="qto-scroll ex-preview"><table><thead><tr>${table.head.map((h, j) => `<th data-sort="${esc(c.columns[j])}">${esc(h)}${state.sort?.[0]?.key === c.columns[j] ? (state.sort[0].desc ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((r) => `<tr>${r.map((v, j) => `<td class="${table.numeric.includes(j) ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="qto-actions">
        <button class="btn" data-act="copy" ${table.rows.length ? '' : 'disabled'} title="Copier pour coller dans Excel">Copier</button>
        <button class="btn" data-act="csv" ${table.rows.length ? '' : 'disabled'}>Exporter CSV…</button>
        <button class="btn primary" data-act="table" ${table.rows.length ? '' : 'disabled'}>Insérer un tableau…</button>
        <button class="btn" data-act="close">Fermer</button>
      </div>`;
    return table;
  };
  gather();
  let table = render();
  return new Promise((resolve) => {
    const finish = (v) => {
      savePrefs({ columns: state.columns, combine: state.combine, nested: state.nested, attrOnly: state.attrOnly });
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    dlg.onclose = () => finish(null);
    dlg.onclick = async (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const key = th.dataset.sort;
        state.sort = [{ key, desc: state.sort?.[0]?.key === key ? !state.sort[0].desc : false }];
        table = render();
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') finish(null);
      else if (act === 'all-blocks') { state.blocks = [...state.names]; table = render(); }
      else if (act === 'no-blocks') { state.blocks = []; table = render(); }
      else if (act === 'copy') {
        const text = [table.head, ...table.rows].map((r) => r.join('\t')).join('\r\n');
        try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copié'; } catch { e.target.textContent = 'Copie impossible'; }
      } else if (act === 'csv') { download('Extraction des attributs.csv', toCsv(table)); }
      else if (act === 'table') finish({ action: 'table', cfg: cfg(), table });
    };
    dlg.onchange = (e) => {
      const t = e.target;
      if (t.name === 'ex-scope') { state.scope = t.value; gather(); }
      else if (t.dataset.opt === 'nested' || t.dataset.opt === 'attrOnly') { state[t.dataset.opt] = t.checked; gather(); }
      else if (t.dataset.opt === 'combine') state.combine = t.checked;
      else if (t.dataset.opt === 'title') { state.title = t.value; return; }
      else if (t.dataset.block != null) {
        const n = t.dataset.block;
        state.blocks = t.checked ? [...state.blocks, n] : state.blocks.filter((x) => x !== n);
      } else if (t.dataset.col != null) {
        const k = t.dataset.col;
        state.columns = t.checked ? [...state.columns.filter((x) => x !== k), k] : state.columns.filter((x) => x !== k);
        // « Nombre » toujours en premier, comme AutoCAD.
        if (state.columns.includes('count')) state.columns = ['count', ...state.columns.filter((x) => x !== 'count')];
      } else return;
      table = render();
    };
    if (!dlg.open) dlg.showModal();
  });
}

// Nom libre pour un bloc de tableau.
function tableBlockName(doc) {
  let k = 1;
  while (doc.blocks.has(`CV_TABLE_${k}`)) k++;
  return `CV_TABLE_${k}`;
}

// Recalcule un tableau d'extraction (insertion portant `extract`) : définition du bloc remplacée (annulable).
export function refreshExtraction(doc, ins) {
  const x = ins.extract;
  if (!x) return false;
  const table = runExtraction(doc, x);
  const t = extractionEntities(table, x);
  const b = doc.blocks.get(ins.name);
  doc.setTableEntry('blocks', ins.name, { ...(b || { name: ins.name, base: [0, 0, 0], flags: 0, xref: false }), entities: t.entities });
  return true;
}

export function registerExtractCommands(ed) {
  ed.register('EXTRACTATT', async (ctx) => {
    const { doc } = ctx;
    const r = await openExtractDialog(doc, { selection: [...ed.selection] });
    if (r?.action !== 'table') return;
    const paper = (doc.currentSpace || 'model') !== 'model';
    const scale = paper ? 1 : doc.header?.annoScale || (doc.header?.insunits === 4 ? 50 : 1);
    const h = await ctx.getDistance('Hauteur de texte', { default: 2.5 * scale });
    if (!(h > 0)) return;
    const t = extractionEntities(r.table, { h, title: r.cfg.title });
    const name = tableBlockName(doc);
    const block = { name, base: [0, 0, 0], flags: 0, xref: false, entities: t.entities };
    // Réglages gardés avec le tableau (pas la sélection : la mise à jour relit tout le dessin si elle a disparu).
    const extract = { ...r.cfg, h, ids: r.cfg.ids?.length ? r.cfg.ids : null };
    const mk = (q) => ({ type: 'INSERT', name, p: [q[0], q[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [], layer: doc.currentLayer, color: 256 });
    doc.blocks.set(name, block); // pour l'aperçu
    let p;
    try { p = await ctx.getPoint('Coin supérieur gauche du tableau', { preview: (q) => [mk(q)] }); } finally { doc.blocks.delete(name); }
    doc.transaction('Tableau d’extraction', () => {
      doc.setTableEntry('blocks', name, block);
      doc.add({ ...mk(p), space: doc.currentSpace || 'model', extract });
    });
    ctx.print(`Tableau de ${r.table.rows.length} ligne(s) inséré (${fmt(t.width)} × ${fmt(t.height)}). MAJEXTRACTION le met à jour.`);
  }, { aliases: ['DATAEXTRACTION', 'EXTRACTDONNEES', 'EATTEXT', 'ATTEXT', 'EXTRACTIONATT'], label: 'EXTRACTATT', transaction: false });

  // Mise à jour des tableaux d'extraction (tous, ou ceux de la sélection).
  ed.register('MAJEXTRACTION', (ctx) => {
    const { doc } = ctx;
    const sel = [...ed.selection].map((id) => doc.get(id)).filter((e) => e?.extract);
    const list = sel.length ? sel : [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.extract);
    if (!list.length) { ctx.print('Aucun tableau d’extraction dans le dessin.'); return; }
    doc.transaction('Mise à jour des extractions', () => {
      for (const e of list) {
        // Sélection d'origine disparue : tout le dessin.
        if (e.extract.ids && !e.extract.ids.some((id) => doc.get(id))) doc.update({ ...e, extract: { ...e.extract, ids: null } });
        refreshExtraction(doc, doc.get(e.id));
      }
    });
    ctx.print(`${list.length} tableau(x) d’extraction mis à jour.`);
  }, { aliases: ['DATALINKUPDATE', 'MAJLIAISONS', 'EXTRACTMAJ'], label: 'MAJEXTRACTION', transaction: false });
}
