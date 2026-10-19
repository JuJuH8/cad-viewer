// SPDX-License-Identifier: GPL-3.0-or-later
// Commandes et boîte de dialogue « Fonds de plan » : attacher une base architecte, la recharger, la remplacer
// par une nouvelle version, comparer les versions, la traiter (profils partagés avec le module AutoCAD LT).

import { loadProfiles, saveProfile, parseTpp, serializeTpp, defaults } from './profiles.js';
import { parseLayerTable, exportLayerTable } from './layertable.js';
import { cleanDocument } from './clean.js';
import {
  attachFond, replaceFond, detachFond, listFonds, fondInserts, setFondMeta, compareVersions, cloudZones,
  xrefContent, fillFond, FOND_LAYER,
} from './fonds.js';
import { pickDrawing, storeHandle, readSource, sourceInfo } from './sources.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PREF = 'cadviewer.fonds';
const UNITS = [[0, 'Automatique'], [4, 'mm'], [5, 'cm'], [14, 'dm'], [6, 'm'], [1, 'pouces'], [2, 'pieds']];

function prefs() {
  try { return { profile: 'Base architecte', fade: 50, table: null, tableName: '', unit: 0, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { profile: 'Base architecte', fade: 50, unit: 0 }; }
}
function savePrefs(p) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* stockage indisponible */ } }

function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const dateFr = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

