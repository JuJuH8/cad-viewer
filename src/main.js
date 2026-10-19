// SPDX-License-Identifier: GPL-3.0-or-later
// Application : relie le document, le rendu, l'éditeur, les panneaux et la ligne de commande.
import { ucsOf, toUcs } from './core/ucs.js';
import { Document } from './core/document.js';
import { describeVersion, readDrawingAsync, prewarmReaders } from './dwg-loader.js';
import { suggestCommands } from './editor/suggest.js';
import { createPalette } from './ui/palette.js';
import { importDatabase } from './io/importer.js';
import { Renderer } from './render/renderer.js';
import { Editor, fmt, setDisplayPrecision } from './editor/editor.js';
import { registerCommands } from './editor/commands.js';
import { registerMepCommands } from './mep/commands.js';
import { registerDimCommands } from './editor/dims.js';
import { LayerPanel, PropertiesPanel } from './ui/panels.js';
import { writeDxf, dxfFileName } from './io/dxf-writer.js';
import { renderRibbon, RIBBON } from './ui/ribbon.js';
import { saveAutosave, loadAutosave, deserialize } from './io/autosave.js';
import { missingXrefs, matchXref, attachXref } from './io/xref.js';
import { plotPdf, plotPages, PAPERS } from './io/pdf.js';
import { registerFondCommands } from './archi/commands.js';
import { registerElecCommands } from './elec/commands.js';
import { renderSpaceTabs, openPageSetup } from './layout/ui.js';
import { installMspace } from './layout/mspace.js';
import { openViewportLayers } from './layout/vplayers.js';
import { XrefPanel } from './ui/xrefs.js';
import { installDock } from './ui/dock.js';
import { installToolbar3d } from './ui/toolbar3d.js';
import { installContextMenu } from './ui/context-menu.js';
import { unitMmOf as unitMmOfDoc } from './mep/network.js';
import { openSettings, applyPrefs } from './ui/settings.js';
import { BlockEditorSession } from './blocks/block-editor.js';
import { registerBlockCommands } from './blocks/commands.js';
import { registerExtractCommands } from './blocks/extract-dialog.js';
import { renderBlockBar, openVisStates, openBlockParams, openLookupTable, showVisibilityMenu } from './blocks/ui.js';
import { openInsertDialog } from './blocks/insert-dialog.js';
import { openPlotDialog } from './plot/dialog.js';
import { findTable } from './plot/styles.js';
import { sheetOf, describePlot } from './layout/sheet.js';
import { registerUnderlayCommands } from './underlay/commands.js';
import { registerHatchCommands } from './hatch/commands.js';
import { registerClipCommands } from './editor/xclip.js';
import { registerWipeoutCommands } from './editor/wipeout.js';
import { registerUcsCommands } from './editor/ucs.js';
import { registerFieldCommands } from './editor/field-commands.js';
import { installFieldHooks, updateFields } from './core/fields.js';
import { registerLayerStateCommands } from './ui/layerstates.js';
import { openHatchDialog } from './hatch/dialog.js';
import { openAttachDialog, pickFile } from './underlay/dialog.js';
import { setSourceLoader, sourceKey, retryMissingSources, onSourceChange } from './underlay/sources.js';
import { fileName as baseName } from './underlay/underlay.js';
import { readSource, storeHandle } from './archi/sources.js';
import { installIfc3d } from './archi/ifc3d.js';
import { fondInserts } from './archi/fonds.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = new Intl.NumberFormat('fr-FR');

const renderer = new Renderer($('view'));
let doc = null;
let fileName = 'Nouveau dessin';

const cmdInput = $('cmd-input');
const history = $('cmd-history');

const editor = new Editor(renderer, {
  print(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    history.appendChild(line);
    while (history.childNodes.length > 300) history.firstChild.remove();
    history.scrollTop = history.scrollHeight;
  },
  prompt(text, keywords) {
    let html = esc(text);
    for (const k of keywords) html = html.replace(esc(k), `<span class="kw" data-kw="${esc(k)}">${esc(k)}</span>`);
    $('cmd-prompt').innerHTML = html;
  },
  onSelection() { props.render(); },
  onState() { renderToggles(); renderRibbonState(); },
  // Coordonnées du curseur dans le SCU courant.
  onCursor(c) { const q = toUcs(ucsOf(doc), c.world); $('coords').textContent = `${fmt(q[0])}, ${fmt(q[1])}`; },
  onEdit(id) {
    // Champ le plus utile selon le type d'objet ; bloc sans attribut : éditeur de blocs (comme AutoCAD).
    const e = doc.get(id);
    const blk = e?.type === 'INSERT' && !e.elec && !e.mep ? doc.blocks.get(e.name) : null;
    if (blk && !blk.xref && !blk.fond && !e.attribs?.length && !doc.blockEdit) { openBlockEditor(e.name); return; }
    if (e?.type === 'INSERT' && e.attribs?.length) {
      setTimeout(() => { const input = document.querySelector('#props [data-f="attr:0"]'); if (input) { input.focus(); input.select?.(); } }, 0);
      return;
    }
    const field = e?.mep ? (e.mep.kind === 'pipe' || e.mep.shape === 'round' ? 'mepD' : 'mepW')
      : e?.type === 'TEXT' || e?.type === 'MTEXT' ? 'text' : e?.type === 'CIRCLE' || e?.type === 'ARC' ? 'r' : null;
    setTimeout(() => {
      const input = field && document.querySelector(`#props [data-f="${field}"]`);
      if (input) { input.focus(); input.select?.(); }
    }, 0);
  },
  focus() { if (document.activeElement !== cmdInput) cmdInput.focus({ preventScroll: true }); },
  // Liste des espaces modifiée (nouvelle présentation) : on la redessine et on passe à `id`.
  onSpaces(id) { renderSpaces(); if (id) switchSpace(id); },
});
registerCommands(editor);
registerHatchCommands(editor, { hatchDialog: (o) => openHatchDialog(o) });
registerClipCommands(editor);
registerWipeoutCommands(editor);
registerUcsCommands(editor);
registerFieldCommands(editor);
registerMepCommands(editor);
registerDimCommands(editor);
// Électricité : une bibliothèque DWG de symboles de l'utilisateur est lue comme un dessin, sans l'ouvrir.
const elec = registerElecCommands(editor, {
  async loadDocument(buffer, name) { return importDatabase(await readDrawingAsync(buffer, name)).doc; },
  // Palette des symboles dans le panneau latéral « Symboles » (gestionnaire de panneaux créé plus bas).
  panels: { show: (id) => dock.show(id), hide: (id) => dock.hide(id), isOpen: (id) => dock.isOpen(id) },
});
// Fonds de plan (bases architecte) : lecture d'un dessin en document, sans l'ouvrir.
const fonds = registerFondCommands(editor, {
  async loadDocument(buffer, name, opts = {}) {
    if (/\.ifc$/i.test(name)) {
      const { ifcToDocument } = await import('./archi/ifc.js');
      return ifcToDocument(buffer, { ...(opts.ifc || {}), chooseStorey: opts.ifc ? null : opts.chooseStorey });
    }
    const db = await readDrawingAsync(buffer, name);
    return importDatabase(db).doc;
  },
  busy: (text) => busy(text),
});
// Fonds PDF et images (ATTACHER) : fichiers lus par leur chemin (serveur de l'appli), par la poignée gardée par le
// navigateur, ou à côté du dessin.
let drawingDir = null; // dossier du dessin ouvert (URL), pour les fonds en chemin relatif
const handleKey = (path) => `fond-joint:${sourceKey(baseName(path))}`;
setSourceLoader(async (path) => {
  const clean = String(path).replace(/^\.[\\/]/, '');
  if (/^([a-z]:[\\/]|\\\\)/i.test(clean)) {
    try { return (await readSource({ kind: 'path', path: clean })).buffer; } catch { /* essai suivant */ }
  }
  try { return (await readSource({ kind: 'handle', key: handleKey(clean) })).buffer; } catch { /* essai suivant */ }
  if (drawingDir) {
    const r = await fetch(`${drawingDir}${encodeURIComponent(baseName(clean))}`).catch(() => null);
    if (r?.ok) return r.arrayBuffer();
  }
  return null;
});
registerUnderlayCommands(editor, {
  attachDialog: (o) => openAttachDialog({
    ...o, layers: [...doc.layers.keys()].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })), currentLayer: doc.currentLayer,
    storeHandle: (path, handle) => storeHandle(handleKey(path), handle).catch(() => {}),
  }),
  changed: () => xrefs.render(),
});

