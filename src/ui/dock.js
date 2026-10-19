// SPDX-License-Identifier: GPL-3.0-or-later
// Panneaux détachables (Calques, Références, Propriétés) : ancrés à gauche ou à droite, ou flottants (déplacés par
// leur barre de titre, redimensionnables, ancrés de nouveau en les lâchant contre un bord). Masquage automatique :
// le panneau se réduit à un onglet sur le bord (ou à sa barre de titre s'il flotte) et ressort au survol ; il reste
// ouvert tant qu'on s'en sert (souris dessus, champ en cours de saisie). Disposition retenue dans le navigateur.

const KEY = 'cv-panels';
const DEFAULTS = {
  layers: { dock: 'left', auto: false, x: 80, y: 160, w: 280, h: 460 },
  xrefs: { dock: 'left', auto: false, x: 120, y: 200, w: 300, h: 360 },
  props: { dock: 'right', auto: false, x: 900, y: 160, w: 290, h: 520 },
  // Palette des symboles électriques : fermée tant qu'on ne l'ouvre pas (SYMBOLE, ruban).
  symbols: { dock: 'right', auto: false, closed: true, x: 860, y: 180, w: 320, h: 560 },
};
const WIDTHS = { left: 252, right: 270 };
const ICONS = {
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  unpin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/><path d="M4 4l16 16"/>',
  float: '<rect x="4" y="8" width="12" height="12" rx="2"/><path d="M10 4h10v10"/>',
  dock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const svg = (d) => `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

export function installDock({ onLayout } = {}) {
  const ws = document.getElementById('workspace');
  const docks = { left: document.getElementById('dock-left'), right: document.getElementById('dock-right') };
  const rails = { left: document.getElementById('rail-left'), right: document.getElementById('rail-right') };
  const floatLayer = document.getElementById('float-layer');
  const panels = new Map([...document.querySelectorAll('.panel[data-panel]')].map((el) => [el.dataset.panel, el]));
  let state = load();
  const widths = { ...WIDTHS, ...(state.widths || {}) };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      const out = structuredClone(DEFAULTS);
      for (const k of Object.keys(DEFAULTS)) if (saved[k]) out[k] = { ...out[k], ...saved[k] };
      if (saved.widths) out.widths = saved.widths;
      return out;
    } catch { return structuredClone(DEFAULTS); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ ...state, widths })); } catch { /* navigation privée */ }
  }

  // Boutons de la barre de titre.
  for (const [id, el] of panels) {
    el.querySelector('.panel-btns').innerHTML = `
      <button class="panel-btn" data-act="auto" aria-label="Masquage automatique"></button>
      <button class="panel-btn" data-act="float" aria-label="Détacher ou ancrer"></button>${el.dataset.closable ? `
      <button class="panel-btn" data-act="close" aria-label="Fermer" title="Fermer">${svg(ICONS.close)}</button>` : ''}`;
    el.querySelector('.panel-btns').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const s = state[id];
      if (act === 'auto') s.auto = !s.auto;
      if (act === 'close') s.closed = true;
      if (act === 'float') {
        if (s.dock === 'float') s.dock = s.lastDock || 'left';
        else { s.lastDock = s.dock; s.dock = 'float'; placeFloat(id, el); }
      }
      layout();
      save();
    });
    dragHeader(id, el);
    hoverAutoHide(id, el);
  }

  // Panneau flottant : position de départ près de son ancien emplacement.
  function placeFloat(id, el) {
    const r = el.getBoundingClientRect();
    const s = state[id];
    s.x = Math.max(8, Math.min(r.left + 24, innerWidth - 220));
    s.y = Math.max(60, Math.min(r.top + 24, innerHeight - 160));
    s.w = Math.max(220, Math.round(r.width));
    s.h = Math.max(200, Math.min(Math.round(r.height), innerHeight - s.y - 60));
  }

  function layout() {
    for (const side of ['left', 'right']) { rails[side].innerHTML = ''; }
    for (const [id, el] of panels) {
      const s = state[id];
      el.classList.toggle('floating', s.dock === 'float');
      el.classList.toggle('auto', s.auto);
      el.classList.remove('open', 'flyout-left', 'flyout-right');
      el.style.cssText = '';
      el.hidden = !!s.closed;
      const [btnAuto, btnFloat] = el.querySelectorAll('.panel-btn');
      btnAuto.innerHTML = svg(s.auto ? ICONS.unpin : ICONS.pin);
      btnAuto.title = s.auto ? 'Garder ouvert (désactiver le masquage automatique)' : 'Masquer automatiquement quand il ne sert pas';
      btnAuto.classList.toggle('on', s.auto);
      btnFloat.innerHTML = svg(s.dock === 'float' ? ICONS.dock : ICONS.float);
      btnFloat.title = s.dock === 'float' ? `Ancrer à ${(s.lastDock || 'left') === 'left' ? 'gauche' : 'droite'}` : 'Détacher (panneau flottant)';
      if (s.closed) {
        docks[s.dock === 'float' ? s.lastDock || 'right' : s.dock].appendChild(el);
      } else if (s.dock === 'float') {
        floatLayer.appendChild(el);
        Object.assign(el.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: s.auto ? '' : `${s.h}px` });
      } else if (s.auto) {
        // Onglet sur le rail du bord ; le panneau sort en surimpression au survol.
        const tab = document.createElement('button');
        tab.className = 'rail-tab';
        tab.dataset.panel = id;
        tab.textContent = el.dataset.title;
        tab.title = `${el.dataset.title} (survoler pour ouvrir)`;
        rails[s.dock].appendChild(tab);
        tab.addEventListener('mouseenter', () => openAuto(id));
        tab.addEventListener('click', () => openAuto(id));
        tab.addEventListener('mouseleave', () => scheduleClose(id));
        ws.appendChild(el);
        el.classList.add(`flyout-${s.dock}`);
        el.style.width = `${widths[s.dock]}px`;
      } else {
        docks[s.dock].appendChild(el);
        if (s.grow) el.style.flexGrow = String(s.grow);
      }
    }
    // Ordre des panneaux ancrés (Calques, Références, Propriétés) ; poignée de largeur côté dessin.
    for (const side of ['left', 'right']) {
      const dock = docks[side];
      const handle = dock.querySelector('.dock-resize');
      const docked = [...dock.querySelectorAll(':scope > .panel')].sort((a, b) => order(a) - order(b));
      for (const el of docked) dock.appendChild(el);
      if (side === 'left') dock.appendChild(handle); else dock.prepend(handle);
      const visible = docked.filter((el) => !el.hidden);
      dock.hidden = !visible.length;
      // Séparateurs entre panneaux empilés : glisser pour partager la hauteur.
      for (const sp of dock.querySelectorAll(':scope > .dock-split')) sp.remove();
      for (let i = 1; i < visible.length; i++) {
        const sp = document.createElement('div');
        sp.className = 'dock-split';
        sp.title = 'Glisser pour partager la hauteur';
        visible[i].before(sp);
        splitDrag(sp, visible[i - 1], visible[i]);
      }
      rails[side].hidden = !rails[side].children.length;
      ws.style.setProperty(`--dock-${side}`, visible.length ? `${widths[side]}px` : '0px');
    }
    onLayout?.();
  }
  const order = (el) => ['layers', 'xrefs', 'props', 'symbols'].indexOf(el.dataset.panel);

  // Masquage automatique : ouverture au survol, fermeture différée quand la souris part (sauf saisie en cours).
  const timers = new Map();
  function openAuto(id) {
    const el = panels.get(id);
    clearTimeout(timers.get(id));
    for (const [other, o] of panels) if (other !== id && state[other].auto && state[other].dock !== 'float') o.classList.remove('open');
    el.classList.add('open');
  }
  function scheduleClose(id) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      const el = panels.get(id);
      if (el.matches(':hover') || el.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return scheduleClose(id);
      el.classList.remove('open');
    }, 450));
  }
  function hoverAutoHide(id, el) {
    el.addEventListener('mouseenter', () => { if (state[id].auto) openAuto(id); });
    el.addEventListener('mouseleave', () => { if (state[id].auto) scheduleClose(id); });
    el.addEventListener('focusout', () => { if (state[id].auto) scheduleClose(id); });
  }

  // Panneau flottant : déplacement par la barre de titre ; lâché contre un bord du plan de travail → ancré.
  function dragHeader(id, el) {
    const barEl = el.querySelector('.panel-bar');
    barEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const s = state[id];
      if (s.dock !== 'float') {
        // Glisser un panneau ancré le détache.
        s.lastDock = s.dock;
        placeFloat(id, el);
        s.dock = 'float';
        layout();
      }
      const start = { x: e.clientX, y: e.clientY, left: s.x, top: s.y };
      barEl.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const wsBox = ws.getBoundingClientRect();
      const move = (ev) => {
        s.x = Math.max(0, Math.min(start.left + ev.clientX - start.x, innerWidth - 120));
        s.y = Math.max(0, Math.min(start.top + ev.clientY - start.y, innerHeight - 40));
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
        const side = ev.clientX < wsBox.left + 36 ? 'left' : ev.clientX > wsBox.right - 36 ? 'right' : null;
        ws.dataset.dropSide = side || '';
      };
      const up = (ev) => {
        barEl.removeEventListener('pointermove', move);
        barEl.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        const side = ws.dataset.dropSide;
        ws.dataset.dropSide = '';
        if (side) { s.dock = side; s.lastDock = side; }
        layout();
        save();
      };
      barEl.addEventListener('pointermove', move);
      barEl.addEventListener('pointerup', up);
    });
    // Taille d'un panneau flottant (poignée du coin, CSS resize) retenue.
    new ResizeObserver(() => {
      const s = state[id];
      if (s.auto && s.dock !== 'float' && el.classList.contains('open')) {
        const w = Math.round(el.getBoundingClientRect().width);
        if (w >= 200 && w !== widths[s.dock]) { widths[s.dock] = w; save(); }
        return;
      }
      if (s.dock !== 'float' || s.auto || el.classList.contains('dragging')) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { s.w = Math.round(r.width); s.h = Math.round(r.height); save(); }
    }).observe(el);
  }

  // Séparateur entre deux panneaux empilés : les hauteurs se partagent (flex-grow proportionnel).
  function splitDrag(sp, a, b) {
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      const ha = a.getBoundingClientRect().height, hb = b.getBoundingClientRect().height, y0 = e.clientY;
      const ga = parseFloat(getComputedStyle(a).flexGrow) || 1, gb = parseFloat(getComputedStyle(b).flexGrow) || 1;
      const total = ga + gb;
      sp.classList.add('active');
      const move = (ev) => {
        const dy = ev.clientY - y0;
        const na = Math.max(80, ha + dy), nb = Math.max(80, hb - dy);
        const fa = (total * na) / (na + nb), fb = total - fa;
        a.style.flexGrow = String(fa); b.style.flexGrow = String(fb);
      };
      const up = () => {
        sp.classList.remove('active');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        state[a.dataset.panel].grow = parseFloat(a.style.flexGrow);
        state[b.dataset.panel].grow = parseFloat(b.style.flexGrow);
        save();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  }

  // Largeur des docks : poignée sur le bord intérieur.
  for (const handle of document.querySelectorAll('.dock-resize')) {
    handle.addEventListener('pointerdown', (e) => {
      const side = handle.dataset.side;
      const start = { x: e.clientX, w: widths[side] };
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) * (side === 'left' ? 1 : -1);
        widths[side] = Math.max(200, Math.min(start.w + dx, 520));
        ws.style.setProperty(`--dock-${side}`, `${widths[side]}px`);
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); save(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  layout();
  return {
    get state() { return structuredClone(state); },
    set(id, props) { Object.assign(state[id], props); layout(); save(); },
    reset() {
      state = structuredClone(DEFAULTS);
      Object.assign(widths, WIDTHS);
      for (const el of panels.values()) el.style.flexGrow = '';
      layout();
      save();
    },
    open: openAuto,
    // Panneau fermable (palette des symboles) : ouvert, ou fermé.
    show(id) {
      const s = state[id];
      if (!s) return;
      s.closed = false;
      layout();
      save();
      if (s.auto && s.dock !== 'float') openAuto(id);
    },
    hide(id) { if (state[id]) { state[id].closed = true; layout(); save(); } },
    isOpen: (id) => !!state[id] && !state[id].closed,
  };
}