// loadDocument(buffer, name) → Document importé (fourni par l'appli : lecture DWG/DXF/IFC).
export function registerFondCommands(editor, { loadDocument, busy = async () => {}, onCompare = () => {} }) {
  const state = { comparison: null, pending: null, newer: new Map() };
  const ifcBuffers = new Map(); // nom du fond → fichier IFC lu (volumes de la vue 3D)

  // Lecture + traitement d'une base selon le profil et la table choisis.
  async function prepare(buffer, fileName, cfg, table, unit, ifc = null) {
    try {
      await busy(`Lecture de « ${fileName} »…`);
      // IFC : niveau et hauteur de coupe demandés au premier chargement, repris pour les versions suivantes.
      const xdoc = await loadDocument(buffer, fileName, { ifc, chooseStorey: async (storeys) => { await busy(null); const r = await askIfcOptions(storeys); await busy('Coupe de la maquette IFC…'); return r; } });
      if (unit) xdoc.header = { ...(xdoc.header || {}), insunits: unit };
      await busy('Traitement de la base…');
      const rep = cleanDocument(xdoc, cfg, { table });
      return { xdoc, rep };
    } finally {
      await busy(null);
    }
  }

  function currentSettings() {
    const p = prefs();
    const profiles = loadProfiles();
    const cfg = profiles[p.profile] || profiles['Base architecte'];
    const table = cfg.CONV_CALQUES || p.table ? (p.table ? parseLayerTable(p.table) : null) : null;
    return { p, cfg: { ...cfg, CONV_CALQUES: !!table?.length || cfg.CONV_CALQUES }, table };
  }

  function applyFade() {
    const doc = editor.doc;
    const p = prefs();
    const layers = new Set();
    for (const b of listFonds(doc)) {
      if (b.fond.fade === false) continue;
      for (const l of doc.layers.keys()) if (l.startsWith(`${b.name}|`)) layers.add(l);
    }
    editor.r.setFade(layers.size && p.fade > 0 ? { on: true, layers, amount: Math.min(0.9, p.fade / 100) } : null);
  }

  function showComparison(cmp) {
    state.comparison = cmp;
    editor.r.setMarkup(cmp ? {
      groups: [
        { entities: cmp.removed, color: 0xef4444, opacity: 0.3 },
        { entities: cmp.added, color: 0x22c55e, opacity: 0.3 },
      ],
      boxes: cmp.zones,
    } : null);
    onCompare(cmp);
  }

  async function attachFrom({ buffer, name, source, handle }, insertion) {
    const { p, cfg, table } = currentSettings();
    const { xdoc, rep } = await prepare(buffer, name, cfg, table, p.unit);
    const fname = attachFond(editor.doc, {
      name: name.replace(/\.(dwg|dxf|ifc)$/i, ''), xdoc, insertion,
      meta: { file: name, source, profile: p.profile, table: p.tableName || null, tableRows: table || null, unit: p.unit || 0, mtime: source?.mtime ?? null, report: rep.lines, ...(xdoc.ifc ? { ifc: xdoc.ifc } : {}) },
    });
    if (/\.ifc$/i.test(name)) ifcBuffers.set(fname, buffer);
    if (handle) {
      const key = `${fname}:${Date.now()}`;
      await storeHandle(key, handle).catch(() => {});
      setFondMeta(editor.doc, fname, { source: { kind: 'handle', key, name } });
    }
    for (const l of rep.lines) editor.print(l);
    editor.print(`Fond de plan « ${fname} » attaché (${editor.doc.blocks.get(fname).entities.length} objets, échelle ${editor.doc.blocks.get(fname).fond.scale}).`);
    applyFade();
    return fname;
  }

  // Nouvelle version d'un fond (fichier lu) : traitement identique, remplacement, comparaison affichée.
  async function newVersion(name, { buffer, file, source, mtime }) {
    const doc = editor.doc;
    const fond = doc.blocks.get(name).fond;
    const profiles = loadProfiles();
    const cfg = profiles[fond.profile] || currentSettings().cfg;
    const table = tableOf(fond);
    const { xdoc, rep } = await prepare(buffer, file, { ...cfg, CONV_CALQUES: !!table?.length || cfg.CONV_CALQUES }, table, fond.unit || 0, fond.ifc);
    if (/\.ifc$/i.test(file)) ifcBuffers.set(name, buffer); else ifcBuffers.delete(name);
    const r = replaceFond(doc, name, xdoc, { file, ...(source ? { source } : {}), mtime: mtime ?? Date.now(), report: rep.lines, ...(xdoc.ifc ? { ifc: xdoc.ifc } : {}) });
    for (const l of rep.lines) editor.print(l);
    const cmp = compareVersions(doc, name, r.before, r.after);
    editor.print(`Fond « ${name} » : version ${doc.blocks.get(name).fond.version} — ${cmp.addedCount} objet(s) ajouté(s), ${cmp.removedCount} supprimé(s), ${cmp.zones.length} zone(s) modifiée(s).`);
    state.newer.delete(name);
    renderNotice();
    showComparison(cmp);
    return cmp;
  }

  // Table de calques d'un fond : celle enregistrée avec lui, sinon la table choisie si elle porte le même nom.
  function tableOf(fond) {
    if (fond.tableRows?.length) return fond.tableRows;
    const p = prefs();
    if (fond.table && p.tableName === fond.table && p.table) return parseLayerTable(p.table);
    if (fond.table) editor.print(`Fond : table de calques « ${fond.table} » introuvable, choisissez-la dans FOND pour la réappliquer.`);
    return null;
  }

  // Fonds rouverts sans leur contenu (références externes à chemin connu) : relus et retraités.
  async function loadMissing() {
    const doc = editor.doc;
    for (const b of listFonds(doc)) {
      if (b.entities.length || b.fond.source?.kind !== 'path') continue;
      try {
        const src = await readSource(b.fond.source);
        const profiles = loadProfiles();
        const cfg = profiles[b.fond.profile] || currentSettings().cfg;
        const table = tableOf(b.fond);
        const { xdoc, rep } = await prepare(src.buffer, src.name, { ...cfg, CONV_CALQUES: !!table?.length || cfg.CONV_CALQUES }, table, b.fond.unit || 0, b.fond.ifc);
        if (/\.ifc$/i.test(src.name)) ifcBuffers.set(b.name, src.buffer);
        const n = fillFond(doc, b.name, xdoc);
        if (src.mtime > (b.fond.mtime || 0) + 1000) state.newer.set(b.name, { mtime: src.mtime });
        b.fond.report = rep.lines;
        editor.print(`Fond de plan « ${b.name} » rechargé depuis ${b.fond.source.path} (${n} objets).`);
      } catch (err) {
        editor.print(`Fond de plan « ${b.name} » : ${err.message || err}`);
      }
    }
    applyFade();
    renderNotice();
  }

  // Fichier IFC d'un fond (volumes de la vue 3D) : gardé depuis la lecture, sinon relu depuis sa source.
  async function ifcBuffer(name) {
    if (ifcBuffers.has(name)) return ifcBuffers.get(name);
    const fond = editor.doc.blocks.get(name)?.fond;
    if (!fond?.ifc) throw new Error('ce fond ne vient pas d’une maquette IFC');
    if (!fond.source) throw new Error('fichier IFC d’origine inconnu, rechargez le fond (FOND)');
    const src = await readSource(fond.source);
    ifcBuffers.set(name, src.buffer);
    return src.buffer;
  }

  async function reload(name) {
    const fond = editor.doc.blocks.get(name)?.fond;
    const src = await readSource(fond?.source);
    return newVersion(name, { buffer: src.buffer, file: src.name, mtime: src.mtime });
  }

  async function replaceWithPicked(name) {
    const picked = await pickDrawing();
    if (!picked) return null;
    let source = null;
    if (picked.handle) {
      const key = `${name}:${Date.now()}`;
      await storeHandle(key, picked.handle).catch(() => {});
      source = { kind: 'handle', key, name: picked.file.name };
    }
    return newVersion(name, { buffer: await picked.file.arrayBuffer(), file: picked.file.name, source, mtime: picked.file.lastModified });
  }

  async function replaceWithPath(name, path) {
    const source = { kind: 'path', path };
    const src = await readSource(source);
    return newVersion(name, { buffer: src.buffer, file: src.name, source, mtime: src.mtime });
  }

  // Nouvelles versions enregistrées depuis le chargement (sources lisibles sans autorisation).
  async function checkNewer() {
    const doc = editor.doc;
    if (!doc) return;
    for (const b of listFonds(doc)) {
      const info = await sourceInfo(b.fond.source).catch(() => null);
      if (info && b.fond.mtime && info.mtime > b.fond.mtime + 1000) state.newer.set(b.name, info);
      else state.newer.delete(b.name);
    }
    renderNotice();
    if (dialog?.open) render();
  }

  function renderNotice() {
    let btn = document.getElementById('fond-notice');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'fond-notice';
      btn.className = 'toggle on';
      btn.onclick = () => editor.run('FOND');
      document.querySelector('.statusbar')?.appendChild(btn);
    }
    const names = [...state.newer.keys()];
    btn.hidden = !names.length;
    btn.textContent = names.length ? `Nouvelle version : ${names.join(', ')}` : '';
    btn.title = 'Une nouvelle version du fond de plan a été enregistrée : cliquez pour la charger et voir les changements';
  }
  setInterval(checkNewer, 20000);

  // --- boîte de dialogue --------------------------------------------------------------

  let dialog = null;
  let lastReport = null;

  async function act(fn) {
    try { await fn(); } catch (err) {
      console.error(err);
      editor.print(`Fonds de plan : ${err.message || err}`);
      lastReport = [`Erreur : ${err.message || err}`];
    } finally { await busy(null); render(); }
  }

  function render() {
    if (!dialog) return;
    const doc = editor.doc;
    const fonds = listFonds(doc);
    const p = prefs();
    const profiles = loadProfiles();
    const cmp = state.comparison;
    const rows = fonds.map((b) => {
      const f = b.fond, lay = doc.layers.get(FOND_LAYER(b.name));
      const src = f.source?.kind === 'path' ? f.source.path : f.source?.kind === 'handle' ? `${f.source.name} (fichier choisi)` : f.file;
      const newer = state.newer.get(b.name);
      return `<tr data-name="${esc(b.name)}">
        <td><b>${esc(b.name)}</b><br><span class="muted" title="${esc(src)}">${esc(src || '')}</span>
          ${newer ? `<br><span class="warn">Nouvelle version du ${esc(dateFr(new Date(newer.mtime).toISOString()))}</span>` : ''}</td>
        <td>v${f.version}<br><span class="muted">${esc(dateFr(f.loadedAt))}</span></td>
        <td class="num">${b.entities.length}</td>
        <td><label title="Afficher"><input type="checkbox" data-act="show" ${lay?.on !== false ? 'checked' : ''}></label></td>
        <td><label title="Verrouiller (non sélectionnable, l'accrochage reste actif)"><input type="checkbox" data-act="lock" ${lay?.locked ? 'checked' : ''}></label></td>
        <td><label title="Atténuer"><input type="checkbox" data-act="fade" ${f.fade !== false ? 'checked' : ''}></label></td>
        <td class="fond-actions">
          <button class="btn" data-act="reload" ${f.source ? '' : 'disabled'} title="Relire le fichier d'origine (nouvelle version enregistrée au même endroit)">Recharger</button>
          <button class="btn" data-act="replace" title="Choisir le fichier de la nouvelle version">Nouvelle version…</button>
          <button class="btn" data-act="table" title="Table des calques de la base (CSV pour Excel)">Calques…</button>
          <button class="btn" data-act="detach" title="Retirer le fond (annulable)">Retirer</button>
        </td></tr>`;
    }).join('');
    dialog.innerHTML = `<h2>Fonds de plan</h2>
      ${fonds.length ? `<div class="qto-scroll"><table class="fonds"><thead><tr><th>Fond</th><th>Version</th><th>Objets</th><th>Aff.</th><th>Verr.</th><th>Att.</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="muted">Aucun fond de plan. Attachez la base de l’architecte (DWG ou DXF) : elle est traitée selon le profil choisi, puis insérée comme une référence externe.</p>'}
      <div class="fond-row"><label>Atténuation <input type="range" min="0" max="90" step="5" data-k="fade" value="${p.fade}"> <span>${p.fade} %</span></label></div>
      ${cmp ? `<div class="fond-cmp"><b>Comparaison « ${esc(cmp.name)} »</b> : <span class="add">+${cmp.addedCount} ajouté(s)</span>, <span class="del">−${cmp.removedCount} supprimé(s)</span>, ${cmp.same} inchangé(s) ; ${cmp.zones.length} zone(s) modifiée(s)
        <div class="qto-scroll" style="max-height:20vh"><table><tbody>${cmp.zones.slice(0, 200).map((z, i) => `<tr class="clickable" data-zone="${i}"><td>Zone ${i + 1}</td><td class="add">+${z.added}</td><td class="del">−${z.removed}</td></tr>`).join('')}</tbody></table></div>
        <div class="qto-actions" style="justify-content:flex-start"><button class="btn" data-act="clouds">Nuages de révision</button><button class="btn" data-act="clear-cmp">Effacer la comparaison</button></div></div>` : ''}
      <h3>Attacher une base</h3>
      <div class="fond-row"><label>Profil de traitement <select data-k="profile">${Object.keys(profiles).map((n) => `<option ${n === p.profile ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <button class="btn" data-act="import-tpp" title="Importer un profil du module AutoCAD LT (.tpp)">Importer un profil…</button>
        <button class="btn" data-act="export-tpp" title="Enregistrer le profil choisi au format .tpp (module AutoCAD LT)">Exporter</button></div>
      <div class="fond-row"><label>Table de calques <span class="muted">${esc(p.tableName || 'aucune')}</span></label>
        <button class="btn" data-act="pick-table">Choisir…</button>${p.tableName ? '<button class="btn" data-act="no-table">Aucune</button>' : ''}
        <label>Unité de la base <select data-k="unit">${UNITS.map(([v, n]) => `<option value="${v}" ${v === p.unit ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <div class="fond-row"><button class="btn primary" data-act="attach">Choisir le fichier…</button>
        <span class="muted">ou chemin :</span><input data-k="path" placeholder="C:\\Projets\\Archi\\Base.dwg" style="flex:1;min-width:220px">
        <button class="btn" data-act="attach-path" title="Le fichier est lu par le serveur de l’appli : le fond pourra être rechargé et ses nouvelles versions détectées">Attacher</button></div>
      ${lastReport ? `<details class="fond-report"><summary>Dernier traitement</summary><pre>${esc(lastReport.join('\n'))}</pre></details>` : ''}
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  }

  function openDialog() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'fonds-dialog';
      dialog.className = 'qto';
      document.body.appendChild(dialog);
      dialog.addEventListener('change', onChange);
      dialog.addEventListener('input', (e) => {
        if (e.target.dataset.k === 'fade') { const p = prefs(); p.fade = +e.target.value; savePrefs(p); e.target.nextElementSibling.textContent = `${p.fade} %`; applyFade(); }
      });
      dialog.addEventListener('click', onClick);
    }
    // Le tableau suit le dessin (annuler, calques…) tant que la boîte est ouverte.
    dialog.unsub?.();
    let timer = null;
    dialog.unsub = editor.doc.on(() => { if (dialog.open) { clearTimeout(timer); timer = setTimeout(render, 150); } });
    render();
    if (!dialog.open) dialog.show();
  }

  function onChange(e) {
    const k = e.target.dataset.k, a = e.target.dataset.act;
    const p = prefs();
    if (k === 'profile') { p.profile = e.target.value; savePrefs(p); }
    if (k === 'unit') { p.unit = +e.target.value; savePrefs(p); }
    const name = e.target.closest('tr[data-name]')?.dataset.name;
    if (!name) return;
    const doc = editor.doc;
    const lay = FOND_LAYER(name);
    if (a === 'show' && doc.layers.has(lay)) doc.setLayer(lay, { on: e.target.checked });
    if (a === 'lock' && doc.layers.has(lay)) doc.setLayer(lay, { locked: e.target.checked });
    if (a === 'fade') { setFondMeta(doc, name, { fade: e.target.checked }); applyFade(); }
  }

  function onClick(e) {
    const a = e.target.dataset.act;
    const zone = e.target.closest('tr[data-zone]')?.dataset.zone;
    if (zone != null && state.comparison) {
      const z = state.comparison.zones[+zone];
      const m = Math.max(z.maxX - z.minX, z.maxY - z.minY) * 0.3 + 1;
      editor.r.fit({ minX: z.minX - m, minY: z.minY - m, maxX: z.maxX + m, maxY: z.maxY + m });
      return;
    }
    if (!a) return;
    const name = e.target.closest('tr[data-name]')?.dataset.name;
    const doc = editor.doc;
    if (a === 'close') { dialog.close(); return; }
    if (a === 'attach') act(async () => {
      const picked = await pickDrawing();
      if (!picked) return;
      const n = await attachFrom({ buffer: await picked.file.arrayBuffer(), name: picked.file.name, handle: picked.handle, source: null });
      lastReport = doc.blocks.get(n)?.fond.report;
      editor.r.fit();
    });
    if (a === 'attach-path') act(async () => {
      const path = dialog.querySelector('[data-k="path"]').value.trim().replace(/^"|"$/g, '');
      if (!path) throw new Error('indiquez le chemin complet du fichier (par exemple C:\\Projets\\Base.dwg)');
      const source = { kind: 'path', path };
      const src = await readSource(source);
      const n = await attachFrom({ buffer: src.buffer, name: src.name, source: { ...source, mtime: src.mtime } });
      setFondMeta(doc, n, { source, mtime: src.mtime });
      lastReport = doc.blocks.get(n)?.fond.report;
      editor.r.fit();
    });
    if (a === 'reload') act(async () => { await reload(name); lastReport = doc.blocks.get(name)?.fond.report; });
    if (a === 'replace') act(async () => { await replaceWithPicked(name); lastReport = doc.blocks.get(name)?.fond.report; });
    if (a === 'detach') act(async () => {
      detachFond(doc, name);
      if (state.comparison?.name === name) showComparison(null);
      editor.print(`Fond « ${name} » retiré (U pour annuler).`);
      applyFade();
    });
    if (a === 'table') {
      // Table des calques de la base (noms d'origine, sans le préfixe de la xref).
      const prefix = `${name}|`;
      const tmp = { layers: new Map(), entities: new Map() };
      for (const [n, l] of doc.layers) if (n.startsWith(prefix)) tmp.layers.set(n.slice(prefix.length), { ...l, name: n.slice(prefix.length) });
      let i = 0;
      for (const ent of doc.blocks.get(name).entities) tmp.entities.set(i++, { layer: ent.layer.startsWith(prefix) ? ent.layer.slice(prefix.length) : ent.layer });
      download(`${name} - calques.csv`, exportLayerTable(tmp));
      editor.print(`Table des calques de « ${name} » enregistrée : complétez la colonne « Calque cible » dans Excel, puis choisissez-la comme table de calques.`);
    }
    if (a === 'pick-table') act(async () => {
      const f = await pickText('.csv,.txt');
      if (!f) return;
      const rows = parseLayerTable(f.text);
      const p = prefs(); p.table = f.text; p.tableName = f.name; savePrefs(p);
      editor.print(`Table de calques « ${f.name} » : ${rows.length} ligne(s).`);
    });
    if (a === 'no-table') { const p = prefs(); p.table = null; p.tableName = ''; savePrefs(p); render(); }
    if (a === 'import-tpp') act(async () => {
      const f = await pickText('.tpp');
      if (!f) return;
      const cfg = parseTpp(f.text);
      const n = f.name.replace(/\.tpp$/i, '');
      saveProfile(n, cfg);
      const p = prefs(); p.profile = n; savePrefs(p);
      editor.print(`Profil « ${n} » importé.`);
    });
    if (a === 'export-tpp') {
      const p = prefs();
      const cfg = loadProfiles()[p.profile] || defaults();
      download(`${p.profile}.tpp`, serializeTpp(cfg), 'text/plain');
    }
    if (a === 'clouds' && state.comparison) {
      const n = cloudZones(doc, state.comparison.zones);
      editor.print(`${n} nuage(s) de révision sur le calque FOND-MODIFICATIONS (U pour annuler).`);
    }
    if (a === 'clear-cmp') { showComparison(null); render(); }
  }

  // Maquette IFC : niveau à dessiner et hauteur de coupe (au-dessus du niveau).
  function askIfcOptions(storeys) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'qto';
      d.innerHTML = `<h2>Maquette IFC : plan d’un niveau</h2>
        <div class="fond-row"><label>Niveau <select data-k="storey">${storeys.map((s, i) => `<option value="${i}">${esc(s.name)} (${s.elevation.toFixed(2)} m)</option>`).join('')}</select></label></div>
        <div class="fond-row"><label>Hauteur de coupe au-dessus du niveau <input data-k="cut" value="1.10" size="5"> m</label></div>
        <p class="muted">Les éléments coupés (murs, poteaux, menuiseries) sont en traits épais, les éléments vus en dessous (dalles, escaliers, mobilier, sanitaires) en traits fins.</p>
        <div class="qto-actions"><button class="btn primary" data-act="ok">Dessiner le plan</button><button class="btn" data-act="cancel">Annuler</button></div>`;
      document.body.appendChild(d);
      d.onclick = (e) => {
        const a = e.target.dataset.act;
        if (!a) return;
        const cut = parseFloat(d.querySelector('[data-k="cut"]').value.replace(',', '.'));
        const r = a === 'ok' ? { storey: storeys[+d.querySelector('[data-k="storey"]').value]?.name, cut: cut > 0 ? cut : 1.1 } : null;
        d.close(); d.remove(); resolve(r);
      };
      d.oncancel = () => { d.remove(); resolve(null); };
      d.showModal();
    });
  }

  function pickText(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return resolve(null);
        const buf = await f.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('\ufffd')) text = new TextDecoder('windows-1252').decode(buf); // CSV Excel « ANSI »
        resolve({ name: f.name, text });
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  // --- commandes ---------------------------------------------------------------------

  editor.register('FOND', () => openDialog(), { aliases: ['FONDS', 'FONDPLAN', 'BASEARCHI'], label: 'FOND', transaction: false });

  editor.register('FONDATTACHER', async (ctx) => {
    const picked = await pickDrawing();
    if (!picked) return;
    const pt = await ctx.getKeyword('Point d’insertion', ['Origine', 'Désigner'], { default: 'Origine' }) === 'Désigner'
      ? await ctx.getPoint('Point d’insertion') : [0, 0, 0];
    await act(async () => {
      await attachFrom({ buffer: await picked.file.arrayBuffer(), name: picked.file.name, handle: picked.handle, source: null }, [pt[0], pt[1], 0]);
    });
  }, { aliases: ['FATT', 'XATTACHFOND'], label: 'FONDATTACHER', transaction: false });

  editor.register('FONDRECHARGER', async (ctx) => {
    const fonds = listFonds(ctx.doc);
    if (!fonds.length) { ctx.print('Aucun fond de plan.'); return; }
    const name = fonds.length === 1 ? fonds[0].name : await ctx.getKeyword('Fond à recharger', fonds.map((b) => b.name), { default: fonds[0].name });
    await act(() => reload(name));
  }, { aliases: ['FREC'], label: 'FONDRECHARGER', transaction: false });

  editor.register('FINCOMPARAISON', () => { showComparison(null); }, { aliases: ['FINCOMP'], label: 'FINCOMPARAISON', transaction: false });

  // Accès pour les tests et la console.
  return {
    attachFrom, newVersion, reload, replaceWithPath, replaceWithPicked, checkNewer, applyFade, showComparison, openDialog, loadMissing, ifcBuffer,
    get comparison() { return state.comparison; }, get newer() { return state.newer; },
  };
}

export { xrefContent, fondInserts };