// Panneau « Références » (fonds de plan et xrefs), à côté des calques.
onSourceChange(() => { xrefs.render(); props.render(); }); // fond PDF / image chargé ou introuvable
// Panneaux Calques, Références, Propriétés : ancrés, flottants ou masqués automatiquement.
const dock = installDock();
// Outils de la vue 3D : boîte et plans de coupe, mesures, filtres.
const tools3d = installToolbar3d({ renderer, editor, unitM: () => unitMmOfDoc(doc) / 1000 });
// Maquettes IFC des fonds en volumes dans la vue 3D (niveau du plan, ou tout le bâtiment).
renderer.ifc3dManager = installIfc3d(renderer, {
  getDoc: () => doc,
  getBuffer: (name) => fonds.ifcBuffer(name),
  insertOf: (name) => { const e = fondInserts(doc, name)[0]; return e ? { p: e.p, sx: e.sx, rot: e.rot } : null; },
  options: () => ({ show: tools3d.filter.ifc && !tools3d.isolate, all: tools3d.filter.ifcAll }),
  print: (m) => editor.print(m),
});
renderer.modeListeners.push(() => renderer.ifc3dManager.refresh());
// Clic droit dans le dessin (sans commande) : menu contextuel.
installContextMenu({ editor, showProps: () => dock.show('props') });
editor.register('PANNEAUXDEFAUT', () => dock.reset(), { aliases: ['RESETPANNEAUX'], label: 'PANNEAUXDEFAUT', transaction: false });

const xrefs = new XrefPanel({
  editor, fonds, busy: (text) => busy(text), loadXrefFiles: () => $('xref-input').click(),
  // Fond PDF / image introuvable : fichier choisi sur le disque (poignée gardée pour les prochaines ouvertures).
  pickUnderlayFile: async (path) => {
    const r = await pickFile();
    if (r?.handle) storeHandle(handleKey(path), r.handle).catch(() => {});
    return r;
  },
});

// --- éditeur de blocs et blocs dynamiques -----------------------------------------------------------
const blockSession = new BlockEditorSession({ editor, renderer, getDoc: () => doc, setDoc: setEditDocument });
registerBlockCommands(editor, blockSession);
registerExtractCommands(editor);
const readDocument = async (buffer, name) => importDatabase(await readDrawingAsync(buffer, name)).doc;
const refreshBlockBar = () => renderBlockBar($('view'), blockSession, editor);
function openBlockEditor(name) {
  try {
    editor.cancel();
    editor.setSelection([]);
    blockSession.open(name);
    editor.print(`Éditeur de blocs : « ${name} » (barre en haut du dessin ; BENREG pour enregistrer, BFERMER pour sortir).`);
  } catch (err) { editor.print(`Impossible d’ouvrir le bloc : ${err.message}`); }
}
editor.ui.openInsert = () => openInsertDialog(editor, { loadDocument: readDocument, editBlock: openBlockEditor });
registerLayerStateCommands(editor, { loadDocument: readDocument });
editor.ui.openVisStates = () => openVisStates(blockSession, refreshBlockBar, editor);
editor.ui.openLookup = (id) => openLookupTable(blockSession, id, refreshBlockBar);
editor.ui.openBlockParams = () => openBlockParams(blockSession, refreshBlockBar, editor.ui.openLookup);
editor.ui.onDynMenu = (id, param, pos) => showVisibilityMenu(doc, id, param, pos, renderer.canvas);

// Dessin affiché remplacé par le dessin de travail de l'éditeur de blocs, puis rétabli (vue, espace, sélection).
function setEditDocument(d, info = {}) {
  doc = d;
  renderer.setDocument(d);
  editor.setDocument(d);
  renderer.setSheet(null);
  if (info.blockEditor) {
    d.on(scheduleRefresh);
    d.on(refreshBlockBar);
    setTheme(modelTheme);
    $('space-tabs').innerHTML = `<span class="space-tab active">Éditeur de blocs — ${esc(blockSession.name)}</span>`;
  } else {
    switchSpace(info.space || 'model');
    if (info.view) {
      Object.assign(renderer.center, info.view.center);
      renderer.scale = info.view.scale;
      renderer.autoFit = false;
      renderer.requestRender(true);
    }
    if (info.selection) editor.setSelection(info.selection.filter((id) => d.get(id)));
  }
  refreshBlockBar();
  layers.recount();
  layers.render();
  props.render();
  xrefs.render();
  renderStats();
}

