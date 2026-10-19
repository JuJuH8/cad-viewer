// SPDX-License-Identifier: GPL-3.0-or-later
// Cœur interactif de l'éditeur : souris, clavier, sélection, poignées, accrochages,
// et exécution des commandes (fonctions asynchrones qui « demandent » des points,
// des distances ou une sélection, comme les commandes AutoCAD).
import { ucsOf, toUcs, fromUcs, isWorld, ucsIconOf } from '../core/ucs.js';
import * as G from '../core/geom.js';
import { gripsOf, applyGrip } from '../core/entities.js';
import { dynGrips, withValue, valueFromPoint } from '../blocks/dynamic.js';
import { findSnap, orthoPoint, polarPoint, SNAP_LABELS, trackPoint } from './snap.js';
import { parseCoord, parseNumber, matchKeyword } from './parse.js';

export class Cancel extends Error {
  constructor() { super('*Annuler*'); }
}

const APERTURE_PX = 10;
const PICKBOX_PX = 5;
const GRIP_PX = 5;
const DRAG_PX = 5;

export class Editor {
  constructor(renderer, ui = {}) {
    this.r = renderer;
    this.ui = ui;                         // { print, prompt, onSelection, onState }
    this.commands = new Map();            // nom → { name, fn, label }
    this.aliases = new Map();             // alias → nom
    this.settings = {
      osnap: true,
      modes: new Set(['end', 'mid', 'cen', 'qua', 'int', 'per', 'node', 'ins']),
      ortho: false,
      polar: false,
      otrack: true,
      polarInc: 45,
      grid: false,
      gridSize: 0,
      snap: false,
      snapSize: 0,
      // Préférences d'affichage (pixels) : ouverture d'accrochage, boîte de sélection, poignées, curseur.
      aperture: APERTURE_PX,
      pickbox: PICKBOX_PX,
      grip: GRIP_PX,
      cursor: 22,
    };
    this.selection = new Set();
    this.tracked = [];               // points acquis pour le repérage d'accrochage
    this.request = null;
    this.running = null;
    this.lastCommand = null;
    this.lastPoint = null;
    this.cursor = { screen: null, world: [0, 0], raw: [0, 0], snap: null, polar: null };
    this.box = null;                      // sélection par fenêtre en cours
    this.dragGrip = null;
    this.typeahead = [];                  // clics et saisies arrivés pendant qu'une commande calcule
    renderer.uiDraw = (ctx, view) => this.drawUi(ctx, view);
    this.bindPointer();
  }

  setDocument(doc) {
    this.cancel();
    this.vpCommit?.();
    this.r.activeViewport = null;
    this.doc = doc;
    for (const f of this.docHooks || []) f(doc);
    this.setSelection([]);
    this.lastPoint = null;
  }

  // --- messages ------------------------------------------------------------------

  print(msg) { this.ui.print?.(msg); }

  setPrompt(text, keywords = []) { this.ui.prompt?.(text, keywords); }

  // --- commandes -------------------------------------------------------------------

  register(name, fn, { aliases = [], label = name, transaction = true } = {}) {
    const key = name.toUpperCase();
    this.commands.set(key, { name: key, fn, label, transaction });
    for (const a of [key, ...aliases]) this.aliases.set(a.toUpperCase(), key);
  }

  findCommand(text) {
    const key = this.aliases.get(text.trim().toUpperCase());
    return key ? this.commands.get(key) : null;
  }

  async run(text) {
    const cmd = typeof text === 'string' ? this.findCommand(text) : text;
    if (!cmd) {
      this.print(`Commande inconnue : « ${text} ».`);
      return;
    }
    if (this.running) this.cancel();
    if (!this.doc) { this.print('Ouvrez ou créez un dessin.'); return; }
    if (cmd.transaction) this.lastCommand = cmd.name;
    this.print(`Commande : ${cmd.label}`);
    const run = { cmd, usedSelection: false };
    this.running = run;
    this.ui.onState?.();
    if (cmd.transaction) this.doc.begin(cmd.label);
    try {
      await cmd.fn(this.context(run));
    } catch (err) {
      if (err instanceof Cancel) this.print('*Annuler*');
      else {
        console.error(err);
        this.print(`Erreur : ${err.message}`);
      }
    } finally {
      if (cmd.transaction) this.doc.commit(); // ce qui a été fait reste fait (comme AutoCAD après Échap)
      if (run.usedSelection) this.setSelection([]);
      if (this.running === run) {
        this.running = null;
        this.request = null;
        this.typeahead = [];
        this.resetTracking(); // points de repérage : le temps d'une commande, comme AutoCAD
        this.r.setPreview([]);
        this.setPrompt('Commande :');
        this.ui.onState?.();
      }
    }
  }

  cancel() {
    this.typeahead = [];
    if (this.request) {
      const req = this.request;
      this.request = null;
      req.reject(new Cancel());
    }
    this.box = null;
    this.dragGrip = null;
    this.resetTracking();
    this.r.setPreview([]);
    this.r.requestRender();
  }

  // Repérage oublié : fin ou abandon de commande, fin d'un étirement par poignée, F11.
  resetTracking() {
    this.tracked = [];
    this.hoverSnap = null;
    clearTimeout(this.acquireTimer);
    if (this.cursor) this.cursor.track = null;
  }

