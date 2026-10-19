// SPDX-License-Identifier: GPL-3.0-or-later
// Vue du dessin : rendu WebGL (three.js) et canvas 2D superposé pour les textes.
// - Mode 2D : caméra orthographique vue de dessus, panoramique et zoom « façon AutoCAD ».
// - Mode 3D : caméra perspective en orbite (axe Z vertical), éclairage, volumes extrudés.
//
// Précision : les coordonnées DWG peuvent être très grandes (plans géoréférencés).
// Les sommets envoyés au GPU sont donc recentrés sur une origine locale.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FOREGROUND, toCss } from './colors.js';
import { drawTexts } from './text.js';

const THEMES = {
  dark: { background: 0x212830, foreground: 0xffffff, grid: [0x3a4350, 0x2b323c] },
  light: { background: 0xffffff, foreground: 0x000000, grid: [0xc5cad3, 0xe3e6eb] },
};
const HIGHLIGHT = 0xff9f1a;
const CLICK_TOLERANCE_PX = 4;

export class Viewer {
  constructor(container, { onCursor, onPick } = {}) {
    this.container = container;
    this.onCursor = onCursor;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'text-overlay';
    this.container.appendChild(this.overlay);
    this.ctx2d = this.overlay.getContext('2d');

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.camera.position.set(0, 0, 1e6);
    this.perspective = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.perspective.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.perspective, this.renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.sun);

    this.extrusions = new THREE.Group();
    this.extrusions.visible = false;
    this.scene.add(this.extrusions);

    this.mode = '2d';
    this.origin = { x: 0, y: 0, z: 0 };
    this.center = { x: 0, y: 0 };
    this.scale = 1; // pixels CSS par unité de dessin
    this.texts = [];
    this.layerGroups = new Map();
    this.hiddenLayers = new Set();
    this.materials = new Map();
    this.extents = null;
    this.highlightShape = null;
    this.highlightLine = null;
    this.grid = null;
    this.setTheme('dark');

    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // --- chargement -------------------------------------------------------------

