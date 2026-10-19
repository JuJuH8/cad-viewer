// SPDX-License-Identifier: GPL-3.0-or-later
// Affichage des fonds (PDF, images) dans la vue : une texture de base par page (≈ 200 dpi du papier, partagée par
// les références identiques), puis une texture « détail » de la zone visible, redessinée à la résolution de
// l'écran quand on arrête de zoomer ou de se déplacer — le fond reste net à tout zoom, comme dans AutoCAD.
import * as THREE from 'three';
import { triangulateLoops } from '../hatch.js';
import { ensureSource, onSourceChange, getSource, pdfPage, nativeSize } from './sources.js';
import { renderRegion, NUANCEUR } from './raster.js';
import { pageToWorld, worldToPage, visibleBox, visibleAt, activeClip, resolvePending, PAGE, fileName } from './underlay.js';
import { snapGeometry, segmentsIn } from './vectors.js';

const VERT = /* glsl */ `
  attribute vec2 st;
  varying vec2 vST;
  void main() {
    vST = st;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const BASE_DPI = 200;
const BASE_MAX = 4096;
const DETAIL_MAX = 4096;
const DETAIL_PIXELS = 16e6;

// Textures de base partagées : `${source}|${page}|${calques masqués}` → { tex, w, h, ready, users }.
const bases = new Map();

function baseKey(e) {
  return `${String(e.path).toLowerCase()}|${e.kind === 'pdf' ? e.page || 1 : 0}|${(e.ocgOff || []).slice().sort().join(',')}`;
}

function textureOf(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// Étiquette d'un fond introuvable (affichée dans son cadre).
function missingTexture(e, src) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.max(64, Math.round(512 * (Math.hypot(...e.v) / Math.max(Math.hypot(...e.u), 1e-9))));
  c.height = Math.min(c.height, 2048);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(200,60,60,0.10)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(200,60,60,0.9)';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const msg = src?.status === 'error' ? 'Fichier illisible' : src?.status === 'loading' ? 'Chargement…' : 'Fichier introuvable';
  ctx.fillText(msg, c.width / 2, c.height / 2 - 16);
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillText(fileName(e.path), c.width / 2, c.height / 2 + 18);
  return textureOf(c);
}

async function baseTexture(e, maxTex) {
  const key = baseKey(e);
  let b = bases.get(key);
  if (b) { b.users++; return b.ready; }
  b = { users: 1, tex: null, w: 0, h: 0 };
  bases.set(key, b);
  b.ready = (async () => {
    const src = await ensureSource(e.path);
    if (src.status !== 'ok') { bases.delete(key); return null; }
    let w, h;
    if (src.kind === 'pdf') {
      const { size } = await pdfPage(src, e.page || 1);
      const long = Math.max(size[0], size[1]);
      const px = Math.min(BASE_MAX, maxTex, Math.max(1024, Math.ceil((long / 25.4) * BASE_DPI)));
      w = Math.round((px * size[0]) / long); h = Math.round((px * size[1]) / long);
    } else {
      const k = Math.min(1, Math.min(BASE_MAX, maxTex) / Math.max(src.width, src.height));
      w = Math.round(src.width * k); h = Math.round(src.height * k);
    }
    const canvas = await renderRegion(src, { s0: 0, t0: 0, s1: 1, t1: 1 }, w, h, { page: e.page || 1, ocgOff: e.ocgOff });
    b.tex = textureOf(canvas);
    b.w = w; b.h = h;
    return b;
  })();
  b.ready.catch(() => bases.delete(key));
  return b.ready;
}

function releaseBase(key) {
  const b = bases.get(key);
  if (!b) return;
  if (--b.users <= 0) { b.tex?.dispose(); bases.delete(key); }
}

// Triangles (s, t) de la partie visible : page, découpe, ou page moins la découpe (découpe inversée).
function visibleTriangles(e) {
  const c = activeClip(e);
  if (!c) return [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  return c.invert ? triangulateLoops([PAGE, c.pts]) : triangulateLoops([c.pts]);
}

function makeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null }, region: { value: new THREE.Vector4(0, 0, 1, 1) }, hole: { value: new THREE.Vector4(2, 2, 2, 2) },
      fade: { value: 0 }, contrast: { value: 1 }, mono: { value: 0 }, adjust: { value: 0 }, whiteOff: { value: 1 },
      bg: { value: new THREE.Vector3(1, 1, 1) }, opacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: NUANCEUR,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

export class UnderlayView {
  constructor(renderer) {
    this.r = renderer;
    this.group = new THREE.Group();
    this.items = new Map(); // id → { e, mesh, detailMesh, baseKey, base, detail, ctrl, dirty }
    this.unsub = onSourceChange((src) => this.sourceChanged(src));
    this.timer = 0;
  }

  maxTexture() {
    return this.r.webgl?.capabilities?.maxTextureSize || 4096;
  }

  set(e) {
    const old = this.items.get(e.id);
    if (old) this.drop(old);
    const item = { e, dirty: true, gen: 0 };
    this.items.set(e.id, item);
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.drop(it);
    this.items.delete(id);
  }

  clear() {
    for (const it of this.items.values()) this.drop(it);
    this.items.clear();
  }

  drop(it) {
    it.gen = -1;
    it.ctrl?.abort();
    for (const m of [it.mesh, it.detailMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    it.detail?.tex.dispose();
    it.missing?.dispose();
    if (it.baseKey && it.base) releaseBase(it.baseKey);
    it.mesh = it.detailMesh = it.detail = it.base = it.missing = null;
  }

  // Tout reconstruire (nouvelle origine des coordonnées GPU).
  rebuild() {
    for (const it of this.items.values()) { this.drop(it); it.dirty = true; it.gen = 0; }
    this.flush();
  }

  flush() {
    for (const it of this.items.values()) if (it.dirty) this.build(it);
  }

  geometry(e) {
    const o = this.r.origin;
    const tri = visibleTriangles(e);
    const pos = new Float32Array(tri.length * 3), st = new Float32Array(tri.length * 2);
    tri.forEach(([s, t], i) => {
      const [x, y] = pageToWorld(e, s, t);
      pos[i * 3] = x - o.x; pos[i * 3 + 1] = y - o.y; pos[i * 3 + 2] = (e.p[2] || 0) - (o.z || 0);
      st[i * 2] = s; st[i * 2 + 1] = t;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('st', new THREE.BufferAttribute(st, 2));
    return g;
  }

  build(it) {
    it.dirty = false;
    const gen = ++it.gen;
    const e = it.e;
    if (e.pending) this.resolve(it, gen);
    it.mesh = new THREE.Mesh(this.geometry(e), makeMaterial());
    it.mesh.renderOrder = -10;
    it.mesh.frustumCulled = false;
    this.group.add(it.mesh);
    this.applyLook(it);
    this.applyVisibility(it);
    const src = getSource(e.path);
    if (!src || src.status === 'loading' || src.status === 'ok') {
      it.baseKey = baseKey(e);
      baseTexture(e, this.maxTexture()).then((b) => {
        if (it.gen !== gen) { if (b) releaseBase(it.baseKey); return; }
        if (!b) { this.showMissing(it); return; }
        it.base = b;
        it.mesh.material.uniforms.map.value = b.tex;
        it.mesh.visible = it.visible;
        this.r.requestRender(true);
        this.viewChanged();
      }).catch((err) => { console.warn('Fond illisible', err); if (it.gen === gen) this.showMissing(it); });
      it.mesh.visible = false; // invisible jusqu'à ce que la texture soit prête
    } else this.showMissing(it);
  }

  // Fond relu d'un fichier (taille de page inconnue) : recalé dès que le PDF est lu, sans étape d'annulation.
  resolve(it, gen) {
    const e = it.e;
    ensureSource(e.path).then(async (src) => {
      if (src.status !== 'ok' || it.gen !== gen) return;
      const native = await nativeSize(src, e.page || 1);
      const doc = this.r.doc, cur = doc?.get(e.id);
      if (!cur?.pending || it.gen !== gen) return;
      doc.updateQuiet(resolvePending(cur, native));
    }).catch(() => {});
  }

  showMissing(it) {
    if (!it.mesh) return;
    it.missing?.dispose();
    it.missing = missingTexture(it.e, getSource(it.e.path));
    const u = it.mesh.material.uniforms;
    u.map.value = it.missing;
    u.whiteOff.value = 0; u.adjust.value = 0; u.mono.value = 0; u.fade.value = 0; u.contrast.value = 1;
    it.mesh.visible = it.visible;
    this.r.requestRender(true);
  }

  // Réglages d'affichage (estompage, contraste…) passés au nuanceur.
  applyLook(it) {
    const e = it.e;
    const paper = this.r.space !== 'model' && !!this.r.sheet;
    const bg = paper ? 0xffffff : this.r.theme.background;
    const dark = ((bg >> 16) & 255) * 0.299 + ((bg >> 8) & 255) * 0.587 + (bg & 255) * 0.114 < 128;
    for (const m of [it.mesh, it.detailMesh]) {
      if (!m) continue;
      const u = m.material.uniforms;
      if (m.material.uniforms.map.value && m.material.uniforms.map.value === it.missing) continue;
      u.fade.value = Math.min(0.8, Math.max(0, (e.fade || 0) / 100));
      u.contrast.value = Math.min(1, Math.max(0, (e.contrast ?? 100) / 100));
      u.mono.value = e.mono ? 1 : 0;
      u.adjust.value = e.adjust !== false && dark ? 1 : 0;
      u.whiteOff.value = e.whiteOff !== false ? 1 : 0;
      u.bg.value.set(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255);
    }
  }

  applyTheme() {
    for (const it of this.items.values()) this.applyLook(it);
  }

  applyVisibility(it) {
    const e = it.e;
    const l = this.r.doc?.layers.get(e.layer);
    it.visible = e.show !== false && (!l || (l.on && !l.frozen)) && this.r.mode === '2d';
    const ready = !!(it.base || it.missing);
    if (it.mesh) it.mesh.visible = it.visible && ready;
    if (it.detailMesh) it.detailMesh.visible = it.visible && !!it.detail;
  }

  refreshVisibility() {
    for (const it of this.items.values()) this.applyVisibility(it);
  }

  sourceChanged(src) {
    for (const it of this.items.values()) {
      if (String(it.e.path).toLowerCase().replace(/\//g, '\\') !== src.key) continue;
      this.drop(it);
      it.dirty = true;
      it.gen = 0;
    }
    this.flush();
    this.r.requestRender(true);
  }

  // Vue modifiée : textures de détail recalculées un peu plus tard (quand on arrête de zoomer).
  viewChanged() {
    clearTimeout(this.timer);
    if (!this.items.size) return;
    this.timer = setTimeout(() => this.updateDetails(), 160);
  }

  updateDetails() {
    const r = this.r;
    if (r.mode !== '2d') return;
    const dpr = r.webgl.getPixelRatio ? r.webgl.getPixelRatio() : window.devicePixelRatio || 1;
    const corners = [r.toWorld(0, 0), r.toWorld(r.width, 0), r.toWorld(r.width, r.height), r.toWorld(0, r.height)];
    for (const it of this.items.values()) {
      if (!it.visible || !it.base) continue;
      const e = it.e;
      const ppw = Math.hypot(...e.u) * r.scale * dpr, pph = Math.hypot(...e.v) * r.scale * dpr;
      if (ppw <= it.base.w * 1.25 && pph <= it.base.h * 1.25) { this.dropDetail(it); continue; }
      // Zone de la page visible à l'écran (avec une marge pour les petits déplacements).
      const pts = corners.map(([x, y]) => worldToPage(e, x, y)).filter(Boolean);
      if (pts.length < 4) continue;
      let s0 = Math.min(...pts.map((p) => p[0])), s1 = Math.max(...pts.map((p) => p[0]));
      let t0 = Math.min(...pts.map((p) => p[1])), t1 = Math.max(...pts.map((p) => p[1]));
      const ms = (s1 - s0) * 0.15, mt = (t1 - t0) * 0.15;
      const vb = visibleBox(e);
      s0 = Math.max(vb.minX, s0 - ms); s1 = Math.min(vb.maxX, s1 + ms);
      t0 = Math.max(vb.minY, t0 - mt); t1 = Math.min(vb.maxY, t1 + mt);
      if (s1 <= s0 || t1 <= t0) { this.dropDetail(it); continue; }
      let w = (s1 - s0) * ppw, h = (t1 - t0) * pph;
      const k = Math.min(1, DETAIL_MAX / w, DETAIL_MAX / h, Math.sqrt(DETAIL_PIXELS / (w * h)));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const d = it.detail;
      const density = w / (s1 - s0);
      if (d && d.s0 <= s0 + 1e-9 && d.s1 >= s1 - 1e-9 && d.t0 <= t0 + 1e-9 && d.t1 >= t1 - 1e-9 && d.density >= density * 0.9) continue;
      if (it.pending && it.pending.density >= density * 0.9 && it.pending.s0 <= s0 && it.pending.s1 >= s1 && it.pending.t0 <= t0 && it.pending.t1 >= t1) continue;
      this.renderDetail(it, { s0, t0, s1, t1, density }, w, h);
    }
  }

  async renderDetail(it, region, w, h) {
    it.ctrl?.abort();
    const ctrl = new AbortController();
    it.ctrl = ctrl;
    it.pending = region;
    const gen = it.gen;
    try {
      const src = getSource(it.e.path);
      if (!src || src.status !== 'ok') return;
      const canvas = await renderRegion(src, region, w, h, { page: it.e.page || 1, ocgOff: it.e.ocgOff, signal: ctrl.signal });
      if (!canvas || ctrl.signal.aborted || it.gen !== gen) return;
      const tex = textureOf(canvas);
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      it.detail?.tex.dispose();
      it.detail = { ...region, tex };
      if (!it.detailMesh) {
        it.detailMesh = new THREE.Mesh(it.mesh.geometry.clone(), makeMaterial());
        it.detailMesh.renderOrder = -9;
        it.detailMesh.frustumCulled = false;
        this.group.add(it.detailMesh);
      }
      const u = it.detailMesh.material.uniforms;
      u.map.value = tex;
      u.region.value.set(region.s0, region.t0, region.s1, region.t1);
      // Base masquée sous le détail (un peu en retrait du bord pour ne pas laisser de joint).
      const ins = Math.min(region.s1 - region.s0, region.t1 - region.t0) * 0.002;
      it.mesh.material.uniforms.hole.value.set(region.s0 + ins, region.t0 + ins, region.s1 - ins, region.t1 - ins);
      this.applyLook(it);
      this.applyVisibility(it);
      this.r.requestRender(true);
    } catch (err) {
      console.warn('Détail du fond impossible', err);
    } finally {
      if (it.ctrl === ctrl) { it.ctrl = null; it.pending = null; }
    }
  }

  dropDetail(it) {
    it.ctrl?.abort();
    it.mesh?.material.uniforms.hole.value.set(2, 2, 2, 2);
    if (!it.detailMesh) return;
    this.group.remove(it.detailMesh);
    it.detailMesh.geometry.dispose();
    it.detailMesh.material.dispose();
    it.detail?.tex.dispose();
    it.detailMesh = null;
    it.detail = null;
  }

  // Traits du PDF près d'un point (accrochage), en coordonnées du monde : { lines, curves } (tableaux
  // [x0, y0, x1, y1…]). La géométrie de la page est lue à la première demande (rien tant qu'elle n'est pas prête).
  segsNear(e, p, tol) {
    const it = this.items.get(e.id);
    const out = { lines: [], curves: [] };
    if (!it || e.kind !== 'pdf' || !it.visible) return out;
    if (!it.snap) {
      const src = getSource(e.path);
      if (!it.snapLoading && src?.status === 'ok') {
        it.snapLoading = snapGeometry(src, e.page || 1).then((g) => { it.snap = g; }).catch((err) => console.warn(err));
      }
      return out;
    }
    const pts = [[p[0] - tol, p[1] - tol], [p[0] + tol, p[1] - tol], [p[0] + tol, p[1] + tol], [p[0] - tol, p[1] + tol]]
      .map(([x, y]) => worldToPage(e, x, y)).filter(Boolean);
    if (pts.length < 4) return out;
    const box = { minX: Math.min(...pts.map((q) => q[0])), maxX: Math.max(...pts.map((q) => q[0])), minY: Math.min(...pts.map((q) => q[1])), maxY: Math.max(...pts.map((q) => q[1])) };
    const found = segmentsIn(it.snap, box, e.ocgOff?.length ? new Set(e.ocgOff) : null);
    for (const key of ['lines', 'curves']) {
      const src = found[key], dst = out[key];
      for (let i = 0; i + 3 < src.length; i += 4) {
        // Partie découpée du fond : ses traits ne sont pas accrochables.
        if (activeClip(e) && !visibleAt(e, (src[i] + src[i + 2]) / 2, (src[i + 1] + src[i + 3]) / 2)) continue;
        const a = pageToWorld(e, src[i], src[i + 1]), b = pageToWorld(e, src[i + 2], src[i + 3]);
        dst.push(a[0], a[1], b[0], b[1]);
      }
    }
    return out;
  }

  // Préparer l'accrochage d'un fond (géométrie de la page lue d'avance).
  prepareSnap(e) {
    this.segsNear(e, e.p, 0);
    return this.items.get(e.id)?.snapLoading || Promise.resolve();
  }

  // Fonds de l'espace objet vus dans les fenêtres de présentation : maillages avec les textures de base, rangés
  // dans le groupe de leur calque (gel par fenêtre). onReady : appelé quand une texture arrive.
  addToModelView(doc, mv, onReady) {
    const o = mv.origin;
    const bg = 0xffffff; // fenêtres de présentation : sur la feuille blanche
    for (const e of doc.entities.values()) {
      if (e.type !== 'UNDERLAY' || e.space !== 'model' || e.show === false) continue;
      const l = doc.layers.get(e.layer);
      if (l && (!l.on || l.frozen)) continue;
      const tri = visibleTriangles(e);
      const pos = new Float32Array(tri.length * 3), st = new Float32Array(tri.length * 2);
      tri.forEach(([s, t], i) => {
        const [x, y] = pageToWorld(e, s, t);
        pos[i * 3] = x - o.x; pos[i * 3 + 1] = y - o.y; pos[i * 3 + 2] = 0;
        st[i * 2] = s; st[i * 2 + 1] = t;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('st', new THREE.BufferAttribute(st, 2));
      const m = new THREE.Mesh(g, makeMaterial());
      m.renderOrder = -10;
      m.frustumCulled = false;
      m.visible = false;
      const u = m.material.uniforms;
      u.fade.value = Math.min(0.8, Math.max(0, (e.fade || 0) / 100));
      u.contrast.value = Math.min(1, Math.max(0, (e.contrast ?? 100) / 100));
      u.mono.value = e.mono ? 1 : 0;
      u.adjust.value = 0; // présentation : papier blanc
      u.whiteOff.value = e.whiteOff !== false ? 1 : 0;
      u.bg.value.set(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255);
      let lg = mv.layerGroups?.get(e.layer);
      if (!lg) { lg = new THREE.Group(); mv.group.add(lg); mv.layerGroups?.set(e.layer, lg); }
      lg.add(m);
      const key = baseKey(e);
      (mv.underlayKeys ||= []).push(key);
      baseTexture(e, this.maxTexture()).then((b) => {
        if (!b) return;
        u.map.value = b.tex;
        m.visible = true;
        onReady?.();
      }).catch(() => {});
    }
  }

  releaseModelView(mv) {
    for (const k of mv?.underlayKeys || []) releaseBase(k);
    if (mv) mv.underlayKeys = [];
  }
}
