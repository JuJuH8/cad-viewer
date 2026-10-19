// SPDX-License-Identifier: GPL-3.0-or-later
// Moteur de rendu de l'éditeur.
//
// - La géométrie de chaque entité est tessellée une fois et mise en cache.
// - Les entités sont regroupées en paquets (« chunks ») de taille limitée : modifier une
//   entité ne reconstruit que son paquet, pas tout le dessin.
// - Un index spatial (R-tree) sert à la sélection et à l'accrochage.
// - Deux calques 2D superposés : textes (redessinés quand la vue change) et interface
//   (curseur, poignées, fenêtre de sélection… redessinés à chaque mouvement de souris).
// - Ordre de tracé (ORDRETRACE, masques) : en 2D, la profondeur de chaque sommet vient de la clé d'ordre de son
//   objet (attribut drawOrder), le test de profondeur de la carte graphique superpose donc les objets dans le bon
//   ordre quel que soit leur paquet. Les textes (canevas 2D) sont dessinés par-dessus, sauf sous un masque.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RBush from 'rbush';
import * as G from '../core/geom.js';
import { aciToColor, FOREGROUND, BACKGROUND, toCss } from '../colors.js';
import { drawKey } from '../core/draworder.js';
import { buildModelView, disposeModelView, viewportMatrix, viewportRect, viewportScale } from './viewports.js';
import { fatLines, fatMaterial, updateFatMaterials, overrideMaterial, lwMm } from './fatlines.js';
import { partLineweight } from '../core/document.js';
import { lwDefaultMm } from '../core/drawing-settings.js';
import { plotColor, styleOf } from '../plot/styles.js';
import { Tessellator, partsBox, colorToken } from '../core/tessellate.js';
import { buildMep3d, disposeGroup } from '../mep/mep3d.js';
import { curvesOf, distanceToCurves } from '../core/entities.js';
import { drawTexts, textHit } from '../text.js';
import { buildGrid, gridItems } from './seggrid.js';
import { UnderlayView } from '../underlay/layer3d.js';
import { onFontLoaded } from '../fonts/registry.js';
import { triangulateLoops } from '../hatch.js';

const CHUNK_SIZE = 1500;
// Couleurs exactes (ACI, RVB, fond) : pas de conversion d'espace colorimétrique des couleurs ni des sommets ; sortie
// linéaire en 2D (octets affichés tels quels), sRVB en 3D (éclairage).
THREE.ColorManagement.enabled = false;

// Matériau dont la profondeur suit l'ordre de tracé en 2D (uniformes partagés par le moteur de rendu).
function orderable(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float drawOrder;\nuniform float uOrder2d;\nuniform float uOrderK;\nuniform float uOrderZ0;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tif (uOrder2d > 0.5) gl_Position.z = (uOrderZ0 - drawOrder * uOrderK) * gl_Position.w;');
  };
  mat.customProgramCacheKey = () => 'cv-draw-order';
  return mat;
}
const THEMES = {
  // Fonds de la charte de l'interface (sombre #111110, clair #F2F1EC) ; sélection en bleu, distincte des objets rouges.
  dark: { background: 0x161615, foreground: 0xffffff, grid: [0x3a3936, 0x262624], select: 0x4da3ff, hover: 0x9cc9ff, preview: 0xffcc66 },
  light: { background: 0xfbfbf9, foreground: 0x000000, grid: [0xd3d1ca, 0xe8e6e0], select: 0x1d6fe0, hover: 0x5b9cf0, preview: 0xc77800 },
  // Présentation : feuille blanche sur fond gris, couleur 7 en noir (comme AutoCAD).
  paper: { background: 0x4a4a47, foreground: 0x000000, grid: [0xd3d1ca, 0xe8e6e0], select: 0x1d6fe0, hover: 0x5b9cf0, preview: 0xc77800, sheet: 0xffffff, shadow: 0x1d1d1b },
};