// Dans l'éditeur de blocs, le dessin affiché n'est qu'un bloc : enregistrer et tracer attendent sa fermeture.
const outsideBlockEditor = (ctx) => {
  if (!ctx.doc.blockEdit) return true;
  ctx.print('Éditeur de blocs ouvert : enregistrez le bloc (BENREG) et fermez l’éditeur (BFERMER) avant d’enregistrer ou de tracer le dessin.');
  return false;
};
// Avant l'enregistrement : date d'enregistrement et nom du fichier dans les champs (sans historique).
function fieldsBeforeSave(d, name) {
  const saveDate = new Date();
  d.header = { ...(d.header || {}), saveDate: saveDate.toISOString() };
  d.fileName = name;
  updateFields(d, { saveDate, fileName: name }, { quiet: true });
}
editor.register('ENREGDXF', (ctx) => {
  if (!outsideBlockEditor(ctx)) return;
  const t0 = performance.now();
  const name = dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName);
  fieldsBeforeSave(ctx.doc, name);
  const text = writeDxf(ctx.doc);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/dxf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  ctx.print(`Enregistré : ${name} (${(text.length / 1024).toFixed(0)} Ko, ${(performance.now() - t0).toFixed(0)} ms).`);
}, { aliases: ['SAVEDXF', 'DXFOUT', 'ENREG'], label: 'ENREGDXF', transaction: false });