  // API offerte aux commandes.
  context(run = {}) {
    const ed = this;
    return {
      doc: this.doc,
      editor: this,
      print: (m) => this.print(m),
      getPoint: (prompt, o = {}) => this.ask({ kind: 'point', prompt, ...o }),
      // Sans point de base, un point désigné (clic ou coordonnées) demande un deuxième point, comme AutoCAD.
      getDistance: async (prompt, o = {}) => {
        const r = await this.ask({ kind: 'distance', prompt, ...o });
        return Array.isArray(r) ? G.dist(r, await this.ask({ kind: 'point', prompt: 'Deuxième point', base: r })) : r;
      },
      getAngle: async (prompt, o = {}) => {
        const r = await this.ask({ kind: 'angle', prompt, ...o });
        return Array.isArray(r) ? G.angleOf(r, await this.ask({ kind: 'point', prompt: 'Deuxième point', base: r })) : r;
      },
      getString: (prompt, o = {}) => this.ask({ kind: 'string', prompt, ...o }),
      getKeyword: (prompt, keywords, o = {}) => this.ask({ kind: 'keyword', prompt, keywords, ...o }),
      getEntity: (prompt, o = {}) => this.ask({ kind: 'entity', prompt, ...o }),
      async getSelection(prompt = 'Choix des objets') {
        run.usedSelection = true;
        if (ed.selection.size) {
          const ids = [...ed.selection];
          ed.print(`${ids.length} objet(s) trouvé(s)`);
          return ids;
        }
        while (true) {
          const r = await ed.ask({ kind: 'select', prompt, allowNone: true });
          if (r === null) return [...ed.selection];
        }
      },
      preview: (entities) => this.r.setPreview(entities),
      clearSelection: () => this.setSelection([]),
      get lastPoint() { return ed.lastPoint; },
      set lastPoint(p) { ed.lastPoint = p; },
    };
  }

  ask(req) {
    // Ce que la commande a déjà fait est affiché avant chaque nouvelle question (symbole posé visible dès le clic).
    this.doc?.flush?.();
    return new Promise((resolve, reject) => {
      this.request = { ...req, resolve, reject };
      const kw = req.keywords?.length ? ` [${req.keywords.join('/')}]` : '';
      const def = req.default != null ? ` <${typeof req.default === 'number' ? fmt(req.default) : req.default}>` : '';
      this.setPrompt(`${req.prompt}${kw}${def} :`, req.keywords || []);
      this.updatePreview();
      // Saisie anticipée : un clic ou un texte reçu pendant que la commande calculait répond tout de suite.
      if (this.typeahead.length) {
        const r = this.request;
        queueMicrotask(() => { if (this.request === r) this.replayTypeahead(); });
      }
    });
  }

  replayTypeahead() {
    const t = this.typeahead.shift();
    if (!t) return;
    if (t.text != null) { this.submit(t.text); return; }
    const req = this.request;
    if (req && ['point', 'distance', 'angle', 'entity'].includes(req.kind)) {
      const saved = this.cursor;
      this.cursor = { ...saved, world: t.world, raw: t.raw };
      this.click(t.shift);
      this.cursor = saved;
    } else this.typeahead = []; // la commande attend autre chose : on oublie le reste
  }

  // Une commande tourne mais n'a pas encore reposé sa question (calcul, lecture de fichier…).
  busyBetweenRequests() {
    return !!this.running && !this.request;
  }

  answer(value) {
    const req = this.request;
    if (!req) return;
    this.request = null;
    if (Array.isArray(value)) this.lastPoint = value;
    this.r.setPreview([]);
    req.resolve(value);
  }

  // --- saisie au clavier ---------------------------------------------------------------

  // Texte validé par Entrée (ou Espace) dans la ligne de commande.
  submit(raw) {
    const text = raw.trim();
    const req = this.request;
    if (!req && this.busyBetweenRequests() && this.typeahead.length < 20) { this.typeahead.push({ text: raw }); return; }
    if (!req) {
      if (!text) {
        if (this.lastCommand) this.run(this.lastCommand);
        return;
      }
      this.run(text);
      return;
    }
    if (req.kind === 'string') {
      this.answer(text || (req.default ?? ''));
      return;
    }
    if (!text) {
      // Angle d'orientation (texte, bloc…) : compté depuis l'axe X du SCU, comme AutoCAD.
      if (req.default != null && req.kind === 'angle' && req.absolute && typeof req.default === 'number') { this.answer(req.default + ucsOf(this.doc).angle); return; }
      if (req.default != null) { this.answer(req.default); return; }
      if (req.allowNone || req.kind === 'select') { this.answer(null); return; }
      return;
    }
    const kw = matchKeyword(text, req.keywords);
    if (kw) { this.answer(kw); return; }
    if (req.kind === 'keyword') { this.print('Option non reconnue.'); return; }

    const base = req.base || this.lastPoint;
    const c = parseCoord(text, base, ucsOf(this.doc));
    if (req.kind === 'point' || req.kind === 'entity') {
      // Objet désigné par des coordonnées tapées (scripts) : l'objet sous ce point.
      if (c?.kind === 'point' && req.kind === 'entity') {
        const id = this.r.pick(c.p, this.worldTol(this.settings.pickbox));
        if (id == null) { this.print('Aucun objet trouvé.'); return; }
        this.answer({ id, p: c.p });
        return;
      }
      if (c?.kind === 'point') { this.answer(c.p); return; }
      const tr = this.cursor?.track;
      if (c?.kind === 'number' && tr?.lines.length === 1) {
        const t = tr.lines[0].t;
        const dir = G.norm(G.sub(this.cursor.world, t));
        if (dir[0] || dir[1]) { this.answer(G.add(t, G.mul(dir, c.value))); return; }
      }
      if (c?.kind === 'number' && req.base) {
        // Distance directe : dans la direction du curseur (avec ORTHO / POLAIRE).
        const dir = G.norm(G.sub(this.cursor.world, req.base));
        if (!dir[0] && !dir[1]) { this.print('Indiquez une direction avec le curseur.'); return; }
        this.answer(G.add(req.base, G.mul(dir, c.value)));
        return;
      }
    }
    if (req.kind === 'distance') {
      const n = parseNumber(text);
      if (n != null) { this.answer(n); return; }
      if (c?.kind === 'point') { this.answer(req.base ? G.dist(req.base, c.p) : c.p); return; }
    }
    if (req.kind === 'angle') {
      const n = parseNumber(text);
      if (n != null) { this.answer((n * Math.PI) / 180 + (req.absolute ? ucsOf(this.doc).angle : 0)); return; }
    }
    this.print('Saisie non valide.');
  }

