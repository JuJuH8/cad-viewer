// SPDX-License-Identifier: GPL-3.0-or-later
// Menu contextuel du dessin (clic droit sans commande en cours, comme AutoCAD) : sur une sélection, « Dessiner un(e)
// … semblable » (AJOUTSELECT) puis les modifications courantes ; dans le vide, répéter, annuler, coller, zoom.
// Pendant une commande, le clic droit reste « Entrée » (editor.js).
import { addSelectedLabel } from '../editor/commands.js';
import { kindLabel } from '../mep/systems.js';
import { typeLabel } from './props-info.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (d) => `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  draw: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  scale: '<rect x="3" y="13" width="8" height="8" rx="1"/><path d="M13 11l8-8M15 3h6v6"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L3 18h6zM15 6l6 12h-6z"/>',
  offset: '<path d="M4 18c4-8 12-8 16 0"/><path d="M4 12c4-6 12-6 16 0" opacity=".55"/>',
  stretch: '<path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  erase: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  clip: '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4h6v3H9z"/>',
  isolate: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  props: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  none: '<path d="M6 6l12 12M18 6L6 18"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  all: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/>',
};
const PATHS = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE']);

// Nom lisible de la sélection : « Canalisation », « 3 objets ».
function selectionTitle(doc, ids) {
  if (ids.length !== 1) return `${ids.length} objets`;
  const e = doc.get(ids[0]);
  if (!e) return '1 objet';
  if (e.mep && e.type === 'LWPOLYLINE') return `${kindLabel(e.mep)} ${e.mep.system || ''}`.trim();
  return typeLabel(e);
}

export function installContextMenu({ editor, showProps = () => {} }) {
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => { if (!menu?.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const label = (name) => editor.commands.get(name)?.label || name;

  function items({ ids }) {
    const doc = editor.doc;
    const out = [];
    const cmd = (name, text, icon, hint = '') => (editor.commands.has(name) ? out.push({ k: `cmd:${name}`, text, icon, hint }) : null);
    if (ids.length) {
      out.push({ title: selectionTitle(doc, ids) });
      const add = ids.length === 1 ? addSelectedLabel(editor, doc.get(ids[0])) : null;
      if (add) { out.push({ k: 'cmd:AJOUTSELECT', text: `Dessiner ${add}`, icon: I.draw, strong: true }); out.push({ sep: true }); }
      cmd('DEPLACER', 'Déplacer', I.move, 'M');
      cmd('COPIER', 'Copier', I.copy, 'CO');
      cmd('ROTATION', 'Rotation', I.rotate, 'RO');
      cmd('ECHELLE', 'Échelle', I.scale, 'EC');
      cmd('MIROIR', 'Miroir', I.mirror, 'MI');
      if (ids.length === 1 && PATHS.has(doc.get(ids[0])?.type)) cmd('DECALER', 'Décaler', I.offset, 'DC');
      cmd('ETIRER', 'Étirer', I.stretch, 'S');
      cmd('EFFACER', 'Effacer', I.erase, 'Suppr');
      out.push({ sep: true });
      cmd('COPIERPRESSE', 'Copier dans le presse-papiers', I.clip, 'Ctrl+C');
      cmd('ISOLEROBJETS', 'Isoler', I.isolate);
      out.push({ k: 'props', text: 'Propriétés', icon: I.props });
      out.push({ k: 'deselect', text: 'Tout désélectionner', icon: I.none, hint: 'Échap' });
    } else {
      if (editor.lastCommand && editor.commands.has(editor.lastCommand)) out.push({ k: `cmd:${editor.lastCommand}`, text: `Répéter ${label(editor.lastCommand)}`, icon: I.repeat, hint: 'Entrée', strong: true }, { sep: true });
      cmd('U', 'Annuler', I.undo, 'Ctrl+Z');
      cmd('REDO', 'Rétablir', I.redo, 'Ctrl+Y');
      out.push({ sep: true });
      cmd('COLLER', 'Coller', I.paste, 'Ctrl+V');
      out.push({ k: 'all', text: 'Tout sélectionner', icon: I.all, hint: 'Ctrl+A' });
      out.push({ k: 'fit', text: 'Zoom étendu', icon: I.fit, hint: 'Double-clic molette' });
    }
    return out;
  }

  function open(info) {
    close();
    const list = items(info);
    if (!list.some((i) => i.k)) return;
    menu = document.createElement('div');
    menu.className = 'ctx-menu cad-ctx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = list.map((i) => (i.sep ? '<hr>' : i.title ? `<div class="ctx-title">${esc(i.title)}</div>`
      : `<button role="menuitem" data-k="${esc(i.k)}" class="${i.strong ? 'strong' : ''}">${i.icon ? ico(i.icon) : '<span class="ico-svg"></span>'}<span class="ctx-text">${esc(i.text)}</span>${i.hint ? `<span class="ctx-hint">${esc(i.hint)}</span>` : ''}</button>`)).join('');
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(info.x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(info.y, innerHeight - r.height - 4))}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      close();
      if (k.startsWith('cmd:')) editor.run(k.slice(4));
      else if (k === 'props') showProps();
      else if (k === 'deselect') editor.setSelection([]);
      else if (k === 'all') editor.selectAll();
      else if (k === 'fit') { editor.r.fit(); editor.r.requestRender(true); }
    });
  }

  editor.ui.onContextMenu = open;
  return { open, close, items };
}