// Export IFC4 des réseaux MEP et de l'électricité (coordination BIM : Revit, Navisworks).
editor.register('EXPORTIFC', async (ctx) => {
  const { writeIfc } = await import('./io/ifc-writer.js');
  // Même nom de projet que l'export BCF des interférences : mêmes GlobalId, les points de vue désignent ces éléments.
  const base = (ctx.doc.fileName || 'dessin').replace(/\.[^.]+$/, '');
  const r = writeIfc(ctx.doc, { project: base });
  if (!r.elements) { ctx.print('Aucun réseau ni appareil électrique à exporter.'); return; }
  const blob = new Blob([r.text], { type: 'application/x-step' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${base}.ifc`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  ctx.print(`IFC créé : ${base}.ifc (${r.elements} éléments : ${Object.entries(r.counts).map(([k, n]) => `${n} ${k.replace(/^IFC/, '').toLowerCase()}`).join(', ')}).`);
}, { aliases: ['IFCOUT', 'EXPORTERIFC'], label: 'EXPORTIFC', transaction: false });

// Tracé PDF vectoriel (format, orientation, zone, échelle, noir ou couleurs).
const plotLast = { paper: 'A3', orient: 'Paysage', zone: 'Affichage', scale: 'Ajuster', colors: 'Noir', weights: 'Objets' };
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// TRACER : boîte de tracé (styles de tracé, aperçu) ; -TRACER : questions en ligne de commande.
let zoneResolve = null;
editor.register('ZONETRACE', async (ctx) => {
  try {
    const a = await ctx.getPoint('Premier coin de la zone à tracer');
    const b = await ctx.getPoint('Coin opposé', { base: a });
    zoneResolve?.({ minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  } catch (err) { zoneResolve?.(null); throw err; } finally { zoneResolve = null; }
}, { label: 'ZONETRACE', transaction: false });
editor.register('TRACER', (ctx) => {
  if (!outsideBlockEditor(ctx)) return;
  openPlotDialog({
    editor, renderer, doc: () => doc,
    sheetFor, spaceLabel: (id) => spaceOf(id)?.label || id,
    saveSheet: (id, props) => { const { derived, ...cur } = sheetFor(id); doc.transaction('Mise en page', () => doc.updateSpace(id, { plot: { ...cur, ...props } })); },
    download: downloadBlob,
    baseName: () => (fileName === 'Nouveau dessin' ? 'dessin' : fileName.replace(/\.(dwg|dxf)$/i, '')),
    pickWindow: () => new Promise((res) => { zoneResolve = res; editor.run('ZONETRACE'); }),
    pageSetup: (id) => spaceHandlers.pageSetup(id),
  });
}, { aliases: ['PLOT', 'IMPRIMER', 'PDF'], label: 'TRACER', transaction: false });

editor.register('-TRACER', async (ctx) => {
  if (!outsideBlockEditor(ctx)) return;
  // Présentation : sa mise en page (feuille, marges, style de tracé), au 1:1, comme AutoCAD.
  const space = ctx.doc.currentSpace || 'model';
  if (space !== 'model') {
    const sheet = sheetFor(space);
    const k = await ctx.getKeyword(`Tracé de « ${spaceOf(space).label} » — ${describePlot(sheet)}, ${sheet.mono !== false ? 'noir' : 'couleurs'}`, ['Tracer', 'Miseenpage'], { default: 'Tracer' });
    if (k === 'Miseenpage') { spaceHandlers.pageSetup(space); return; }
    await busy('Tracé PDF…');
    try {
      const r = await plotPdf(renderer, ctx.doc, { sheet, mono: sheet.mono !== false, lineweights: sheet.lineweights !== false, title: spaceOf(space).label });
      const name = dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName).replace(/\.dxf$/i, ` - ${spaceOf(space).label}.pdf`);
      downloadBlob(r.blob, name);
      ctx.print(`PDF créé : ${name} (${r.segments} traits, ${r.texts} textes, feuille ${describePlot(sheet)}).`);
    } finally {
      busy(null);
    }
    return;
  }
  const paper = await ctx.getKeyword('Format', Object.keys(PAPERS), { default: plotLast.paper });
  const orient = await ctx.getKeyword('Orientation', ['Paysage', 'Portrait'], { default: plotLast.orient });
  const zone = await ctx.getKeyword('Zone à tracer', ['Affichage', 'Fenêtre', 'Étendue'], { default: plotLast.zone });
  let box;
  if (zone === 'Fenêtre') {
    const a = await ctx.getPoint('Premier coin');
    const b = await ctx.getPoint('Coin opposé', { base: a });
    box = { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
  } else if (zone === 'Étendue') {
    box = renderer.extents;
  } else {
    const [x0, y0] = renderer.toWorld(0, renderer.height), [x1, y1] = renderer.toWorld(renderer.width, 0);
    box = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
  const sc = await ctx.getString('Échelle (Ajuster, ou N pour 1:N)', { default: plotLast.scale });
  const n = parseFloat(String(sc).replace(/^1\s*:\s*/, '').replace(',', '.'));
  const colors = await ctx.getKeyword('Couleurs', ['Noir', 'Couleur'], { default: plotLast.colors });
  const weights = await ctx.getKeyword('Épaisseurs (Objets : épaisseurs des objets et calques ; Fines : tout en trait fin)', ['Objets', 'Fines'], { default: plotLast.weights });
  Object.assign(plotLast, { paper, orient, zone, scale: sc, colors, weights });
  await busy('Tracé PDF…');
  try {
    const title = fileName === 'Nouveau dessin' ? 'Dessin' : fileName;
    const r = await plotPdf(renderer, ctx.doc, { paper, landscape: orient === 'Paysage', box, scale: n > 0 ? n : null, mono: colors === 'Noir', title, lineweights: weights === 'Objets' });
    const name = dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName).replace(/\.dxf$/i, '.pdf');
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.print(`PDF créé : ${name} (${r.segments} traits, ${r.texts} textes, échelle ≈ 1:${Math.round(r.scale)}).`);
  } finally {
    busy(null);
  }
}, { aliases: ['-PLOT'], label: '-TRACER', transaction: false });

// Mode des styles de tracé du dessin (comme CONVERTPSTYLES) : dépendant de la couleur (tables CTB) ↔ styles nommés
// (tables STB, style choisi par calque ou par objet). Vers les styles nommés, chaque calque prend « Normal » ; vers les
// couleurs, les styles des calques et des objets sont retirés. Les tables de tracé suivent (monochrome, acad).
editor.register('CONVSTYLESTRACE', async (ctx) => {
  const d = ctx.doc;
  const named = d.header?.pstylemode === 0;
  const k = await ctx.getKeyword(`Dessin en styles ${named ? 'nommés (STB)' : 'dépendant de la couleur (CTB)'} : convertir en styles ${named ? 'dépendant de la couleur' : 'nommés'} ?`, ['Oui', 'Non'], { default: 'Oui' });
  if (k !== 'Oui') return;
  const ext = named ? '.ctb' : '.stb';
  const swap = (name) => (!name ? name : /^(acad|monochrome)\./i.test(name) ? name.replace(/\.(ctb|stb)$/i, ext) : `monochrome${ext}`);
  d.setHeader({ pstylemode: named ? 1 : 0, ...(d.header.plotModel ? { plotModel: { ...d.header.plotModel, ctb: swap(d.header.plotModel.ctb) } } : {}) });
  for (const l of [...d.layers.values()]) d.setLayer(l.name, { pstyle: named ? undefined : 'Normal' });
  if (named) for (const e of [...d.entities.values()]) if (e.pstyle) { const c = structuredClone(e); delete c.pstyle; d.update(c); }
  for (const sp of d.spaces) if (sp.plot?.ctb) d.updateSpace(sp.id, { plot: { ...sp.plot, ctb: swap(sp.plot.ctb) } });
  ctx.print(`Dessin converti en styles de tracé ${named ? 'dépendant de la couleur (tables .ctb)' : 'nommés (tables .stb) : style « Normal » sur chaque calque, à changer dans le gestionnaire des calques ou les Propriétés'}.`);
}, { aliases: ['CONVERTPSTYLES'], label: 'CONVSTYLESTRACE' });

// Enregistrement DWG : le serveur local fait convertir le DXF par AutoCAD (s'il est installé).
// PUBLIER : toutes les présentations dans un seul PDF, une page chacune selon sa mise en page (feuille au 1:1).
editor.register('PUBLIER', async (ctx) => {
  if (!outsideBlockEditor(ctx)) return;
  const layouts = ctx.doc.spaces.filter((sp) => sp.id !== 'model');
  if (!layouts.length) { ctx.print('Aucune présentation : utilisez TRACER pour l’espace objet (ou PRESENTATION pour en créer une).'); return; }
  await busy('Publication PDF…');
  try {
    const base = fileName === 'Nouveau dessin' ? 'Dessin' : fileName;
    const pages = layouts.map((sp) => {
      const sheet = sheetFor(sp.id);
      return { space: sp.id, sheet, mono: sheet.mono !== false, lineweights: sheet.lineweights !== false, title: `${base} — ${sp.label}` };
    });
    const view = { center: { ...renderer.center }, scale: renderer.scale };
    const r = await plotPages(renderer, ctx.doc, pages);
    Object.assign(renderer.center, view.center);
    renderer.scale = view.scale;
    renderer.requestRender(true);
    const name = dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName).replace(/\.dxf$/i, ' - jeu de plans.pdf');
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.print(`Jeu de plans : ${r.pages.length} page(s) — ${name}.`);
  } finally {
    busy(null);
  }
}, { aliases: ['PUBLISH', 'PUB'], label: 'PUBLIER', transaction: false });

editor.register('ENREGDWG', async (ctx) => {
  if (!outsideBlockEditor(ctx)) return;
  const t0 = performance.now();
  ctx.print('Conversion en DWG par AutoCAD…');
  await busy('Enregistrement DWG (AutoCAD)…');
  try {
    fieldsBeforeSave(ctx.doc, dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName).replace(/\.dxf$/i, '.dwg'));
    const res = await fetch('__dwg', { method: 'POST', body: writeDxf(ctx.doc) });
    if (!res.ok) {
      ctx.print(res.status === 501
        ? 'Enregistrement DWG indisponible : AutoCAD n’est pas installé sur cette machine. Utilisez ENREGDXF.'
        : `Échec de l’enregistrement DWG : ${await res.text()}`);
      return;
    }
    const blob = await res.blob();
    const name = dxfFileName(fileName === 'Nouveau dessin' ? 'dessin' : fileName).replace(/\.dxf$/i, '.dwg');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.print(`Enregistré : ${name} (DWG 2018, ${(blob.size / 1024).toFixed(0)} Ko, ${((performance.now() - t0) / 1000).toFixed(1)} s).`);
  } catch (err) {
    ctx.print(`Échec de l’enregistrement DWG : ${err.message}`);
  } finally {
    busy(null);
  }
}, { aliases: ['SAVEDWG', 'DWGOUT'], label: 'ENREGDWG', transaction: false });

const layers = new LayerPanel({
  getDoc: () => doc, renderer, onCurrent: () => props.render(),
  onSelectLayer: (name) => {
    const ids = [...doc.entities.values()].filter((e) => e.layer === name && e.space === renderer.space && renderer.selectable(e.id)).map((e) => e.id);
    editor.setSelection(ids);
    editor.print(`${ids.length} objet(s) du calque « ${name} » sélectionné(s).`);
  },
  onManageStates: () => editor.run('ETATCALQUE'),
});
const props = new PropertiesPanel({
  getDoc: () => doc, getSelection: () => [...editor.selection],
  onAction(act, ids) {
    if (act === 'vplayers' && doc.get(ids[0])?.type === 'VIEWPORT') openViewportLayers(doc, ids[0], { foreground: renderer.theme.foreground });
    if (act === 'hatchedit' && doc.get(ids[0])?.type === 'HATCH') editor.run('HACHEDIT');
    if (act === 'xclip' && doc.get(ids[0])?.type === 'INSERT') editor.run('DECOUPXREF');
    const fond = { ulLayers: 'CALQUESFOND', ulClip: 'DECOUPFOND', ulImport: 'PDFIMPORT' }[act];
    if (fond && doc.get(ids[0])?.type === 'UNDERLAY') editor.run(fond);
  },
});

// --- document ------------------------------------------------------------------

let refreshTimer = null;
function scheduleRefresh() {
  if (doc?.entities.size) $('drop-hint').hidden = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    layers.recount();
    layers.render();
    props.render();
    xrefs.render();
    renderStats();
    renderer.ifc3dManager?.refresh();
  }, 60);
}

// --- sauvegarde automatique ----------------------------------------------------------

let dirty = false;
async function autosave(force = false) {
  if (!doc || doc.blockEdit || (!dirty && !force) || !doc.entities.size) return;
  dirty = false;
  try {
    await saveAutosave(doc, fileName);
    const t = new Date();
    $('autosave').textContent = `Sauvegarde auto ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  } catch (err) {
    console.warn('Sauvegarde automatique impossible :', err);
  }
}
setInterval(autosave, 60000);
window.addEventListener('pagehide', () => autosave());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave(); });