  // --- sélection ------------------------------------------------------------------

  setSelection(ids) {
    this.selection = new Set(ids);
    this.r.setSelection(this.selection);
    this.ui.onSelection?.([...this.selection]);
  }

  addToSelection(ids, remove = false) {
    ids = this.expandGroups(ids);
    const s = new Set(this.selection);
    for (const id of ids) { if (remove) s.delete(id); else s.add(id); }
    this.setSelection(s);
  }

  // Groupes (GROUPE) : désigner un membre sélectionne tout le groupe (sauf si settings.groups est faux).
  expandGroups(ids) {
    if (this.settings.groups === false || !this.doc) return ids;
    const names = new Set();
    for (const id of ids) { const g = this.doc.get(id)?.group; if (g) names.add(g); }
    if (!names.size) return ids;
    const out = new Set(ids);
    for (const e of this.doc.entities.values()) if (e.group && names.has(e.group) && e.space === this.r.space) out.add(e.id);
    return [...out];
  }

  selectAll() {
    const ids = [];
    for (const e of this.doc.entities.values()) if (e.space === this.r.space && this.r.selectable(e.id)) ids.push(e.id);
    this.setSelection(ids);
  }

  grips() {
    if (this.selection.size > 200) return [];
    const out = [];
    for (const id of this.selection) {
      const e = this.doc.get(id);
      if (!e) continue;
      for (const g of gripsOf(e)) out.push({ ...g, id });
      if (e.type === 'INSERT') for (const g of dynGrips(this.doc, e)) out.push({ ...g, id }); // bloc dynamique
    }
    return out;
  }

  // Objet modifié par une poignée amenée en p (poignée dynamique : nouvelle valeur du paramètre).
  gripResult(e, grip, p) {
    if (grip.k === 'dyn') {
      const v = valueFromPoint(this.doc, e, grip.param, p);
      return v == null ? e : withValue(this.doc, e, grip.param, v);
    }
    return applyGrip(e, grip, p);
  }

  // --- souris -------------------------------------------------------------------------

  worldTol(px) { return px / this.r.scale; }

  // Point du curseur après accrochage, ORTHO et POLAIRE.
  computeCursor(screen) {
    const raw = this.r.toWorld(screen[0], screen[1]);
    const ucs = ucsOf(this.doc);
    const req = this.request;
    let p = raw, snap = null, polar = null;
    const wantsPoint = req && ['point', 'distance', 'angle', 'entity'].includes(req.kind) || this.dragGrip;
    const base = this.dragGrip ? this.dragGrip.grip.p : req?.base;
    if (wantsPoint && this.settings.osnap && this.doc) {
      snap = findSnap({ renderer: this.r, doc: this.doc, p: raw, tol: this.worldTol(this.settings.aperture), modes: this.settings.modes, base });
      if (snap) p = snap.p;
    }
    // Repérage d'accrochage : un point d'accrochage survolé un instant est acquis ; le curseur s'aligne
    // ensuite sur ses horizontales / verticales (ou angles polaires) et sur leurs intersections.
    let track = null;
    // Survol interrompu : le point pourra être acquis (ou abandonné) au prochain survol.
    if (!snap && this.hoverSnap) { this.hoverSnap = null; clearTimeout(this.acquireTimer); }
    if (wantsPoint && this.settings.otrack && this.settings.osnap) {
      if (snap) this.scheduleAcquire(snap.p);
      else if (this.tracked.length) {
        track = trackPoint(this.tracked, raw, this.worldTol(this.settings.aperture), this.settings.polar ? this.settings.polarInc : 90, ucs.angle);
        if (track) { p = track.p; snap = null; }
      }
    }
    if (!snap && !track && this.settings.snap && wantsPoint) {
      // Pas de la grille, dans le SCU.
      const k = this.settings.snapSize || this.settings.gridSize || 10;
      const q = toUcs(ucs, raw);
      p = fromUcs(ucs, [Math.round(q[0] / k) * k, Math.round(q[1] / k) * k]);
    }
    if (!snap && !track && base && wantsPoint) {
      if (this.settings.ortho) p = orthoPoint(base, p, ucs.angle);
      else if (this.settings.polar) {
        polar = polarPoint(base, raw, this.settings.polarInc, 4, ucs.angle);
        if (polar) p = polar.p;
      }
    }
    this.cursor = { screen, world: p, raw, snap, polar, track };
  }

  // Acquisition (ou abandon, si déjà acquis) d'un point de repérage après 350 ms de survol.
  scheduleAcquire(p) {
    if (this.hoverSnap && G.dist(this.hoverSnap, p) < 1e-9) return;
    this.hoverSnap = p;
    clearTimeout(this.acquireTimer);
    this.acquireTimer = setTimeout(() => {
      const s = this.cursor?.snap;
      if (s && G.dist(s.p, p) < 1e-9) this.acquire(p);
    }, 350);
  }

