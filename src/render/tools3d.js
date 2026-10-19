// SPDX-License-Identifier: GPL-3.0-or-later
// Outils de la vue 3D : boîte de coupe (6 faces déplaçables par leurs poignées), plans de coupe (6 au plus,
// horizontaux ou verticaux, côté gardé inversable), mesures (point à point avec ΔX ΔY ΔZ, angle par 3 points, laser :
// distance perpendiculaire depuis une face jusqu'au premier objet en face), filtres d'affichage (dessin 2D, fonds de
// plan, grille, réseaux par système) et isolement de la sélection. Les coupes sont des plans de découpe de three.js
// appliqués à toute la scène ; les poignées et les mesures sont dessinées par-dessus, sans découpe.
import * as THREE from 'three';

const MAX_PLANES = 6;
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export class Tools3D {
  constructor(renderer, { unitM = () => 0.001, onChange } = {}) {
    this.r = renderer;
    this.unitM = unitM;            // mètres par unité du dessin (affichage des mesures)
    this.onChange = onChange;      // barre d'outils à rafraîchir
    this.scene = new THREE.Scene(); // poignées, plans, mesures (dessinés sans découpe)
    this.box = null;               // { min: Vector3, max: Vector3 } (coordonnées de la scène)
    this.planes = [];              // [{ axis: 'x'|'y'|'z', pos, flip }]
    this.measures = [];            // [{ kind, pts: [Vector3…], value… }]
    this.tool = null;              // 'distance' | 'angle' | 'laser' | null
    this.pending = [];             // points déjà cliqués de la mesure en cours
    this.filter = { drawing: true, underlays: true, grid: true, ifc: true, ifcAll: false, hiddenSystems: new Set() };
    this.isolate = null;           // Set d'id d'objets isolés, ou null
    this.ray = new THREE.Raycaster();
    this.handles = [];             // poignées de la boîte et des plans : { mesh, kind, index, axis, sign }
    this.drag = null;
    this.install();
  }

  // --- état et découpe -------------------------------------------------------------------
  get active() { return !!this.box || this.planes.length > 0; }

  clipPlanes() {
    if (this.r.mode !== '3d') return [];
    const out = [];
    if (this.box) {
      const { min, max } = this.box;
      out.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), -min.x), new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x));
      out.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -min.y), new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y));
      out.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -min.z), new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z));
    }
    for (const p of this.planes) {
      // Garde le côté négatif de l'axe (sous un plan horizontal), ou le positif si « inversé ».
      const n = AXES[p.axis].clone().multiplyScalar(p.flip ? 1 : -1);
      out.push(new THREE.Plane(n, p.flip ? -p.pos : p.pos));
    }
    return out;
  }

  // Emprise de la scène 3D (réseaux, maquette IFC et dessin), coordonnées de la scène.
  sceneBounds() {
    const b = new THREE.Box3();
    if (this.r.mep3d) b.expandByObject(this.r.mep3d);
    if (this.r.ifc3d) b.expandByObject(this.r.ifc3d);
    const e = this.r.extents;
    if (e && Number.isFinite(e.minX)) {
      b.expandByPoint(new THREE.Vector3(e.minX - this.r.origin.x, e.minY - this.r.origin.y, 0));
      b.expandByPoint(new THREE.Vector3(e.maxX - this.r.origin.x, e.maxY - this.r.origin.y, 0));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 1));
    if (b.max.z - b.min.z < 1e-6) b.max.z = b.min.z + Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 0.1;
    return b;
  }

  // Boîte autour des objets choisis (emprise 2D + altitude des réseaux), avec une marge ; toute la scène sinon.
  boxForSelection(ids) {
    const r = this.r;
    const b = new THREE.Box3();
    let zmin = Infinity, zmax = -Infinity;
    for (const id of ids || []) {
      const box = r.cache.get(id)?.box;
      const e = r.doc?.get(id);
      if (box) {
        b.expandByPoint(new THREE.Vector3(box.minX - r.origin.x, box.minY - r.origin.y, 0));
        b.expandByPoint(new THREE.Vector3(box.maxX - r.origin.x, box.maxY - r.origin.y, 0));
      }
      const m = e?.mep;
      if (m) {
        const h = m.h || m.d || 0;
        zmin = Math.min(zmin, (m.z || 0) - h, ...(m.z1 != null ? [m.z1 - h] : []));
        zmax = Math.max(zmax, (m.z || 0) + h, ...(m.z1 != null ? [m.z1 + h] : []));
      }
    }
    if (b.isEmpty()) return null;
    const all = this.sceneBounds();
    // Toujours depuis le niveau du plan (z = 0) : le local dessiné reste visible sous les réseaux.
    b.min.z = Math.min(Number.isFinite(zmin) ? zmin - r.origin.z : all.min.z, -r.origin.z);
    b.max.z = Number.isFinite(zmax) ? zmax - r.origin.z : all.max.z;
    const pad = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * 0.08 + 1e-6;
    b.expandByScalar(pad);
    return b;
  }

  setBox(box3) {
    this.box = box3 ? { min: box3.min.clone(), max: box3.max.clone() } : null;
    this.rebuild();
    if (box3) this.frame(box3);
  }

  toggleBox(selection) {
    if (this.box) { this.setBox(null); return; }
    const b = this.boxForSelection(selection) || this.sceneBounds().clone();
    // Faces de la boîte un peu en retrait des objets : pas de scintillement sur les faces confondues (murs, dalles).
    this.setBox(b.expandByScalar(b.getSize(new THREE.Vector3()).length() * 0.003 || 1e-6));
  }

  addPlane(axis = 'z') {
    if (this.planes.length >= MAX_PLANES) return false;
    const b = this.box ? new THREE.Box3(this.box.min, this.box.max) : this.sceneBounds();
    const c = b.getCenter(new THREE.Vector3());
    this.planes.push({ axis, pos: axis === 'z' ? b.min.z + (b.max.z - b.min.z) * 0.6 : c[axis], flip: false });
    this.rebuild();
    return true;
  }
  removePlane(i) { this.planes.splice(i, 1); this.rebuild(); }
  flipPlane(i) { this.planes[i].flip = !this.planes[i].flip; this.rebuild(); }
  setPlaneAxis(i, axis) {
    const b = this.box ? new THREE.Box3(this.box.min, this.box.max) : this.sceneBounds();
    this.planes[i].axis = axis;
    this.planes[i].pos = b.getCenter(new THREE.Vector3())[axis];
    this.rebuild();
  }

  clearAll() {
    this.box = null; this.planes = []; this.measures = []; this.pending = []; this.tool = null;
    this.isolate = null;
    this.filter = { drawing: true, underlays: true, grid: true, ifc: true, ifcAll: false, hiddenSystems: new Set() };
    this.applyFilter();
    this.rebuild();
  }

  frame(box3) {
    const r = this.r;
    const c = box3.getCenter(new THREE.Vector3());
    const size = box3.getSize(new THREE.Vector3()).length() || 1;
    const dir = r.perspective.position.clone().sub(r.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.55, -0.95, 0.8).normalize();
    r.controls.target.copy(c);
    r.perspective.position.copy(c).addScaledVector(dir, size * 1.1);
    r.perspective.near = size / 2000;
    r.perspective.far = size * 100;
    r.perspective.updateProjectionMatrix();
    r.controls.update();
    r.requestRender(true);
  }

  // --- filtres -----------------------------------------------------------------------------
  applyFilter() {
    const r = this.r;
    r.drawing.visible = this.filter.drawing && !this.isolate;
    r.underlays.group.visible = this.filter.underlays && !this.isolate;
    if (r.grid) r.grid.visible = r.mode === '3d' && this.filter.grid;
    r.refreshMep3d();
    r.ifc3dManager?.refresh();
    r.requestRender(true);
  }
  // Réseaux visibles en 3D (filtre par système, isolement) : utilisé par renderer.refreshMep3d.
  keepMep(e) {
    if (this.isolate && !this.isolate.has(e.id)) return false;
    return !this.filter.hiddenSystems.has(e.mep.system);
  }
  setIsolate(ids) {
    this.isolate = ids?.length ? new Set(ids) : null;
    this.applyFilter();
    if (this.isolate) { const b = this.boxForSelection(ids); if (b) this.frame(b); }
  }

  // --- gizmos ------------------------------------------------------------------------------
  rebuild() {
    for (const o of [...this.scene.children]) { this.scene.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.handles = [];
    const size = this.sceneBounds().getSize(new THREE.Vector3()).length() || 1;
    const hs = size * 0.008;
    const handleMat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    if (this.box) {
      const { min, max } = this.box;
      const geo = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xda291c, depthTest: false, transparent: true, opacity: 0.9 }));
      geo.dispose();
      edges.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      edges.renderOrder = 10;
      this.scene.add(edges);
      const c = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      for (const axis of ['x', 'y', 'z']) {
        for (const sign of [-1, 1]) {
          const m = new THREE.Mesh(new THREE.SphereGeometry(hs, 16, 12), handleMat(0xda291c));
          m.position.copy(c);
          m.position[axis] = sign < 0 ? min[axis] : max[axis];
          m.renderOrder = 11;
          this.scene.add(m);
          this.handles.push({ mesh: m, kind: 'box', axis, sign });
        }
      }
    }
    const b = this.box ? new THREE.Box3(this.box.min, this.box.max) : this.sceneBounds();
    this.planes.forEach((p, i) => {
      const s = b.getSize(new THREE.Vector3());
      const c = b.getCenter(new THREE.Vector3());
      const [w, h] = p.axis === 'z' ? [s.x, s.y] : p.axis === 'x' ? [s.y, s.z] : [s.x, s.z];
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.05, h * 1.05),
        new THREE.MeshBasicMaterial({ color: 0x5b9bd0, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      quad.position.copy(c);
      quad.position[p.axis] = p.pos;
      if (p.axis === 'x') quad.rotation.y = Math.PI / 2;
      if (p.axis === 'y') quad.rotation.x = Math.PI / 2;
      this.scene.add(quad);
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: 0x5b9bd0, depthTest: false, transparent: true, opacity: 0.8 }));
      frame.position.copy(quad.position);
      frame.rotation.copy(quad.rotation);
      this.scene.add(frame);
      const m = new THREE.Mesh(new THREE.SphereGeometry(hs * 1.2, 16, 12), handleMat(0x5b9bd0));
      m.position.copy(quad.position);
      m.renderOrder = 11;
      this.scene.add(m);
      this.handles.push({ mesh: m, kind: 'plane', index: i, axis: p.axis });
    });
    // Mesures : segments et points (étiquettes dessinées sur le calque 2D, voir drawUi).
    const lineMat = new THREE.LineBasicMaterial({ color: 0xf2b134, depthTest: false });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xf2b134, depthTest: false });
    for (const ms of [...this.measures, ...(this.pending.length ? [{ kind: this.tool, pts: this.pending }] : [])]) {
      const pts = ms.kind === 'laser' ? [ms.pts[0], ms.to || ms.pts[0]] : ms.pts;
      if (pts.length >= 2) {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const l = new THREE.Line(g, lineMat.clone());
        l.renderOrder = 12;
        this.scene.add(l);
      }
      for (const p of pts) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(hs * 0.6, 12, 8), dotMat.clone());
        d.position.copy(p);
        d.renderOrder = 12;
        this.scene.add(d);
      }
    }
    lineMat.dispose(); dotMat.dispose();
    this.onChange?.();
    this.r.requestRender(true);
  }

  // Étiquettes des mesures (calque 2D par-dessus la vue 3D).
  drawUi(ctx, dpr) {
    if (this.r.mode !== '3d') return;
    const cam = this.r.perspective, w = this.r.width, h = this.r.height;
    const scr = (v) => { const p = v.clone().project(cam); return p.z > 1 ? null : [((p.x + 1) / 2) * w * dpr, ((1 - p.y) / 2) * h * dpr]; };
    const k = this.unitM();
    const len = (v) => (k && k !== 1 ? `${(v * k).toFixed(3).replace('.', ',')} m` : v.toFixed(2).replace('.', ','));
    ctx.font = `${12 * dpr}px "Segoe UI", sans-serif`;
    const label = (v, lines) => {
      const p = scr(v);
      if (!p) return;
      const pad = 5 * dpr, lh = 15 * dpr;
      const tw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + pad * 2;
      ctx.fillStyle = 'rgba(17,17,16,0.86)';
      ctx.beginPath(); ctx.roundRect?.(p[0] + 8 * dpr, p[1] - lh * lines.length - pad, tw, lh * lines.length + pad, 5 * dpr); ctx.fill();
      ctx.fillStyle = '#f2f1ec';
      lines.forEach((t, i) => ctx.fillText(t, p[0] + 8 * dpr + pad, p[1] - lh * (lines.length - i - 1) - pad - 3 * dpr));
    };
    for (const ms of this.measures) {
      if (ms.kind === 'distance') {
        const [a, b] = ms.pts, d = b.clone().sub(a);
        label(a.clone().add(b).multiplyScalar(0.5), [`Distance ${len(d.length())}`, `ΔX ${len(Math.abs(d.x))}  ΔY ${len(Math.abs(d.y))}  ΔZ ${len(Math.abs(d.z))}`]);
      } else if (ms.kind === 'angle') {
        const [a, o, b] = ms.pts;
        const ang = a.clone().sub(o).angleTo(b.clone().sub(o)) * 180 / Math.PI;
        label(o, [`Angle ${ang.toFixed(1).replace('.', ',')}°`, `${len(a.distanceTo(o))} · ${len(b.distanceTo(o))}`]);
      } else if (ms.kind === 'laser') {
        label(ms.to ? ms.pts[0].clone().add(ms.to).multiplyScalar(0.5) : ms.pts[0], ms.to ? [`Laser ${len(ms.pts[0].distanceTo(ms.to))}`] : ['Laser : rien en face']);
      }
    }
  }

  // --- interaction --------------------------------------------------------------------------
  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    this.pending = [];
    this.r.canvas.classList.toggle('measuring', !!this.tool);
    this.rebuild();
  }
  clearMeasures() { this.measures = []; this.pending = []; this.rebuild(); }

  pointerRay(ev) {
    const rect = this.r.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.r.perspective);
    return this.ray;
  }

  // Premier objet touché (volumes des réseaux et de la maquette IFC, traits du dessin), hors partie coupée.
  pick(ev) {
    const ray = this.pointerRay(ev);
    const size = this.sceneBounds().getSize(new THREE.Vector3()).length() || 1;
    ray.params.Line = { threshold: size * 0.004 };
    const planes = this.clipPlanes();
    const kept = (p) => planes.every((pl) => pl.distanceToPoint(p) >= -1e-6);
    const targets = [];
    if (this.r.mep3d?.visible) targets.push(this.r.mep3d);
    if (this.r.ifc3d?.visible) targets.push(this.r.ifc3d);
    if (this.r.drawing.visible) targets.push(this.r.drawing);
    for (const hit of ray.intersectObjects(targets, true)) {
      if (!hit.object.visible || hit.object.type === 'LineSegments' && hit.object.parent === this.r.mep3d) continue; // arêtes des volumes
      if (!kept(hit.point)) continue;
      return hit;
    }
    return null;
  }

  click(ev) {
    const hit = this.pick(ev);
    if (!hit) return;
    const p = hit.point.clone();
    if (this.tool === 'laser') {
      // Normale de la face touchée (repère monde), orientée vers la caméra ; premier objet sur cette demi-droite.
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
      if (n.dot(this.ray.ray.direction) > 0) n.negate();
      const r2 = new THREE.Raycaster(p.clone().addScaledVector(n, 1e-3), n);
      const targets = [this.r.mep3d, this.r.ifc3d, this.r.drawing].filter((o) => o?.visible);
      const planes = this.clipPlanes();
      const next = r2.intersectObjects(targets, true).find((h) => h.distance > 1e-3 && !(h.object.type === 'LineSegments' && h.object.parent === this.r.mep3d) && planes.every((pl) => pl.distanceToPoint(h.point) >= -1e-6));
      this.measures.push({ kind: 'laser', pts: [p], to: next ? next.point.clone() : null });
      this.rebuild();
      return;
    }
    this.pending.push(p);
    const need = this.tool === 'angle' ? 3 : 2;
    if (this.pending.length >= need) {
      this.measures.push({ kind: this.tool, pts: this.pending.slice(0, need) });
      this.pending = [];
    }
    this.rebuild();
  }

  install() {
    const el = this.r.canvas;
    let down = null;
    el.addEventListener('pointerdown', (ev) => {
      if (this.r.mode !== '3d' || ev.button !== 0) return;
      down = { x: ev.clientX, y: ev.clientY };
      // Poignée de la boîte ou d'un plan : glissée le long de son axe (l'orbite est suspendue).
      if (!this.handles.length) return;
      const ray = this.pointerRay(ev);
      const hit = ray.intersectObjects(this.handles.map((h) => h.mesh), false)[0];
      if (!hit) return;
      const h = this.handles.find((x) => x.mesh === hit.object);
      this.drag = { h, start: this.axisParam(ray, h), value: h.kind === 'box' ? (h.sign < 0 ? this.box.min : this.box.max)[h.axis] : this.planes[h.index].pos };
      this.r.controls.enabled = false;
      el.setPointerCapture(ev.pointerId);
      ev.stopPropagation();
    }, true);
    el.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const { h, start, value } = this.drag;
      const t = this.axisParam(this.pointerRay(ev), h);
      if (!Number.isFinite(t)) return;
      let v = value + (t - start);
      if (h.kind === 'box') {
        const gap = 1e-3 * (this.sceneBounds().getSize(new THREE.Vector3()).length() || 1);
        if (h.sign < 0) this.box.min[h.axis] = Math.min(v, this.box.max[h.axis] - gap);
        else this.box.max[h.axis] = Math.max(v, this.box.min[h.axis] + gap);
      } else this.planes[h.index].pos = v;
      this.rebuild();
    });
    el.addEventListener('pointerup', (ev) => {
      if (this.drag) { this.drag = null; this.r.controls.enabled = true; return; }
      if (!down || this.r.mode !== '3d') return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4;
      down = null;
      if (!moved && this.tool) this.click(ev);
    });
  }

  // Paramètre le long de l'axe de la poignée du point de cet axe le plus proche du rayon de la souris.
  axisParam(ray, h) {
    const o = h.mesh.position.clone(), d = AXES[h.axis];
    const w0 = o.clone().sub(ray.ray.origin);
    const a = d.dot(d), b = d.dot(ray.ray.direction), c = ray.ray.direction.dot(ray.ray.direction);
    const dd = d.dot(w0), e = ray.ray.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-12) return NaN;
    const s = (b * e - c * dd) / den; // paramètre sur l'axe (depuis la position de la poignée)
    return o[h.axis] + s;
  }
}