async function offerRecovery() {
  const rec = await loadAutosave();
  if (!rec || !rec.count) return;
  const box = $('recover');
  const date = new Date(rec.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  box.innerHTML = `<span><strong>Dessin récupérable</strong> : « ${esc(rec.name)} », ${rec.count} objet(s), sauvegardé le ${date}.</span>
    <button class="btn primary" data-act="restore">Récupérer</button><button class="btn" data-act="dismiss">Ignorer</button>`;
  box.hidden = false;
  box.onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'restore') {
      setDocument(deserialize(rec.data), `${rec.name}`);
      editor.print(`Dessin récupéré (${rec.count} objets).`);
    }
    if (act) box.hidden = true;
  };
}

function setDocument(d, name, info = {}) {
  editor.ui.mspace?.abort(); // travail dans une fenêtre de l'ancien dessin : abandonné
  if (blockSession?.editing) { blockSession.active = null; renderer.overlayDrawers = []; }
  doc = d;
  dirty = false;
  $('recover').hidden = true;
  fileName = name;
  // Champs : nom du fichier, recalcul à l'ouverture (sans historique), mise à jour des champs dépendants.
  doc.fileName = name;
  installFieldHooks(doc);
  updateFields(doc, { fileName: name }, { quiet: true });
  doc.currentSpace = 'model';
  doc.on(scheduleRefresh);
  doc.on(() => { dirty = true; });
  doc.on((change) => { if (change.spaces) spacesChanged(); });
  // Précision d'affichage du dessin (LUPREC), suivie aussi à l'annulation.
  setDisplayPrecision(doc.header?.luprec ?? 4);
  doc.on((change) => { if (change.reset) setDisplayPrecision(doc.header?.luprec ?? 4); });
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.setSheet(null);
  renderer.setLwDisplay(!!doc.header?.lwdisplay);
  renderToggles();
  refreshBlockBar();
  renderSpaces();
  setTheme(modelTheme);
  $('file-label').textContent = name;
  $('file-label').title = info.version ? `${name} — ${info.version}` : name;
  $('doc-eyebrow').textContent = info.version ? `CAD Viewer — ${info.version}` : 'CAD Viewer';
  const skipped = info.stats ? [...info.stats.skipped].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`) : [];
  const missing = info.stats ? [...info.stats.missingBlocks] : [];
  const parts = [];
  if (skipped.length) parts.push(`Non importés : ${skipped.join(', ')}`);
  if (missing.length) parts.push(`Blocs absents : ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  $('skipped').textContent = parts.join(' · ');
  $('skipped').title = parts.join('\n');
  $('drop-hint').hidden = doc.entities.size > 0 || name !== 'Nouveau dessin';
  updateXrefButton();
  layers.recount();
  layers.render();
  props.render();
  renderStats(info.timing);
  renderer.ifc3dManager?.refresh();
  editor.print(info.version ? `Ouvert : ${name} (${info.version})` : `Nouveau dessin.`);
}

function newDocument() {
  const d = new Document();
  d.header.insunits = 4; // millimètres
  setDocument(d, 'Nouveau dessin');
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busy-text').textContent = text;
  return new Promise((r) => setTimeout(r, 30));
}

async function openBuffer(buffer, name, dir = null) {
  drawingDir = dir;
  retryMissingSources();
  try {
    await busy('Lecture du fichier…');
    const version = describeVersion(buffer, name);
    const t0 = performance.now();
    const db = await readDrawingAsync(buffer, name);
    const t1 = performance.now();
    await busy('Préparation du dessin…');
    const { doc: d, stats } = importDatabase(db);
    const t2 = performance.now();
    const timing = { read: t1 - t0, import: t2 - t1, view: 0 };
    setDocument(d, name, { version, stats, timing });
    timing.view = performance.now() - t2;
    renderStats(timing);
    // Fonds de plan enregistrés comme références externes : relus depuis leur chemin et retraités.
    if ([...d.blocks.values()].some((b) => b.fond && !b.entities.length)) fonds.loadMissing().then(updateXrefButton);
  } catch (err) {
    console.error(err);
    editor.print(`Impossible d’ouvrir « ${name} » : ${err.message || err}`);
  } finally {
    busy(null);
  }
}

async function openUrl(url) {
  const name = decodeURIComponent(url.split('/').pop());
  await busy('Téléchargement…');
  const res = await fetch(url);
  if (!res.ok) { busy(null); editor.print(`Fichier introuvable : ${url}`); return; }
  await openBuffer(await res.arrayBuffer(), name, url.slice(0, url.lastIndexOf('/') + 1));
  // Références externes : on cherche les fichiers à côté du dessin (même dossier).
  const dir = url.slice(0, url.lastIndexOf('/') + 1);
  for (const xname of missingXrefs(doc)) {
    for (const ext of ['dwg', 'dxf']) {
      const r = await fetch(`${dir}${encodeURIComponent(xname)}.${ext}`).catch(() => null);
      if (r?.ok) { await loadXref(xname, await r.arrayBuffer(), `${xname}.${ext}`); break; }
    }
  }
}

// --- références externes ----------------------------------------------------------

async function loadXref(name, buffer, file) {
  try {
    await busy(`Référence externe « ${name} »…`);
    const xdb = await readDrawingAsync(buffer, file);
    const { doc: xdoc } = importDatabase(xdb);
    const n = attachXref(doc, name, xdoc);
    editor.print(`Référence externe « ${name} » chargée (${n} objets).`);
  } catch (err) {
    editor.print(`Impossible de charger la référence « ${name} » : ${err.message}`);
  } finally {
    busy(null);
    updateXrefButton();
  }
}