function pointInTri(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export class Renderer {
  constructor(container) {
    this.container = container;
    this.webgl = new THREE.WebGLRenderer({ antialias: true, stencil: true }); // gabarit : fenêtres non rectangulaires
    this.webgl.setPixelRatio(window.devicePixelRatio || 1);
    this.webgl.outputColorSpace = THREE.LinearSRGBColorSpace;
    container.appendChild(this.webgl.domElement);
    this.canvas = this.webgl.domElement;

    this.textLayer = document.createElement('canvas');
    this.textLayer.className = 'overlay';
    container.appendChild(this.textLayer);
    this.uiLayer = document.createElement('canvas');
    this.uiLayer.className = 'overlay';
    container.appendChild(this.uiLayer);

    this.scene = new THREE.Scene();
    // Ordre de tracé : profondeur = Z0 - clé × K (clés relatives à orderBase, fenêtre orderWin).
    this.orderUniforms = { uOrder2d: { value: 1 }, uOrderK: { value: 1 }, uOrderZ0: { value: 0.99 } };
    this.mvOrderUniforms = { uOrder2d: { value: 1 }, uOrderK: { value: 1 }, uOrderZ0: { value: 0.99 } }; // fenêtres
    this.orderBase = 0;
    this.orderWin = { lo: 0, hi: 1 };
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.ortho.position.set(0, 0, 1e6);
    this.perspective = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.perspective.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.perspective, this.canvas);
    this.controls.enabled = false;
    this.controls.addEventListener('change', () => this.requestRender());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.sun);

    this.drawing = new THREE.Group();     // paquets du dessin
    this.overlay3d = new THREE.Group();   // sélection, survol, aperçu
    this.overlaySel = new THREE.Group();  // sélection et survol
    this.overlayPrev = new THREE.Group(); // aperçu de la commande en cours
    this.overlay3d.add(this.overlaySel, this.overlayPrev);
    this.selDirty = this.prevDirty = false;
    this.markup3d = new THREE.Group();   // comparaison de versions d'un fond de plan (construite une fois)
    this.sheet3d = new THREE.Group();    // feuille de la présentation (sous le dessin)
    this.sheet = null;                   // mise en page de la présentation affichée (layout/sheet.js)
    this.scene.add(this.sheet3d, this.drawing, this.overlay3d, this.markup3d);
    this.underlays = new UnderlayView(this); // fonds PDF et images (sous le dessin)
    this.scene.add(this.underlays.group);

    this.mode = '2d';
    this.origin = { x: 0, y: 0, z: 0 };
    this.modeListeners = []; // appelés après un changement de vue 2D / 3D (en plus de onModeChange)
    this.center = { x: 0, y: 0 };
    this.scale = 1;                     // pixels CSS par unité de dessin
    this.extents = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
    this.doc = null;
    this.space = 'model';
    this.cache = new Map();             // id → { parts, box, item }
    this.maskIds = new Set();           // objets masquants (WIPEOUT, blocs qui en contiennent) de l'espace affiché
    this.chunks = [];                   // { layer, ids: Set, group, texts, dirty, partLayers, colorLayers }
    this.chunkOf = new Map();           // id → paquet
    this.openChunks = new Map();        // calque → paquet en cours de remplissage
    this.layerState = new Map();        // calque → état connu (pour détecter ce qui a changé)
    this.index = new RBush();
    this.selection = new Set();
    this.hover = null;
    this.preview = [];
    this.markup = null;                 // comparaison de fonds de plan : { groups: [{ entities, color }], boxes, boxColor }
    this.uiDraw = null;                 // fonction (ctx, view) fournie par l'éditeur
    this.modelScene = new THREE.Scene(); // contenu de l'espace objet vu dans les fenêtres de présentation
    this.modelView = null;
    this.viewports = [];                // fenêtres de la présentation affichée
    this.lwDisplay = false;             // affichage des épaisseurs de ligne dans les présentations (LWDISPLAY)
    this.plotStyles = null;             // table de styles de tracé affichée dans la présentation
    this.activeViewport = null;         // fenêtre où l'on zoome / se déplace (double-clic dedans)
    this.setTheme('dark');
    // Police SHX arrivée : textes redessinés (une fois pour plusieurs polices).
    onFontLoaded(() => {
      clearTimeout(this.fontTimer);
      this.fontTimer = setTimeout(() => this.refreshTexts(), 30);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // --- document ------------------------------------------------------------------

  // Réseaux MEP voisins (pour les ouvertures de paroi au droit des piquages).
  mepNeighbors(e) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of e.pts) G.growBox(b, p[0], p[1]);
    const pad = (e.mep.w || e.mep.d || 0) + 1;
    const ids = this.index.search({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad });
    return ids.map((h) => this.doc.get(h.id)).filter((o) => o && o.mep && o.type === 'LWPOLYLINE' && o.id !== e.id);
  }

  newTessellator() {
    const t = new Tessellator(this.doc);
    t.neighborsOf = (e) => this.mepNeighbors(e);
    return t;
  }

  setDocument(doc) {
    this.unsubscribe?.();
    this.dropModelView();
    this.doc = doc;
    this.hiddenIds = null; // objets masqués (ISOLEROBJETS / MASQUEROBJETS) : état de la vue, non enregistré
    this.markup = null;
    this.markupTess = null;
    this.buildMarkup?.();
    this.tess = this.newTessellator();
    this.space = 'model';
    this.selection.clear();
    this.hover = null;
    this.unsubscribe = doc.on((change) => this.onChange(change));
    this.rebuildAll(true);
  }

  // sheet : mise en page de la présentation (feuille affichée), si elle est connue.
  setSpace(id, sheet) {
    this.space = id;
    if (sheet !== undefined) this.sheet = sheet;
    this.selection.clear();
    this.hover = null;
    this.rebuildAll(true);
  }

  onChange(change) {
    // Contenu des fenêtres de présentation : à refaire si l'espace objet a changé.
    if (this.modelView && !this.modelView.dirty) {
      if (change.reset || this.space === 'model') this.modelView.dirty = true;
      else if ([...change.added, ...change.modified].some((id) => this.doc.get(id)?.space === 'model')
        || [...change.removed].some((id) => !this.cache.has(id))) this.modelView.dirty = true;
    }
    if (change.reset) { this.rebuildAll(false); return; }
    for (const name of change.layers) this.layerChanged(name);
    // Réseaux MEP touchés : leurs voisins (avant et après) sont redessinés aussi (ouvertures de paroi).
    const neighbors = new Set();
    const touched = [...change.removed, ...change.added, ...change.modified];
    for (const id of touched) {
      const old = this.cache.get(id);
      const e = this.doc.get(id);
      if (!old?.mep && !e?.mep) continue;
      const boxes = old?.box ? [old.box] : [];
      if (e?.mep && e.type === 'LWPOLYLINE') for (const o of this.mepNeighbors(e)) neighbors.add(o.id);
      for (const b of boxes) for (const h of this.index.search(b)) if (this.doc.get(h.id)?.mep) neighbors.add(h.id);
    }
    for (const id of change.removed) this.forget(id);
    for (const id of new Set([...change.added, ...change.modified])) {
      const e = this.doc.get(id);
      this.forget(id);
      if (e && e.space === this.space) this.track(e);
    }
    // Réseaux ajoutés ou modifiés ensemble (DIMENSIONNER, copie…) : second passage, une fois tous
    // indexés, pour qu'ils se voient mutuellement (réductions, piquages).
    const mepChanged = [...new Set([...change.added, ...change.modified])].map((id) => this.doc.get(id))
      .filter((e) => e?.mep && e.type === 'LWPOLYLINE' && e.space === this.space);
    if (mepChanged.length > 1) for (const e of mepChanged) { this.forget(e.id); this.track(e); }
    for (const id of neighbors) {
      if (touched.includes(id)) continue;
      const e = this.doc.get(id);
      if (e && e.space === this.space && this.cache.has(id)) { this.forget(id); this.track(e); }
    }
    for (const id of change.removed) this.selection.delete(id);
    if (this.hover && !this.doc.get(this.hover)) this.hover = null;
    this.flush();
    this.refreshOverlay3d();
    if (this.mode === '3d') this.refreshMep3d();
    this.refreshViewports();
    this.requestRender(true);
  }

  // --- feuille de présentation --------------------------------------------------------

  // Mise en page de la présentation affichée (null : pas de feuille, espace objet).
  setSheet(sheet) {
    this.sheet = sheet || null;
    this.buildSheet();
    this.requestRender(true);
  }

  // Feuille blanche et son ombre, sous le dessin.
  buildSheet() {
    this.clearGroup(this.sheet3d);
    const sh = this.sheet;
    if (!sh || this.space === 'model') return;
    const o = this.origin;
    const x0 = sh.origin[0] - o.x, y0 = sh.origin[1] - o.y, x1 = x0 + sh.w, y1 = y0 + sh.h;
    const d = Math.max(sh.w, sh.h) * 0.006;
    const quad = (a0, b0, a1, b1, color, order) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([a0, b0, 0, a1, b0, 0, a1, b1, 0, a0, b0, 0, a1, b1, 0, a0, b1, 0], 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
      m.renderOrder = order;
      this.sheet3d.add(m);
    };
    quad(x0 + d, y0 - d, x1 + d, y1 - d, THEMES.paper.shadow, -21);
    quad(x0, y0, x1, y1, THEMES.paper.sheet, -20);
  }

  // Zone imprimable en pointillés (si la mise en page a des marges).
  drawPrintable(ctx, view) {
    const sh = this.sheet;
    const m = sh?.margins;
    if (!sh || this.space === 'model' || !m || !m.some((v) => v > 0)) return;
    const [l, b, r, t] = m;
    const [ax, ay] = view.toScreen(sh.origin[0] + l, sh.origin[1] + sh.h - t);
    const [bx, by] = view.toScreen(sh.origin[0] + sh.w - r, sh.origin[1] + b);
    ctx.save();
    ctx.strokeStyle = 'rgba(70, 80, 95, 0.8)';
    ctx.lineWidth = view.dpr;
    ctx.setLineDash([5 * view.dpr, 4 * view.dpr]);
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
    ctx.restore();
  }

  // Fenêtre active (zoom / déplacement dans la fenêtre) : cadre épais.
  drawActiveViewport(ctx, view) {
    const v = this.activeViewport != null ? this.viewports.find((x) => x.id === this.activeViewport) : null;
    if (!v) return;
    const [ax, ay] = view.toScreen(v.c[0] - v.w / 2, v.c[1] + v.h / 2);
    const [bx, by] = view.toScreen(v.c[0] + v.w / 2, v.c[1] - v.h / 2);
    ctx.save();
    ctx.strokeStyle = v.locked ? '#d97706' : '#2563eb';
    ctx.lineWidth = 3 * view.dpr;
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
    ctx.restore();
  }

  // --- fenêtres de présentation -------------------------------------------------------

  refreshViewports() {
    this.viewports = this.space === 'model' || !this.doc ? []
      : [...this.doc.entities.values()].filter((e) => e.type === 'VIEWPORT' && e.space === this.space);
  }

  dropModelView() {
    if (!this.modelView) return;
    this.underlays.releaseModelView(this.modelView);
    this.modelScene.remove(this.modelView.group);
    disposeModelView(this.modelView);
    this.modelView = null;
  }

  // Épaisseurs affichées : présentations seulement (comme AutoCAD, sur le papier).
  fatActive() {
    return this.lwDisplay && this.space !== 'model' && this.mode === '2d';
  }

  setLwDisplay(on) {
    if (this.lwDisplay === !!on) return;
    this.lwDisplay = !!on;
    if (this.modelView) this.modelView.dirty = true;
    if (this.space !== 'model') { for (const c of this.chunks) c.dirty = true; this.flush(); }
    this.requestRender(true);
  }

  ensureModelView() {
    if (!this.viewports.length) return null;
    if (this.modelView && !this.modelView.dirty && this.modelView.fat === this.fatActive()) return this.modelView;
    this.dropModelView();
    // Origine des coordonnées GPU : le point de l'espace objet au centre de la première fenêtre.
    const v = this.viewports[0];
    const [a, b, c, d, e, f] = viewportMatrix(v);
    const det = a * d - b * c, px = v.c[0] - e, py = v.c[1] - f;
    const origin = { x: (d * px - c * py) / det, y: (-b * px + a * py) / det, z: 0 };
    this.modelView = buildModelView(this.doc, {
      layerVisible: (n) => this.layerVisible(n), resolveColor: (t, part) => this.plotMap(this.resolveColor(t), part),
      lwFor: (t, mm, part) => this.plotLw(this.resolveColor(t), mm, part),
      rgbOf: (col) => this.rgbOf(col), materials: this.mvMaterials, origin, fat: this.fatActive(), lwDefault: lwDefaultMm(this.doc),
    });
    // Profondeur de l'ordre de tracé : fenêtre des clés de l'espace objet.
    const [lo, hi] = this.modelView.orderRange;
    const k = 1.98 / Math.max(hi - lo, 1e-9);
    this.mvOrderUniforms.uOrderK.value = k;
    this.mvOrderUniforms.uOrderZ0.value = 0.99 + lo * k;
    this.underlays.addToModelView(this.doc, this.modelView, () => this.requestRender(true));
    this.modelScene.add(this.modelView.group);
    return this.modelView;
  }

  // Rectangle d'une fenêtre à l'écran (pixels CSS), borné au canevas ; null s'il est hors champ.
  viewportScreenRect(v) {
    const r = viewportRect(v);
    const x0 = Math.max(0, (r.minX - this.center.x) * this.scale + this.width / 2);
    const x1 = Math.min(this.width, (r.maxX - this.center.x) * this.scale + this.width / 2);
    const y0 = Math.max(0, this.height / 2 - (r.maxY - this.center.y) * this.scale);
    const y1 = Math.min(this.height, this.height / 2 - (r.minY - this.center.y) * this.scale);
    return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
  }

  renderViewports() {
    const mv = this.ensureModelView();
    if (!mv) return;
    const gl = this.webgl;
    gl.autoClear = false;
    gl.setScissorTest(true);
    const o = mv.origin, po = this.origin;
    for (const v of this.viewports) {
      if (v.off) continue;
      const s = this.viewportScreenRect(v);
      if (!s) continue;
      gl.setScissor(s.x0, this.height - s.y1, s.x1 - s.x0, s.y1 - s.y0);
      const [a, b, c, d, e, f] = viewportMatrix(v);
      mv.group.matrix.set(a, c, 0, a * o.x + c * o.y + e - po.x, b, d, 0, b * o.x + d * o.y + f - po.y, 0, 0, 1, 0, 0, 0, 0, 1);
      mv.group.matrixWorldNeedsUpdate = true;
      this.applyViewportOverrides(mv, v);
      const clipped = v.clip?.length >= 3;
      if (clipped) this.stencilMask(v); // contour de la fenêtre dans le gabarit
      if (clipped) this.stencilTest(mv.group, true);
      gl.clearDepth();
      gl.render(this.modelScene, this.ortho);
      if (clipped) this.stencilTest(mv.group, false);
    }
    this.applyViewportOverrides(mv, null);
    gl.setScissorTest(false);
    gl.autoClear = true;
  }

  // Fenêtre découpée : son contour (papier) écrit dans le gabarit, puis le contenu dessiné seulement là.
  stencilMask(v) {
    if (!this.maskScene) {
      this.maskScene = new THREE.Scene();
      this.maskMat = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      });
    }
    this.maskScene.clear();
    const o = this.origin, pos = [];
    for (const t of triangulateLoops([v.clip])) pos.push(t[0] - o.x, t[1] - o.y, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, this.maskMat);
    m.frustumCulled = false;
    this.maskScene.add(m);
    this.webgl.clearStencil();
    this.webgl.render(this.maskScene, this.ortho);
    g.dispose();
  }

  stencilTest(group, on) {
    group.traverse((x) => {
      const mats = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
      for (const mat of mats) {
        mat.stencilWrite = on;
        mat.stencilRef = 1;
        mat.stencilFunc = on ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
        mat.stencilFail = mat.stencilZFail = mat.stencilZPass = THREE.KeepStencilOp;
      }
    });
  }

  // Réglages propres à une fenêtre, appliqués au contenu de l'espace objet juste avant de la dessiner
  // (v = null : état normal) : calques gelés, couleur / épaisseur / transparence imposées par calque,
  // transparence des hachures et remplissages.
  applyViewportOverrides(mv, v) {
    if (!mv.layerGroups) return;
    const fz = v?.frozen?.length ? new Set(v.frozen) : null;
    const fillAlpha = 1 - Math.min(90, Math.max(0, v?.hatchAlpha || 0)) / 100;
    for (const [layer, g] of mv.layerGroups) {
      g.visible = !fz || !fz.has(layer);
      const ov = v?.layerOvr?.[layer];
      const color = ov?.color != null ? this.rgbHex(aciToColor(ov.color)) : null;
      const alpha = 1 - Math.min(90, Math.max(0, ov?.transparency || 0)) / 100;
      for (const child of g.children) {
        const u = child.userData;
        if (!u?.base) continue;
        if (!v) { child.material = u.base; continue; }
        const a = u.kind === 'fill' ? alpha * fillAlpha : alpha;
        if (u.kind === 'fat') {
          const mm = ov?.lweight != null ? lwMm(ov.lweight, lwDefaultMm(this.doc)) : u.mm;
          child.material = color == null && a === 1 && mm === u.mm ? u.base : fatMaterial(mm, color, a);
        } else child.material = color == null && a === 1 ? u.base : overrideMaterial(u.kind, color, a);
      }
    }
  }

  // Couleur résolue (FOREGROUND compris) en entier RVB.
  rgbHex(color) {
    return color === FOREGROUND ? this.theme.foreground : color;
  }

  // Volumes 3D des réseaux MEP (reconstruits à chaque modification en vue 3D).
  refreshMep3d() {
    if (this.mep3d) { this.scene.remove(this.mep3d); disposeGroup(this.mep3d); this.mep3d = null; }
    if (this.mode !== '3d' || !this.doc) return;
    const ents = [...this.doc.entities.values()].filter((e) => e.mep && e.space === this.space && this.layerVisible(e.layer)
      && (!this.tools3d || this.tools3d.keepMep(e))); // filtres et isolement de la vue 3D
    if (!ents.length) return;
    const colorOf = (e) => {
      const c = this.resolveColor(colorToken(e));
      return c === FOREGROUND ? 0xd0d4da : c;
    };
    this.mep3d = buildMep3d(ents, colorOf, this.origin);
    this.scene.add(this.mep3d);
  }

  forget(id) {
    this.underlays.remove(id);
    this.maskIds.delete(id);
    const entry = this.cache.get(id);
    if (!entry) return;
    this.index.remove(entry.item);
    this.cache.delete(id);
    const chunk = this.chunkOf.get(id);
    if (chunk) { chunk.ids.delete(id); chunk.dirty = true; }
    this.chunkOf.delete(id);
  }

  // Objets masqués temporairement (null = aucun) ; la vue est reconstruite.
  setHidden(ids) {
    this.hiddenIds = ids && ids.size ? ids : null;
    this.dropModelView?.();
    this.rebuildAll(false);
  }

  track(e, bulk = null) {
    if (this.hiddenIds?.has(e.id)) return null;
    let parts;
    const mep = !!e.mep;
    try {
      parts = this.tess.entity(e);
    } catch (err) {
      console.warn(`Rendu impossible pour ${e.type} #${e.id}`, err);
      parts = [];
    }
    const box = partsBox(parts);
    const entry = { parts, box, item: null, mep, infinite: e.type === 'XLINE' };
    if (G.boxValid(box)) {
      entry.item = { ...box, id: e.id };
      if (bulk) bulk.push(entry.item); else this.index.insert(entry.item);
    }
    this.cache.set(e.id, entry);
    if (e.type === 'UNDERLAY') this.underlays.set(e);
    if (parts.some((p) => p.color === BACKGROUND && p.tris.length)) this.maskIds.add(e.id);
    // Un paquet ne contient que des entités d'un même calque : masquer un calque revient
    // le plus souvent à masquer ses paquets, sans rien reconstruire.
    let chunk = this.openChunks.get(e.layer);
    if (!chunk || chunk.ids.size >= CHUNK_SIZE) {
      chunk = { layer: e.layer, ids: new Set(), group: null, texts: [], dirty: true, partLayers: new Set(), colorLayers: new Set() };
      this.chunks.push(chunk);
      this.openChunks.set(e.layer, chunk);
    }
    chunk.ids.add(e.id);
    chunk.dirty = true;
    this.chunkOf.set(e.id, chunk);
    return entry;
  }

  // Textes redessinés (police chargée, style modifié) : tout est retessellé, vue conservée.
  refreshTexts() {
    if (!this.doc) return;
    if (this.modelView) this.modelView.dirty = true;
    const view = { center: { ...this.center }, scale: this.scale };
    this.rebuildAll(false);
    Object.assign(this.center, view.center);
    this.scale = view.scale;
    this.requestRender(true);
  }

  rebuildAll(fit) {
    for (const c of this.chunks) this.disposeChunk(c);
    this.chunks = [];
    this.cache.clear();
    this.chunkOf.clear();
    this.openChunks.clear();
    this.index.clear();
    this.underlays.clear();
    this.maskIds.clear();
    if (!this.doc) return;
    this.layerState = new Map([...this.doc.layers].map(([n, l]) => [n, { ...l }]));
    this.tess = this.newTessellator();
    this.resetOrder();
    const items = [];
    for (const e of this.doc.entities.values()) {
      if (e.space === this.space) this.track(e, items);
    }
    this.index.load(items); // chargement en bloc, bien plus rapide que des insertions successives
    // Les réseaux MEP dépendent de leurs voisins (ouvertures de paroi) : recalcul une fois l'index rempli.
    for (const e of this.doc.entities.values()) {
      if (e.space === this.space && e.mep && e.type === 'LWPOLYLINE') { this.forget(e.id); this.track(e); }
    }
    this.refreshViewports();
    this.extents = this.robustExtents();
    this.origin = { x: (this.extents.minX + this.extents.maxX) / 2, y: (this.extents.minY + this.extents.maxY) / 2, z: 0 };
    if (this.markup) this.buildMarkup(); // repères recalés sur la nouvelle origine
    this.buildSheet();
    this.flush();
    this.buildGrid();
    this.refreshOverlay3d();
    if (fit) this.fit();
    this.requestRender(true);
  }

  // --- ordre de tracé -------------------------------------------------------------

  // Base et fenêtre des clés d'ordre (objets de l'espace affiché), uniformes du nuanceur.
  resetOrder() {
    let lo = Infinity, hi = -Infinity;
    for (const e of this.doc?.entities.values() || []) {
      if (e.space !== this.space) continue;
      const k = drawKey(e);
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    this.orderBase = lo - 1;
    this.orderWin = { lo: 0, hi: 1 };
    this.noteOrder(0, hi - this.orderBase + 1);
    this.updateOrderUniforms(true);
  }

  // Clés écrites dans un paquet : la fenêtre s'élargit (avec de la marge) si elles en sortent.
  noteOrder(vmin, vmax) {
    const w = this.orderWin;
    if (vmin >= w.lo && vmax <= w.hi) return;
    const lo = Math.min(vmin, w.lo), hi = Math.max(vmax, w.hi), span = hi - lo;
    w.lo = lo - span * 0.25 - 16;
    w.hi = hi + span * 0.25 + 1024;
    this.updateOrderUniforms();
  }

  updateOrderUniforms() {
    const { lo, hi } = this.orderWin;
    const k = 1.98 / (hi - lo);
    this.orderUniforms.uOrderK.value = k;
    this.orderUniforms.uOrderZ0.value = 0.99 + lo * k;
  }

  // Clé d'ordre d'une part : clé de l'objet (relative à la base) + rang de la part dans l'objet.
  orderOf(e, i, n) {
    return drawKey(e) - this.orderBase + (n > 1 ? (0.9 * i) / n : 0);
  }

  // --- paquets -------------------------------------------------------------------

  // Changement d'un calque : visibilité seule → on masque / affiche les paquets « purs » ;
  // couleur → on reconstruit les paquets qui l'utilisent.
  layerChanged(name) {
    if (this.modelView) this.modelView.dirty = true;
    this.underlays.refreshVisibility();
    const prev = this.layerState.get(name);
    const now = this.doc.layers.get(name);
    if (now) this.layerState.set(name, { ...now }); else this.layerState.delete(name);
    const visChanged = !prev || !now || prev.on !== now.on || prev.frozen !== now.frozen;
    if (prev && now && prev.ltype !== now.ltype) {
      // Type de ligne du calque modifié : la géométrie (tirets) des entités du calque change.
      for (const e of this.doc.entities.values()) {
        if (e.space === this.space && e.layer === name && this.cache.has(e.id)) { this.forget(e.id); this.track(e); }
      }
    }
    const colorChanged = !prev || !now || prev.color !== now.color || prev.rgb !== now.rgb;
    for (const c of this.chunks) {
      if (colorChanged && (c.colorLayers.has(name) || c.partLayers.has(name))) { c.dirty = true; continue; }
      if (!visChanged) continue;
      if (c.layer === name && c.partLayers.size <= 1 && (!c.partLayers.size || c.partLayers.has(name))) {
        if (c.group) c.group.visible = this.layerVisible(name);
      } else if (c.layer === name || c.partLayers.has(name)) {
        c.dirty = true;
      }
    }
  }

  layerVisible(name) {
    if (this.vpHidden?.has(name)) return false; // calque gelé dans la fenêtre où l'on travaille (mspace.js)
    const l = this.doc.layers.get(name);
    return !l || (l.on && !l.frozen);
  }

  resolveColor(token) {
    if (typeof token === 'number' || token === FOREGROUND || token === BACKGROUND) return token;
    if (token === 'BYBLOCK') return FOREGROUND;
    const l = this.doc.layers.get(token.slice(2)) || this.doc.layers.get('0');
    if (!l) return FOREGROUND;
    if (typeof l.rgb === 'number') return l.rgb;
    return aciToColor(l.color);
  }

  // Styles de tracé affichés dans une présentation (« Afficher les styles de tracé ») : couleur et épaisseur
  // tracées au lieu de celles des objets.
  setPlotStyles(table) {
    if (this.plotStyles === (table || null)) return;
    this.plotStyles = table || null;
    if (this.modelView) this.modelView.dirty = true;
    if (this.space !== 'model' && this.doc) { for (const c of this.chunks) c.dirty = true; this.flush(); }
    this.requestRender(true);
  }

  // Aperçu des styles de tracé (présentations) : style par la couleur (CTB) ou par le style nommé du morceau (STB).
  plotMap(color, part = null) {
    if (!this.plotStyles || this.space === 'model' || color === BACKGROUND) return color;
    return plotColor(styleOf(this.plotStyles, color, part, this.doc), color);
  }

  plotLw(color, mm, part = null) {
    if (!this.plotStyles || this.space === 'model') return mm;
    return styleOf(this.plotStyles, color, part, this.doc)?.lineweight ?? mm;
  }

  rgbOf(color) {
    // Fond : celui de l'écran, ou la feuille blanche dans une présentation.
    const c = color === FOREGROUND ? this.theme.foreground : color === BACKGROUND ? (this.theme.sheet ?? this.theme.background) : color;
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; // octets (attribut couleur normalisé)
  }

  // Fond de plan atténué (ATTENUER, comme XREFFADE) : calques des xrefs ou calques choisis, mêlés au fond.
  isFaded(layer) {
    const f = this.fade;
    return !!f?.on && (f.layers ? f.layers.has(layer) : String(layer).includes('|'));
  }

  fadeColor(c) {
    if (c === BACKGROUND) return c; // un masque reste de la couleur du fond
    const v = c === FOREGROUND ? this.theme.foreground : c;
    const bg = this.theme.background, k = this.fade?.amount ?? 0.6;
    const mix = (sh) => Math.round(((v >> sh) & 255) + ((((bg >> sh) & 255) - ((v >> sh) & 255)) * k));
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  }

  setFade(fade) {
    this.fade = fade;
    for (const c of this.chunks) c.dirty = true;
    this.flush();
    this.requestRender(true);
  }

  flush() {
    for (const c of this.chunks) if (c.dirty) this.buildChunk(c);
    this.chunks = this.chunks.filter((c) => {
      if (c.ids.size) return true;
      this.disposeChunk(c);
      if (this.openChunks.get(c.layer) === c) this.openChunks.delete(c.layer);
      return false;
    });
    this.underlays.flush();
  }

  disposeChunk(c) {
    if (!c.group) return;
    this.drawing.remove(c.group);
    c.group.traverse((o) => o.geometry?.dispose());
    c.group = null;
  }

  buildChunk(chunk) {
    this.disposeChunk(chunk);
    chunk.texts = [];
    chunk.dirty = false;
    chunk.partLayers = new Set();
    chunk.colorLayers = new Set();
    for (const id of chunk.ids) {
      for (const part of this.cache.get(id)?.parts || []) {
        chunk.partLayers.add(part.layer);
        if (typeof part.color === 'string' && part.color.startsWith('L:')) chunk.colorLayers.add(part.color.slice(2));
      }
    }
    // Paquet « pur » (un seul calque) : toute sa géométrie est construite, la visibilité passe par group.visible.
    const pure = chunk.partLayers.size === 1 && chunk.partLayers.has(chunk.layer);
    const o = this.origin;
    const colorCache = new Map();
    const rgb = (token, part) => {
      const key = part?.ps || part?.layer ? `${token}\u0000${part.ps || ''}\u0000${part.layer || ''}` : token;
      let v = colorCache.get(key);
      if (!v) { v = this.rgbOf(this.plotMap(this.resolveColor(token), part)); colorCache.set(key, v); }
      return v;
    };
    // Première passe : parts retenues et tailles ; seconde passe : remplissage direct de tableaux
    // typés (positions en Float32, couleurs en octets normalisés : 4 fois moins de mémoire).
    const parts = [];
    const keys = new Map(); // part → clé d'ordre
    let kmin = Infinity, kmax = -Infinity;
    const fat = this.fatActive();
    const fatParts = fat ? new Map() : null; // épaisseur (mm) → parts
    let nl = 0, nt = 0, np = 0;
    for (const id of chunk.ids) {
      const e = this.doc.get(id);
      const entry = this.cache.get(id);
      if (!e || !entry) continue;
      const own = this.doc.layers.get(e.layer);
      if (!pure && own && own.frozen) continue;
      entry.parts.forEach((part, i) => {
        const k = this.orderOf(e, i, entry.parts.length);
        keys.set(part, k);
        if (k < kmin) kmin = k;
        if (k > kmax) kmax = k;
      });
      for (const part of entry.parts) {
        if (!pure && !this.layerVisible(part.layer)) continue;
        if (fat && part.segs.length) {
          const mm = this.plotLw(this.resolveColor(part.color), lwMm(partLineweight(this.doc, part), lwDefaultMm(this.doc)), part);
          if (!fatParts.has(mm)) fatParts.set(mm, []);
          fatParts.get(mm).push(part);
        }
        parts.push(part);
        nl += part.segs.length; nt += part.tris.length; np += part.pts.length;
        if (part.texts.length) {
          const color = this.isFaded(part.layer) ? this.fadeColor(this.plotMap(this.resolveColor(part.color), part)) : this.plotMap(this.resolveColor(part.color), part);
          for (const t of part.texts) chunk.texts.push({ ...t, color, id, key: keys.get(part) });
        }
      }
    }
    if (kmin <= kmax) this.noteOrder(kmin, kmax);
    const lp = new Float32Array(fat ? 0 : nl), lc = new Uint8Array(fat ? 0 : nl), lo = new Float32Array(fat ? 0 : nl / 3);
    const tp = new Float32Array(nt), tc = new Uint8Array(nt), to = new Float32Array(nt / 3);
    const pp = new Float32Array(np), pc = new Uint8Array(np), po = new Float32Array(np / 3);
    let il = 0, it = 0, ip = 0;
    const fill = (src, pos, col, ord, k, r, g, b, key) => {
      const ox = o.x, oy = o.y, oz = o.z;
      for (let i = 0; i < src.length; i += 3, k += 3) {
        pos[k] = src[i] - ox; pos[k + 1] = src[i + 1] - oy; pos[k + 2] = src[i + 2] - oz;
        col[k] = r; col[k + 1] = g; col[k + 2] = b;
        ord[k / 3] = key;
      }
      return k;
    };
    for (const part of parts) {
      const [r, g, b] = this.isFaded(part.layer) ? this.rgbOf(this.fadeColor(this.plotMap(this.resolveColor(part.color), part))) : rgb(part.color, part);
      const key = keys.get(part);
      if (part.segs.length && !fat) il = fill(part.segs, lp, lc, lo, il, r, g, b, key);
      if (part.tris.length) it = fill(part.tris, tp, tc, to, it, r, g, b, key);
      if (part.pts.length) ip = fill(part.pts, pp, pc, po, ip, r, g, b, key);
    }
    const group = new THREE.Group();
    const geo = (pos, col, ord) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      if (ord) g.setAttribute('drawOrder', new THREE.BufferAttribute(ord, 1));
      return g;
    };
    if (tp.length) {
      const mesh = new THREE.Mesh(geo(tp, tc, to), this.materials.fill);
      mesh.renderOrder = 0;
      group.add(mesh);
    }
    if (lp.length && !fat) {
      const lines = new THREE.LineSegments(geo(lp, lc, lo), this.materials.line);
      lines.renderOrder = 1;
      group.add(lines);
    }
    if (fat) {
      for (const [mm, list] of fatParts) {
        let n = 0;
        for (const part of list) n += part.segs.length;
        const pos = new Float32Array(n), col = new Uint8Array(n), ord = new Float32Array(n / 3); // traits épais : sans ordre (par-dessus)
        let k = 0;
        for (const part of list) {
          const [r, g, b] = this.isFaded(part.layer) ? this.rgbOf(this.fadeColor(this.plotMap(this.resolveColor(part.color), part))) : rgb(part.color, part);
          k = fill(part.segs, pos, col, ord, k, r, g, b, 0);
        }
        const l = fatLines(pos, col, fatMaterial(mm));
        l.renderOrder = 1;
        group.add(l);
      }
    }
    if (pp.length) group.add(new THREE.Points(geo(pp, pc, po), this.materials.point));
    if (pure) group.visible = this.layerVisible(chunk.layer);
    chunk.group = group;
    this.drawing.add(group);
  }

  // --- sélection, survol, aperçu ---------------------------------------------------

  setSelection(ids) {
    this.selection = new Set(ids);
    this.refreshOverlay3d('selection');
    this.requestRender(true);
  }

  // Survol : les textes ne sont redessinés que si l'objet quitté ou survolé en a (couleur de survol).
  setHover(id) {
    if (this.hover === id) return;
    const texts = this.hasTexts(this.hover) || this.hasTexts(id);
    this.hover = id;
    this.refreshOverlay3d('selection');
    this.requestRender(texts);
  }

  hasTexts(id) {
    return id != null && !!this.cache.get(id)?.parts.some((part) => part.texts.length);
  }

  // Entités temporaires (aperçu pendant une commande) : tessellées sans cache, dans l'image qui suit
  // (aucun retard sur le curseur) ; les textes du dessin ne sont redessinés que si l'aperçu en a.
  setPreview(entities) {
    if (!this.preview.length && !entities?.length) return;
    this.preview = entities || [];
    this.refreshOverlay3d('preview');
    this.requestRender();
  }

  // Repères temporaires (comparaison de versions d'un fond de plan) : objets colorés et cadres, par-dessus
  // le dessin, jamais enregistrés. null pour effacer.
  setMarkup(markup) {
    this.markup = markup && (markup.groups?.length || markup.boxes?.length) ? markup : null;
    this.markupTess = null;
    this.buildMarkup();
    this.refreshOverlay3d();
    this.requestRender(true);
  }

  // Géométrie des repères (une seule fois par comparaison, ou si l'origine de la vue change).
  buildMarkup() {
    for (const o of [...this.markup3d.children]) { this.markup3d.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.markupTexts = null;
    if (!this.markup || !this.doc) return;
    if (!this.markupTess) {
      const tess = new Tessellator(this.doc);
      tess.blockCache = this.tess.blockCache;
      this.markupTess = (this.markup.groups || []).map((g) => {
        const segs = [], tris = [], texts = [];
        for (const e of g.entities) {
          for (const part of tess.entity(e)) {
            for (let i = 0; i < part.segs.length; i++) segs.push(part.segs[i]);
            for (let i = 0; i < part.tris.length; i++) tris.push(part.tris[i]);
            for (const t of part.texts) texts.push({ ...t, color: g.color });
          }
        }
        return { segs, tris, texts, color: g.color, opacity: g.opacity ?? 0.35 };
      });
      const box = [];
      for (const b of this.markup.boxes || []) {
        const q = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
        for (let i = 0; i < 4; i++) box.push(q[i][0], q[i][1], 0, q[(i + 1) % 4][0], q[(i + 1) % 4][1], 0);
      }
      this.markupTess.push({ segs: box, tris: [], texts: [], color: this.markup.boxColor ?? 0xf59e0b, opacity: 1 });
    }
    const o = this.origin;
    this.markupTexts = [];
    for (const g of this.markupTess) {
      const pos = new Float32Array(g.segs.length), tris = new Float32Array(g.tris.length);
      for (let i = 0; i < g.segs.length; i += 3) { pos[i] = g.segs[i] - o.x; pos[i + 1] = g.segs[i + 1] - o.y; pos[i + 2] = g.segs[i + 2] - o.z; }
      for (let i = 0; i < g.tris.length; i += 3) { tris[i] = g.tris[i] - o.x; tris[i + 1] = g.tris[i + 1] - o.y; tris[i + 2] = g.tris[i + 2] - o.z; }
      this.addOverlayGeometry(pos, tris, g.color, g.opacity, this.markup3d);
      for (const t of g.texts) this.markupTexts.push(t);
    }
  }

  // Sélection, survol, aperçu : marqués à refaire, reconstruits au début de l'image suivante, juste avant
  // le dessin (plusieurs demandes dans la même tâche — modification puis désélection d'une sélection de
  // 100 000 objets — n'en coûtent qu'une). what : 'selection', 'preview' ou tout.
  refreshOverlay3d(what) {
    if (what !== 'preview') this.selDirty = true;
    if (what !== 'selection') this.prevDirty = true;
    this.requestRender();
  }

  // Reconstruit ce qui est marqué ; renvoie vrai si les textes doivent être redessinés.
  flushOverlay() {
    let texts = false;
    if (this.selDirty) { this.selDirty = false; this.rebuildSelOverlay(); }
    if (this.prevDirty) {
      this.prevDirty = false;
      const before = this.previewTexts?.length || 0;
      this.rebuildPrevOverlay();
      texts = before > 0 || this.previewTexts.length > 0;
    }
    return texts;
  }

  clearGroup(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
  }

  rebuildOverlay3d() {
    this.rebuildSelOverlay();
    this.rebuildPrevOverlay();
  }

  rebuildSelOverlay() {
    this.clearGroup(this.overlaySel);
    if (!this.doc) return;
    const o = this.origin;
    const add = (ids, color, opacity) => {
      const pos = [], tris = [];
      for (const id of ids) {
        const entry = this.cache.get(id);
        if (!entry) continue;
        for (const part of entry.parts) {
          for (let i = 0; i < part.segs.length; i += 3) pos.push(part.segs[i] - o.x, part.segs[i + 1] - o.y, part.segs[i + 2] - o.z);
          for (let i = 0; i < part.tris.length; i += 3) tris.push(part.tris[i] - o.x, part.tris[i + 1] - o.y, part.tris[i + 2] - o.z);
        }
      }
      this.addOverlayGeometry(pos, tris, color, opacity, this.overlaySel);
    };
    if (this.selection.size) add(this.selection, this.theme.select, 0.35);
    if (this.hover != null && !this.selection.has(this.hover)) add([this.hover], this.theme.hover, 0.25);
  }

  rebuildPrevOverlay() {
    this.clearGroup(this.overlayPrev);
    this.previewTexts = [];
    if (!this.doc) return;
    const o = this.origin;
    if (this.preview.length) {
      const tess = new Tessellator(this.doc);
      tess.blockCache = this.tess.blockCache;
      const pos = [], tris = [];
      for (const e of this.preview) {
        for (const part of tess.entity(e)) {
          for (let i = 0; i < part.segs.length; i += 3) pos.push(part.segs[i] - o.x, part.segs[i + 1] - o.y, part.segs[i + 2] - o.z);
          for (let i = 0; i < part.tris.length; i += 3) tris.push(part.tris[i] - o.x, part.tris[i + 1] - o.y, part.tris[i + 2] - o.z);
          for (const t of part.texts) this.previewTexts.push({ ...t, color: this.theme.preview });
        }
      }
      this.addOverlayGeometry(pos, tris, this.theme.preview, 0.3, this.overlayPrev);
    }
    // Repères de comparaison : géométrie construite une fois (setMarkup), seuls leurs textes sont repris ici.
    if (this.markupTexts) for (const t of this.markupTexts) this.previewTexts.push(t);
  }

  addOverlayGeometry(pos, tris, color, opacity, group = this.overlayPrev) {
    if (tris.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      }));
      m.renderOrder = 10;
      group.add(m);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false }));
      l.renderOrder = 11;
      group.add(l);
    }
  }

  // --- interrogation (sélection, accrochage) ------------------------------------------

  entitySegs(id) {
    const entry = this.cache.get(id);
    if (!entry) return null;
    const out = [];
    for (const p of entry.parts) for (let i = 0; i < p.segs.length; i++) out.push(p.segs[i]);
    return out;
  }

  curvesOf(e) {
    return curvesOf(e, (x) => this.entitySegs(x.id));
  }

  selectable(id) {
    const e = this.doc.get(id);
    if (!e) return false;
    const l = this.doc.layers.get(e.layer);
    return !l || (l.on && !l.frozen && !l.locked);
  }

  // Index en grille d'une référence de bloc lourde (fond de plan, xref), construit à la première demande.
  gridOf(entry) {
    if (entry.grid === undefined) entry.grid = buildGrid(entry.parts, entry.box);
    return entry.grid;
  }

  bigGrid(e, entry) {
    return entry && (e.type === 'INSERT' || e.type === 'BLOCKREF') ? this.gridOf(entry) : null;
  }

  // Segments [x1, y1, x2, y2, …] de l'entité près du point (tous si l'entité est petite).
  segsNear(id, p, tol) {
    const e = this.doc.get(id), entry = this.cache.get(id);
    if (!e || !entry) return [];
    if (e.type === 'UNDERLAY') { const u = this.underlays.segsNear(e, p, tol); return [...u.lines, ...u.curves]; }
    const grid = this.bigGrid(e, entry);
    if (grid) return gridItems(grid, entry.parts, { minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol }).segs;
    const out = [];
    for (const part of entry.parts) {
      const s = part.segs;
      for (let i = 0; i + 5 < s.length; i += 6) out.push(s[i], s[i + 1], s[i + 3], s[i + 4]);
    }
    return out;
  }

  // Courbes de l'entité utiles près du point (accrochage) : une grosse référence ne donne que ses segments proches.
  curvesNear(e, p, tol) {
    if (e.type === 'UNDERLAY') {
      const u = this.underlays.segsNear(e, p, tol), out = this.curvesOf(e);
      for (const s of [u.lines, u.curves]) for (let i = 0; i + 3 < s.length; i += 4) out.push({ k: 'seg', a: [s[i], s[i + 1]], b: [s[i + 2], s[i + 3]] });
      return out;
    }
    const entry = this.cache.get(e.id);
    const grid = this.bigGrid(e, entry);
    if (!grid) return this.curvesOf(e);
    const s = gridItems(grid, entry.parts, { minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol }).segs;
    const out = [];
    for (let i = 0; i + 3 < s.length; i += 4) out.push({ k: 'seg', a: [s[i], s[i + 1]], b: [s[i + 2], s[i + 3]] });
    return out;
  }

  // Distance du point à l'entité (0 si à l'intérieur d'un remplissage ou d'un texte).
  distanceTo(id, p, tol) {
    const e = this.doc.get(id);
    const entry = this.cache.get(id);
    if (!e || !entry) return Infinity;
    let best = Infinity;
    const grid = this.bigGrid(e, entry);
    if (grid) {
      // Grosse référence : seuls les segments et triangles proches du point sont testés.
      const { segs, tris } = gridItems(grid, entry.parts, { minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol });
      for (let i = 0; i + 3 < segs.length; i += 4) best = Math.min(best, G.distToSegment(p, [segs[i], segs[i + 1]], [segs[i + 2], segs[i + 3]]));
      for (let i = 0; i + 5 < tris.length; i += 6) {
        if (pointInTri(p[0], p[1], [tris[i], tris[i + 1]], [tris[i + 2], tris[i + 3]], [tris[i + 4], tris[i + 5]])) return 0;
      }
      if (best <= tol) return best;
      for (const part of entry.parts) for (const t of part.texts) if (textHit(t, p[0], p[1], tol)) return 0;
      return best;
    }
    const curves = this.curvesOf(e);
    if (curves.length) best = distanceToCurves(curves, p);
    if (e.mep && best > tol) {
      // Objet MEP : on accepte aussi un clic sur son double trait.
      for (const part of entry.parts) {
        const s = part.segs;
        for (let i = 0; i + 5 < s.length; i += 6) best = Math.min(best, G.distToSegment(p, [s[i], s[i + 1]], [s[i + 3], s[i + 4]]));
      }
    }
    for (const part of entry.parts) {
      for (const t of part.texts) if (textHit(t, p[0], p[1], tol)) return 0;
      if (part.color === BACKGROUND) continue; // masque : désigné par son cadre seulement
      const tr = part.tris;
      for (let i = 0; i + 8 < tr.length; i += 9) {
        if (pointInTri(p[0], p[1], [tr[i], tr[i + 1]], [tr[i + 3], tr[i + 4]], [tr[i + 6], tr[i + 7]])) return 0;
      }
    }
    return best;
  }

  pick(p, tol) {
    const hits = this.index.search({ minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol });
    let best = null, bestD = Infinity;
    for (const h of hits) {
      if (!this.selectable(h.id)) continue;
      const d = this.distanceTo(h.id, p, tol);
      // À distance égale, on préfère l'objet au-dessus dans l'ordre de tracé.
      if (d <= tol && (d < bestD || (d === bestD && drawKey(this.doc.get(h.id)) >= drawKey(this.doc.get(best))))) { best = h.id; bestD = d; }
    }
    return best;
  }

  // Sélection par fenêtre (entièrement dedans) ou capture (touchée).
  selectBox(box, crossing) {
    const out = [];
    for (const h of this.index.search(box)) {
      if (!this.selectable(h.id)) continue;
      if (G.boxContainsBox(box, h)) { out.push(h.id); continue; }
      if (!crossing) continue;
      if (this.touchesBox(h.id, box)) out.push(h.id);
    }
    return out;
  }

  touchesBox(id, box) {
    const entry = this.cache.get(id);
    const grid = this.bigGrid(this.doc.get(id), entry);
    if (grid) {
      const { segs, tris } = gridItems(grid, entry.parts, box);
      for (let i = 0; i + 3 < segs.length; i += 4) if (G.segmentHitsBox([segs[i], segs[i + 1]], [segs[i + 2], segs[i + 3]], box)) return true;
      for (let i = 0; i + 5 < tris.length; i += 6) {
        const tri = [[tris[i], tris[i + 1]], [tris[i + 2], tris[i + 3]], [tris[i + 4], tris[i + 5]]];
        for (let k = 0; k < 3; k++) if (G.segmentHitsBox(tri[k], tri[(k + 1) % 3], box)) return true;
        if (pointInTri(box.minX, box.minY, ...tri)) return true;
      }
    }
    for (const part of entry.parts) {
      if (grid) { // segments et triangles déjà testés : restent les textes et les points
        for (const tx of part.texts) {
          if (G.boxesOverlap(box, { minX: tx.x - tx.radius / 2, minY: tx.y - tx.radius / 2, maxX: tx.x + tx.radius / 2, maxY: tx.y + tx.radius / 2 })) return true;
        }
        continue;
      }
      const s = part.segs;
      for (let i = 0; i + 5 < s.length; i += 6) {
        if (G.segmentHitsBox([s[i], s[i + 1]], [s[i + 3], s[i + 4]], box)) return true;
      }
      const t = part.tris;
      for (let i = 0; i + 8 < t.length; i += 9) {
        const tri = [[t[i], t[i + 1]], [t[i + 3], t[i + 4]], [t[i + 6], t[i + 7]]];
        for (let k = 0; k < 3; k++) if (G.segmentHitsBox(tri[k], tri[(k + 1) % 3], box)) return true;
        if (pointInTri(box.minX, box.minY, ...tri)) return true;
      }
      for (const tx of part.texts) {
        if (G.boxesOverlap(box, { minX: tx.x - tx.radius / 2, minY: tx.y - tx.radius / 2, maxX: tx.x + tx.radius / 2, maxY: tx.y + tx.radius / 2 })) return true;
      }
      for (let i = 0; i < part.pts.length; i += 3) {
        const x = part.pts[i], y = part.pts[i + 1];
        if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) return true;
      }
    }
    return false;
  }

  // Entités visibles proches du point (l'accrochage fonctionne aussi sur les calques verrouillés).
  near(p, tol) {
    return this.index.search({ minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol })
      .map((h) => h.id).filter((id) => {
        const e = this.doc.get(id);
        return e && this.layerVisible(e.layer);
      });
  }

  // Emprise robuste : ignore les rares objets isolés très loin du dessin.
  robustExtents() {
    // Tableaux typés : leur tri numérique natif est bien plus rapide qu'un tri avec comparateur.
    let xs = new Float64Array(this.cache.size * 2), ys = new Float64Array(this.cache.size * 2);
    let n = 0;
    const full = G.emptyBox();
    for (const entry of this.cache.values()) {
      const b = entry.box;
      if (!G.boxValid(b) || entry.infinite) continue; // droites de construction : hors emprise
      G.growBox(full, b.minX, b.minY);
      G.growBox(full, b.maxX, b.maxY);
      xs[n] = b.minX; xs[n + 1] = b.maxX;
      ys[n] = b.minY; ys[n + 1] = b.maxY;
      n += 2;
    }
    if (!G.boxValid(full)) return { minX: 0, minY: 0, maxX: 420, maxY: 297 }; // dessin vide : format A3 en mm
    if (n < 100) return full;
    xs = xs.subarray(0, n).sort(); ys = ys.subarray(0, n).sort();
    const q = (a, f) => a[Math.floor(f * (a.length - 1))];
    const qx0 = q(xs, 0.005), qx1 = q(xs, 0.995), qy0 = q(ys, 0.005), qy1 = q(ys, 0.995);
    const qw = Math.max(qx1 - qx0, 1e-9), qh = Math.max(qy1 - qy0, 1e-9);
    if (full.maxX - full.minX <= qw * 4 && full.maxY - full.minY <= qh * 4) return full;
    return {
      minX: Math.max(full.minX, qx0 - qw * 0.05), maxX: Math.min(full.maxX, qx1 + qw * 0.05),
      minY: Math.max(full.minY, qy0 - qh * 0.05), maxY: Math.min(full.maxY, qy1 + qh * 0.05),
    };
  }

  // --- vue ---------------------------------------------------------------------------

  setTheme(name) {
    if (this.modelView) this.modelView.dirty = true;
    this.themeName = name;
    this.theme = THEMES[name];
    this.webgl.setClearColor(this.theme.background);
    // Profondeur toujours testée : en 3D la vraie, en 2D celle de l'ordre de tracé (voir orderable).
    const u = this.orderUniforms;
    this.materials = {
      line: orderable(new THREE.LineBasicMaterial({ vertexColors: true }), u),
      fill: orderable(new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }), u),
      point: orderable(new THREE.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false }), u),
    };
    // Contenu de l'espace objet dans les fenêtres : mêmes matériaux, ordre propre (uniformes à part).
    const mu = this.mvOrderUniforms;
    this.mvMaterials = {
      line: orderable(new THREE.LineBasicMaterial({ vertexColors: true }), mu),
      fill: orderable(new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }), mu),
      point: orderable(new THREE.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false }), mu),
    };
    if (this.doc) {
      for (const c of this.chunks) c.dirty = true;
      this.flush();
      this.buildGrid();
      this.refreshOverlay3d();
    }
    this.underlays?.applyTheme();
    this.requestRender(true);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const is3d = mode === '3d';
    this.orderUniforms.uOrder2d.value = is3d ? 0 : 1;
    this.webgl.outputColorSpace = is3d ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    this.controls.enabled = is3d;
    if (this.grid) this.grid.visible = is3d;
    this.canvas.classList.toggle('orbit', is3d);
    this.refreshMep3d();
    this.underlays.refreshVisibility();
    if (is3d) this.frame3d();
    if (this.grid && this.tools3d) this.grid.visible = is3d && this.tools3d.filter.grid;
    this.onModeChange?.(mode);
    for (const f of this.modeListeners) f(mode);
    this.requestRender(true);
  }

  buildGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const e = this.extents;
    const size = Math.max(e.maxX - e.minX, e.maxY - e.minY) * 1.4 || 10;
    this.grid = new THREE.GridHelper(size, 28, ...this.theme.grid);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.visible = this.mode === '3d';
    this.scene.add(this.grid);
  }

  fit(box) {
    // Zoom étendu : emprise recalculée (des objets ont pu être ajoutés depuis l'ouverture) ; dans une
    // présentation, la feuille entière.
    const auto = !box;
    if (!box) {
      if (this.cache.size) this.extents = this.robustExtents();
      box = this.extents;
      if (this.sheet && this.space !== 'model') {
        const s = { minX: this.sheet.origin[0], minY: this.sheet.origin[1], maxX: this.sheet.origin[0] + this.sheet.w, maxY: this.sheet.origin[1] + this.sheet.h };
        box = this.cache.size ? { minX: Math.min(s.minX, box.minX), minY: Math.min(s.minY, box.minY), maxX: Math.max(s.maxX, box.maxX), maxY: Math.max(s.maxY, box.maxY) } : s;
      }
    }
    if (this.mode === '3d') { this.frame3d(); return; }
    const w = this.width, h = this.height;
    const dw = Math.max(box.maxX - box.minX, 1e-9), dh = Math.max(box.maxY - box.minY, 1e-9);
    this.scale = Math.min(w / dw, h / dh) * 0.92;
    this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    this.autoFit = auto;
    this.requestRender(true);
  }

  frame3d() {
    // Emprise : plan du dessin, réseaux et maquette IFC des fonds ; vue en perspective qui l'englobe.
    const e = this.extents, o = this.origin;
    const box = new THREE.Box3();
    if (Number.isFinite(e.minX)) box.set(new THREE.Vector3(e.minX - o.x, e.minY - o.y, 0), new THREE.Vector3(e.maxX - o.x, e.maxY - o.y, this.mep3d?.userData.maxZ || 0));
    if (this.ifc3d) box.union(new THREE.Box3().setFromObject(this.ifc3d));
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 0));
    const dims = box.getSize(new THREE.Vector3());
    const size = Math.max(dims.x, dims.y, 1e-6);
    const target = box.getCenter(new THREE.Vector3());
    const dist = Math.max(size * 1.25, dims.length() / 2 / Math.sin(THREE.MathUtils.degToRad(this.perspective.fov) / 2));
    this.perspective.position.copy(target).addScaledVector(new THREE.Vector3(0.55, -0.95, 0.8).normalize(), dist);
    this.perspective.near = dist / 1000;
    this.perspective.far = dist * 50;
    this.perspective.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.sun.position.copy(target).add(new THREE.Vector3(0.4, -0.7, 1).multiplyScalar(size));
    this.framedAt = this.perspective.position.clone(); // vue cadrée automatiquement (recadrée si la maquette arrive après)
    this.requestRender(true);
  }

  toWorld(px, py) {
    return [this.center.x + (px - this.width / 2) / this.scale, this.center.y - (py - this.height / 2) / this.scale];
  }

  toScreen(x, y) {
    return [(x - this.center.x) * this.scale + this.width / 2, this.height / 2 - (y - this.center.y) * this.scale];
  }

  zoomAt(px, py, factor) {
    const [wx, wy] = this.toWorld(px, py);
    this.autoFit = false;
    this.scale *= factor;
    this.center.x = wx - (px - this.width / 2) / this.scale;
    this.center.y = wy + (py - this.height / 2) / this.scale;
    this.requestRender(true);
  }

  pan(dxPx, dyPx) {
    this.autoFit = false;
    this.center.x -= dxPx / this.scale;
    this.center.y += dyPx / this.scale;
    this.requestRender(true);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.webgl.setSize(w, h);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.textLayer, this.uiLayer]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    if (this.autoFit && this.mode === '2d') this.fit();
    this.requestRender(true);
  }

  // --- rendu --------------------------------------------------------------------------

  // full = vrai si la vue ou le dessin a changé (sinon seule la couche interface est redessinée).
  requestRender(full = false) {
    this.needFull = this.needFull || full;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const fullNow = this.needFull;
      this.needFull = false;
      this.render(fullNow);
    });
  }

  view() {
    const dpr = this.uiLayer.width / this.width;
    return {
      dpr,
      scale: this.scale * dpr,
      toScreen: (x, y) => [((x - this.center.x) * this.scale + this.width / 2) * dpr, (this.height / 2 - (y - this.center.y) * this.scale) * dpr],
    };
  }

  render(full = true) {
    if (!this.width) return;
    if (this.flushOverlay()) full = true;
    const view = this.view();
    if (this.fatActive()) updateFatMaterials(this.scale * view.dpr, this.uiLayer.width, this.uiLayer.height);
    // La scène WebGL est redessinée à chaque image : c'est peu coûteux, et l'aperçu / la sélection en dépendent.
    if (this.mode === '3d') {
      // Boîte et plans de coupe : découpe de toute la scène ; poignées et mesures dessinées ensuite, sans découpe.
      const t = this.tools3d;
      this.webgl.clippingPlanes = t ? t.clipPlanes() : [];
      this.webgl.render(this.scene, this.perspective);
      this.webgl.clippingPlanes = [];
      if (t?.scene.children.length) {
        const auto = this.webgl.autoClear;
        this.webgl.autoClear = false;
        this.webgl.render(t.scene, this.perspective);
        this.webgl.autoClear = auto;
      }
    } else {
      this.webgl.clippingPlanes = [];
      const hw = this.width / 2 / this.scale, hh = this.height / 2 / this.scale;
      const cx = this.center.x - this.origin.x, cy = this.center.y - this.origin.y;
      Object.assign(this.ortho, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
      this.ortho.updateProjectionMatrix();
      this.webgl.render(this.scene, this.ortho);
      if (this.viewports.length) this.renderViewports();
      const vk = `${this.center.x}|${this.center.y}|${this.scale}|${this.width}|${this.height}`;
      if (vk !== this.viewKey) { this.viewKey = vk; this.underlays.viewChanged(); } // fonds : détail net à ce zoom
    }
    if (full) this.renderTexts(view);
    const ui = this.uiLayer.getContext('2d');
    ui.setTransform(1, 0, 0, 1, 0, 0);
    ui.clearRect(0, 0, this.uiLayer.width, this.uiLayer.height);
    if (this.mode === '2d') {
      this.drawPrintable(ui, view);
      this.drawActiveViewport(ui, view);
      for (const draw of this.overlayDrawers || []) draw(ui, view); // éditeur de blocs : paramètres, point de base
    }
    if (this.mode === '2d' && this.uiDraw) this.uiDraw(ui, view);
    if (this.mode === '3d') this.tools3d?.drawUi(ui, view.dpr); // étiquettes des mesures 3D
  }

  renderTexts(view) {
    const ctx = this.textLayer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.textLayer.width, this.textLayer.height);
    if (this.mode !== '2d') return;
    const fg = this.theme.foreground;
    const css = new Map();
    const resolveCss = (c) => {
      let s = css.get(c);
      if (!s) { s = toCss(c, fg); css.set(c, s); }
      return s;
    };
    const always = () => true;
    const sel = this.selection, hov = this.hover;
    const masks = this.masksInView(view);
    const pending = masks.length ? [] : null;
    for (const c of this.chunks) {
      if (c.group && !c.group.visible) continue;
      const texts = sel.size || hov != null
        ? c.texts.map((t) => (sel.has(t.id) ? { ...t, color: this.theme.select } : t.id === hov ? { ...t, color: this.theme.hover } : t))
        : c.texts;
      if (pending) pending.push(...texts); else drawTexts(ctx, texts, view, resolveCss, always);
    }
    if (pending) {
      // Masques à l'écran : textes triés par clé ; chaque masque efface les textes déjà dessinés (situés dessous).
      pending.sort((a, b) => a.key - b.key);
      let i = 0;
      for (const m of masks) {
        let j = i;
        while (j < pending.length && pending[j].key < m.key) j++;
        if (j > i) drawTexts(ctx, pending.slice(i, j), view, resolveCss, always);
        i = j;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        for (const poly of m.polys) {
          poly.forEach((q, k) => { const [sx, sy] = view.toScreen(q[0], q[1]); if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
          ctx.closePath();
        }
        ctx.fill();
        ctx.restore();
      }
      if (i < pending.length) drawTexts(ctx, pending.slice(i), view, resolveCss, always);
    }
    // Textes de l'espace objet dans les fenêtres : même transformation, découpés au cadre.
    if (this.viewports.length && this.modelView && !this.modelView.dirty) {
      const dpr = view.dpr;
      for (const v of this.viewports) {
        if (v.off) continue;
        const s = this.viewportScreenRect(v);
        if (!s) continue;
        const [a, b, c, d, e, f] = viewportMatrix(v);
        const vpView = { dpr, scale: view.scale * viewportScale(v), rot: v.twist || 0, toScreen: (x, y) => view.toScreen(a * x + c * y + e, b * x + d * y + f) };
        ctx.save();
        ctx.beginPath();
        if (v.clip?.length >= 3) {
          v.clip.forEach(([x, y], i) => { const [sx, sy] = view.toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
          ctx.closePath();
        } else ctx.rect(s.x0 * dpr, s.y0 * dpr, (s.x1 - s.x0) * dpr, (s.y1 - s.y0) * dpr);
        ctx.clip();
        const fz = v.frozen?.length ? new Set(v.frozen) : null;
        drawTexts(ctx, this.modelView.texts, vpView, resolveCss, fz ? (layer) => !fz.has(layer) : always);
        ctx.restore();
      }
    }
    if (this.previewTexts?.length) drawTexts(ctx, this.previewTexts, view, resolveCss, always);
  }

  // Masques visibles (clé d'ordre, contours) triés par clé ; vide s'il n'y en a pas à l'écran.
  masksInView(view) {
    if (!this.maskIds.size) return [];
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [x, y] of [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]]) {
      const p = this.toWorld(x, y);
      box.minX = Math.min(box.minX, p[0]); box.maxX = Math.max(box.maxX, p[0]);
      box.minY = Math.min(box.minY, p[1]); box.maxY = Math.max(box.maxY, p[1]);
    }
    const out = [];
    for (const id of this.maskIds) {
      const e = this.doc.get(id), entry = this.cache.get(id);
      if (!e || !entry?.box || !this.layerVisible(e.layer)) continue;
      const b = entry.box;
      if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) continue;
      entry.parts.forEach((part, i) => {
        if (part.color !== BACKGROUND || !part.tris.length || !this.layerVisible(part.layer)) return;
        const polys = [];
        if (e.type === 'WIPEOUT') polys.push(e.pts);
        else for (let k = 0; k + 8 < part.tris.length; k += 9) polys.push([[part.tris[k], part.tris[k + 1]], [part.tris[k + 3], part.tris[k + 4]], [part.tris[k + 6], part.tris[k + 7]]]);
        out.push({ key: this.orderOf(e, i, entry.parts.length), polys });
      });
    }
    return out.sort((a, b) => a.key - b.key);
  }

  stats() {
    let segs = 0, tris = 0, texts = 0;
    for (const entry of this.cache.values()) {
      for (const p of entry.parts) { segs += p.segs.length / 6; tris += p.tris.length / 9; texts += p.texts.length; }
    }
    return { entities: this.cache.size, segs, tris, texts, chunks: this.chunks.length };
  }
}