  load(result) {
    this.clear();
    const ext = result.extents;
    this.origin = { x: (ext.minX + ext.maxX) / 2, y: (ext.minY + ext.maxY) / 2, z: 0 };
    const o = this.origin;
    const shift = (arr) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        out[i] = arr[i] - o.x; out[i + 1] = arr[i + 1] - o.y; out[i + 2] = arr[i + 2] - o.z;
      }
      return out;
    };
    for (const [name, bucket] of result.layers) {
      const group = new THREE.Group();
      group.name = name;
      for (const [color, arr] of bucket.fills) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(shift(arr), 3));
        const mesh = new THREE.Mesh(geo, this.material('fill', color));
        mesh.renderOrder = 0;
        group.add(mesh);
      }
      for (const [color, arr] of bucket.lines) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(shift(arr), 3));
        const lines = new THREE.LineSegments(geo, this.material('line', color));
        lines.renderOrder = 1;
        group.add(lines);
      }
      for (const [color, arr] of bucket.points) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(shift(arr), 3));
        group.add(new THREE.Points(geo, this.material('point', color)));
      }
      group.visible = !this.hiddenLayers.has(name);
      this.scene.add(group);
      this.layerGroups.set(name, group);
    }
    this.texts = result.texts;
    this.extents = ext;
    this.buildGrid();
    this.fit();
  }

  clear() {
    for (const g of this.layerGroups.values()) {
      g.traverse((o) => o.geometry?.dispose());
      this.scene.remove(g);
    }
    this.layerGroups.clear();
    this.texts = [];
    this.setHighlight(null);
    this.requestRender();
  }

  material(kind, color) {
    const key = `${kind}:${color}`;
    let m = this.materials.get(key);
    if (!m) {
      const c = new THREE.Color(color === FOREGROUND ? this.theme.foreground : color);
      const depth = this.mode === '3d';
      const common = { color: c, depthTest: depth, depthWrite: depth };
      if (kind === 'fill') {
        m = new THREE.MeshBasicMaterial({
          ...common, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
      } else if (kind === 'point') {
        m = new THREE.PointsMaterial({ ...common, size: 3, sizeAttenuation: false });
      } else {
        m = new THREE.LineBasicMaterial(common);
      }
      m.userData.color = color;
      this.materials.set(key, m);
    }
    return m;
  }

  // Grille au sol, visible seulement en 3D, pour se repérer.
  buildGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const e = this.extents;
    const size = Math.max(e.maxX - e.minX, e.maxY - e.minY) * 1.4 || 10;
    this.grid = new THREE.GridHelper(size, 28, ...this.theme.grid);
    this.grid.rotation.x = Math.PI / 2; // GridHelper est dans le plan XZ ; on le couche dans XY
    this.grid.visible = this.mode === '3d';
    this.scene.add(this.grid);
  }

  // --- état de la vue -------------------------------------------------------------

  setTheme(name) {
    this.themeName = name;
    this.theme = THEMES[name];
    this.renderer.setClearColor(this.theme.background);
    for (const m of this.materials.values()) {
      if (m.userData.color === FOREGROUND) m.color.set(this.theme.foreground);
    }
    if (this.grid) this.buildGrid();
    this.requestRender();
  }

  setLayerVisible(name, visible) {
    if (visible) this.hiddenLayers.delete(name); else this.hiddenLayers.add(name);
    const g = this.layerGroups.get(name);
    if (g) g.visible = visible;
    this.requestRender();
  }

  setHiddenLayers(names) {
    this.hiddenLayers = new Set(names);
    for (const [name, g] of this.layerGroups) g.visible = !this.hiddenLayers.has(name);
    this.requestRender();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const is3d = mode === '3d';
    for (const m of this.materials.values()) {
      m.depthTest = is3d;
      m.depthWrite = is3d;
    }
    this.controls.enabled = is3d;
    this.extrusions.visible = is3d;
    if (this.grid) this.grid.visible = is3d;
    this.renderer.domElement.classList.toggle('orbit', is3d);
    if (is3d) this.frame3d();
    this.updateHighlightLine();
    this.requestRender();
  }

  fit() {
    if (this.mode === '3d') { this.frame3d(); return; }
    const e = this.extents;
    if (!e) return;
    const w = this.width, h = this.height;
    const dw = Math.max(e.maxX - e.minX, 1e-9), dh = Math.max(e.maxY - e.minY, 1e-9);
    this.scale = Math.min(w / dw, h / dh) * 0.92;
    this.center = { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 };
    this.autoFit = true; // recadre tant que l'utilisateur n'a pas bougé la vue
    this.requestRender();
  }

  // Vue 3D cadrée sur le dessin, depuis le sud-est, légèrement plongeante.
  frame3d() {
    const e = this.extents;
    if (!e) return;
    const box = new THREE.Box3().setFromObject(this.extrusions);
    const top = box.isEmpty() ? 0 : box.max.z;
    const size = Math.max(e.maxX - e.minX, e.maxY - e.minY, top, 1e-6);
    const target = new THREE.Vector3((e.minX + e.maxX) / 2 - this.origin.x, (e.minY + e.maxY) / 2 - this.origin.y, top / 2);
    const dist = size * 1.25;
    const dir = new THREE.Vector3(0.55, -0.95, 0.8).normalize();
    this.perspective.position.copy(target).addScaledVector(dir, dist);
    this.perspective.near = dist / 1000;
    this.perspective.far = dist * 50;
    this.perspective.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.sun.position.copy(target).add(new THREE.Vector3(0.4, -0.7, 1).multiplyScalar(size));
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
    this.requestRender();
  }

  toWorld(px, py) {
    return [this.center.x + (px - this.width / 2) / this.scale, this.center.y - (py - this.height / 2) / this.scale];
  }

  zoomAt(px, py, factor) {
    const [wx, wy] = this.toWorld(px, py);
    this.autoFit = false;
    this.scale *= factor;
    this.center.x = wx - (px - this.width / 2) / this.scale;
    this.center.y = wy + (py - this.height / 2) / this.scale;
    this.requestRender();
  }

  // --- volumes 3D et sélection ------------------------------------------------------

  addExtrusion(group) {
    this.extrusions.add(group);
    this.requestRender();
  }

  removeExtrusion(group) {
    this.extrusions.remove(group);
    this.requestRender();
  }

  setHighlight(shape) {
    this.highlightShape = shape;
    this.updateHighlightLine();
    this.requestRender();
  }

  // En 3D la sélection est tracée par three.js ; en 2D sur le calque des textes (plus épais).
  updateHighlightLine() {
    if (this.highlightLine) {
      this.scene.remove(this.highlightLine);
      this.highlightLine.geometry.dispose();
      this.highlightLine = null;
    }
    const s = this.highlightShape;
    if (!s || this.mode !== '3d') return;
    const pos = [];
    const o = this.origin;
    for (const [x, y, z] of s.pts) pos.push(x - o.x, y - o.y, z - o.z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.highlightLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: HIGHLIGHT, depthTest: false }));
    this.highlightLine.renderOrder = 999;
    this.scene.add(this.highlightLine);
  }

  // Volumes extrudés au format glTF binaire (.glb) : axe Y vertical, unités en mètres.
  async exportGlb(metersPerUnit = 1) {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    root.scale.setScalar(metersPerUnit);
    this.extrusions.traverse((o) => {
      if (o.isMesh) {
        const mesh = new THREE.Mesh(o.geometry, o.material);
        mesh.name = o.parent?.name || 'volume';
        root.add(mesh);
      }
    });
    return new GLTFExporter().parseAsync(root, { binary: true });
  }

  // --- interaction ---------------------------------------------------------------

  bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('wheel', (e) => {
      if (this.mode !== '2d') return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });

    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== '2d' || (e.button !== 0 && e.button !== 1)) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button };
    });
    el.addEventListener('pointermove', (e) => {
      if (this.mode !== '2d') return;
      const r = el.getBoundingClientRect();
      if (this.onCursor) this.onCursor(...this.toWorld(e.clientX - r.left, e.clientY - r.top));
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > CLICK_TOLERANCE_PX) {
        el.classList.add('panning');
        drag.moved = true;
      }
      if (!drag.moved) return;
      this.autoFit = false;
      this.center.x -= (e.clientX - drag.x) / this.scale;
      this.center.y += (e.clientY - drag.y) / this.scale;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.requestRender();
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && drag.button === 0 && this.onPick) {
        const r = el.getBoundingClientRect();
        const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
        this.onPick(wx, wy, 6 / this.scale);
      }
      drag = null;
      el.classList.remove('panning');
    });
    el.addEventListener('pointercancel', () => { drag = null; el.classList.remove('panning'); });
    el.addEventListener('dblclick', () => this.fit());
    el.addEventListener('auxclick', (e) => e.preventDefault());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    if (this.autoFit && this.mode === '2d') this.fit();
    this.requestRender();
  }

  // --- rendu -------------------------------------------------------------------

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    if (!this.width) return;
    const ctx = this.ctx2d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

    if (this.mode === '3d') {
      this.renderer.render(this.scene, this.perspective);
      return; // les textes ne sont affichés qu'en 2D pour l'instant
    }

    const hw = this.width / 2 / this.scale, hh = this.height / 2 / this.scale;
    const cx = this.center.x - this.origin.x, cy = this.center.y - this.origin.y;
    Object.assign(this.camera, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    const dpr = this.overlay.width / this.width;
    const view = {
      scale: this.scale * dpr,
      toScreen: (x, y) => [
        ((x - this.center.x) * this.scale + this.width / 2) * dpr,
        (this.height / 2 - (y - this.center.y) * this.scale) * dpr,
      ],
    };
    const fg = this.theme.foreground;
    const cssCache = new Map();
    const resolveCss = (c) => {
      let s = cssCache.get(c);
      if (!s) { s = toCss(c, fg); cssCache.set(c, s); }
      return s;
    };
    drawTexts(ctx, this.texts, view, resolveCss, (layer) => !this.hiddenLayers.has(layer));

    const s = this.highlightShape;
    if (s) {
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => {
        const [px, py] = view.toScreen(x, y);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      if (s.closed) ctx.closePath();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = '#' + HIGHLIGHT.toString(16);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
}
