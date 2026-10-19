// SPDX-License-Identifier: GPL-3.0-or-later
// Panneau « Références » (à côté des calques), comme la palette Références externes d'AutoCAD : chaque
// fond de plan (base DWG / DXF / IFC attachée) et chaque xref d'un fichier ouvert, avec son état (chargée,
// introuvable, nouvelle version), son fichier, et les actions : recharger, nouvelle version, changer le
// chemin, afficher, verrouiller, atténuer, zoomer, retirer.
import { listFonds, fondInserts, detachFond, setFondMeta, FOND_LAYER } from '../archi/fonds.js';
import { getSource, reloadSource, addSource } from '../underlay/sources.js';
import { defName, fileName } from '../underlay/underlay.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const dateFr = (t) => (t ? new Date(t).toLocaleString('fr-CH', { dateStyle: 'short', timeStyle: 'short' }) : '');

// Références du dessin : fonds de plan et xrefs classiques (blocs xref d'un fichier ouvert).
export function listReferences(doc, newer = new Map()) {
  const out = [];
  for (const b of listFonds(doc)) {
    const f = b.fond;
    const src = f.source?.kind === 'path' ? f.source.path : f.source?.kind === 'handle' ? `${f.source.name} (fichier choisi)` : f.file || '';
    const state = !b.entities.length ? 'missing' : newer.has(b.name) ? 'newer' : 'ok';
    out.push({ kind: 'fond', name: b.name, src, state, version: f.version, loadedAt: f.loadedAt, count: b.entities.length, inserts: fondInserts(doc, b.name).length, fade: f.fade !== false, reloadable: !!f.source, ifc: !!f.ifc });
  }
  // Fonds PDF et images (ATTACHER) : une ligne par fichier (et page), avec ses références.
  const uls = new Map();
  for (const e of doc.entities.values()) {
    if (e.type !== 'UNDERLAY') continue;
    const key = `ul:${String(e.path).toLowerCase()}|${e.kind === 'pdf' ? e.page || 1 : 0}`;
    if (!uls.has(key)) uls.set(key, { kind: e.kind, key, name: defName(e), src: e.path, ids: [], show: e.show !== false });
    uls.get(key).ids.push(e.id);
  }
  for (const u of uls.values()) {
    const s = getSource(u.src);
    const state = !s || s.status === 'loading' ? 'loading' : s.status === 'ok' ? 'ok' : 'missing';
    out.push({ ...u, state, error: s?.status === 'error' ? s.error : null, count: u.ids.length, ocg: s?.ocg?.length || 0, pages: s?.pageCount || 1 });
  }
  for (const b of doc.blocks.values()) {
    if (!b.xref || b.fond) continue;
    const inserts = [...doc.entities.values()].filter((e) => e.type === 'INSERT' && e.name === b.name).length;
    out.push({ kind: 'xref', name: b.name, src: b.path || '', state: b.entities.length ? 'ok' : 'missing', count: b.entities.length, inserts });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
}

export class XrefPanel {
  // api : { editor, fonds (API des fonds de plan), loadXrefFiles(files), busy(text) }
  constructor(api) {
    this.api = api;
    this.sel = null;
    this.list = $('xref-list');
    this.list.addEventListener('click', (e) => this.click(e));
    this.list.addEventListener('change', (e) => this.change(e));
    this.list.addEventListener('dblclick', (e) => {
      const name = e.target.closest('li[data-name]')?.dataset.name;
      if (name && !e.target.closest('button, input')) this.zoom(name);
    });
    $('xref-attach').addEventListener('click', () => this.api.editor.run('FONDATTACHER'));
    $('xref-attach-pdf').addEventListener('click', () => this.api.editor.run('ATTACHER'));
    $('xref-manager').addEventListener('click', () => this.api.fonds.openDialog());
    $('xref-reload-all').addEventListener('click', () => this.reloadAll());
  }

  get doc() { return this.api.editor.doc; }

  render() {
    const doc = this.doc;
    if (!doc) return;
    const refs = listReferences(doc, this.api.fonds.newer || new Map());
    const badge = $('xref-count');
    const missing = refs.filter((r) => r.state !== 'ok').length;
    badge.hidden = !refs.length;
    badge.textContent = refs.length;
    badge.classList.toggle('warn', missing > 0);
    badge.title = missing ? `${missing} référence(s) à recharger` : '';
    if (!refs.length) {
      this.list.innerHTML = '<li class="muted" style="cursor:default">Aucune référence. « + Attacher » pour insérer la base de l’architecte (DWG, DXF, IFC) en fond de plan.</li>';
      return;
    }
    this.list.innerHTML = refs.map((r) => {
      if (r.key) return this.underlayRow(r);
      const lay = doc.layers.get(FOND_LAYER(r.name));
      const st = r.state === 'missing' ? 'Introuvable / non chargée' : r.state === 'newer' ? 'Nouvelle version disponible' : 'Chargée';
      const sub = r.kind === 'fond'
        ? `${r.ifc ? 'IFC · ' : ''}v${r.version} · ${r.count} objets · ${dateFr(r.loadedAt)}`
        : `xref · ${r.count} objets · ${r.inserts} insertion(s)`;
      const actions = r.kind === 'fond' ? `
        <div class="xref-actions">
          <button class="btn" data-act="reload" ${r.reloadable ? '' : 'disabled'} title="Relire le fichier d’origine">Recharger</button>
          <button class="btn" data-act="replace" title="Choisir le fichier de la nouvelle version (même position, même traitement)">Nouvelle version…</button>
          <button class="btn" data-act="path" title="Changer le chemin du fichier">Chemin…</button>
          <button class="btn" data-act="zoom" title="Zoomer sur le fond">Zoom</button>
          <button class="btn" data-act="detach" title="Retirer le fond (annulable)">Retirer</button>
          <label><input type="checkbox" data-act="show" ${lay?.on !== false ? 'checked' : ''}> Affiché</label>
          <label><input type="checkbox" data-act="lock" ${lay?.locked ? 'checked' : ''}> Verrouillé</label>
          <label><input type="checkbox" data-act="fade" ${r.fade ? 'checked' : ''}> Atténué</label>
        </div>
        <div class="xref-actions" data-path hidden><input class="xr-path" placeholder="C:\\Projets\\Archi\\Base.dwg" style="flex:1;min-width:0"><button class="btn" data-act="path-ok">OK</button></div>` : `
        <div class="xref-actions">
          ${r.state === 'missing' ? '<button class="btn" data-act="load" title="Choisir le fichier DWG / DXF de la référence">Charger…</button>' : ''}
          <button class="btn" data-act="zoom">Zoom</button>
        </div>`;
      return `<li data-name="${esc(r.name)}" data-kind="${r.kind}" class="${this.sel === r.name ? 'sel' : ''}">
        <div class="xr-name"><span class="st ${r.state === 'ok' ? '' : r.state}" title="${st}"></span>${esc(r.name)}</div>
        <div class="xr-sub" title="${esc(r.src)}">${esc(r.src || '—')}</div>
        <div class="xr-sub">${esc(sub)}</div>
        ${this.sel === r.name ? actions : ''}</li>`;
    }).join('');
  }

  // Ligne d'un fond PDF / image.
  underlayRow(r) {
    const st = r.state === 'missing' ? (r.error ? `Illisible : ${r.error}` : 'Introuvable') : r.state === 'loading' ? 'Chargement…' : 'Chargé';
    const sub = `${r.kind === 'pdf' ? `PDF${r.pages > 1 ? ` · ${r.pages} pages` : ''}${r.ocg ? ` · ${r.ocg} calques` : ''}` : 'Image'} · ${r.count} référence(s)`;
    const actions = `
        <div class="xref-actions">
          <button class="btn" data-act="ul-reload" title="Relire le fichier">Recharger</button>
          <button class="btn" data-act="ul-find" title="Choisir le fichier sur le disque (fichier déplacé ou introuvable)">Rechercher…</button>
          <button class="btn" data-act="path" title="Changer le chemin du fichier">Chemin…</button>
          ${r.kind === 'pdf' && r.ocg ? '<button class="btn" data-act="ul-layers" title="Calques du PDF affichés / masqués">Calques…</button>' : ''}
          <button class="btn" data-act="zoom">Zoom</button>
          <button class="btn" data-act="ul-detach" title="Retirer le fond (annulable)">Détacher</button>
          <label><input type="checkbox" data-act="ul-show" ${r.show ? 'checked' : ''}> Affiché</label>
        </div>
        <div class="xref-actions" data-path hidden><input class="xr-path" placeholder="C:\\Projets\\Archi\\plan.pdf" style="flex:1;min-width:0"><button class="btn" data-act="ul-path-ok">OK</button></div>`;
    return `<li data-name="${esc(r.key)}" data-kind="${r.kind}" class="${this.sel === r.key ? 'sel' : ''}">
        <div class="xr-name"><span class="st ${r.state === 'ok' ? '' : r.state === 'loading' ? 'newer' : 'missing'}" title="${esc(st)}"></span>${esc(r.name)}</div>
        <div class="xr-sub" title="${esc(r.src)}">${esc(r.src || '—')}</div>
        <div class="xr-sub">${esc(sub)}${r.state === 'missing' ? ` · <span class="del">${esc(st)}</span>` : ''}</div>
        ${this.sel === r.key ? actions : ''}</li>`;
  }

  underlayRefs(key) {
    return [...this.doc.entities.values()].filter((e) => e.type === 'UNDERLAY' && `ul:${String(e.path).toLowerCase()}|${e.kind === 'pdf' ? e.page || 1 : 0}` === key);
  }

  async run(fn, label) {
    const { editor, busy } = this.api;
    try {
      if (label) await busy?.(label);
      await fn();
    } catch (err) {
      console.error(err);
      editor.print(`Références : ${err.message || err}`);
    } finally {
      if (label) await busy?.(null);
      this.render();
    }
  }

  click(e) {
    const li = e.target.closest('li[data-name]');
    if (!li) return;
    const name = li.dataset.name;
    const act = e.target.closest('button')?.dataset.act;
    if (!act) {
      if (e.target.closest('input, label')) return;
      this.sel = this.sel === name ? null : name;
      if (name.startsWith('ul:')) {
        if (this.sel) this.api.editor.setSelection(this.underlayRefs(name).map((x) => x.id));
        this.render();
        return;
      }
      // Sélection de la référence : ses insertions sont sélectionnées dans le dessin.
      const ids = [...this.doc.entities.values()].filter((x) => x.type === 'INSERT' && x.name === name).map((x) => x.id);
      if (this.sel && ids.length) this.api.editor.setSelection(ids);
      this.render();
      return;
    }
    const { fonds, editor } = this.api;
    if (act === 'reload') this.run(() => fonds.reload(name), `Rechargement de « ${name} »…`);
    if (act === 'replace') this.run(() => fonds.replaceWithPicked(name));
    if (act === 'path') {
      const row = li.querySelector('[data-path]');
      row.hidden = !row.hidden;
      if (!row.hidden) row.querySelector('input').focus();
    }
    if (act === 'path-ok') {
      const path = li.querySelector('.xr-path').value.trim().replace(/^"|"$/g, '');
      if (!path) { editor.print('Indiquez le chemin complet du fichier (par exemple C:\\Projets\\Base.dwg).'); return; }
      this.run(() => fonds.replaceWithPath(name, path), `Lecture de ${path}…`);
    }
    if (act === 'zoom') this.zoom(name);
    if (act === 'detach') {
      if (detachFond(this.doc, name)) editor.print(`Fond « ${name} » retiré (U pour annuler).`);
      this.sel = null;
      this.render();
    }
    if (act === 'load') this.api.loadXrefFiles?.();
    if (act.startsWith('ul-')) this.underlayAction(act, name, li);
  }

  // Actions sur un fond PDF / image (toutes ses références).
  async underlayAction(act, key, li) {
    const { editor } = this.api;
    const doc = this.doc;
    const refs = this.underlayRefs(key);
    if (!refs.length) return;
    const path = refs[0].path;
    if (act === 'ul-reload') this.run(() => reloadSource(path), `Lecture de ${fileName(path)}…`);
    if (act === 'ul-find') {
      const r = await this.api.pickUnderlayFile?.(path);
      if (!r) return;
      this.run(async () => {
        const src = await addSource(path, await r.file.arrayBuffer());
        editor.print(src.status === 'ok' ? `Fond « ${fileName(path)} » retrouvé (${r.file.name}).` : `Fichier illisible : ${src.error || r.file.name}`);
      }, `Lecture de ${r.file.name}…`);
    }
    if (act === 'ul-path-ok') {
      const p = li.querySelector('.xr-path').value.trim().replace(/^"|"$/g, '');
      if (!p) { editor.print('Indiquez le chemin complet du fichier.'); return; }
      doc.transaction('Chemin du fond', () => { for (const x of refs) doc.modify(x.id, (y) => { y.path = p; }); });
      this.sel = null;
      this.render();
    }
    if (act === 'ul-layers') { editor.setSelection([refs[0].id]); editor.run('CALQUESFOND'); }
    if (act === 'ul-detach') {
      doc.transaction('Détacher le fond', () => { for (const x of refs) doc.remove(x.id); });
      editor.print(`Fond « ${fileName(path)} » détaché (${refs.length} référence(s) ; U pour annuler).`);
      this.sel = null;
      this.render();
    }
  }

  change(e) {
    const li = e.target.closest('li[data-name]');
    const act = e.target.dataset.act;
    if (!li || !act) return;
    const doc = this.doc, name = li.dataset.name, lay = FOND_LAYER(name);
    if (act === 'ul-show') {
      doc.transaction('Afficher le fond', () => { for (const x of this.underlayRefs(name)) doc.modify(x.id, (y) => { y.show = e.target.checked; }); });
      this.render();
      return;
    }
    if (act === 'show' && doc.layers.has(lay)) doc.transaction('Afficher le fond', () => doc.setLayer(lay, { on: e.target.checked }));
    if (act === 'lock' && doc.layers.has(lay)) doc.transaction('Verrouiller le fond', () => doc.setLayer(lay, { locked: e.target.checked }));
    if (act === 'fade') { doc.transaction('Atténuer le fond', () => setFondMeta(doc, name, { fade: e.target.checked })); this.api.fonds.applyFade(); }
    this.render();
  }

  // Zoom sur les insertions d'une référence (emprise affichée).
  zoom(name) {
    const r = this.api.editor.r;
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const ul = name.startsWith('ul:') ? new Set(this.underlayRefs(name).map((x) => x.id)) : null;
    for (const e of this.doc.entities.values()) {
      if (ul ? !ul.has(e.id) : e.type !== 'INSERT' || e.name !== name) continue;
      const box = r.cache.get(e.id)?.box;
      if (!box) continue;
      b.minX = Math.min(b.minX, box.minX); b.minY = Math.min(b.minY, box.minY);
      b.maxX = Math.max(b.maxX, box.maxX); b.maxY = Math.max(b.maxY, box.maxY);
    }
    if (Number.isFinite(b.minX)) r.fit(b);
  }

  async reloadAll() {
    const refs = listReferences(this.doc).filter((x) => x.kind === 'fond' && x.reloadable);
    if (!refs.length) { this.api.editor.print('Aucun fond rechargeable (attachés par un chemin ou un fichier choisi).'); return; }
    for (const x of refs) await this.run(() => this.api.fonds.reload(x.name), `Rechargement de « ${x.name} »…`);
  }
}
