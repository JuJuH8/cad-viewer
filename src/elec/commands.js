// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes électricité (NIBT) : palette de symboles et pose, tableaux, circuits, bilan de puissance et
// dimensionnement, schéma unifilaire, légende.

import * as G from '../core/geom.js';
import { SYMBOLS, CATEGORIES, symbolInsert, ensureSymbolBlock, defaultSymbolSize, refreshAttribs } from './symbols.js';
import { CIRCUIT_TYPES, METHODS, RATINGS, SECTIONS, fmtSection, SUPPLIES, supplyOf } from './nibt.js';
import {
  boards, devices, boardByName, nextCircuitId, nextBoardName, computeInstallation, assignCircuit, setCircuit, circuitTypeOf, PREFIX,
} from './circuits.js';
import { singleLinePages, legendEntities, circuitsPerPage } from './schema.js';
import { makePlot } from '../layout/sheet.js';
import { loadLibrary, libraryInsert, insertScale, blockSvg, savedFolder, saveFolder, DEFAULT_FOLDER } from './library.js';
import { tableEntities } from '../mep/table.js';
import { annoScale } from '../editor/dims.js';
import { unitMmOf } from '../mep/network.js';
import { sectionLabel } from '../mep/systems.js';
import { ELEC_LABELS, elecData, withElecValue } from './settings.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '');

// Aperçu SVG d'un symbole (palette, légende de la boîte).
export function symbolSvg(key, px = 34) {
  const ents = SYMBOLS[key].draw();
  const y = (v) => -v;
  const parts = [];
  for (const e of ents) {
    if (e.type === 'LINE') parts.push(`<line x1="${e.p1[0]}" y1="${y(e.p1[1])}" x2="${e.p2[0]}" y2="${y(e.p2[1])}"/>`);
    else if (e.type === 'CIRCLE') parts.push(`<circle cx="${e.c[0]}" cy="${y(e.c[1])}" r="${e.r}"/>`);
    else if (e.type === 'ARC') {
      const a = G.polar(e.c, e.a0, e.r), b = G.polar(e.c, e.a1, e.r);
      const large = G.sweep(e.a0, e.a1) > Math.PI ? 1 : 0;
      parts.push(`<path d="M${a[0]} ${y(a[1])} A${e.r} ${e.r} 0 ${large} 0 ${b[0]} ${y(b[1])}"/>`);
    } else if (e.type === 'LWPOLYLINE') parts.push(`<polyline points="${[...e.pts, ...(e.closed ? [e.pts[0]] : [])].map((p) => `${p[0]},${y(p[1])}`).join(' ')}"/>`);
    else if (e.type === 'HATCH') parts.push(`<polygon class="f" points="${e.loops[0].map((p) => `${p[0]},${y(p[1])}`).join(' ')}"/>`);
    else if (e.type === 'TEXT') parts.push(`<text x="${e.p[0]}" y="${y(e.p[1])}" font-size="${e.h}" text-anchor="middle" dominant-baseline="central">${esc(e.text)}</text>`);
  }
  return `<svg class="sym" viewBox="-0.9 -0.9 1.8 1.8" width="${px}" height="${px}">${parts.join('')}</svg>`;
}