function updateXrefButton() {
  xrefs.render();
  const missing = doc ? missingXrefs(doc) : [];
  $('xref-btn').hidden = !missing.length;
  $('xref-btn').title = missing.length ? `Références externes à charger : ${missing.join(', ')}` : '';
  const text = $('skipped').textContent.replace(/ ?·? ?(Blocs absents|Xrefs non chargées) : .*$/, '');
  $('skipped').textContent = missing.length ? `${text}${text ? ' · ' : ''}Xrefs non chargées : ${missing.join(', ')}` : text;
}

$('xref-btn').addEventListener('click', () => $('xref-input').click());
$('xref-input').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const name = matchXref(doc, f.name);
    if (name) await loadXref(name, await f.arrayBuffer(), f.name);
    else editor.print(`« ${f.name} » ne correspond à aucune référence externe manquante.`);
  }
  e.target.value = '';
});

function renderStats(timing) {
  const s = renderer.stats();
  let text = `${int.format(s.entities)} objets · ${int.format(s.segs)} segments · ${int.format(s.texts)} textes · ${s.chunks} paquets`;
  if (timing) text += ` · lecture ${timing.read.toFixed(0)} ms, import ${timing.import.toFixed(0)} ms, vue ${timing.view.toFixed(0)} ms`;
  $('stats').textContent = text;
}

// --- barre d'état et ruban -------------------------------------------------------------

function renderToggles() {
  $('tg-osnap').classList.toggle('on', editor.settings.osnap);
  $('tg-ortho').classList.toggle('on', editor.settings.ortho);
  $('tg-polar').classList.toggle('on', editor.settings.polar);
  $('tg-otrack').classList.toggle('on', editor.settings.otrack);
  $('tg-grid').classList.toggle('on', editor.settings.grid);
  $('tg-snap').classList.toggle('on', editor.settings.snap);
  $('tg-lw').classList.toggle('on', renderer.lwDisplay);
}

function renderRibbonState() {
  const running = editor.running?.cmd.name;
  for (const b of document.querySelectorAll('#ribbon [data-cmd]')) {
    const cmd = editor.findCommand(b.dataset.cmd);
    b.classList.toggle('active', !!running && cmd?.name === running);
  }
}

$('tg-osnap').addEventListener('click', () => editor.toggle('osnap'));
$('tg-ortho').addEventListener('click', () => editor.toggle('ortho'));
$('tg-polar').addEventListener('click', () => editor.toggle('polar'));
$('tg-otrack').addEventListener('click', () => editor.toggle('otrack'));
$('tg-lw').addEventListener('click', () => editor.run('LWDISPLAY'));
// Réglages du dessin (onglet Format) et préférences d'affichage de l'utilisateur.
editor.ui.openSettings = (tab) => openSettings(editor, tab, {
  setPrecision: (n) => { setDisplayPrecision(n); renderToggles(); },
  toggleLwDisplay: () => editor.run('LWDISPLAY'),
});
applyPrefs(editor);
$('tg-grid').addEventListener('click', () => editor.toggle('grid'));
$('tg-snap').addEventListener('click', () => editor.toggle('snap'));
let ribbonTab = 0;
renderRibbon($('ribbon'), ribbonTab);
// Ruban plus large que la fenêtre : la molette le fait défiler horizontalement.
$('ribbon').addEventListener('wheel', (e) => {
  const panel = $('ribbon').querySelector('.rpanel');
  if (!panel || panel.scrollWidth <= panel.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  panel.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });
$('ribbon').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    ribbonTab = +tab.dataset.tab;
    renderRibbon($('ribbon'), ribbonTab);
    renderRibbonState();
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'fit') { renderer.fit(); cmdInput.focus(); return; }
  const b = e.target.closest('[data-cmd]');
  if (b) { editor.run(b.dataset.cmd); cmdInput.focus(); }
});
$('cmd-prompt').addEventListener('click', (e) => {
  const kw = e.target.dataset?.kw;
  if (kw) { editor.submit(kw); cmdInput.focus(); }
});

// --- ligne de commande et clavier -----------------------------------------------------

// Saisie semi-automatique des commandes (libellés repris du ruban).
const ribbonLabels = Object.fromEntries(RIBBON.flatMap((t) => t.groups.flatMap((g) => g.items)).filter(([c]) => !c.startsWith('@'))
  .map(([c, label]) => [editor.findCommand(c)?.name || c, label]));
const suggestBox = $('cmd-suggest');
let suggestions = [], suggestSel = -1;
function renderSuggest() {
  suggestBox.hidden = !suggestions.length;
  suggestBox.innerHTML = suggestions.map((s, i) => `<li data-i="${i}" class="${i === suggestSel ? 'sel' : ''}"><span class="name">${esc(s.name)}</span>`
    + `<span class="alias">${s.alias ? esc(s.alias) : ''}</span><span class="label">${esc(s.label)}</span></li>`).join('');
}
function updateSuggest() {
  suggestions = editor.request ? [] : suggestCommands(editor, cmdInput.value, ribbonLabels);
  suggestSel = -1;
  renderSuggest();
}
function hideSuggest() { suggestions = []; suggestSel = -1; renderSuggest(); }

// Aide (F1) : toutes les commandes, leurs alias et leur libellé, avec un filtre.
editor.register('AIDE', () => {
  let dlg = document.getElementById('help-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'help-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const aliases = new Map();
  for (const [a, name] of editor.aliases) if (a !== name) (aliases.get(name) || aliases.set(name, []).get(name)).push(a);
  const rows = [...editor.commands.keys()].sort().map((n) => ({ n, a: (aliases.get(n) || []).join(', '), l: ribbonLabels[n] || '' }));
  dlg.innerHTML = `<h2>Commandes (${rows.length})</h2>
    <input class="help-filter" placeholder="Filtrer (nom, alias, libellé)…" style="width:100%;margin-bottom:8px;padding:5px 8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
    <div class="qto-scroll"><table><thead><tr><th>Commande</th><th>Alias</th><th>Ruban</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-cmd="${esc(r.n)}"><td><b>${esc(r.n)}</b></td><td>${esc(r.a)}</td><td>${esc(r.l)}</td></tr>`).join('')}
    </tbody></table></div><p class="muted">Cliquez une commande pour la lancer. Saisie semi-automatique dans la ligne de commande (↑↓, Tab).</p>
    <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  const filter = dlg.querySelector('.help-filter');
  filter.oninput = () => {
    const q = filter.value.trim().toUpperCase();
    for (const tr of dlg.querySelectorAll('tr[data-cmd]')) tr.hidden = !!q && !tr.textContent.toUpperCase().includes(q);
  };
  dlg.onclick = (e) => {
    if (e.target.dataset.act === 'close') { dlg.close(); return; }
    const tr = e.target.closest('tr[data-cmd]');
    if (tr) { dlg.close(); editor.run(tr.dataset.cmd); cmdInput.focus(); }
  };
  if (!dlg.open) dlg.showModal();
  filter.focus();
}, { aliases: ['?', 'HELP', 'F1'], label: 'AIDE', transaction: false });
cmdInput.addEventListener('input', updateSuggest);
cmdInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));
suggestBox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  const s = suggestions[+li.dataset.i];
  hideSuggest();
  cmdInput.value = '';
  editor.print(`Commande : ${s.name}`);
  editor.submit(s.name);
});

