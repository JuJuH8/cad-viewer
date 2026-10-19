// SPDX-License-Identifier: GPL-3.0-or-later
// Interface de l'éditeur de blocs : barre d'outils (paramètres, visibilité, enregistrer / fermer), gestionnaire
// de visibilité (grille objets × états, plusieurs paramètres), tables de consultation, liste des paramètres et
// actions ; menu des choix sur la poignée triangle d'une insertion.
import { PARAM_TYPES, ACTION_TYPES, defaultValue, describeValue, withValue, valueOf, choicesOf, CUSTOM_ROW } from './dynamic.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (v) => parseFloat(String(v).replace(',', '.'));
const fmtLen = (v) => String(Math.round(v * 1000) / 1000).replace('.', ',');
const TYPE_LABELS = { LINE: 'Ligne', LWPOLYLINE: 'Polyligne', CIRCLE: 'Cercle', ARC: 'Arc', TEXT: 'Texte', MTEXT: 'Texte multiligne', ATTDEF: 'Attribut', INSERT: 'Bloc', HATCH: 'Hachure', SOLID: 'Solide', ELLIPSE: 'Ellipse', SPLINE: 'Spline', POINT: 'Point' };

function dialog(id) {
  let d = document.getElementById(id);
  if (!d) {
    d = document.createElement('dialog');
    d.id = id;
    d.className = 'qto';
    document.body.appendChild(d);
  }
  return d;
}

// --- barre de l'éditeur ----------------------------------------------------------------------------