export function registerElecCommands(editor, opts = {}) {
  const state = { cat: 'LUMIERE', key: 'LUM', board: '', circuit: '', size: null, source: 'integres', pal: '', filter: '', tool: null, factor: 1 };
  const sizeOf = (doc) => state.size || defaultSymbolSize(doc, annoScale(doc), unitMmOf(doc));
  const unitM = (doc) => unitMmOf(doc) / 1000;
  // Bibliothèque DWG de symboles (tierce) : chargée à la demande depuis un dossier de palettes d'outils.
  const lib = { lib: null, loading: false, error: '', folder: savedFolder() || DEFAULT_FOLDER };
  const toolOf = (ref) => ref && lib.lib?.palettes.find((p) => p.name === ref.pal)?.tools.find((t) => t.block === ref.block && t.name === ref.name);
  // Outils affichés : palette choisie, ou toutes (sans doublons) quand on filtre.
  const libTools = () => {
    if (!lib.lib) return [];
    const f = state.filter.trim().toLowerCase();
    const all = state.pal === '*' || !!f;
    const seen = new Set(), out = [];
    for (const p of all ? lib.lib.palettes : lib.lib.palettes.filter((x) => x.name === state.pal)) {
      for (const t of p.tools) {
        if (all && seen.has(t.block)) continue;
        if (f && !`${t.name} ${t.block} ${t.layer}`.toLowerCase().includes(f)) continue;
        seen.add(t.block);
        out.push({ ...t, pal: p.name });
      }
    }
    return out.slice(0, 400);
  };
  // Appareil rattaché au tableau et au circuit choisis : appareils alimentés et commandes d'éclairage
  // (le courant faible n'est pas sur les circuits NIBT).
  const attachable = (sym, p) => {
    const s = SYMBOLS[sym];
    return !!s && (p > 0 || !!CATEGORIES[s.cat].circuit || s.cat === 'COMMANDE');
  };
  const circuitTypeOfTool = (t) => {
    const s = SYMBOLS[t?.info?.sym];
    return s ? s.circuit || CATEGORIES[s.cat].circuit || 'FORCE' : 'FORCE';
  };

  // --- palette ------------------------------------------------------------------------
  let palette = null;
  function libraryGrid() {
    const tools = libTools();
    if (!tools.length) return '<p class="muted">Aucun symbole.</p>';
    return tools.map((t) => {
      const sel = state.tool && state.tool.block === t.block && state.tool.name === t.name ? 'sel' : '';
      const kind = t.info.plain ? 'bloc posé tel quel (sans données électriques)' : `${SYMBOLS[t.info.sym].label}${t.info.p ? `, ${t.info.p} W` : ''}`;
      return `<button class="elec-sym ${sel}" data-tool="${esc(t.pal)}|${esc(t.block)}|${esc(t.name)}" title="${esc(t.info.label)} — ${esc(kind)} — calque ${esc(t.layer)}">${blockSvg(lib.lib.docOf(t), t.block)}<span>${esc(t.info.label)}</span></button>`;
    }).join('');
  }
  function libraryBody() {
    const head = `<div class="fond-row"><label>Dossier des palettes <input data-k="folder" value="${esc(lib.folder)}" size="52"></label>
      <button class="btn" data-act="load" ${lib.loading ? 'disabled' : ''}>${lib.lib ? 'Recharger' : 'Charger'}</button></div>
      ${lib.error ? `<p class="del">${esc(lib.error)}</p>` : ''}`;
    if (lib.loading) return `${head}<p class="muted">Chargement de la bibliothèque…</p>`;
    if (!lib.lib) {
      return `${head}<p class="muted">Indiquez le dossier qui contient les palettes d’outils AutoCAD (.atc) et le DWG des blocs — par exemple le dossier d’installation d’une bibliothèque de symboles électriques. Les symboles sont posés avec leur bloc et leur calque d’origine, et rattachés aux tableaux et circuits comme les symboles intégrés.</p>`;
    }
    const pals = lib.lib.palettes;
    if (state.pal !== '*' && !pals.some((p) => p.name === state.pal)) state.pal = pals[0].name;
    return `${head}<div class="fond-row"><label>Palette <select data-k="pal"><option value="*" ${state.pal === '*' ? 'selected' : ''}>Toutes les palettes</option>${pals.map((p) => `<option value="${esc(p.name)}" ${p.name === state.pal ? 'selected' : ''}>${esc(p.name.replace(/_Cn$/i, '').replace(/_/g, ' '))} (${p.tools.length})</option>`).join('')}</select></label>
      <input type="search" data-k="filter" value="${esc(state.filter)}" placeholder="Filtrer (nom, calque)…"></div>
      <div class="elec-syms lib" data-grid>${libraryGrid()}</div>`;
  }
  function renderPalette() {
    const doc = editor.doc;
    const bs = boards(doc).map((b) => b.elec.board);
    if (state.board && !bs.includes(state.board)) state.board = '';
    const biblio = state.source === 'biblio';
    const cats = Object.entries(CATEGORIES).filter(([k]) => Object.values(SYMBOLS).some((s) => s.cat === k));
    // Panneau latéral : catégories en liste déroulante (les boutons prendraient toute la hauteur d'un panneau étroit).
    const catPicker = palette.inPanel
      ? `<label class="elec-catsel">Catégorie <select data-k="cat">${cats.map(([k, c]) => `<option value="${k}" ${k === state.cat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>`
      : `<div class="elec-cats">${cats.map(([k, c]) => `<button class="btn ${k === state.cat ? 'primary' : ''}" data-cat="${k}">${esc(c.label)}</button>`).join('')}</div>`;
    const body = biblio ? libraryBody() : `${catPicker}
      <div class="elec-syms">${Object.entries(SYMBOLS).filter(([, s]) => s.cat === state.cat).map(([k, s]) => `<button class="elec-sym ${k === state.key ? 'sel' : ''}" data-sym="${k}" title="${esc(s.label)}">${symbolSvg(k)}<span>${esc(s.label)}</span></button>`).join('')}</div>`;
    palette.innerHTML = `${palette.inPanel ? '' : '<h2>Symboles électriques</h2>'}
      <div class="elec-cats elec-src"><button class="btn ${biblio ? '' : 'primary'}" data-src="integres">Symboles intégrés</button><button class="btn ${biblio ? 'primary' : ''}" data-src="biblio">Bibliothèque DWG${lib.lib ? ` (${lib.lib.count})` : ''}</button></div>
      <div class="fond-row elec-target"><label>Tableau <select data-k="board"><option value="">—</option>${bs.map((b) => `<option ${b === state.board ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
        <label>Circuit <input data-k="circuit" value="${esc(state.circuit)}" size="6"></label>
        <button class="btn" data-act="next" title="Prochain numéro libre du tableau pour ce type de circuit">Nouveau</button>
        ${biblio ? `<label title="Multiplie l’échelle des blocs (dessinés pour le 1:50, adaptés à l’échelle des annotations du dessin)">Facteur d’échelle <input data-k="factor" value="${num(state.factor, 2)}" size="4"></label>` : `<label>Taille <input data-k="size" value="${num(sizeOf(doc), 0)}" size="6"></label>`}</div>
      ${body}
      <p class="muted elec-help">Cliquez un symbole puis ses points d’insertion dans le dessin (R : rotation, Entrée pour finir). Chaque symbole apparaît dès le clic ; il est posé sur le calque SIA de sa catégorie et rattaché au circuit indiqué.</p>
      ${palette.inPanel ? '' : '<div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>'}`;
  }
  async function loadLib(folder = lib.folder) {
    if (!opts.loadDocument) throw new Error('lecture des DWG indisponible');
    lib.folder = folder;
    lib.loading = true;
    lib.error = '';
    if (palette?.open) renderPalette();
    try {
      lib.lib = await loadLibrary(folder, opts.loadDocument);
      saveFolder(folder);
      state.tool = null;
      editor.print(`Bibliothèque chargée : ${lib.lib.count} symboles dans ${lib.lib.palettes.length} palettes.`);
    } catch (err) {
      lib.error = `Bibliothèque non chargée : ${err.message}`;
      editor.print(lib.error);
    } finally {
      lib.loading = false;
      if (palette?.open) renderPalette();
    }
    return lib.lib;
  }
  function openPalette() {
    if (!palette) {
      // Panneau latéral « Symboles » quand l'interface en a un ; sinon boîte de dialogue (tests, autre page).
      const body = typeof document !== 'undefined' && document.getElementById('symbols-body');
      if (body && opts.panels) {
        palette = body;
        palette.inPanel = true;
        Object.defineProperty(palette, 'open', { get: () => opts.panels.isOpen('symbols') });
        palette.show = () => opts.panels.show('symbols');
        palette.close = () => opts.panels.hide('symbols');
      } else {
        palette = document.createElement('dialog');
        palette.id = 'elec-palette';
        palette.className = 'qto';
        document.body.appendChild(palette);
      }
      palette.addEventListener('click', (e) => {
        const src = e.target.closest('[data-src]')?.dataset.src;
        if (src) {
          state.source = src;
          renderPalette();
          if (src === 'biblio' && !lib.lib && !lib.loading && savedFolder()) loadLib(savedFolder());
          return;
        }
        const tool = e.target.closest('[data-tool]')?.dataset.tool;
        if (tool) {
          const [pal, block, name] = tool.split('|');
          state.tool = { pal, block, name };
          palette.querySelector('[data-grid]').innerHTML = libraryGrid();
          editor.cancel?.();
          editor.run('POSEBIBLIO');
          return;
        }
        const cat = e.target.closest('[data-cat]')?.dataset.cat;
        if (cat) { state.cat = cat; renderPalette(); return; }
        const sym = e.target.closest('[data-sym]')?.dataset.sym;
        if (sym) {
          state.key = sym;
          renderPalette();
          editor.cancel?.();
          editor.run(SYMBOLS[sym].board ? 'TABLEAU' : 'POSESYMBOLE');
          return;
        }
        const act = e.target.dataset.act;
        if (act === 'close') palette.close();
        if (act === 'load') loadLib(palette.querySelector('[data-k="folder"]')?.value.trim() || lib.folder);
        if (act === 'next') {
          if (!state.board) { editor.print('Choisissez d’abord le tableau.'); return; }
          const type = state.source === 'biblio' ? circuitTypeOfTool(toolOf(state.tool)) : SYMBOLS[state.key].circuit || CATEGORIES[SYMBOLS[state.key].cat].circuit || 'FORCE';
          state.circuit = nextCircuitId(editor.doc, state.board, type);
          renderPalette();
        }
      });
      palette.addEventListener('change', (e) => {
        const k = e.target.dataset.k;
        if (k === 'board') state.board = e.target.value;
        if (k === 'circuit') state.circuit = e.target.value.trim();
        if (k === 'size') { const v = parseFloat(e.target.value.replace(',', '.')); state.size = v > 0 ? v : null; }
        if (k === 'factor') { const v = parseFloat(e.target.value.replace(',', '.')); state.factor = v > 0 ? v : 1; }
        if (k === 'folder') lib.folder = e.target.value.trim();
        if (k === 'cat') { state.cat = e.target.value; renderPalette(); }
        if (k === 'pal') { state.pal = e.target.value; state.filter = ''; renderPalette(); }
      });
      palette.addEventListener('input', (e) => {
        if (e.target.dataset.k !== 'filter') return;
        state.filter = e.target.value;
        palette.querySelector('[data-grid]').innerHTML = libraryGrid();
      });
    }
    renderPalette();
    if (!palette.open) palette.show();
  }

  editor.register('SYMBOLE', () => openPalette(), { aliases: ['SYMBOLES', 'ELEC', 'SYM'], label: 'SYMBOLE', transaction: false });

  editor.register('BIBLIOELEC', () => {
    state.source = 'biblio';
    openPalette();
    if (!lib.lib && !lib.loading && savedFolder()) loadLib(savedFolder());
  }, { aliases: ['BIBLIO'], label: 'BIBLIOELEC', transaction: false });

  // Clic droit › « Dessiner… » (AJOUTSELECT) : un symbole se reproduit tel quel (même circuit, mêmes données) ;
  // un tableau, lui, est un nouveau tableau (commande TABLEAU).
  (editor.addSelected ||= []).push({
    label(e) {
      const s = e.type === 'INSERT' && SYMBOLS[e.elec?.sym];
      if (!s) return null;
      if (e.elec.kind === 'board') return 'un nouveau tableau';
      const label = e.elec.block ? (e.elec.label || s.label) : s.label;
      return `« ${label} »${e.elec.board && e.elec.circuit ? ` (circuit ${e.elec.board}.${e.elec.circuit})` : ''}`;
    },
    draw: null,
  }, {
    label: (e) => (e.type === 'INSERT' && e.elec?.kind === 'board' ? 'un nouveau tableau' : null),
    draw: (ctx) => editor.commands.get('TABLEAU').fn(ctx),
  });

  editor.register('POSESYMBOLE', async (ctx) => {
    const { doc } = ctx;
    const key = state.key && SYMBOLS[state.key] && !SYMBOLS[state.key].board ? state.key : 'LUM';
    let rot = 0, n = 0;
    const size = sizeOf(doc);
    const elec = () => (state.board && attachable(key, SYMBOLS[key].p) ? { board: state.board, ...(state.circuit ? { circuit: state.circuit } : {}) } : {});
    for (;;) {
      const p = await ctx.getPoint(`${SYMBOLS[key].label} : point d’insertion`, {
        keywords: ['Rotation'], allowNone: true,
        preview: (q) => [symbolInsert(doc, key, q, { size, rot, elec: elec(), preview: true })],
      });
      if (p == null) break;
      if (p === 'Rotation') { rot = await ctx.getAngle('Rotation (degrés)'); continue; } // radians
      doc.add(symbolInsert(doc, key, p, { size, rot, elec: elec() }));
      n++;
    }
    if (n) ctx.print(`${n} ${SYMBOLS[key].label.toLowerCase()}(s) posé(s)${elec().circuit ? ` sur le circuit ${state.board}.${state.circuit}` : ''}.`);
  }, { aliases: ['POSESYM'], label: 'POSESYMBOLE' });

  // Nom et tableau amont d'un nouveau tableau ; null si abandon.
  async function askBoard(ctx) {
    const { doc } = ctx;
    const name = (await ctx.getString('Nom du tableau', { default: nextBoardName(doc) })).trim();
    if (!name) return null;
    if (boardByName(doc, name)) { ctx.print(`Le tableau ${name} existe déjà.`); return null; }
    const others = boards(doc).map((b) => b.elec.board);
    let parent = '';
    if (others.length) {
      const k = await ctx.getKeyword('Alimenté par', ['Aucun', ...others], { default: others.includes('TP') ? 'TP' : 'Aucun' });
      parent = k === 'Aucun' ? '' : k;
    }
    return { name, parent };
  }

  editor.register('TABLEAU', async (ctx) => {
    const { doc } = ctx;
    const ask = await askBoard(ctx);
    if (!ask) return;
    const { name, parent } = ask;
    const size = sizeOf(doc);
    const elec = { kind: 'board', board: name, parent, circuits: [] };
    const p = await ctx.getPoint(`Tableau ${name} : point d’insertion`, { preview: (q) => [symbolInsert(doc, 'TABLEAU', q, { size, elec, preview: true })] });
    doc.add(symbolInsert(doc, 'TABLEAU', p, { size, elec }));
    state.board = name;
    if (palette?.open) renderPalette();
    ctx.print(`Tableau ${name} posé${parent ? `, alimenté par ${parent}` : ''}.`);
  }, { aliases: ['TD', 'TABLEAUELEC'], label: 'TABLEAU' });

  // Pose d'un symbole de la bibliothèque DWG (bloc et calque de l'outil de palette).
  editor.register('POSEBIBLIO', async (ctx) => {
    const { doc } = ctx;
    const tool = toolOf(state.tool);
    if (!tool) { ctx.print('Choisissez d’abord un symbole de la bibliothèque (commande BIBLIOELEC).'); return; }
    const L = lib.lib;
    const scale = insertScale(doc, L.docOf(tool), tool, { annoScale: annoScale(doc), unitMm: unitMmOf(doc), factor: state.factor || 1 });
    const { info } = tool;
    if (!info.plain && SYMBOLS[info.sym].board) {
      const ask = await askBoard(ctx);
      if (!ask) return;
      const elec = { kind: 'board', board: ask.name, parent: ask.parent, circuits: [] };
      const p = await ctx.getPoint(`Tableau ${ask.name} : point d’insertion`, { preview: (q) => [libraryInsert(doc, L, tool, q, { scale, elec, preview: true })] });
      doc.add(libraryInsert(doc, L, tool, p, { scale, elec }));
      state.board = ask.name;
      if (palette?.open) renderPalette();
      ctx.print(`Tableau ${ask.name} posé (${info.label})${ask.parent ? `, alimenté par ${ask.parent}` : ''}.`);
      return;
    }
    let rot = 0, n = 0;
    const elec = () => (!info.plain && state.board && attachable(info.sym, info.p) ? { board: state.board, ...(state.circuit ? { circuit: state.circuit } : {}) } : {});
    for (;;) {
      const p = await ctx.getPoint(`${info.label} : point d’insertion`, {
        keywords: ['Rotation'], allowNone: true,
        preview: (q) => [libraryInsert(doc, L, tool, q, { scale, rot, elec: elec(), preview: true })],
      });
      if (p == null) break;
      if (p === 'Rotation') { rot = await ctx.getAngle('Rotation (degrés)'); continue; }
      doc.add(libraryInsert(doc, L, tool, p, { scale, rot, elec: elec() }));
      n++;
    }
    if (n) ctx.print(`${n} × ${info.label} posé(s)${elec().circuit ? ` sur le circuit ${state.board}.${state.circuit}` : ''}.`);
  }, { aliases: ['POSEBIB'], label: 'POSEBIBLIO' });

  editor.register('CIRCUIT', async (ctx) => {
    const { doc } = ctx;
    const bs = boards(doc).map((b) => b.elec.board);
    if (!bs.length) { ctx.print('Posez d’abord un tableau (commande TABLEAU).'); return; }
    const ids = (await ctx.getSelection('Appareils du circuit')).filter((id) => doc.get(id)?.elec && doc.get(id).elec.kind !== 'board');
    if (!ids.length) { ctx.print('Aucun appareil électrique sélectionné.'); return; }
    const board = bs.length === 1 ? bs[0] : await ctx.getKeyword('Tableau', bs, { default: state.board && bs.includes(state.board) ? state.board : bs[0] });
    const types = ids.map((id) => circuitTypeOf(doc.get(id))).filter(Boolean);
    const type = types[0] || 'FORCE';
    const id = (await ctx.getString('Circuit', { default: nextCircuitId(doc, board, type) })).trim();
    if (!id) return;
    assignCircuit(doc, ids, board, id);
    const def = boardByName(doc, board).elec.circuits?.find((c) => c.id === id);
    if (!def) setCircuit(doc, board, id, { type });
    state.board = board; state.circuit = id;
    ctx.print(`${ids.length} appareil(s) sur le circuit ${board}.${id} (${CIRCUIT_TYPES[type]?.label || type}).`);
  }, { aliases: ['CI', 'CIRCUITELEC'], label: 'CIRCUIT' });

  // --- bilan et dimensionnement ---------------------------------------------------------
  let bilan = null, bilanBoard = '', bilanTab = 'bilan';
  // Origine de la longueur d'un départ (colonne L du bilan).
  const LEN_SRC = {
    chemins: ['CDC', 'par les chemins de câbles dessinés'],
    partiel: ['CDC*', 'en partie par les chemins de câbles (appareils hors chemins estimés)'],
    'estimée': ['est.', 'estimée (trajet orthogonal + 15 % + 3 m) : aucun chemin de câbles relié au tableau'],
  };
  // Onglet « Données électriques » : réseau, câbles, matériels, cheminement (valeurs générales modifiables).
  function dataTab(doc) {
    const data = elecData(doc), saved = doc.header?.elecData || {};
    return Object.entries(ELEC_LABELS).map(([g, [title, labels]]) => `<fieldset class="elec-data"><legend>${esc(title)}</legend>
      ${Object.entries(labels).map(([k, label]) => `<label>${esc(label)} <input data-g="${g}" data-k="${k}" value="${esc(String(data[g][k]).replace('.', typeof data[g][k] === 'number' ? ',' : '.'))}"${saved[g]?.[k] !== undefined ? ' class="set"' : ''} size="12"></label>`).join('')}
      </fieldset>`).join('')
      + '<p class="muted">Valeurs générales par défaut, à préciser par projet (effacer un champ rétablit la valeur par défaut). Enregistrées dans le dessin.</p>';
  }
  // Onglet « Chemins de câbles » : remplissage de chaque chemin emprunté par les circuits.
  function fillTab(inst) {
    const data = elecData(editor.doc);
    if (!inst.router.hasTrays) return `<p class="muted">Aucun chemin de câbles ni tube des systèmes ${esc(data.routing.systems)} dans le dessin : longueurs estimées.</p>`;
    if (!inst.fill.length) return '<p class="muted">Aucun circuit ne passe par les chemins de câbles (appareils trop loin, ou chemins non reliés aux tableaux).</p>';
    const rows = inst.fill.map((f) => `<tr class="${f.ok ? '' : 'ko'}"><td>${esc(f.tray.mep.system)}</td><td>${esc(sectionLabel(f.tray.mep))}</td>
      <td class="num">${f.cables.length}</td><td>${esc(f.cables.map((c) => `${c.board}.${c.circuit} (${c.cores}${c.wires ? ' fils' : ''}×${fmtSection(c.section)})`).join(', '))}</td>
      <td class="num">${num(f.area, 0)}</td><td class="num">${num(f.fill, 1)}</td><td>${f.ok ? 'OK' : `> ${f.max} %`}</td></tr>`).join('');
    return `<div class="qto-scroll"><table class="bilan"><thead><tr><th>Système</th><th>Chemin / tube</th><th>Câbles</th><th>Circuits</th><th>Section des câbles (mm²)</th><th>Remplissage (%)</th><th>Contrôle</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="muted">Diamètres de câbles approximatifs (cuivre, FE0 / TT) ; section utile = largeur × hauteur du chemin, section intérieure du tube (≈ 72 % du diamètre). CHEMINEMENT dessine le trajet des câbles.</p>`;
  }
  function renderBilan() {
    const doc = editor.doc;
    const inst = computeInstallation(doc, { unitM: unitM(doc) });
    const names = [...inst.keys()];
    if (!names.includes(bilanBoard)) bilanBoard = names[0] || '';
    const info = inst.get(bilanBoard);
    const tabs = [['bilan', 'Bilan'], ['chemins', 'Chemins de câbles'], ['donnees', 'Données électriques']]
      .map(([k, l]) => `<button class="btn ${k === bilanTab ? 'primary' : ''}" data-tab="${k}">${l}</button>`).join('');
    if (bilanTab !== 'bilan') {
      bilan.innerHTML = `<h2>Bilan de puissance et dimensionnement (NIBT)</h2><div class="elec-cats">${tabs}</div>
        ${bilanTab === 'donnees' ? dataTab(doc) : fillTab(inst)}
        <div class="qto-actions">${bilanTab === 'chemins' ? '<button class="btn" data-act="route">Dessiner le cheminement</button>' : ''}<button class="btn" data-act="close">Fermer</button></div>`;
      return;
    }
    const opt = (list, cur, fmt = (x) => x) => list.map((v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(fmt(v))}</option>`).join('');
    let body = '<p class="muted">Aucun tableau : posez un tableau (TABLEAU), des appareils (SYMBOLE), puis rattachez-les à des circuits (CIRCUIT).</p>';
    if (info) {
      const rows = info.circuits.map((c) => {
        const r = c.r, d = c.def;
        return `<tr data-c="${esc(d.id)}" class="${r.ok ? '' : 'ko'}">
          <td><b>${esc(d.id)}</b></td>
          <td><input data-f="label" value="${esc(d.label || '')}" placeholder="${esc(d.sub ? `Tableau ${d.sub}` : CIRCUIT_TYPES[d.type]?.label || '')}" size="14"></td>
          <td>${d.sub ? 'Tableau' : `<select data-f="type">${opt(Object.keys(CIRCUIT_TYPES).filter((t) => t !== 'TABLEAU'), d.type, (t) => CIRCUIT_TYPES[t].label)}</select>`}</td>
          <td class="num">${c.devices.length || (d.sub ? '—' : 0)}</td>
          <td class="num">${Math.round(c.p)}</td>
          <td class="num"><input data-f="ks" value="${d.ks ?? ''}" placeholder="${num(r.ks, 2)}" size="4"></td>
          <td class="num">${Math.round(r.pabs)}</td>
          <td class="num">${num(r.ib)}</td>
          <td><select data-f="curve">${opt(['B', 'C', 'D', 'gG'], r.curve)}</select><select data-f="rating"><option value="">auto (${r.rating})</option>${opt(RATINGS, d.rating ?? '')}</select></td>
          <td><select data-f="method">${opt(Object.keys(METHODS), d.method || 'B2')}</select></td>
          <td><select data-f="supply" title="Alimentation (calque des fils)"><option value="">${esc(SUPPLIES[supplyOf(info.board, { type: d.type })].short)} (tableau)</option>${Object.entries(SUPPLIES).map(([k, x]) => `<option value="${k}" ${k === d.supply ? 'selected' : ''}>${esc(x.short)}</option>`).join('')}</select></td>
          <td class="num"><input data-f="len" value="${d.len ?? ''}" placeholder="${num(c.len)}" size="5">${LEN_SRC[c.lenSrc] ? ` <small title="${esc(LEN_SRC[c.lenSrc][1])}">${LEN_SRC[c.lenSrc][0]}</small>` : ''}</td>
          <td><select data-f="s"><option value="">auto (${fmtSection(r.s)})</option>${opt(SECTIONS, d.s ?? '', fmtSection)}</select></td>
          <td>${esc(r.cable)}</td>
          <td class="num">${num(r.iz)}</td>
          <td class="num ${r.duTotal > 4 ? 'del' : ''}">${num(r.duTotal, 2)}</td>
          <td class="num">${num(r.lmax, 0)}</td>
          <td class="num" title="seuil de déclenchement ${c.sc ? Math.round(c.sc.ia) : ''} A">${c.sc ? Math.round(c.sc.ik1) : ''}</td>
          <td class="${c.sel?.kind === 'non' ? 'del' : ''}">${esc(c.sel ? c.sel.text.replace(/^sélectivité non assurée.*/, 'non assurée') : '')}</td>
          <td>${r.ok ? (r.rcd ? 'OK (DDR 30 mA)' : 'OK') : esc(r.warnings.join(' ; '))}</td></tr>`;
      }).join('');
      const b = info.board.elec, s = info.supply;
      body = `<div class="fond-row"><label>Facteur de simultanéité du tableau <input data-b="ks" value="${b.ks ?? ''}" placeholder="0,8" size="4"></label>
        <label title="Calque et couleur des fils et des étiquettes (CHEMINEMENT, ETIQCIRCUIT)">Alimentation <select data-b="supply">${Object.entries(SUPPLIES).map(([k, x]) => `<option value="${k}" ${k === (b.supply || 'N') ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
        ${b.parent ? `<span class="muted">Alimenté par ${esc(b.parent)}</span>` : `<label>Longueur du branchement (m) <input data-b="supplyLen" value="${b.supplyLen ?? ''}" placeholder="0" size="5"></label>
        <label>Pose <select data-b="supplyMethod">${opt(Object.keys(METHODS), b.supplyMethod || 'C')}</select></label>`}</div>
        ${info.ik3 ? `<p><b>Court-circuit au jeu de barres</b> : Ik3 max ${num(info.ik3 / 1000, 2)} kA (pouvoir de coupure ${num(elecData(doc).equipment.icu, 0)} kA) — Ik1 min ${num(info.ik1 / 1000, 2)} kA <span class="muted">(depuis Ik3 ${num(elecData(doc).network.ik3, 1)} kA / Ik1 ${num(elecData(doc).network.ik1, 1)} kA au raccordement, onglet Données électriques)</span></p>` : ''}
        ${s ? `<p><b>Alimentation</b> : ${Math.round(info.p)} W appelés — Ib ${num(s.ib)} A — ${esc(s.protection)} — ${esc(s.cable)} — ΔU ${num(s.duTotal, 2)} % ${s.ok ? '' : `<span class="del">${esc(s.warnings.join(' ; '))}</span>`}</p>` : ''}
        <div class="qto-scroll"><table class="bilan"><thead><tr><th>Circuit</th><th>Désignation</th><th>Type</th><th>App.</th><th>P inst. (W)</th><th>ks</th><th>P abs. (W)</th><th>Ib (A)</th><th>Protection</th><th>Pose</th><th>Alim.</th><th>L (m)</th><th>Section</th><th>Câble</th><th>Iz (A)</th><th>ΔU cumul (%)</th><th>L max (m)</th><th>Ik1 min (A)</th><th>Sélectivité</th><th>Contrôle</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="muted">Valeurs « auto » choisies selon la NIBT (Ib ≤ In ≤ Iz, ΔU ≤ ${num(elecData(doc).network.duMax, 0)} % depuis le point de raccordement, coupure en schéma TN) ; saisir une valeur l’impose. L : CDC = par les chemins de câbles dessinés (réserve comprise), est. = estimée. Résultats à vérifier par le projeteur.</p>`;
    }
    bilan.innerHTML = `<h2>Bilan de puissance et dimensionnement (NIBT)</h2>
      <div class="elec-cats">${tabs}</div>
      <div class="elec-cats">${names.map((n) => `<button class="btn ${n === bilanBoard ? 'primary' : ''}" data-board="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      ${body}
      <div class="qto-actions"><button class="btn" data-act="csv">Exporter CSV</button><button class="btn" data-act="table">Insérer le bilan</button><button class="btn" data-act="schema">Schéma unifilaire</button><button class="btn" data-act="close">Fermer</button></div>`;
  }
  function openBilan() {
    if (!bilan) {
      bilan = document.createElement('dialog');
      bilan.id = 'elec-bilan';
      bilan.className = 'qto';
      document.body.appendChild(bilan);
      bilan.addEventListener('click', (e) => {
        const b = e.target.closest('[data-board]')?.dataset.board;
        if (b) { bilanBoard = b; renderBilan(); return; }
        const tab = e.target.closest('[data-tab]')?.dataset.tab;
        if (tab) { bilanTab = tab; renderBilan(); return; }
        const act = e.target.dataset.act;
        if (act === 'close') bilan.close();
        if (act === 'csv') exportCsv();
        if (act === 'route') { bilan.close(); editor.run('CHEMINEMENT'); }
        if (act === 'table') { bilan.close(); editor.run('BILANTABLE'); }
        if (act === 'schema') { bilan.close(); state.schemaBoard = bilanBoard; editor.run('UNIFILAIRE'); }
      });
      bilan.addEventListener('change', (e) => {
        const doc = editor.doc;
        const g = e.target.dataset.g;
        if (g) {
          const next = withElecValue(doc, g, e.target.dataset.k, e.target.value);
          if (next === undefined) { renderBilan(); return; }
          doc.setHeader({ elecData: next }, { light: true });
          renderBilan();
          return;
        }
        const tr = e.target.closest('tr[data-c]');
        const f = e.target.dataset.f, bf = e.target.dataset.b;
        const raw = e.target.value.trim().replace(',', '.');
        const val = (k) => (raw === '' ? null : ['ks', 'len', 'rating', 's'].includes(k) ? Number(raw) : raw);
        doc.transaction('Circuit', () => {
          if (tr && f) setCircuit(doc, bilanBoard, tr.dataset.c, { [f]: val(f) });
          if (bf) {
            const b = boardByName(doc, bilanBoard);
            doc.modify(b.id, (x) => { x.elec = { ...x.elec, [bf]: raw === '' ? undefined : bf === 'supplyMethod' || bf === 'supply' ? raw : Number(raw) }; });
          }
        });
        renderBilan();
      });
    }
    renderBilan();
    if (!bilan.open) bilan.show();
  }

  function bilanRows(doc) {
    const inst = computeInstallation(doc, { unitM: unitM(doc) });
    const rows = [];
    for (const [name, info] of inst) {
      for (const c of info.circuits) {
        const r = c.r;
        rows.push([name, c.def.id, c.def.label || (c.def.sub ? `Tableau ${c.def.sub}` : CIRCUIT_TYPES[c.def.type]?.label || ''), c.devices.length,
          Math.round(c.p), num(r.ks, 2), Math.round(r.pabs), num(r.ib), r.protection, r.method, num(c.len), r.cable, num(r.iz), num(r.duTotal, 2), num(r.lmax, 0),
          c.sc ? Math.round(c.sc.ik1) : '', c.sel ? c.sel.text.replace(/^sélectivité non assurée.*/, 'non assurée') : '', r.ok ? 'OK' : r.warnings.join(' ; ')]);
      }
    }
    return rows;
  }
  const HEAD = ['Tableau', 'Circuit', 'Désignation', 'Appareils', 'P inst. (W)', 'ks', 'P abs. (W)', 'Ib (A)', 'Protection', 'Pose', 'L (m)', 'Câble', 'Iz (A)', 'ΔU cumul (%)', 'L max (m)', 'Ik1 min (A)', 'Sélectivité', 'Contrôle'];

  function exportCsv() {
    const cell = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const text = `﻿${[HEAD, ...bilanRows(editor.doc)].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'Bilan électrique NIBT.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    editor.print('Bilan exporté : Bilan électrique NIBT.csv');
  }

  // Calque des fils et étiquettes d'une alimentation (créé avec sa couleur s'il manque).
  const supplyLayer = (doc, k) => {
    const s = SUPPLIES[k] || SUPPLIES.N;
    if (!doc.layers.has(s.layer)) doc.addLayer(s.layer, { color: s.color });
    return s.layer;
  };

  // Fils : trajet de chaque départ (chemins de câbles, tubes, raccordements) sur le calque de son alimentation
  // (normal, secours, ASI) — couleur du calque. Les fils dessinés auparavant (data « wire ») sont remplacés.
  editor.register('CHEMINEMENT', (ctx) => {
    const { doc } = ctx;
    const inst = computeInstallation(doc, { unitM: unitM(doc) });
    for (const e of [...doc.entities.values()]) if (e.wire || e.layer === 'ELE-CHEMINEMENT') doc.remove(e.id);
    let n = 0, est = 0;
    const per = {};
    for (const [name, info] of inst) {
      for (const c of info.circuits) {
        if (!c.route || !(c.route.routed || c.route.partial)) { if (c.devices.length || c.def.sub) est++; continue; }
        const k = supplyOf(info.board, c.def);
        const layer = supplyLayer(doc, k);
        for (const pts of c.route.paths) {
          if (pts.length < 2) continue;
          doc.add({ type: 'LWPOLYLINE', layer, color: 256, space: 'model', pts: pts.map((q) => [q[0], q[1]]), bulges: pts.map(() => 0), closed: false, z: 0, width: 0, wire: { board: name, circuit: c.def.id } });
        }
        per[k] = (per[k] || 0) + 1;
        n++;
      }
    }
    const parts = Object.entries(per).map(([k, m]) => `${m} ${SUPPLIES[k].short.toLowerCase()} (${SUPPLIES[k].layer})`).join(', ');
    ctx.print(n ? `Fils de ${n} départ(s) dessinés : ${parts}${est ? ` ; ${est} départ(s) sans chemin de câbles (longueur estimée)` : ''}.`
      : 'Aucun départ ne passe par les chemins de câbles (systèmes des données électriques, distance maximale aux appareils).');
  }, { aliases: ['ROUTAGE', 'CHEMCABLES', 'FILS'], label: 'CHEMINEMENT' });

  // Étiquette d'un objet : une colonne par circuit concerné (nom, câble), sur le calque de son alimentation.
  // Appareil : son circuit ; tableau : son alimentation ; boîte, tube, chemin de câbles : circuits qui y passent ;
  // fil (CHEMINEMENT) : son circuit.
  function labelColumns(doc, inst, e) {
    const cols = [];
    const add = (name, info, c) => {
      if (!c || cols.some((x) => x.board === name && x.id === c.def.id)) return;
      cols.push({ board: name, id: c.def.id, title: `${name}.${c.def.id}`, sub: c.def.label || '', cable: c.r?.cable || '', supply: supplyOf(info.board, c.def) });
    };
    const circuit = (name, id) => { const info = inst.get(name); return info && [info, info.circuits.find((x) => x.def.id === id)]; };
    if (e.wire) { const r = circuit(e.wire.board, e.wire.circuit); if (r) add(e.wire.board, ...r); return cols; }
    if (e.type === 'INSERT' && e.elec?.kind === 'board') {
      const info = inst.get(e.elec.board);
      if (info) cols.push({ board: e.elec.board, id: '', title: e.elec.board, sub: e.elec.parent ? `← ${e.elec.parent}` : '', cable: info.supply?.cable || '', supply: supplyOf(info.board, null) });
      return cols;
    }
    if (e.type === 'INSERT' && e.elec?.board && e.elec.circuit) { const r = circuit(e.elec.board, e.elec.circuit); if (r) add(e.elec.board, ...r); return cols; }
    // Boîte : circuits qui empruntent un tube aboutissant à la boîte (un câble qui longe le chemin n'y passe pas).
    const reach = e.type === 'INSERT' ? Math.max(0.6 * Math.abs(e.sx || 1), 200 / (unitM(doc) * 1000)) : 0;
    const tubes = reach ? [...doc.entities.values()].filter((t) => t.mep?.conduit && t.pts?.length > 1 && [t.pts[0], t.pts.at(-1)].some((q) => G.dist(q, e.p) <= reach)).map((t) => t.id) : [];
    for (const [name, info] of inst) {
      for (const c of info.circuits) {
        if (!c.route?.trays) continue;
        if (e.mep && c.route.trays.has(e.id)) add(name, info, c);
        else if (tubes.some((id) => c.route.trays.has(id))) add(name, info, c);
      }
    }
    return cols;
  }
  // Entités de l'étiquette : trait de rappel depuis anchor, tableau de cellules à partir de q (une colonne par circuit).
  function labelEntities(doc, cols, anchor, q, h, group) {
    const out = [];
    const w = (t) => Math.max(t.length * h * 0.72, h * 3) + h * 1.2;
    const colW = cols.map((c) => Math.max(w(c.title), w(c.cable), c.sub ? w(c.sub) : 0));
    const rows = cols.some((c) => c.sub) ? 3 : 2, rh = h * 1.8;
    const total = colW.reduce((s, x) => s + x, 0);
    const right = anchor[0] > q[0]; // étiquette à gauche du point d'attache : rappel sur son bord droit
    let x = right ? q[0] - total : q[0];
    const top = q[1] + (rows * rh) / 2;
    const base = { color: 256, space: doc.currentSpace || 'model', ...(group ? { group } : {}) };
    const firstLayer = cols[0] ? supplyLayer(doc, cols[0].supply) : doc.currentLayer;
    out.push({ ...base, type: 'LINE', layer: firstLayer, p1: [anchor[0], anchor[1], 0], p2: [q[0], q[1], 0] });
    cols.forEach((c, i) => {
      const layer = supplyLayer(doc, c.supply);
      const cells = rows === 3 ? [c.sub, c.title, c.cable] : [c.title, c.cable];
      cells.forEach((t, r) => {
        const y0 = top - (r + 1) * rh, y1 = top - r * rh;
        out.push({ ...base, type: 'LWPOLYLINE', layer, pts: [[x, y0], [x + colW[i], y0], [x + colW[i], y1], [x, y1]], bulges: [0, 0, 0, 0], closed: true, z: 0, width: 0 });
        if (t) out.push({ ...base, type: 'TEXT', layer, p: [x + h * 0.6, (y0 + y1) / 2, 0], h, rot: 0, text: t, align: 'left', valign: 'middle', wf: 1 });
      });
      x += colW[i];
    });
    return out;
  }
  editor.register('ETIQCIRCUIT', async (ctx) => {
    const { doc } = ctx;
    const h = textHeight(doc);
    let k = 1;
    const used = new Set([...doc.entities.values()].map((e) => e.group).filter(Boolean));
    for (;;) {
      const pick = await ctx.getEntity('Objet à étiqueter (appareil, boîte, tube, chemin de câbles, fil, tableau)', { allowNone: true });
      if (!pick) return;
      const e = doc.get(pick.id);
      const inst = computeInstallation(doc, { unitM: unitM(doc) });
      const cols = e ? labelColumns(doc, inst, e) : [];
      if (!cols.length) { ctx.print('Aucun circuit sur cet objet (rattachez les appareils à un circuit, dessinez les chemins et les tubes).'); continue; }
      let anchor = pick.p || e.p;
      if (e.type === 'INSERT') anchor = e.p;
      else if (e.pts) {
        let bd = Infinity;
        for (let i = 1; i < e.pts.length; i++) { const r = G.closestOnSegment(pick.p, e.pts[i - 1], e.pts[i]); if (r.d < bd) { bd = r.d; anchor = r.point; } }
      }
      const at = await ctx.getPoint('Position de l’étiquette', { base: anchor, preview: (q) => labelEntities(doc, cols, anchor, q, h, null) });
      while (used.has(`ETIQ${k}`)) k++;
      const group = `ETIQ${k}`;
      used.add(group);
      for (const x of labelEntities(doc, cols, anchor, at, h, group)) doc.add(x);
      ctx.print(`Étiquette : ${cols.map((c) => `${c.title}${c.cable ? ` ${c.cable}` : ''}`).join(' · ')}.`);
    }
  }, { aliases: ['ETIQE', 'ETIQUETTE', 'ETIQFIL'], label: 'ETIQCIRCUIT' });

  editor.register('BILANELEC', () => openBilan(), { aliases: ['BILAN', 'NIBT', 'DIMELEC'], label: 'BILANELEC', transaction: false });

  // Insertion d'un bloc (tableau, schéma, légende) au point désigné.
  async function placeBlock(ctx, prefix, entities, prompt) {
    const { doc } = ctx;
    let k = 1;
    while (doc.blocks.has(`${prefix}${k}`)) k++;
    const name = `${prefix}${k}`;
    doc.blocks.set(name, { name, base: [0, 0, 0], flags: 0, xref: false, entities });
    const mk = (q) => ({ type: 'INSERT', name, p: [q[0], q[1], 0], sx: 1, sy: 1, sz: 1, rot: 0, cols: 1, rows: 1, dc: 0, dr: 0, attribs: [], layer: doc.currentLayer, color: 256, space: doc.currentSpace || 'model' });
    const p = await ctx.getPoint(prompt, { preview: (q) => [mk(q)] });
    doc.add(mk(p));
    return name;
  }
  const textHeight = (doc) => 2.5 * ((doc.currentSpace || 'model') !== 'model' ? 1 : annoScale(doc));

  editor.register('BILANTABLE', async (ctx) => {
    const rows = bilanRows(ctx.doc);
    if (!rows.length) { ctx.print('Aucun circuit à présenter.'); return; }
    const t = tableEntities(HEAD, rows, { h: textHeight(ctx.doc), title: 'BILAN DE PUISSANCE ET DIMENSIONNEMENT (NIBT)', numeric: [3, 4, 5, 6, 7, 10, 12, 13, 14, 15] });
    await placeBlock(ctx, 'CV_BILAN_', t.entities, 'Coin supérieur gauche du bilan');
    ctx.print(`Bilan inséré (${rows.length} circuits).`);
  }, { aliases: ['TABLEBILAN'], label: 'BILANTABLE' });

  editor.register('UNIFILAIRE', async (ctx) => {
    const { doc } = ctx;
    const inst = computeInstallation(doc, { unitM: unitM(doc) });
    const names = [...inst.keys()];
    if (!names.length) { ctx.print('Aucun tableau dans le dessin.'); return; }
    const name = state.schemaBoard && names.includes(state.schemaBoard) ? state.schemaBoard
      : names.length === 1 ? names[0] : await ctx.getKeyword('Tableau', [...names, 'Tous'], { default: names[0] });
    state.schemaBoard = null;
    // Une présentation par page, prête à imprimer (échelle 1:1 sur la feuille, cartouche) : A4 paysage si le tableau
    // tient sur une page (12 départs), sinon pages A3 (18 départs). Présentations « Unifilaire <tableau> » refaites
    // à chaque fois (contenu et mise en page remplacés).
    const date = new Date().toLocaleDateString('fr-CH');
    const project = (doc.fileName || '').replace(/\.[^.]+$/, '');
    const boardsToDraw = name === 'Tous' ? names : [name];
    const LAYER = 'ELE-UNIFILAIRE';
    if (!doc.layers.has(LAYER)) doc.addLayer(LAYER, { color: 7 });
    const created = [];
    const formats = {};
    for (const b of boardsToDraw) {
      const info = inst.get(b);
      const paper = info.circuits.length <= circuitsPerPage('A4') ? 'A4' : 'A3';
      const pages = singleLinePages(info, { h: 2.5, project, date, paper, perPage: circuitsPerPage(paper) });
      pages.forEach((pg, i) => {
        const label = `Unifilaire ${b}${pages.length > 1 ? ` (${i + 1}-${pages.length})` : ''}`;
        const plot = makePlot(paper, true);
        let sp = doc.spaces.find((s) => s.label.toLowerCase() === label.toLowerCase());
        if (sp) {
          for (const e of [...doc.entities.values()]) if (e.space === sp.id) doc.remove(e.id);
          doc.updateSpace(sp.id, { plot });
        } else {
          let k = 1;
          while (doc.spaces.some((s) => s.id === `*Paper_Space_CV${k}`)) k++;
          sp = { id: `*Paper_Space_CV${k}`, label, order: doc.spaces.length, plot };
          doc.setSpaces([...doc.spaces, sp]);
        }
        // Coordonnées de la page : coin supérieur gauche en (0, 0) ; feuille : coin inférieur gauche en (0, 0).
        const dy = pg.height;
        for (const e of pg.entities) {
          const base = { ...e, layer: LAYER, color: e.color === 0 ? 256 : e.color, space: sp.id };
          doc.add(e.type === 'LINE' ? { ...base, p1: [e.p1[0], e.p1[1] + dy, 0], p2: [e.p2[0], e.p2[1] + dy, 0] }
            : e.type === 'TEXT' ? { ...base, p: [e.p[0], e.p[1] + dy, 0] } : { ...base, pts: e.pts.map((q) => [q[0], q[1] + dy]) });
        }
        created.push(sp.id);
        formats[paper] = (formats[paper] || 0) + 1;
      });
    }
    ctx.editor.ui.onSpaces?.(created[0]);
    ctx.print(`Schéma unifilaire : ${boardsToDraw.length} tableau(x), ${created.length} présentation(s) ${Object.entries(formats).map(([f, n]) => `${n} ${f}`).join(' + ')} paysage, prête(s) à imprimer.`);
  }, { aliases: ['SCHEMA', 'UNIF'], label: 'UNIFILAIRE' });

  editor.register('LEGENDEELEC', async (ctx) => {
    const { doc } = ctx;
    const devs = [...devices(doc), ...boards(doc)].filter((d) => (d.space || 'model') === 'model');
    if (!devs.length) { ctx.print('Aucun symbole électrique dans le dessin.'); return; }
    const l = legendEntities(doc, devs, { size: sizeOf(doc), h: textHeight(doc) });
    await placeBlock(ctx, 'CV_LEGENDE_', l.entities, 'Coin supérieur gauche de la légende');
    ctx.print(`Légende insérée (${new Set(devs.map((d) => d.elec.block || d.elec.sym)).size} symboles).`);
  }, { aliases: ['LEGENDE', 'LEG'], label: 'LEGENDEELEC' });

  editor.register('ETIQELEC', (ctx) => {
    const { doc } = ctx;
    let n = 0;
    for (const d of [...devices(doc), ...boards(doc)]) { doc.modify(d.id, (x) => { refreshAttribs(x); }); n++; }
    ctx.print(`${n} étiquette(s) mise(s) à jour.`);
  }, { aliases: ['ETIQUETTESELEC'], label: 'ETIQELEC' });

  return {
    state, openPalette, openBilan, loadLibrary: loadLib,
    get library() { return lib.lib; },
    useLibrary(l) { lib.lib = l; lib.error = ''; }, // bibliothèque déjà prête (tests, autre source)
    get bilanBoard() { return bilanBoard; },
  };
}

export { PREFIX, ensureSymbolBlock };
