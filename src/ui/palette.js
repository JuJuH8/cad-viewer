// SPDX-License-Identifier: GPL-3.0-or-later
// Palette de commandes (Ctrl+K) : on tape un nom, un alias ou un libellé (« gaine », « bilan »…), on choisit avec
// ↑ ↓ et Entrée ; la commande est lancée comme depuis la ligne de commande.
import { suggestCommands } from '../editor/suggest.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEARCH = '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
// Commandes proposées quand rien n'est tapé.
const COMMON = ['LIGNE', 'POLYLIGN', 'GAINE', 'CHEMINCABLE', 'TUBE', 'SYMBOLE', 'CIRCUIT', 'BILANELEC', 'INTERFERENCES', 'METRE', 'TRACER', 'EXPORTIFC'];

export function createPalette(editor, labels, { onRun } = {}) {
  let dlg = null, items = [], sel = 0;
  const recent = [];
  const list = () => dlg.querySelector('.palette-list');
  const render = () => {
    list().innerHTML = items.length
      ? items.map((s, i) => `<li data-i="${i}" class="${i === sel ? 'sel' : ''}" role="option" aria-selected="${i === sel}">
          <span class="pl-label">${esc(s.label || s.name)}</span><span class="pl-name">${esc(s.name)}</span>
          <span class="pl-alias">${s.alias ? esc(s.alias) : ''}</span></li>`).join('')
      : '<li class="palette-empty">Aucune commande ne correspond.</li>';
    list().querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => {
    const q = dlg.querySelector('input').value;
    if (q.trim()) items = suggestCommands(editor, q.replace(/\s+/g, ''), labels, 14);
    else {
      const names = [...new Set([...recent, ...COMMON])].map((n) => editor.findCommand(n)?.name).filter(Boolean);
      items = [...new Set(names)].slice(0, 12).map((name) => ({ name, alias: '', label: labels[name] || '' }));
    }
    sel = 0;
    render();
  };
  const run = (s) => {
    if (!s) return;
    dlg.close();
    const k = recent.indexOf(s.name);
    if (k >= 0) recent.splice(k, 1);
    recent.unshift(s.name);
    recent.length = Math.min(recent.length, 6);
    onRun ? onRun(s.name) : editor.run(s.name);
  };
  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'palette';
    dlg.setAttribute('aria-label', 'Rechercher une commande');
    dlg.innerHTML = `<div class="palette-input">${SEARCH}<input placeholder="Rechercher une commande : gaine, bilan, ligne…" aria-label="Commande" autocomplete="off" spellcheck="false"></div>
      <ul class="palette-list" role="listbox"></ul>
      <div class="palette-foot">↑ ↓ pour choisir · Entrée pour lancer · Échap pour fermer</div>`;
    document.body.appendChild(dlg);
    const input = dlg.querySelector('input');
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(items[sel]);
      }
    });
    list().addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) run(items[+li.dataset.i]); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic hors de la palette
  }
  return {
    open() {
      if (!dlg) build();
      dlg.querySelector('input').value = '';
      update();
      if (!dlg.open) dlg.showModal();
      dlg.querySelector('input').focus();
    },
    get element() { return dlg; },
  };
}
