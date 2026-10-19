// SPDX-License-Identifier: GPL-3.0-or-later
// Éditeur de table de styles de tracé, comme l'éditeur d'AutoCAD : à gauche les 255 couleurs d'index (CTB) ou la liste
// des styles nommés (STB : ajouter, renommer, supprimer ; « Normal » est fixe), sélection multiple ; à droite leurs
// réglages — couleur tracée, tramage, niveaux de gris, trame, type de ligne, épaisseur, description. Une table
// intégrée se modifie en copie.
import { aciToColor, toCss } from '../colors.js';
import { LINEWEIGHTS, PLOT_LINETYPES, saveUserTable, writeCtb, objectStyle, isStb, styleKey } from './styles.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const MIXED = '__divers__';

let dlg = null;
// table : table à modifier ; hooks : { onSave(table), download(blob, name) }
export function openCtbEditor(table, hooks = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'ctb-editor';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const t = structuredClone(table);
  const stb = isStb(t);
  const ext = stb ? '.stb' : '.ctb';
  const extRe = stb ? /\.stb$/i : /\.ctb$/i;
  if (t.builtin) { delete t.builtin; t.name = t.name.replace(extRe, '') + ` (copie)${ext}`; }
  let sel = new Set([0]);
  let last = 0;
  let dirty = !!table.builtin;
  const common = (f) => {
    const vals = [...sel].map((i) => f(t.styles[i]));
    return vals.every((v) => v === vals[0]) ? vals[0] : MIXED;
  };
  const swatch = (i) => {
    const c = aciToColor(i + 1);
    return toCss(c === 'fg' ? 0xffffff : c, '#ffffff');
  };
  const render = () => {
    const color = common((s) => (s.color == null ? 'obj' : s.color === 0 ? 'noir' : s.color === 0xffffff ? 'blanc' : 'autre'));
    const rgb = common((s) => s.color);
    const lt = common((s) => (s.linetype == null ? 'obj' : String(s.linetype)));
    const lw = common((s) => (s.lineweight == null ? 'obj' : String(s.lineweight)));
    const screen = common((s) => s.screen ?? 100);
    const dither = common((s) => s.dither !== false);
    const gray = common((s) => !!s.grayscale);
    const desc = common((s) => s.description || '');
    const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    const mixed = (cur) => (cur === MIXED ? `<option value="${MIXED}" selected>*Divers*</option>` : '');
    const list = stb
      ? `<div class="ctb-colors ctb-names">${t.styles.map((s, i) => `<button class="ctb-name ${sel.has(i) ? 'sel' : ''}" data-i="${i}">${esc(s.name)}</button>`).join('')}</div>`
      : `<div class="ctb-colors">${t.styles.map((s, i) => `<button class="ctb-sw ${sel.has(i) ? 'sel' : ''} ${s.color != null || s.lineweight != null || s.linetype != null || (s.screen ?? 100) < 100 || s.grayscale ? 'set' : ''}" data-i="${i}" title="Couleur ${i + 1}" style="background:${swatch(i)}">${i + 1}</button>`).join('')}</div>`;
    const one = [...sel][0];
    const what = sel.size > 1 ? `${sel.size} ${stb ? 'styles choisis' : 'couleurs choisies'}` : stb ? `Style « ${esc(t.styles[one]?.name)} »` : `Couleur ${one + 1}`;
    dlg.innerHTML = `<h2>Table de styles de tracé ${stb ? 'nommés (STB)' : 'dépendant de la couleur (CTB)'}</h2>
      <div class="fond-row"><label>Nom <input data-k="name" value="${esc(t.name)}" size="34"></label>
        <label>Description <input data-k="tdesc" value="${esc(t.description || '')}" size="40"></label></div>
      <div class="ctb-layout">
        <div>${list}${stb ? `<div class="fond-row"><button class="btn small" data-act="add">Ajouter un style</button>
          <button class="btn small" data-act="rename" ${sel.size === 1 && one > 0 ? '' : 'disabled'}>Renommer</button>
          <button class="btn small" data-act="remove" ${[...sel].every((i) => i > 0) ? '' : 'disabled'}>Supprimer</button></div>` : ''}</div>
        <div class="ctb-props">
          <div class="muted">${what} (clic, Maj+clic, Ctrl+clic)</div>
          <label>Couleur tracée <select data-k="color">${mixed(color)}${opt('obj', 'Utiliser la couleur de l’objet', color)}${opt('noir', 'Noir', color)}${opt('blanc', 'Blanc', color)}${opt('autre', 'Autre couleur…', color)}</select></label>
          ${color === 'autre' ? `<label>Choix <input type="color" data-k="rgb" value="${rgb === MIXED ? '#808080' : hex(rgb)}"></label>` : ''}
          <label><input type="checkbox" data-k="dither" ${dither === true ? 'checked' : ''}> Tramage (dither)</label>
          <label><input type="checkbox" data-k="gray" ${gray === true ? 'checked' : ''}> Niveaux de gris</label>
          <label>Trame (%) <input data-k="screen" value="${screen === MIXED ? '' : screen}" placeholder="*Divers*" size="4"></label>
          <label>Type de ligne <select data-k="lt">${mixed(lt)}${opt('obj', 'Utiliser le type de ligne de l’objet', lt)}${PLOT_LINETYPES.map(([n], i) => opt(i, n, lt)).join('')}</select></label>
          <label>Épaisseur <select data-k="lw">${mixed(lw)}${opt('obj', 'Utiliser l’épaisseur de l’objet', lw)}${LINEWEIGHTS.map((v) => opt(v, `${v.toFixed(2).replace('.', ',')} mm`, lw)).join('')}</select></label>
          <label>Description <input data-k="desc" value="${desc === MIXED ? '' : esc(desc)}" placeholder="${desc === MIXED ? '*Divers*' : ''}"></label>
          <button class="btn small" data-act="reset" title="Les couleurs choisies reprennent tout de l’objet">Comme l’objet</button>
        </div>
      </div>
      <div class="qto-actions"><span class="muted grow">${dirty ? 'Modifications non enregistrées.' : ''}</span>
        <button class="btn" data-act="export" title="Fichier ${ext} lisible par AutoCAD">Exporter ${ext}</button>
        <button class="btn primary" data-act="save">Enregistrer</button><button class="btn" data-act="close">Fermer</button></div>`;
  };
  const apply = (fn) => { for (const i of sel) fn(t.styles[i]); dirty = true; render(); };
  dlg.onclick = async (e) => {
    const sw = e.target.closest('[data-i]');
    if (sw) {
      const i = +sw.dataset.i;
      if (e.shiftKey) { const [a, b] = [Math.min(last, i), Math.max(last, i)]; for (let k = a; k <= b; k++) sel.add(k); }
      else if (e.ctrlKey || e.metaKey) { if (sel.has(i) && sel.size > 1) sel.delete(i); else sel.add(i); }
      else sel = new Set([i]);
      last = i;
      render();
      return;
    }
    const act = e.target.dataset.act;
    if (act === 'close') dlg.close();
    if (stb && (act === 'add' || act === 'rename')) {
      const cur = act === 'rename' ? t.styles[[...sel][0]] : null;
      const name = (prompt(act === 'add' ? 'Nom du nouveau style' : 'Nouveau nom du style', cur?.name || `Style ${t.styles.length}`) || '').trim();
      if (!name || (t.styles.some((s) => styleKey(s.name) === styleKey(name) && s !== cur))) return;
      if (cur) cur.name = name;
      else { t.styles.push({ ...objectStyle(), name }); sel = new Set([t.styles.length - 1]); }
      dirty = true;
      render();
      return;
    }
    if (stb && act === 'remove') {
      t.styles = t.styles.filter((s, i) => i === 0 || !sel.has(i));
      sel = new Set([0]);
      dirty = true;
      render();
      return;
    }
    if (act === 'reset') apply((s) => Object.assign(s, objectStyle()));
    if (act === 'save') {
      if (!/\S/.test(t.name)) return;
      if (!extRe.test(t.name)) t.name += ext;
      saveUserTable(t);
      dirty = false;
      render();
      hooks.onSave?.(t);
    }
    if (act === 'export') {
      const bytes = await writeCtb(t);
      hooks.download?.(new Blob([bytes], { type: 'application/octet-stream' }), extRe.test(t.name) ? t.name : `${t.name}${ext}`);
    }
  };
  dlg.onchange = (e) => {
    const k = e.target.dataset.k, v = e.target.value;
    if (k === 'name') { t.name = v.trim(); dirty = true; return; }
    if (k === 'tdesc') { t.description = v; dirty = true; return; }
    if (v === MIXED) return;
    if (k === 'color') apply((s) => { s.color = v === 'obj' ? null : v === 'noir' ? 0 : v === 'blanc' ? 0xffffff : (s.color ?? 0x808080); });
    if (k === 'rgb') apply((s) => { s.color = parseInt(v.slice(1), 16); });
    if (k === 'dither') apply((s) => { s.dither = e.target.checked; });
    if (k === 'gray') apply((s) => { s.grayscale = e.target.checked; });
    if (k === 'screen') { const n = parseInt(v, 10); if (n >= 0 && n <= 100) apply((s) => { s.screen = n; }); }
    if (k === 'lt') apply((s) => { s.linetype = v === 'obj' ? null : +v; });
    if (k === 'lw') apply((s) => { s.lineweight = v === 'obj' ? null : +v; });
    if (k === 'desc') apply((s) => { s.description = v; });
  };
  render();
  if (!dlg.open) dlg.showModal();
}
