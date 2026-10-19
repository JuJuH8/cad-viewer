// SPDX-License-Identifier: GPL-3.0-or-later
// Boîte « Tracer » (TRACER), comme celle d'AutoCAD : périphérique PDF, format et orientation, zone de tracé
// (présentation, étendue, affichage, fenêtre), échelle, table de styles de tracé (CTB, ou STB pour un dessin en styles
// nommés : modifier, créer, importer, exporter), options (styles de tracé, épaisseurs, transparence, cadre), aperçu.
import { allFormats, SCALES, describePlot } from '../layout/sheet.js';
import { allTables, findTable, emptyTable, emptyStb, isStb, parseCtb, saveUserTable, writeCtb, deleteUserTable } from './styles.js';
import { openCtbEditor } from './ctb-editor.js';
import { plotPdf } from '../io/pdf.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Réglages de tracé de l'espace objet (gardés dans le dessin) et d'une présentation (sa mise en page).
export const MODEL_DEFAULTS = { paper: 'A3', landscape: true, zone: 'Etendue', scale: 0, ctb: 'monochrome.ctb', useStyles: true, lineweights: true, transparency: true, frame: true };
export const ctbOfSheet = (sh) => (sh?.ctb !== undefined ? sh.ctb : sh?.mono === false ? '' : 'monochrome.ctb');

let dlg = null, previewUrl = null;