cmdInput.addEventListener('keydown', (e) => {
  if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const n = suggestions.length; // -1 = aucune ligne choisie (Entrée envoie le texte tapé)
    if (e.key === 'ArrowDown') suggestSel = suggestSel + 1 >= n ? -1 : suggestSel + 1;
    else suggestSel = suggestSel - 1 < -1 ? n - 1 : suggestSel - 1;
    renderSuggest();
    return;
  }
  if (suggestions.length && e.key === 'Tab') {
    e.preventDefault();
    cmdInput.value = suggestions[Math.max(0, suggestSel)].name;
    updateSuggest();
    return;
  }
  if (suggestions.length && suggestSel >= 0 && e.key === 'Enter') cmdInput.value = suggestions[suggestSel].name;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') hideSuggest();
  const wantsText = editor.request?.kind === 'string';
  if (e.key === 'Enter' || (e.key === ' ' && !wantsText)) {
    e.preventDefault();
    const v = cmdInput.value;
    cmdInput.value = '';
    if (v.trim()) editor.print(`${$('cmd-prompt').textContent} ${v}`);
    editor.submit(v);
    return;
  }
  if (e.key === 'Escape' || e.key.startsWith('F') && e.key.length > 1 || e.ctrlKey || e.metaKey || (e.key === 'Delete' && !cmdInput.value)) {
    if (e.key === 'Escape') cmdInput.value = '';
    if (editor.key(e)) e.preventDefault();
  }
});

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t === cmdInput) return;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
  if (editor.key(e)) { e.preventDefault(); return; }
  // Toute frappe va dans la ligne de commande, comme dans AutoCAD.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    cmdInput.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    editor.submit('');
  }
});

// --- barre du haut : menu Fichier, palette de commandes ---------------------------------

const fileMenu = $('file-menu-pop');
function setFileMenu(open) {
  fileMenu.hidden = !open;
  $('file-menu-btn').setAttribute('aria-expanded', String(open));
}
$('file-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); setFileMenu(fileMenu.hidden); });
fileMenu.addEventListener('click', (e) => {
  if (e.target.closest('select')) return;
  const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
  if (e.target.closest('.menu-item')) setFileMenu(false);
  if (cmd) editor.run(cmd);
});
$('sample-select').addEventListener('change', () => setFileMenu(false));
document.addEventListener('click', (e) => { if (!fileMenu.hidden && !e.target.closest('#file-menu')) setFileMenu(false); });

const palette = createPalette(editor, ribbonLabels, { onRun: (name) => { editor.run(name); cmdInput.focus(); } });
$('cmd-search').addEventListener('click', () => palette.open());
const cmdline = $('cmdline');
function toggleHistory(open = !cmdline.classList.contains('expanded')) {
  cmdline.classList.toggle('expanded', open);
  $('cmd-hist-btn').title = open ? "Masquer l'historique (F2)" : "Afficher l'historique (F2)";
  history.scrollTop = history.scrollHeight;
}
$('cmd-hist-btn').addEventListener('click', () => toggleHistory());
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); palette.open(); return; }
  if (e.key === 'F2' && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleHistory(); return; }
  if (e.key === 'Escape' && !fileMenu.hidden) { setFileMenu(false); e.stopPropagation(); }
}, true);

// --- fichiers -------------------------------------------------------------------------

$('new-btn').addEventListener('click', newDocument);
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await openBuffer(await file.arrayBuffer(), file.name);
  e.target.value = '';
});
$('sample-select').addEventListener('change', async (e) => {
  if (e.target.value) await openUrl(e.target.value);
  e.target.value = '';
});
$('save-btn').addEventListener('click', () => editor.run('ENREGDXF'));
$('save-dwg-btn').addEventListener('click', () => editor.run('ENREGDWG'));
// --- espace objet et présentations ---------------------------------------------------------

// Emprise des objets d'un espace (points caractéristiques) : feuille par défaut d'une présentation.
function spaceBox(id) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x, y) => { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y); };
  for (const e of doc.entities.values()) {
    if (e.space !== id) continue;
    if (e.type === 'VIEWPORT') { grow(e.c[0] - e.w / 2, e.c[1] - e.h / 2); grow(e.c[0] + e.w / 2, e.c[1] + e.h / 2); continue; }
    for (const k of ['p1', 'p2', 'c', 'p']) if (e[k]) grow(e[k][0], e[k][1]);
    for (const q of e.pts || []) grow(q[0], q[1]);
  }
  return Number.isFinite(b.minX) ? b : null;
}

const spaceOf = (id) => doc.spaces.find((s) => s.id === id);
const sheetFor = (id) => sheetOf(spaceOf(id), spaceBox(id));