  acquire(p) {
    const i = this.tracked.findIndex((q) => G.dist(q, p) < 1e-9);
    if (i >= 0) this.tracked.splice(i, 1);
    else {
      this.tracked.push([p[0], p[1]]);
      if (this.tracked.length > 5) this.tracked.shift();
    }
    this.r.requestRender();
  }

  updatePreview() {
    const req = this.request;
    if (this.dragGrip) {
      const { id, grip } = this.dragGrip;
      const e = this.doc.get(id);
      if (e) this.r.setPreview([this.gripResult(e, grip, this.cursor.world)]);
      return;
    }
    if (req?.preview && this.cursor.screen) {
      try { this.r.setPreview(req.preview(this.cursor.world) || []); } catch (err) { console.warn(err); }
    }
  }

  bindPointer() {
    const el = this.r.canvas;
    let down = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (this.r.mode !== '2d') return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const f = Math.pow(1.0015, -e.deltaY);
      if (this.ui.mspace?.locked) return; // fenêtre verrouillée : vue figée
      if (this.vpZoom(e.clientX - rect.left, e.clientY - rect.top, f)) return; // fenêtre active : zoom dans la fenêtre
      this.r.zoomAt(e.clientX - rect.left, e.clientY - rect.top, f);
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      if (this.r.mode !== '2d') return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
      const rect = el.getBoundingClientRect();
      down = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, sx: e.clientX - rect.left, sy: e.clientY - rect.top, button: e.button, shift: e.shiftKey, moved: false, handled: false };
      this.ui.focus?.();
      if (e.button !== 0) return;
      // Comme AutoCAD, un point est pris à l'appui du bouton, là où il a été pressé : des clics rapides
      // ne sont jamais perdus, même si la souris bouge pendant l'appui.
      const req = this.request;
      this.computeCursor([down.sx, down.sy]);
      if (this.dragGrip) { this.click(down.shift); down.handled = true; return; }
      if (req && ['point', 'distance', 'angle', 'entity'].includes(req.kind)) { this.click(down.shift); down.handled = true; return; }
      if (this.busyBetweenRequests()) {
        if (this.typeahead.length < 20) this.typeahead.push({ world: this.cursor.world, raw: this.cursor.raw, shift: down.shift });
        down.handled = true;
        return;
      }
      // Sans commande : appui sur une poignée = étirement (glisser-déposer, ou cliquer la destination).
      if (!req && !down.shift && !this.box) {
        const grip = this.gripAt(this.cursor.raw);
        if (grip) { this.startGrip(grip); down.handled = 'grip'; }
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this.r.mode !== '2d') return;
      const rect = el.getBoundingClientRect();
      const screen = [e.clientX - rect.left, e.clientY - rect.top];
      if (down && down.button === 1) {
        if (this.ui.mspace?.locked) return;
        if (!this.vpPan(e.clientX - down.x, e.clientY - down.y)) this.r.pan(e.clientX - down.x, e.clientY - down.y);
        down.x = e.clientX; down.y = e.clientY;
        down.moved = true;
        return;
      }
      if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
        down.moved = true;
        // Glisser sur le vide (sans commande, ou au « Choix des objets ») : fenêtre de sélection.
        const selecting = !this.request || this.request.kind === 'select';
        if (down.button === 0 && !down.handled && selecting && !this.box && !this.dragGrip) {
          this.box = { start: this.r.toWorld(down.sx, down.sy), drag: true };
        }
      }
      this.computeCursor(screen);
      if (this.box) this.box.end = this.cursor.raw;
      if (!this.request && !this.box && !this.dragGrip) {
        const id = this.r.pick(this.cursor.raw, this.worldTol(this.settings.pickbox));
        this.r.setHover(id);
      } else if (this.r.hover != null) this.r.setHover(null);
      this.updatePreview();
      this.ui.onCursor?.(this.cursor);
      this.r.requestRender();
    });

    el.addEventListener('pointerup', (e) => {
      if (this.r.mode !== '2d' || !down) return;
      const d = down;
      down = null;
      const rect = el.getBoundingClientRect();
      const screen = [e.clientX - rect.left, e.clientY - rect.top];
      if (d.button === 1) {
        // Double-clic sur la molette (deux appuis rapprochés sans déplacement) : zoom étendu, comme AutoCAD.
        // Le navigateur n'envoie « dblclick » que pour le bouton gauche : on le détecte ici.
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= 6) {
          const now = performance.now(), last = this.lastMiddle;
          if (last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 12) {
            this.lastMiddle = null;
            if (this.ui.mspace?.locked) return;
            this.r.fit();
            this.r.requestRender(true);
          } else this.lastMiddle = { t: now, x: e.clientX, y: e.clientY };
        } else this.lastMiddle = null;
        return;
      }
      if (d.button === 2) {
        // Sans commande en cours : menu contextuel (sur un objet : il est sélectionné) ; pendant une commande : Entrée.
        if (!this.request && !this.running && !this.box && !this.dragGrip && this.ui.onContextMenu && !d.moved) {
          this.computeCursor(screen);
          const id = this.r.pick(this.cursor.raw, this.worldTol(this.settings.pickbox));
          if (id != null && !this.selection.has(id)) this.setSelection([id]);
          this.ui.onContextMenu({ x: e.clientX, y: e.clientY, ids: [...this.selection], picked: id });
          return;
        }
        this.submit(''); // clic droit = Entrée
        return;
      }
      if (d.handled === true) return;
      this.computeCursor(screen);
      // Poignée glissée puis relâchée : déposée là ; simple clic : la destination se clique ensuite.
      if (d.handled === 'grip') { if (d.moved && this.dragGrip) this.click(d.shift); return; }
      if (this.box?.drag && d.moved) { this.finishBox(d.shift); return; }
      if (!d.moved) this.click(d.shift);
    });

    el.addEventListener('dblclick', (e) => {
      if (this.request) return;
      // Travail dans une fenêtre de présentation : double-clic hors de la fenêtre = retour à la feuille.
      const ms = this.ui.mspace;
      if (ms?.active) {
        const rect = el.getBoundingClientRect();
        if (!ms.contains([e.clientX - rect.left, e.clientY - rect.top])) { if (this.dragGrip) { this.dragGrip = null; this.r.setPreview([]); } ms.exit(); return; }
      }
      // Le deuxième appui a pu saisir une poignée : un double-clic n'est pas un étirement.
      if (this.dragGrip) { this.dragGrip = null; this.resetTracking(); this.r.setPreview([]); this.print('*Annuler*'); }
      // Présentation : double-clic dans une fenêtre pour y zoomer / se déplacer, hors de la fenêtre active pour
      // revenir à la feuille (comme AutoCAD).
      const vp = this.r.space !== 'model' ? this.viewportAt(this.cursor.raw) : null;
      if (this.r.activeViewport != null && vp?.id !== this.r.activeViewport) { this.setActiveViewport(null); return; }
      // Double-clic sur un objet : on le sélectionne seul et on propose de le modifier.
      const id = this.r.pick(this.cursor.raw, this.worldTol(this.settings.pickbox));
      if (id != null) { this.setSelection([id]); this.ui.onEdit?.(id); return; }
      if (vp && this.r.activeViewport == null) {
        this.setSelection([]);
        if (ms?.enter(vp.id)) return; // on travaille dans la fenêtre (objets de l'espace objet)
        this.setActiveViewport(vp.id); // fenêtre tournée : zoom et déplacement seulement
        return;
      }
      if (!this.selection.size) this.r.fit();
    });
    el.addEventListener('auxclick', (e) => e.preventDefault());
    el.addEventListener('pointerleave', () => { this.cursor.screen = null; this.r.requestRender(); });
  }

  click(shift) {
    const req = this.request;
    const p = this.cursor.world;
    if (this.dragGrip) {
      const { id, grip } = this.dragGrip;
      this.dragGrip = null;
      const e = this.doc.get(id);
      if (e) this.doc.transaction(grip.k === 'dyn' ? 'Paramètre du bloc' : 'Étirer', () => this.doc.update(this.gripResult(e, grip, p)));
      this.resetTracking();
      this.r.setPreview([]);
      this.setSelection(this.selection);
      return;
    }
    if (req) {
      if (req.kind === 'point' || req.kind === 'distance' || req.kind === 'angle') {
        if (req.kind === 'distance' && req.base) { this.answer(G.dist(req.base, p)); return; }
        if (req.kind === 'angle' && req.base) { this.answer(G.angleOf(req.base, p)); return; }
        this.answer([p[0], p[1]]);
        return;
      }
      if (req.kind === 'entity') {
        const id = this.r.pick(this.cursor.raw, this.worldTol(this.settings.pickbox));
        if (id == null) { this.print('Aucun objet trouvé.'); return; }
        this.answer({ id, p: this.cursor.raw });
        return;
      }
      if (req.kind === 'select') { this.selectClick(shift); return; }
      return;
    }
    // Pas de commande : poignée, objet, ou début de fenêtre.
    if (!shift) {
      const grip = this.gripAt(this.cursor.raw);
      if (grip) { this.startGrip(grip); return; }
    }
    this.selectClick(shift);
  }

  // Poignée sous le curseur (objets sur un calque verrouillé exclus).
  gripAt(p) {
    if (!this.selection.size) return null;
    const tol = this.worldTol(this.settings.grip);
    const grip = this.grips().find((g) => Math.abs(g.p[0] - p[0]) <= tol && Math.abs(g.p[1] - p[1]) <= tol);
    if (!grip) return null;
    const l = this.doc.layers.get(this.doc.get(grip.id)?.layer);
    return l?.locked ? null : grip;
  }

  startGrip(grip) {
    // Poignées dynamiques à clic : inversion (immédiate), visibilité (liste des états).
    if (grip.click) {
      const e = this.doc.get(grip.id);
      if (grip.shape === 'flip' && e) {
        const v = (e.dyn?.[grip.param] ?? 0) ? 0 : 1;
        this.doc.transaction('Inverser', () => this.doc.update(withValue(this.doc, e, grip.param, v)));
        this.setSelection(this.selection);
      } else if (grip.shape === 'menu') this.ui.onDynMenu?.(grip.id, grip.param, this.r.toScreen(grip.p[0], grip.p[1]));
      return;
    }
    this.dragGrip = { id: grip.id, grip };
    this.print('** ÉTIREMENT ** Cliquez ou relâchez au nouvel emplacement (Échap pour annuler)');
    this.r.requestRender();
  }

  selectClick(shift) {
    if (this.box) { this.finishBox(shift); return; }
    const id = this.r.pick(this.cursor.raw, this.worldTol(this.settings.pickbox));
    if (id != null) {
      this.addToSelection([id], shift);
      return;
    }
    this.box = { start: this.cursor.raw, end: this.cursor.raw, drag: false };
  }

  finishBox(shift) {
    const { start } = this.box;
    const end = this.cursor.raw;
    this.box = null;
    const crossing = end[0] < start[0]; // droite → gauche : capture
    const box = {
      minX: Math.min(start[0], end[0]), maxX: Math.max(start[0], end[0]),
      minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]),
    };
    const ids = this.r.selectBox(box, crossing);
    this.addToSelection(ids, shift);
    this.r.requestRender();
  }

  // --- fenêtre de présentation active ----------------------------------------------------

  // Fenêtre (non désactivée) de la présentation affichée contenant le point p (papier).
  viewportAt(p) {
    return [...(this.r.viewports || [])].reverse().find((v) => !v.off
      && Math.abs(p[0] - v.c[0]) <= v.w / 2 && Math.abs(p[1] - v.c[1]) <= v.h / 2
      && (!v.clip || inPolygon(p, v.clip))) || null;
  }

  activeVp() {
    const id = this.r.activeViewport;
    const v = id != null ? this.doc?.get(id) : null;
    return v?.type === 'VIEWPORT' && v.space === this.r.space ? v : null;
  }

  setActiveViewport(id) {
    this.vpCommit();
    this.r.activeViewport = id;
    this.r.requestRender();
    const v = this.activeVp();
    if (v) this.print(v.locked ? 'Fenêtre active (affichage verrouillé : la molette zoome la feuille).'
      : 'Fenêtre active : molette = zoom, bouton du milieu = déplacement. Double-clic hors de la fenêtre ou Échap pour revenir à la feuille.');
    else if (id == null) this.print('Retour à la feuille.');
    this.ui.onState?.();
  }

  // Zoom dans la fenêtre active autour du point de l'écran (sx, sy) : le point de l'espace objet sous le
  // curseur reste en place. Faux si aucune fenêtre active (ou verrouillée).
  vpZoom(sx, sy, f) {
    const v = this.activeVp();
    if (!v || v.locked) return false;
    const P = this.r.toWorld(sx, sy);
    const k = v.h / v.vh, k2 = k * f;
    const vc = [v.vc[0] + (P[0] - v.c[0]) * (1 / k - 1 / k2), v.vc[1] + (P[1] - v.c[1]) * (1 / k - 1 / k2)];
    this.vpChange({ ...v, vh: v.vh / f, vc });
    return true;
  }

  vpPan(dx, dy) {
    const v = this.activeVp();
    if (!v || v.locked) return false;
    const k = v.h / v.vh, s = this.r.scale;
    // Le centre de vue est dans le repère du papier (torsion comprise) : déplacement papier / échelle.
    this.vpChange({ ...v, vc: [v.vc[0] - dx / s / k, v.vc[1] + dy / s / k] });
    return true;
  }

  // Vue de la fenêtre modifiée en direct, enregistrée en une étape d'annulation quand on s'arrête.
  vpChange(nv) {
    if (!this.vpBefore) this.vpBefore = this.doc.get(nv.id);
    this.doc.updateQuiet(nv);
    clearTimeout(this.vpTimer);
    this.vpTimer = setTimeout(() => this.vpCommit(), 600);
  }

  vpCommit() {
    clearTimeout(this.vpTimer);
    if (this.vpBefore && this.doc) this.doc.commitQuiet(this.vpBefore, 'Vue de la fenêtre');
    this.vpBefore = null;
  }

  // --- clavier ------------------------------------------------------------------------

  // Renvoie vrai si la touche a été traitée.
  key(e) {
    const k = e.key;
    if (k === 'Escape') {
      if (this.request || this.dragGrip || this.box) this.cancel();
      else if (this.r.activeViewport != null) this.setActiveViewport(null);
      else if (!this.selection.size && this.ui.mspace?.active) this.ui.mspace.exit();
      else this.setSelection([]);
      return true;
    }
    if (k === 'F3') { this.toggle('osnap'); return true; }
    if (k === 'F7') { this.toggle('grid'); return true; }
    if (k === 'F9') { this.toggle('snap'); return true; }
    if (k === 'F8') { this.toggle('ortho'); return true; }
    if (k === 'F10') { this.toggle('polar'); return true; }
    if (k === 'F11') { this.toggle('otrack'); return true; }
    if (k === 'F1') { if (this.findCommand('AIDE')) this.run('AIDE'); return true; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (k === 'z' || k === 'Z')) { this.run('U'); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) { this.run('REDO'); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'A')) { this.selectAll(); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { this.run('ENREGDXF'); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'C') && this.selection.size && !this.request) { this.run('COPIERPRESSE'); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'v' || k === 'V') && !this.request) { this.run('COLLER'); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'x' || k === 'X') && this.selection.size && !this.request) { this.run('COUPERPRESSE'); return true; }
    if ((k === 'Delete') && !this.request && this.selection.size) { this.run('EFFACER'); return true; }
    return false;
  }

  toggle(name) {
    this.settings[name] = !this.settings[name];
    if (name === 'ortho' && this.settings.ortho) this.settings.polar = false;
    if (name === 'polar' && this.settings.polar) this.settings.ortho = false;
    if (name === 'grid' && this.settings.grid && !this.settings.gridSize) this.settings.gridSize = this.defaultGrid();
    if (name === 'snap' && this.settings.snap && !this.settings.snapSize) this.settings.snapSize = this.settings.gridSize || this.defaultGrid();
    this.r.requestRender();
    const labels = { osnap: 'Accrochage aux objets', ortho: 'Mode ortho', polar: 'Repérage polaire', grid: 'Grille', snap: 'Pas', otrack: 'Repérage d’accrochage' };
    if (name === 'otrack' && !this.settings.otrack) this.resetTracking();
    this.print(`<${labels[name]} ${this.settings[name] ? 'activé' : 'désactivé'}>`);
    this.ui.onState?.();
  }

  // --- couche interface (curseur, fenêtre, poignées, accrochage) ---------------------------

  // Pas de grille par défaut : une valeur « ronde » donnant environ 40 pixels à l'écran.
  defaultGrid() {
    const raw = 40 / this.r.scale;
    const pow = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) || raw;
  }

  drawGrid(ctx, view) {
    let k = this.settings.gridSize || this.defaultGrid();
    while (k * view.scale < 8) k *= 5; // trop serrée à ce zoom : on espace
    ctx.strokeStyle = this.r.themeName === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ucs = ucsOf(this.doc);
    if (isWorld(ucs)) {
      const [x0, y0] = this.r.toWorld(0, this.r.height), [x1, y1] = this.r.toWorld(this.r.width, 0);
      for (let x = Math.ceil(x0 / k) * k; x <= x1; x += k) { const [sx] = view.toScreen(x, 0); ctx.moveTo(sx, 0); ctx.lineTo(sx, ctx.canvas.height); }
      for (let y = Math.ceil(y0 / k) * k; y <= y1; y += k) { const [, sy] = view.toScreen(0, y); ctx.moveTo(0, sy); ctx.lineTo(ctx.canvas.width, sy); }
    } else {
      // Grille alignée sur le SCU : emprise de l'écran exprimée dans le SCU.
      const corners = [[0, 0], [this.r.width, 0], [0, this.r.height], [this.r.width, this.r.height]].map(([x, y]) => toUcs(ucs, this.r.toWorld(x, y)));
      const u0 = Math.min(...corners.map((c) => c[0])), u1 = Math.max(...corners.map((c) => c[0]));
      const v0 = Math.min(...corners.map((c) => c[1])), v1 = Math.max(...corners.map((c) => c[1]));
      const seg = (a, b) => { const [ax, ay] = view.toScreen(...fromUcs(ucs, a)), [bx, by] = view.toScreen(...fromUcs(ucs, b)); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); };
      for (let x = Math.ceil(u0 / k) * k; x <= u1; x += k) seg([x, v0], [x, v1]);
      for (let y = Math.ceil(v0 / k) * k; y <= v1; y += k) seg([u0, y], [u1, y]);
    }
    ctx.stroke();
  }

  // Icône du SCU : axes X (rouge) et Y (vert) à l'origine du SCU si elle est à l'écran, sinon en bas à gauche ;
  // un carré au croisement en SCU général (comme AutoCAD).
  drawUcsIcon(ctx, view) {
    const icon = ucsIconOf(this.doc);
    if (!icon.on || !this.doc) return;
    const { dpr } = view;
    const ucs = ucsOf(this.doc);
    const L = 34 * dpr, m = 24 * dpr;
    let [x, y] = view.toScreen(ucs.origin[0], ucs.origin[1]);
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (!icon.origin || x < m || y < L + m || x > W - L - m || y > H - m) { x = m + 6 * dpr; y = H - m - 6 * dpr; }
    const c = Math.cos(ucs.angle), s = Math.sin(ucs.angle);
    const axis = (dx, dy, color, label) => {
      const ex = x + dx * L, ey = y - dy * L;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      const a = Math.atan2(ey - y, ex - x), h = 7 * dpr;
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(ex - h * Math.cos(a - 0.4), ey - h * Math.sin(a - 0.4)); ctx.lineTo(ex - h * Math.cos(a + 0.4), ey - h * Math.sin(a + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.fillText(label, ex + dx * 6 * dpr - 4 * dpr, ey - dy * 6 * dpr + 4 * dpr);
    };
    axis(c, s, '#e5484d', 'X');
    axis(-s, c, '#30a46c', 'Y');
    if (isWorld(ucs)) { ctx.strokeStyle = '#9aa4b2'; ctx.lineWidth = 1 * dpr; ctx.strokeRect(x, y - 6 * dpr, 6 * dpr, 6 * dpr); }
  }

  drawUi(ctx, view) {
    const { dpr } = view;
    const S = (p) => view.toScreen(p[0], p[1]);
    if (this.settings.grid) this.drawGrid(ctx, view);
    this.drawUcsIcon(ctx, view);
    // Poignées
    const grips = this.grips();
    ctx.lineWidth = 1 * dpr;
    for (const g of grips) {
      const [x, y] = S(g.p);
      const hot = this.dragGrip && this.dragGrip.id === g.id && this.dragGrip.grip.k === g.k && this.dragGrip.grip.i === g.i && this.dragGrip.grip.param === g.param;
      const s = this.settings.grip * dpr;
      if (g.k === 'dyn') { drawDynGrip(ctx, x, y, s, g, hot); continue; }
      ctx.fillStyle = hot ? '#ff3b30' : '#2f7bff';
      ctx.strokeStyle = '#ffffff';
      ctx.fillRect(x - s, y - s, 2 * s, 2 * s);
      ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
    }
    // Fenêtre de sélection
    if (this.box?.end) {
      const [x0, y0] = S(this.box.start), [x1, y1] = S(this.box.end);
      const crossing = this.box.end[0] < this.box.start[0];
      ctx.fillStyle = crossing ? 'rgba(46, 204, 113, 0.15)' : 'rgba(52, 120, 246, 0.15)';
      ctx.strokeStyle = crossing ? '#2ecc71' : '#3478f6';
      ctx.setLineDash(crossing ? [6 * dpr, 4 * dpr] : []);
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
    const c = this.cursor;
    if (!c.screen) return;
    const fg = this.r.themeName === 'dark' ? '#ffffff' : '#000000';
    const req = this.request;
    const base = this.dragGrip ? this.dragGrip.grip.p : req?.base;
    // Ligne élastique depuis le point de base
    if (base && (req || this.dragGrip)) {
      const [bx, by] = S(base), [px, py] = S(c.world);
      ctx.strokeStyle = 'rgba(160, 170, 185, 0.9)';
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(px, py); ctx.stroke();
      ctx.setLineDash([]);
      if (c.polar) {
        ctx.strokeStyle = 'rgba(46, 204, 113, 0.7)';
        ctx.setLineDash([2 * dpr, 6 * dpr]);
        const far = G.polar(base, c.polar.angle, 1e5 / this.r.scale);
        const [fx, fy] = S(far);
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Saisie dynamique : longueur et angle
      const d = G.dist(base, c.world);
      const a = (G.normAngle(G.angleOf(base, c.world)) * 180) / Math.PI;
      tooltip(ctx, px + 16 * dpr, py + 22 * dpr, `${fmt(d)} < ${fmt(a)}°`, dpr);
    }
    // Curseur en croix + carré de sélection
    const [cx, cy] = S(c.world);
    const arm = this.settings.cursor * dpr;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
    ctx.stroke();
    if (!req || req.kind === 'select' || req.kind === 'entity') {
      const s = this.settings.pickbox * dpr;
      ctx.strokeRect(cx - s, cy - s, 2 * s, 2 * s);
    }
    // Repérage : points acquis (+) et alignements en pointillés jusqu'au curseur.
    for (const t of this.tracked) {
      const [x, y] = S(t);
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x - 5 * dpr, y); ctx.lineTo(x + 5 * dpr, y); ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x, y + 5 * dpr);
      ctx.stroke();
    }
    if (c.track) {
      ctx.save();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 1 * dpr;
      for (const L of c.track.lines) {
        const [x0, y0] = S(L.t), [x1, y1] = S(c.track.p);
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1 + ((x1 - x0) / len) * 40 * dpr, y1 + ((y1 - y0) / len) * 40 * dpr);
        ctx.stroke();
      }
      ctx.restore();
      const L = c.track.lines[0];
      const ang = Math.round(((Math.atan2(c.track.p[1] - L.t[1], c.track.p[0] - L.t[0]) * 180) / Math.PI + 360) % 360);
      const label = c.track.lines.length > 1 ? 'Repérage : intersection' : `Repérage : ${fmt(G.dist(L.t, c.track.p))} < ${ang}°`;
      tooltip(ctx, cx + 16 * dpr, cy - 14 * dpr, label, dpr);
    }
    // Marqueur d'accrochage
    if (c.snap) {
      drawSnapMarker(ctx, S(c.snap.p), c.snap.k, dpr);
      tooltip(ctx, cx + 16 * dpr, cy - 14 * dpr, SNAP_LABELS[c.snap.k] || c.snap.k, dpr);
    }
  }
}