// deps : { editor, renderer, doc(), sheetFor(spaceId), spaceLabel(spaceId), saveSheet(spaceId, props), download(blob, name),
//          baseName(), pickWindow() → Promise<box|null>, pageSetup(spaceId) }
export function openPlotDialog(deps) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'plot-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const doc = deps.doc();
  const space = doc.currentSpace || 'model';
  const layout = space !== 'model';
  const sheet = layout ? deps.sheetFor(space) : null;
  const st = layout
    ? { zone: 'Presentation', scale: 0, paper: sheet.paper, landscape: sheet.w >= sheet.h, ctb: ctbOfSheet(sheet), useStyles: sheet.useStyles !== false, lineweights: sheet.lineweights !== false, transparency: true, frame: false }
    : { ...MODEL_DEFAULTS, ...(doc.header?.plotModel || {}) };
  st.window = null;
  // Dessin en styles nommés : tables STB seulement (et inversement), comme AutoCAD.
  const named = doc.header?.pstylemode === 0;
  const ext = named ? '.stb' : '.ctb';
  if (st.ctb && isStb({ name: st.ctb }) !== named) st.ctb = `monochrome${ext}`;

  // Options de plotPdf selon les réglages.
  const options = () => {
    const table = st.useStyles ? findTable(st.ctb) : null;
    const base = { styles: table, lineweights: st.lineweights, transparency: st.transparency, title: layout ? deps.spaceLabel(space) : deps.baseName() };
    if (layout && st.zone === 'Presentation') return { ...base, sheet: deps.sheetFor(space), mono: false };
    const r = deps.renderer;
    let box;
    if (st.zone === 'Fenetre' && st.window) box = st.window;
    else if (st.zone === 'Affichage') {
      const [x0, y0] = r.toWorld(0, r.height), [x1, y1] = r.toWorld(r.width, 0);
      box = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
    } else box = r.robustExtents();
    return { ...base, paper: st.paper, landscape: st.landscape, box, scale: st.scale > 0 ? st.scale : null, mono: false, frame: st.frame };
  };

  const render = (preview = '') => {
    const tables = [...allTables().values()].filter((t) => isStb(t) === named);
    const fmts = Object.keys(allFormats());
    const zones = layout ? [['Presentation', 'Présentation (feuille)'], ['Etendue', 'Étendue'], ['Affichage', 'Affichage'], ['Fenetre', 'Fenêtre']]
      : [['Etendue', 'Étendue'], ['Affichage', 'Affichage'], ['Fenetre', 'Fenêtre']];
    const onSheet = layout && st.zone === 'Presentation';
    const cur = findTable(st.ctb);
    dlg.innerHTML = `<h2>Tracer — ${layout ? `présentation « ${esc(deps.spaceLabel(space))} »` : 'espace objet'}</h2>
      <div class="plot-layout"><div class="plot-form">
        <div class="ps-grid">
          <label>Imprimante / traceur <select disabled><option>PDF vectoriel</option></select></label>
          ${onSheet ? `<label>Feuille (mise en page) <span class="plot-sheet">${esc(describePlot(sheet))} <button class="btn small" data-act="setup">Mise en page…</button></span></label>`
    : `<label>Format <select data-k="paper">${fmts.map((f) => `<option ${f === st.paper ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label>Orientation <select data-k="landscape"><option value="1" ${st.landscape ? 'selected' : ''}>Paysage</option><option value="0" ${st.landscape ? '' : 'selected'}>Portrait</option></select></label>`}
          <label>Zone de tracé <select data-k="zone">${zones.map(([v, l]) => `<option value="${v}" ${v === st.zone ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${st.zone === 'Fenetre' ? `<label>Fenêtre <span><button class="btn small" data-act="window">Choisir dans le dessin…</button> ${st.window ? '✓' : '<span class="del">à choisir</span>'}</span></label>` : ''}
          <label>Échelle <select data-k="scale" ${onSheet ? 'disabled' : ''}>${onSheet ? '<option>1:1 (feuille)</option>' : `<option value="0" ${!st.scale ? 'selected' : ''}>Ajuster au format</option>${SCALES.map((n) => `<option value="${n}" ${n === st.scale ? 'selected' : ''}>1:${n}</option>`).join('')}`}</select></label>
        </div>
        <div class="section-title">Table de styles de tracé ${named ? 'nommés (STB : style par calque ou par objet)' : '(CTB : style par couleur)'}</div>
        <div class="fond-row"><select data-k="ctb"><option value="" ${!st.ctb ? 'selected' : ''}>Aucune (couleurs des objets)</option>${tables.map((t) => `<option value="${esc(t.name)}" ${t.name.toLowerCase() === String(st.ctb).toLowerCase() ? 'selected' : ''}>${esc(t.name)}${t.builtin ? '' : ' ★'}</option>`).join('')}</select>
          <button class="btn small" data-act="edit" ${cur ? '' : 'disabled'} title="Modifier la table (une table intégrée se modifie en copie)">Modifier…</button>
          <button class="btn small" data-act="new">Nouvelle…</button>
          <button class="btn small" data-act="import" title="Importer un fichier ${ext} d’AutoCAD">Importer ${ext}…</button>
          <button class="btn small" data-act="export" ${cur ? '' : 'disabled'} title="Enregistrer la table en ${ext} pour AutoCAD">Exporter ${ext}</button>
          ${cur && !cur.builtin ? '<button class="btn small" data-act="delete">Supprimer</button>' : ''}</div>
        ${cur ? `<p class="muted">${esc(cur.description || '')}</p>` : ''}
        <div class="section-title">Options</div>
        <div class="plot-opts">
          <label><input type="checkbox" data-k="useStyles" ${st.useStyles ? 'checked' : ''}> Tracer avec les styles de tracé</label>
          <label><input type="checkbox" data-k="lineweights" ${st.lineweights ? 'checked' : ''}> Tracer les épaisseurs de ligne</label>
          <label><input type="checkbox" data-k="transparency" ${st.transparency ? 'checked' : ''}> Tracer la transparence</label>
          ${onSheet ? '' : `<label><input type="checkbox" data-k="frame" ${st.frame ? 'checked' : ''}> Cadre et cartouche</label>`}
        </div>
      </div>
      <div class="plot-preview">${preview || '<div class="muted plot-empty">Aperçu : bouton « Aperçu ».</div>'}</div></div>
      <div class="qto-actions"><button class="btn" data-act="preview">Aperçu</button>
        <button class="btn" data-act="apply" title="${layout ? 'Enregistrer table et options dans la mise en page de la présentation' : 'Garder ces réglages pour l’espace objet de ce dessin'}">Appliquer ${layout ? 'à la présentation' : 'au dessin'}</button>
        <button class="btn primary" data-act="plot">Tracer</button><button class="btn" data-act="close">Annuler</button></div>`;
  };

  const apply = () => {
    if (layout) deps.saveSheet(space, { ctb: st.ctb, useStyles: st.useStyles, lineweights: st.lineweights, mono: /^monochrome\./i.test(st.ctb) });
    else {
      const { window, ...keep } = st;
      doc.header.plotModel = keep; // réglage de l'espace objet : conservé dans le dessin (pas une modification annulable)
    }
  };
  const fileName = () => `${deps.baseName()}${layout ? ` - ${deps.spaceLabel(space)}` : ''}.pdf`;

  dlg.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'setup') { dlg.close(); deps.pageSetup(space); return; }
    if (act === 'window') {
      dlg.close();
      const box = await deps.pickWindow();
      if (box) st.window = box;
      render();
      dlg.showModal();
      return;
    }
    if (act === 'edit' || act === 'new') {
      const t = act === 'new' ? (named ? emptyStb('Nouvelle table.stb', '') : emptyTable('Nouvelle table.ctb', '')) : findTable(st.ctb);
      openCtbEditor(t, { download: deps.download, onSave: (saved) => { st.ctb = saved.name; render(); } });
      return;
    }
    if (act === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ctb,.stb';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        try {
          const t = await parseCtb(await f.arrayBuffer(), f.name);
          saveUserTable(t);
          if (isStb(t) === named) st.ctb = t.name;
          deps.editor.print(`Table de styles « ${t.name} » importée.${isStb(t) !== named ? ` Ce dessin est en styles ${named ? 'nommés (tables .stb)' : 'dépendant de la couleur (tables .ctb)'} : CONVSTYLESTRACE change de mode.` : ''}`);
        } catch (err) { deps.editor.print(`Import impossible : ${err.message}`); }
        render();
      };
      input.click();
      return;
    }
    if (act === 'export') {
      const t = findTable(st.ctb);
      if (t) deps.download(new Blob([await writeCtb(t)], { type: 'application/octet-stream' }), t.name);
      return;
    }
    if (act === 'delete') { deleteUserTable(st.ctb); st.ctb = `monochrome${ext}`; render(); return; }
    if (act === 'apply') { apply(); deps.editor.print('Réglages de tracé appliqués.'); return; }
    if (st.zone === 'Fenetre' && !st.window) { deps.editor.print('Choisissez d’abord la fenêtre à tracer.'); return; }
    if (act === 'preview' || act === 'plot') {
      const r = await plotPdf(deps.renderer, deps.doc(), options());
      if (act === 'preview') {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(r.blob);
        render(`<iframe class="plot-frame" src="${previewUrl}" title="Aperçu du tracé"></iframe>`);
      } else {
        apply();
        dlg.close();
        deps.download(r.blob, fileName());
        deps.editor.print(`PDF créé : ${fileName()} (${r.segments} traits, ${r.texts} textes${st.useStyles && st.ctb ? `, styles ${st.ctb}` : ''}).`);
      }
    }
  };
  dlg.onchange = (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'landscape') st.landscape = v === '1';
    else if (k === 'scale') st.scale = +v;
    else st[k] = v;
    render();
  };
  render();
  if (!dlg.open) dlg.showModal();
}