const spaceHandlers = {
  switchTo(id) { editor.cancel(); switchSpace(id); },
  create() { editor.run('PRESENTATION'); },
  rename(id, label) {
    if (doc.spaces.some((s) => s.id !== id && s.label.toLowerCase() === label.toLowerCase())) { editor.print(`Une présentation « ${label} » existe déjà.`); renderSpaces(); return; }
    doc.transaction('Renommer la présentation', () => doc.updateSpace(id, { label }));
  },
  remove(id) {
    const sp = spaceOf(id);
    if (!sp || id === 'model') return;
    doc.transaction('Supprimer la présentation', () => {
      for (const e of [...doc.entities.values()]) if (e.space === id) doc.remove(e.id);
      doc.setSpaces(doc.spaces.filter((s) => s.id !== id));
    });
    editor.print(`Présentation « ${sp.label} » supprimée (U pour annuler).`);
  },
  pageSetup(id) {
    const sp = spaceOf(id);
    if (!sp || id === 'model') return;
    openPageSetup(sp, sheetFor(id), (plot) => doc.transaction('Mise en page', () => doc.updateSpace(id, { plot })));
  },
  move(id, delta) {
    const list = doc.spaces.filter((s) => s.id !== 'model');
    const i = list.findIndex((s) => s.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    doc.transaction('Ordre des présentations', () => doc.setSpaces([doc.spaces[0], ...list.map((s, k) => ({ ...s, order: k + 1 }))]));
  },
  refresh() { renderSpaces(); },
};
editor.ui.pageSetup = (id) => spaceHandlers.pageSetup(id);
// Double-clic dans une fenêtre de présentation : on y travaille sur l'espace objet (comme AutoCAD).
installMspace({ editor, renderer, getDoc: () => doc, sheetFor: (id) => sheetFor(id), onChange: () => { renderSpaces(); renderStats(); } });

function renderSpaces() {
  // Travail dans une fenêtre : l'onglet de la présentation reste actif.
  renderSpaceTabs($('space-tabs'), doc, editor.ui.mspace?.active ? editor.ui.mspace.layoutId : doc.currentSpace || 'model', spaceHandlers);
}

// Liste ou mise en page des présentations modifiée (annulation comprise).
function spacesChanged() {
  if (!spaceOf(doc.currentSpace || 'model')) switchSpace('model');
  else if (doc.currentSpace !== 'model') { renderer.setSheet(sheetFor(doc.currentSpace)); applySheetStyles(); }
  renderSpaces();
}

// Styles de tracé affichés à l'écran si la mise en page de la présentation le demande.
function applySheetStyles() {
  const sh = doc.currentSpace && doc.currentSpace !== 'model' ? sheetFor(doc.currentSpace) : null;
  renderer.setPlotStyles(sh?.showStyles ? findTable(sh.ctb !== undefined ? sh.ctb : sh.mono === false ? '' : 'monochrome.ctb') : null);
}

// Thème de l'interface et du fond du dessin : auto (comme Windows), clair ou sombre ; retenu dans le navigateur.
const THEME_KEY = 'cv-theme';
const darkMedia = matchMedia('(prefers-color-scheme: dark)');
// ?theme=light|dark dans l'adresse : thème imposé pour la séance (captures, démonstrations).
const urlTheme = new URLSearchParams(location.search).get('theme');
let uiTheme = ['light', 'dark', 'auto'].includes(urlTheme) ? urlTheme
  : (() => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } })();
const effectiveTheme = () => (uiTheme === 'auto' ? (darkMedia.matches ? 'dark' : 'light') : uiTheme);
let modelTheme = effectiveTheme();
const THEME_ICONS = {
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
};
const THEME_LABELS = { auto: ['Auto', 'comme Windows'], light: ['Clair', 'clair'], dark: ['Sombre', 'sombre'] };
function applyUiTheme() {
  if (uiTheme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', uiTheme);
  const btn = $('theme-btn');
  btn.innerHTML = `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">${THEME_ICONS[uiTheme]}</svg><span>${THEME_LABELS[uiTheme][0]}</span>`;
  btn.title = `Thème : ${THEME_LABELS[uiTheme][1]} (clic : changer)`;
  modelTheme = effectiveTheme();
  if (renderer.themeName !== 'paper' && doc) setTheme(modelTheme);
}
darkMedia.addEventListener('change', () => { if (uiTheme === 'auto') applyUiTheme(); });
function switchSpace(id) {
  if (editor.ui.mspace?.active) editor.ui.mspace.exit();
  editor.vpCommit();
  renderer.activeViewport = null;
  doc.currentSpace = id;
  renderer.setSpace(id, id === 'model' ? null : sheetFor(id));
  setTheme(id === 'model' ? modelTheme : 'paper');
  applySheetStyles();
  renderSpaces();
  renderStats();
}

function setTheme(name) {
  renderer.setTheme(name);
  if (name !== 'paper') modelTheme = name;
  layers.render();
}
$('theme-btn').addEventListener('click', () => {
  uiTheme = { auto: 'light', light: 'dark', dark: 'auto' }[uiTheme];
  try { localStorage.setItem(THEME_KEY, uiTheme); } catch { /* navigation privée : thème non retenu */ }
  applyUiTheme();
});
applyUiTheme();
$('view3d-btn').addEventListener('click', () => {
  const to3d = renderer.mode === '2d';
  editor.cancel();
  renderer.setMode(to3d ? '3d' : '2d');
  $('view3d-btn').querySelector('span').textContent = to3d ? 'Vue 2D' : 'Vue 3D';
});

const view = $('view');
view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragover'); });
view.addEventListener('dragleave', () => view.classList.remove('dragover'));
view.addEventListener('drop', async (e) => {
  e.preventDefault();
  view.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) await openBuffer(await file.arrayBuffer(), file.name);
});

fetch('samples/index.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((files) => {
    $('sample-select').insertAdjacentHTML('beforeend',
      files.map((f) => `<option value="samples/${encodeURIComponent(f)}">${esc(f)}</option>`).join(''));
  })
  .catch(() => {});

// Signe de vie pour le lanceur de la version installable (arrête son serveur quand la fenêtre est fermée).
setInterval(() => { fetch('__ping', { cache: 'no-store' }).catch(() => {}); }, 20000);

// Accès pour les tests automatisés et la console.
window.cad = { editor, renderer, fonds, elec, dock, tools3d, ifc3d: renderer.ifc3dManager, get doc() { return doc; }, openUrl, newDocument, autosave, offerRecovery };

renderToggles();
newDocument();
// ?file= : dessin de l'application elle-même (même origine), jamais une adresse extérieure.
const fileParam = new URLSearchParams(location.search).get('file');
const initial = fileParam && (() => { try { return new URL(fileParam, location.href).origin === location.origin; } catch { return false; } })() ? fileParam : null;
// ?run=BILANELEC (commandes séparées par des virgules) : lancées une fois le dessin ouvert (démonstrations, captures).
// Par sécurité (lien reçu d'un tiers), seulement des commandes d'affichage : sans modification du dessin ni écriture
// de fichier.
const runnable = (c) => { const cmd = editor.findCommand(c); return !!cmd && cmd.transaction === false && !/^(ENREG|EXPORT|TRACER|PUBLIER|SAUV|COPIERPRESSE|COUPERPRESSE)/.test(cmd.name); };
const runAtStart = () => { for (const c of (new URLSearchParams(location.search).get('run') || '').split(',').map((x) => x.trim()).filter(Boolean)) if (runnable(c)) editor.run(c); else editor.print(`?run= : commande « ${c} » non lancée (seules les commandes d'affichage le sont).`); };
if (initial) openUrl(initial).then(runAtStart);
else {
  setTimeout(runAtStart, 0);
  offerRecovery();
  // Workers de lecture prêts avant la première ouverture (LibreDWG compilé au repos).
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => prewarmReaders(), { timeout: 3000 });
}
cmdInput.focus();