export function renderBlockBar(host, session, editor) {
  let bar = document.getElementById('block-bar');
  if (!session.editing) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'block-bar';
    bar.className = 'block-bar';
    host.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
      if (cmd) { editor.cancel?.(); editor.run(cmd); }
    });
    bar.addEventListener('change', (e) => {
      if (e.target.dataset.k === 'vis') session.setVisState(e.target.value);
      if (e.target.dataset.k === 'visparam') session.setVisParam(e.target.value);
      renderBlockBar(host, session, editor);
    });
  }
  const dyn = session.dyn();
  const all = session.visibilities();
  const vis = session.visibility();
  bar.innerHTML = `<span class="bb-title">Éditeur de blocs — <b>${esc(session.name)}</b>${dyn.params.length ? ` <span class="muted">· ${dyn.params.length} paramètre(s)</span>` : ''}</span>
    <span class="bb-group"><span class="muted">Paramètres</span>
      <button class="btn small" data-cmd="PARAMLIN" title="Longueur réglable (étirer, déplacer, échelle)">Linéaire</button>
      <button class="btn small" data-cmd="PARAMPOINT" title="Position réglable (déplacer, étirer)">Point</button>
      <button class="btn small" data-cmd="PARAMROT" title="Angle réglable (rotation)">Rotation</button>
      <button class="btn small" data-cmd="PARAMINV" title="Symétrie (inversion)">Inversion</button>
      <button class="btn small" data-cmd="PARAMCONSULT" title="Table de consultation : des choix nommés qui règlent plusieurs paramètres">Table</button>
      <button class="btn small" data-cmd="BPARAMETRES" title="Liste des paramètres et actions : valeurs, bornes, pas, tables">Liste…</button></span>
    <span class="bb-group"><span class="muted">Visibilité</span>
      ${vis ? `${all.length > 1 ? `<select data-k="visparam" title="Paramètre de visibilité actif">${all.map((v) => `<option value="${esc(v.id)}" ${v.id === vis.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>` : ''}
      <select data-k="vis" title="État affiché">${vis.states.map((s) => `<option ${s === session.visState() ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <button class="btn small" data-cmd="BVNOUVEAU">Nouvel état</button>
      <button class="btn small" data-cmd="BVCACHER" title="Cacher les objets choisis dans cet état">Cacher</button>
      <button class="btn small" data-cmd="BVMONTRER" title="Montrer des objets cachés dans cet état">Montrer</button>
      <button class="btn small ${session.active.showHidden ? 'primary' : ''}" data-cmd="BVMODE" title="Afficher aussi les objets cachés">Tout afficher</button>
      <button class="btn small" data-cmd="VISIBILITE" title="Gestionnaire : grille objets × états, paramètres, ordre, noms">Gérer…</button>
      <button class="btn small" data-cmd="BVPARAM" title="Autre paramètre de visibilité, aux états indépendants">+ Paramètre</button>`
    : '<button class="btn small" data-cmd="VISIBILITE" title="Ajouter des états de visibilité (variantes du bloc)">Ajouter…</button>'}</span>
    <span class="bb-group"><button class="btn small" data-cmd="BPOINTBASE">Point de base</button></span>
    <span class="grow"></span>
    <button class="btn small primary" data-cmd="BENREG">Enregistrer</button>
    <button class="btn small" data-cmd="BFERMER">Fermer</button>`;
}

// --- gestionnaire de visibilité ---------------------------------------------------------------------

// Grille objets × états du paramètre choisi (case cochée : objet visible dans l'état), comme le gestionnaire
// de visibilité d'AutoCAD en plus direct. Plusieurs paramètres de visibilité : onglets.
export function openVisStates(session, onChange = () => {}, editor = null) {
  const dlg = dialog('vis-states');
  let addMode = 'copy';
  const update = (fn, label) => {
    const dyn = session.dyn();
    const v = dyn.params.find((p) => p.id === session.visibility()?.id);
    if (!v) return;
    fn(v, dyn);
    session.setDyn(dyn, label);
    render();
    onChange();
  };
  const render = () => {
    const vis = session.visibility();
    if (!vis) { dlg.close(); return; }
    const all = session.visibilities();
    const ents = [...session.doc.entities.values()];
    const cur = session.visState();
    const hidden = (st) => new Set(vis.hidden?.[st] || []);
    const sets = Object.fromEntries(vis.states.map((s) => [s, hidden(s)]));
    const head = vis.states.map((s, i) => `<th class="vis-col ${s === cur ? 'cur' : ''}" data-i="${i}">
        <input class="vis-name" data-k="name" value="${esc(s)}" title="Nom de l’état">
        <div class="vis-tools"><button class="link" data-act="cur" title="Afficher cet état dans l’éditeur">${s === cur ? '● affiché' : '○ afficher'}</button>
        <button class="link" data-act="left" ${i ? '' : 'disabled'} title="Déplacer vers la gauche (le premier état est celui des nouvelles insertions)">◂</button>
        <button class="link" data-act="right" ${i < vis.states.length - 1 ? '' : 'disabled'} title="Déplacer vers la droite">▸</button>
        <button class="link" data-act="col-all" title="Tout visible dans cet état">tout</button>
        <button class="link" data-act="col-none" title="Tout caché dans cet état">rien</button>
        <button class="link del" data-act="del" ${vis.states.length > 1 ? '' : 'disabled'} title="Supprimer l’état">×</button></div></th>`).join('');
    const rows = ents.map((e) => {
      const what = TYPE_LABELS[e.type] || e.type;
      const extra = e.type === 'ATTDEF' ? ` ${e.tag}` : e.type === 'TEXT' || e.type === 'MTEXT' ? ` « ${String(e.text).slice(0, 18)} »` : e.type === 'INSERT' ? ` ${e.name}` : '';
      return `<tr data-k="${e.id}"><td class="vis-obj" title="Calque ${esc(e.layer)}">${esc(what + extra)} <span class="muted">${esc(e.layer)}</span>
        <button class="link" data-act="row-all" title="Visible dans tous les états">tous</button></td>
        ${vis.states.map((s) => `<td class="c"><input type="checkbox" data-s="${esc(s)}" ${sets[s].has(e.id) ? '' : 'checked'}></td>`).join('')}</tr>`;
    }).join('');
    dlg.innerHTML = `<h2>Visibilité — ${esc(session.name)}</h2>
      <div class="elec-cats">${all.map((v) => `<button class="btn ${v.id === vis.id ? 'primary' : ''}" data-param="${esc(v.id)}">${esc(v.name)}</button>`).join('')}
        <button class="btn" data-act="new-param" title="Paramètre de visibilité supplémentaire (états indépendants)">+ Paramètre</button></div>
      <div class="fond-row"><label>Nom du paramètre <input data-k="pname" value="${esc(vis.name)}"></label>
        <button class="btn small" data-act="del-param" title="Supprimer ce paramètre de visibilité">Supprimer le paramètre</button></div>
      <div class="qto-scroll vis-scroll"><table class="vis-grid"><thead><tr><th>Objet</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="fond-row"><input data-k="new" placeholder="Nom du nouvel état">
        <select data-k="mode"><option value="copy" ${addMode === 'copy' ? 'selected' : ''}>Comme l’état affiché</option><option value="all" ${addMode === 'all' ? 'selected' : ''}>Tout visible</option><option value="none" ${addMode === 'none' ? 'selected' : ''}>Tout caché</option></select>
        <button class="btn" data-act="add">Ajouter l’état</button>
        <button class="btn" data-act="dup" title="Copie de l’état affiché">Dupliquer l’état affiché</button></div>
      <p class="muted">Case cochée : l’objet est visible dans l’état. Le premier état est celui des nouvelles insertions ; un objet caché par l’un des paramètres est caché. Survolez une ligne pour repérer l’objet dans le dessin.</p>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };
  dlg.onclick = (e) => {
    const pid = e.target.closest('[data-param]')?.dataset.param;
    if (pid) { session.setVisParam(pid); render(); onChange(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    const vis = session.visibility();
    if (!act || !vis) return;
    const i = +e.target.closest('[data-i]')?.dataset.i;
    const k = +e.target.closest('tr[data-k]')?.dataset.k;
    const keys = [...session.doc.entities.keys()];
    if (act === 'close') { dlg.close(); return; }
    if (act === 'cur') { session.setVisState(vis.states[i]); render(); onChange(); }
    if (act === 'left' || act === 'right') {
      const j = act === 'left' ? i - 1 : i + 1;
      update((v) => { [v.states[i], v.states[j]] = [v.states[j], v.states[i]]; }, 'Ordre des états');
    }
    if (act === 'col-all') update((v) => { v.hidden = { ...(v.hidden || {}), [v.states[i]]: [] }; }, 'État : tout visible');
    if (act === 'col-none') update((v) => { v.hidden = { ...(v.hidden || {}), [v.states[i]]: [...keys] }; }, 'État : tout caché');
    if (act === 'del') update((v) => { const s = v.states[i]; v.states.splice(i, 1); if (v.hidden) delete v.hidden[s]; }, 'Supprimer l’état');
    if (act === 'row-all') update((v) => { v.hidden = Object.fromEntries(Object.entries(v.hidden || {}).map(([s, ks]) => [s, ks.filter((x) => x !== k)])); }, 'Objet visible partout');
    if (act === 'add' || act === 'dup') {
      const input = dlg.querySelector('[data-k="new"]');
      let name = input.value.trim();
      if (act === 'dup') { name = `${session.visState()} (copie)`; let n = 2; while (vis.states.includes(name)) name = `${session.visState()} (copie ${n++})`; }
      if (!name || vis.states.includes(name)) { input.focus(); return; }
      const mode = act === 'dup' ? 'copy' : dlg.querySelector('[data-k="mode"]').value;
      const from = session.visState();
      update((v) => {
        v.states.push(name);
        v.hidden = { ...(v.hidden || {}), [name]: mode === 'all' ? [] : mode === 'none' ? [...keys] : [...(v.hidden?.[from] || [])] };
      }, 'Nouvel état de visibilité');
      session.setVisState(name);
      render();
      onChange();
    }
    if (act === 'new-param') { dlg.close(); editor?.run('BVPARAM'); }
    if (act === 'del-param') {
      const dyn = session.dyn();
      dyn.params = dyn.params.filter((p) => p.id !== vis.id);
      session.setDyn(dyn, 'Supprimer le paramètre de visibilité');
      session.setVisParam(null);
      render();
      onChange();
    }
  };
  dlg.onchange = (e) => {
    const vis = session.visibility();
    if (!vis) return;
    const k = e.target.dataset.k;
    if (k === 'mode') { addMode = e.target.value; return; }
    if (k === 'pname') { const nv = e.target.value.trim(); if (nv) update((v) => { v.name = nv; }, 'Renommer le paramètre'); return; }
    if (k === 'name') {
      const i = +e.target.closest('[data-i]').dataset.i;
      const nv = e.target.value.trim();
      const old = vis.states[i];
      if (!nv || vis.states.includes(nv)) { render(); return; }
      const shown = session.visState() === old;
      update((v) => { v.states[i] = nv; if (v.hidden?.[old]) { v.hidden[nv] = v.hidden[old]; delete v.hidden[old]; } }, 'Renommer l’état');
      if (shown) session.setVisState(nv);
      onChange();
      return;
    }
    const st = e.target.dataset.s;
    const key = +e.target.closest('tr[data-k]')?.dataset.k;
    if (st != null && key) {
      const visible = e.target.checked;
      update((v) => {
        const set = new Set(v.hidden?.[st] || []);
        if (visible) set.delete(key); else set.add(key);
        v.hidden = { ...(v.hidden || {}), [st]: [...set] };
      }, visible ? 'Montrer dans l’état' : 'Cacher dans l’état');
    }
  };
  // Survol d'une ligne : l'objet est mis en évidence dans l'éditeur.
  dlg.onmouseover = (e) => {
    const k = +e.target.closest('tr[data-k]')?.dataset.k;
    session.renderer.setHover(k || null);
  };
  dlg.onclose = () => session.renderer.setHover(null);
  render();
  if (!dlg.open) dlg.showModal();
}

// --- table de consultation ---------------------------------------------------------------------------

export function openLookupTable(session, paramId, onChange = () => {}) {
  const dlg = dialog('lookup-table');
  const update = (fn, label) => {
    const dyn = session.dyn();
    const p = dyn.params.find((x) => x.id === paramId);
    if (!p) return;
    fn(p, dyn);
    session.setDyn(dyn, label);
    render();
    onChange();
  };
  const render = () => {
    const dyn = session.dyn();
    const p = dyn.params.find((x) => x.id === paramId);
    if (!p) { dlg.close(); return; }
    const cols = dyn.params.filter((x) => x.type !== 'lookup' && x.type !== 'point');
    const cell = (row, q) => {
      const v = row.values?.[q.id];
      if (q.type === 'visibility') return `<select data-q="${esc(q.id)}"><option value="">—</option>${q.states.map((s) => `<option ${s === v ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
      if (q.type === 'flip') return `<select data-q="${esc(q.id)}"><option value="">—</option><option value="0" ${v === 0 ? 'selected' : ''}>Normal</option><option value="1" ${v === 1 ? 'selected' : ''}>Inversé</option></select>`;
      if (q.type === 'rotation') return `<input data-q="${esc(q.id)}" value="${v != null ? fmtLen((v * 180) / Math.PI) : ''}" placeholder="—" size="5"> °`;
      return `<input data-q="${esc(q.id)}" value="${v != null ? fmtLen(v) : ''}" placeholder="—" size="7">`;
    };
    dlg.innerHTML = `<h2>Table de consultation « ${esc(p.name)} » — ${esc(session.name)}</h2>
      ${cols.length ? `<div class="qto-scroll"><table class="settings-table lookup-grid"><thead><tr><th>Choix (nom affiché)</th>${cols.map((q) => `<th>${esc(q.name)} <span class="muted">${PARAM_TYPES[q.type]}</span></th>`).join('')}<th></th></tr></thead>
      <tbody>${(p.rows || []).map((r, i) => `<tr data-i="${i}"><td><input data-k="label" value="${esc(r.label)}"></td>${cols.map((q) => `<td>${cell(r, q)}</td>`).join('')}
        <td><button class="link" data-act="up" ${i ? '' : 'disabled'}>↑</button> <button class="link del" data-act="del">×</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Aucun paramètre à piloter.</p>'}
      <div class="fond-row"><button class="btn" data-act="add">Ajouter une ligne</button><span class="muted">« — » : la ligne ne change pas ce paramètre.</span></div>
      <p class="muted">Sur une insertion, la poignée triangle et Propriétés proposent ces choix ; régler un paramètre à la main affiche « ${CUSTOM_ROW} » si aucune ligne ne correspond.</p>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };
  dlg.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const i = +e.target.closest('tr[data-i]')?.dataset.i;
    if (act === 'close') dlg.close();
    if (act === 'add') update((p) => {
      let n = (p.rows || []).length + 1, label = `Choix ${n}`;
      while ((p.rows || []).some((r) => r.label === label)) label = `Choix ${++n}`;
      p.rows = [...(p.rows || []), { label, values: {} }];
    }, 'Ligne de la table');
    if (act === 'del') update((p) => { p.rows.splice(i, 1); }, 'Supprimer la ligne');
    if (act === 'up') update((p) => { [p.rows[i - 1], p.rows[i]] = [p.rows[i], p.rows[i - 1]]; }, 'Ordre des lignes');
  };
  dlg.onchange = (e) => {
    const i = +e.target.closest('tr[data-i]')?.dataset.i;
    if (Number.isNaN(i)) return;
    const k = e.target.dataset.k, q = e.target.dataset.q;
    const raw = e.target.value.trim();
    update((p, dyn) => {
      const row = p.rows[i];
      if (k === 'label') { if (raw && !p.rows.some((r, j) => j !== i && r.label === raw)) row.label = raw; return; }
      const qp = dyn.params.find((x) => x.id === q);
      const values = { ...(row.values || {}) };
      if (raw === '') delete values[q];
      else if (qp.type === 'visibility') values[q] = raw;
      else if (qp.type === 'flip') values[q] = +raw;
      else if (qp.type === 'rotation') { const n = parse(raw); if (Number.isFinite(n)) values[q] = (n * Math.PI) / 180; }
      else { const n = parse(raw); if (n > 0) values[q] = n; }
      row.values = values;
    }, 'Valeur de la table');
  };
  render();
  if (!dlg.open) dlg.showModal();
}

// --- paramètres et actions -------------------------------------------------------------------------------

export function openBlockParams(session, onChange = () => {}, openLookup = null) {
  const dlg = dialog('block-params');
  const update = (fn, label) => {
    const dyn = session.dyn();
    fn(dyn);
    session.setDyn(dyn, label);
    render();
    onChange();
  };
  const render = () => {
    const dyn = session.dyn();
    const rows = dyn.params.map((p) => {
      const acts = dyn.actions.filter((a) => a.param === p.id);
      const opts = p.type === 'linear' ? `
          <label>Min <input data-f="min" value="${p.min != null ? fmtLen(p.min) : ''}" size="5"></label>
          <label>Max <input data-f="max" value="${p.max != null ? fmtLen(p.max) : ''}" size="5"></label>
          <label>Pas <input data-f="step" value="${p.step ? fmtLen(p.step) : ''}" size="5"></label>
          <label>Liste <input data-f="list" value="${(p.list || []).map(fmtLen).join('; ')}" placeholder="ex. 600; 900; 1200" size="14"></label>`
        : p.type === 'visibility' ? `<span class="muted">${p.states.length} état(s)</span>`
          : p.type === 'lookup' ? `<button class="btn small" data-act="table">Table (${(p.rows || []).length} ligne(s))…</button>` : '';
      return `<tr data-p="${esc(p.id)}"><td><input data-f="name" value="${esc(p.name)}" size="12"></td><td>${PARAM_TYPES[p.type]}</td>
        <td>${esc(describeValue(p, defaultValue(p), fmtLen))}</td><td class="par-opts">${opts}</td>
        <td>${acts.map((a) => `<span class="act-chip">${ACTION_TYPES[a.type]} (${a.keys.length}) <button class="link" data-act="del-action" data-a="${esc(a.id)}" title="Retirer l’action">×</button></span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td><button class="btn small" data-act="del-param">Supprimer</button></td></tr>`;
    }).join('');
    dlg.innerHTML = `<h2>Paramètres du bloc — ${esc(session.name)}</h2>
      ${dyn.params.length ? `<div class="qto-scroll"><table class="settings-table"><thead><tr><th>Nom</th><th>Type</th><th>Défaut</th><th>Valeurs admises</th><th>Actions</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">Aucun paramètre : barre de l’éditeur → Linéaire, Point, Rotation, Inversion, Table ou Visibilité.</p>'}
      <p class="muted">Linéaire : sans bornes, la longueur est libre ; un pas ou une liste limite les valeurs (comme les jeux de valeurs d’AutoCAD).</p>
      <div class="qto-actions"><button class="btn" data-act="close">Fermer</button></div>`;
  };
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    const pid = e.target.closest('tr[data-p]')?.dataset.p;
    if (act === 'close') dlg.close();
    if (act === 'table' && pid) { dlg.close(); openLookup?.(pid); }
    if (act === 'del-param') update((d) => {
      d.params = d.params.filter((p) => p.id !== pid);
      d.actions = d.actions.filter((a) => a.param !== pid);
      for (const p of d.params) if (p.type === 'lookup') for (const r of p.rows || []) delete r.values?.[pid];
    }, 'Supprimer le paramètre');
    if (act === 'del-action') { const aid = e.target.dataset.a; update((d) => { d.actions = d.actions.filter((a) => a.id !== aid); }, 'Supprimer l’action'); }
  };
  dlg.onchange = (e) => {
    const f = e.target.dataset.f;
    const pid = e.target.closest('tr[data-p]')?.dataset.p;
    if (!f || !pid) return;
    const v = e.target.value.trim();
    update((d) => {
      const p = d.params.find((x) => x.id === pid);
      if (f === 'name') { if (v) p.name = v; return; }
      if (f === 'list') {
        const list = v.split(/[;\s]+/).map(parse).filter((x) => x > 0);
        if (list.length) p.list = [...new Set(list)].sort((a, b) => a - b); else delete p.list;
        return;
      }
      const n = parse(v);
      if (v === '' || !(n > 0)) delete p[f]; else p[f] = n;
    }, 'Réglage du paramètre');
  };
  render();
  if (!dlg.open) dlg.showModal();
}

// --- menu des choix d'une insertion ------------------------------------------------------------------

let menu = null;
export function showVisibilityMenu(doc, id, paramId, [x, y], host) {
  menu?.remove();
  const e = doc.get(id);
  const p = doc.blocks.get(e?.name)?.dyn?.params.find((q) => q.id === paramId);
  if (!p) return;
  const cur = valueOf(p, e.dyn);
  const r = host.getBoundingClientRect();
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `<div class="ctx-title">${esc(p.name)}</div>${choicesOf(p).map((s) => `<button data-s="${esc(s)}">${s === cur ? '✓ ' : ''}${esc(s)}</button>`).join('')}`;
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(r.left + x + 8, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(r.top + y + 8, innerHeight - menu.offsetHeight - 4)}px`;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!menu?.contains(ev.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  menu.addEventListener('click', (ev) => {
    const s = ev.target.dataset.s;
    if (s == null) return;
    close();
    const cur2 = doc.get(id);
    if (cur2) doc.transaction(p.type === 'lookup' ? 'Choix du bloc' : 'Visibilité du bloc', () => doc.update(withValue(doc, cur2, paramId, s)));
  });
}