// Précision d'affichage des longueurs et coordonnées (décimales, LUPREC du dessin ; 4 par défaut).
let PREC = 4;
export function setDisplayPrecision(n) {
  PREC = Number.isInteger(n) && n >= 0 && n <= 8 ? n : 4;
}

export function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  const k = 10 ** PREC;
  return String(Math.round(v * k) / k);
}

function tooltip(ctx, x, y, text, dpr) {
  ctx.font = `${12 * dpr}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10 * dpr, h = 18 * dpr;
  ctx.fillStyle = 'rgba(30, 34, 41, 0.92)';
  ctx.fillRect(x, y - h + 4 * dpr, w, h);
  ctx.fillStyle = '#e8ecf1';
  ctx.fillText(text, x + 5 * dpr, y);
}

// Poignée de paramètre dynamique (cyan, comme AutoCAD) : flèche (longueur), carré (point), cercle (rotation),
// double flèche (inversion), triangle (liste de visibilité).
function drawDynGrip(ctx, x, y, s, g, hot) {
  ctx.save();
  ctx.fillStyle = hot ? '#ff3b30' : '#22d3ee';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  ctx.translate(x, y);
  ctx.beginPath();
  const r = s * 1.3;
  if (g.shape === 'arrow' || g.shape === 'flip') {
    ctx.rotate(-(g.dir || 0));
    if (g.shape === 'arrow') { ctx.moveTo(r * 1.2, 0); ctx.lineTo(-r * 0.6, r * 0.8); ctx.lineTo(-r * 0.6, -r * 0.8); }
    else { ctx.moveTo(0, -r * 1.2); ctx.lineTo(r * 0.8, -r * 0.2); ctx.lineTo(-r * 0.8, -r * 0.2); ctx.closePath(); ctx.moveTo(0, r * 1.2); ctx.lineTo(r * 0.8, r * 0.2); ctx.lineTo(-r * 0.8, r * 0.2); }
  } else if (g.shape === 'circle') ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
  else if (g.shape === 'menu') { ctx.moveTo(-r, -r * 0.6); ctx.lineTo(r, -r * 0.6); ctx.lineTo(0, r * 0.8); }
  else ctx.rect(-s, -s, 2 * s, 2 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawSnapMarker(ctx, [x, y], kind, dpr) {
  const s = 7 * dpr;
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  switch (kind) {
    case 'end': ctx.rect(x - s, y - s, 2 * s, 2 * s); break;
    case 'mid': ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s); ctx.lineTo(x - s, y + s); ctx.closePath(); break;
    case 'cen': ctx.arc(x, y, s, 0, Math.PI * 2); break;
    case 'qua': ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); break;
    case 'int': ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); break;
    case 'per': ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.moveTo(x - s, y + s); ctx.lineTo(x - s, y - s); ctx.moveTo(x - s, y); ctx.lineTo(x, y); ctx.lineTo(x, y + s); break;
    case 'nea': ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.closePath(); break;
    case 'node': ctx.arc(x, y, s, 0, Math.PI * 2); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); break;
    default: ctx.rect(x - s, y - s, 2 * s, 2 * s); ctx.rect(x - s / 2, y - s / 2, s, s);
  }
  ctx.stroke();
}

// Point dans un polygone (règle pair-impair) : fenêtres de présentation découpées.
function inPolygon(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
