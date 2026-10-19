// SPDX-License-Identifier: GPL-3.0-or-later
// Conversion d'un DwgDatabase (LibreDWG) en géométrie affichable :
// segments et triangles regroupés par calque et par couleur, plus une liste de textes.
// Les blocs (INSERT), cotes et tableaux sont développés récursivement.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { aciToColor, layerColor, FOREGROUND } from './colors.js';
import {
  arcPoints, bulgePolyline, circlePoints, ellipsePoints, ocsAxes, splinePoints,
} from './curves.js';
import { hatchLoops, patternSegments, triangulateLoops } from './hatch.js';
import { makeText, parseMText, plainText } from './text.js';

const MAX_DEPTH = 16;
const SAMPLE_SIZE = 40000;
// Entités dont on mémorise le contour (sélection, extrusion 3D).
const SHAPE_TYPES = new Set(['LINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D', 'SPLINE']);

const H_ALIGN = { 0: 'left', 1: 'center', 2: 'right', 3: 'center', 4: 'center', 5: 'center' };
const V_ANCHOR = { 0: 'baseline', 1: 'bottom', 2: 'middle', 3: 'top' };
// Point d'attache MTEXT 1..9 → [alignement horizontal, ancrage vertical]
const MTEXT_ATTACH = {
  1: ['left', 'top'], 2: ['center', 'top'], 3: ['right', 'top'],
  4: ['left', 'middle'], 5: ['center', 'middle'], 6: ['right', 'middle'],
  7: ['left', 'mtext-bottom'], 8: ['center', 'mtext-bottom'], 9: ['right', 'mtext-bottom'],
};

function ocsMatrix(extrusion) {
  const a = ocsAxes(extrusion);
  if (!a) return null;
  return new Matrix4().set(
    a[0], a[3], a[6], 0,
    a[1], a[4], a[7], 0,
    a[2], a[5], a[8], 0,
    0, 0, 0, 1);
}

export class SceneBuilder {
  constructor(db) {
    this.db = db;
    this.layerTable = new Map();
    for (const l of db.tables?.LAYER?.entries || []) this.layerTable.set(l.name, l);
    this.blocks = new Map();
    this.blocksByHandle = new Map();
    for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
      this.blocks.set(b.name, b);
      this.blocks.set(b.name.toUpperCase(), b);
      this.blocksByHandle.set(b.handle, b);
    }
    this.layers = new Map();
    this.texts = [];
    this.shapes = [];
    this.capture = null;
    this.stats = { drawn: new Map(), skipped: new Map(), missingBlocks: new Set() };
    this.bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    this.sample = [];
    this.seen = 0;
    this._v = new Vector3();
  }

  // Liste des « espaces » : objet + présentations (espaces papier).
  spaces() {
    const layouts = this.db.objects?.LAYOUT || [];
    const papers = [];
    for (const b of this.db.tables?.BLOCK_RECORD?.entries || []) {
      if (!/^\*paper_space/i.test(b.name) || !b.entities?.length) continue;
      const layout = layouts.find((l) => l.paperSpaceTableId === b.handle || l.handle === b.layout);
      papers.push({ id: b.name, label: layout?.layoutName || b.name, order: layout?.tabOrder ?? 99 });
    }
    papers.sort((a, b) => a.order - b.order);
    return [{ id: 'model', label: 'Objet' }, ...papers];
  }

  build(spaceId = 'model') {
    const entities = spaceId === 'model'
      ? this.db.entities || []
      : this.blocks.get(spaceId)?.entities || [];
    const ctx = { m: new Matrix4(), layer: null, byBlock: null, depth: 0, stack: [] };
    for (const ent of entities) {
      if (spaceId === 'model' && ent.isInPaperSpace) continue;
      this.entity(ent, ctx);
    }
    return {
      layers: this.layers,
      texts: this.texts,
      shapes: this.shapes,
      bbox: this.bbox,
      extents: this.robustExtents(),
      stats: this.stats,
      layerInfo: this.layerInfo(),
    };
  }

  layerInfo() {
    const info = [];
    const names = new Set([...this.layerTable.keys(), ...this.layers.keys()]);
    for (const name of names) {
      const l = this.layerTable.get(name);
      info.push({
        name,
        color: layerColor(l),
        visible: l ? !(l.off || l.frozen || l.colorIndex < 0) : true,
        used: this.layers.has(name) || this.texts.some((t) => t.layer === name),
      });
    }
    return info.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  }

  // --- couleurs, calques -------------------------------------------------

  effLayer(ent, ctx) {
    const name = ent.layer || '0';
    return name === '0' && ctx.layer ? ctx.layer : name;
  }

  color(ent, ctx, layerName) {
    if (typeof ent.color === 'number') return ent.color;
    const idx = ent.colorIndex;
    if (idx === 0) return ctx.byBlock ?? FOREGROUND;
    if (idx >= 1 && idx <= 255) return aciToColor(idx);
    return layerColor(this.layerTable.get(layerName));
  }

  bucket(layer) {
    let b = this.layers.get(layer);
    if (!b) {
      b = { lines: new Map(), fills: new Map(), points: new Map() };
      this.layers.set(layer, b);
    }
    return b;
  }

  // --- émission de géométrie ------------------------------------------------

  tx(m, p) {
    const v = this._v.set(p[0], p[1], p[2] || 0).applyMatrix4(m);
    this.grow(v.x, v.y, v.z);
    return [v.x, v.y, v.z];
  }

  grow(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const b = this.bbox;
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
    this.seen++;
    if (this.sample.length < SAMPLE_SIZE * 2) this.sample.push(x, y);
    else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < SAMPLE_SIZE) { this.sample[j * 2] = x; this.sample[j * 2 + 1] = y; }
    }
  }

  polyline(pts, m, layer, color, closed = false) {
    if (pts.length < 2) return;
    const arr = this.arr(this.bucket(layer).lines, color);
    let prev = this.tx(m, pts[0]);
    const first = prev;
    const world = this.capture ? [first] : null;
    for (let i = 1; i < pts.length; i++) {
      const cur = this.tx(m, pts[i]);
      arr.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
      if (world) world.push(cur);
      prev = cur;
    }
    if (closed) arr.push(prev[0], prev[1], prev[2], first[0], first[1], first[2]);
    if (world) this.recordShape(this.capture, layer, color, world, closed);
  }

  recordShape({ type, handle }, layer, color, pts, closed) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const a = pts[0], b = pts[pts.length - 1];
    const tol = 1e-6 * Math.max(maxX - minX, maxY - minY, 1);
    const isClosed = closed || (pts.length > 2 && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol);
    this.shapes.push({ id: this.shapes.length, type, handle, layer, color, pts, closed: isClosed, minX, minY, maxX, maxY });
  }

  segments2d(segs, m, layer, color) {
    const arr = this.arr(this.bucket(layer).lines, color);
    for (let i = 0; i + 1 < segs.length; i += 2) {
      const a = this.tx(m, segs[i]), b = this.tx(m, segs[i + 1]);
      arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }

  triangles(tris, m, layer, color) {
    const arr = this.arr(this.bucket(layer).fills, color);
    for (const p of tris) {
      const v = this.tx(m, p);
      arr.push(v[0], v[1], v[2]);
    }
  }

  arr(map, key) {
    let a = map.get(key);
    if (!a) { a = []; map.set(key, a); }
    return a;
  }

  count(map, type) {
    map.set(type, (map.get(type) || 0) + 1);
  }

  withOcs(m, extrusion) {
    const o = ocsMatrix(extrusion);
    return o ? m.clone().multiply(o) : m;
  }

  // --- entités ---------------------------------------------------------------

  // Une entité mal formée ne doit pas empêcher d'afficher le reste du dessin.
  entity(ent, ctx) {
    try {
      this.entityUnsafe(ent, ctx);
    } catch (err) {
      console.warn(`Entité ${ent.type} (${ent.handle}) ignorée :`, err);
      this.count(this.stats.skipped, ent.type);
    }
  }

  entityUnsafe(ent, ctx) {
    this.capture = SHAPE_TYPES.has(ent.type) ? { type: ent.type, handle: ent.handle } : null;
    if (ent.isVisible === false) return;
    // Contraintes paramétriques des blocs dynamiques : visibles seulement dans l'éditeur de blocs.
    if (ent.layer === '*ADSK_CONSTRAINTS') return;
    const layer = this.effLayer(ent, ctx);
    const color = this.color(ent, ctx, layer);
    const m = ctx.m;
    let drawn = true;

    switch (ent.type) {
      case 'LINE':
        this.polyline([[ent.startPoint.x, ent.startPoint.y, ent.startPoint.z],
          [ent.endPoint.x, ent.endPoint.y, ent.endPoint.z]], m, layer, color);
        break;
      case 'CIRCLE': {
        const c = ent.center;
        this.polyline(circlePoints(c.x, c.y, ent.radius, c.z), this.withOcs(m, ent.extrusionDirection), layer, color);
        break;
      }
      case 'ARC': {
        const c = ent.center;
        this.polyline(arcPoints(c.x, c.y, ent.radius, ent.startAngle, ent.endAngle, c.z),
          this.withOcs(m, ent.extrusionDirection), layer, color);
        break;
      }
      case 'ELLIPSE':
        this.polyline(ellipsePoints(ent.center, ent.majorAxisEndPoint, ent.axisRatio,
          ent.startAngle, ent.endAngle, ent.extrusionDirection), m, layer, color);
        break;
      case 'LWPOLYLINE': {
        const closed = (ent.flag & 512) !== 0;
        this.polyline(bulgePolyline(ent.vertices || [], closed, ent.elevation || 0),
          this.withOcs(m, ent.extrusionDirection), layer, color);
        break;
      }
      case 'POLYLINE2D': {
        const verts = (ent.vertices || []).filter((v) => !(v.flag & 16));
        const closed = (ent.flag & 1) !== 0;
        const z = ent.elevation || (verts[0] && verts[0].z) || 0;
        this.polyline(bulgePolyline(verts, closed, z), this.withOcs(m, ent.extrusionDirection), layer, color);
        break;
      }
      case 'POLYLINE3D': {
        const verts = (ent.vertices || []).filter((v) => !(v.flag & 16));
        this.polyline(verts.map((v) => [v.x, v.y, v.z]), m, layer, color, (ent.flag & 1) !== 0);
        break;
      }
      case 'SPLINE':
        this.polyline(splinePoints(ent.degree, ent.knots, ent.controlPoints, ent.weights, ent.fitPoints),
          m, layer, color, (ent.flag & 1) !== 0 && !(ent.controlPoints?.length));
        break;
      case 'SOLID': {
        const om = this.withOcs(m, ent.extrusionDirection);
        const c1 = [ent.corner1.x, ent.corner1.y], c2 = [ent.corner2.x, ent.corner2.y];
        const c3 = [ent.corner3.x, ent.corner3.y];
        const c4 = ent.corner4 ? [ent.corner4.x, ent.corner4.y] : c3;
        this.triangles([c1, c2, c3, c2, c4, c3], om, layer, color);
        break;
      }
      case '3DFACE': {
        const c = [ent.corner1, ent.corner2, ent.corner3, ent.corner4 || ent.corner3].map((p) => [p.x, p.y, p.z]);
        this.polyline(c, m, layer, color, true);
        break;
      }
      case 'POINT': {
        const p = this.tx(m, [ent.position.x, ent.position.y, ent.position.z]);
        this.arr(this.bucket(layer).points, color).push(...p);
        break;
      }
      case 'LEADER':
        this.polyline((ent.vertices || []).map((v) => [v.x, v.y, v.z]), m, layer, color);
        break;
      case 'MLINE':
        this.mline(ent, m, layer, color);
        break;
      case 'HATCH':
        drawn = this.hatch(ent, m, layer, color);
        break;
      case 'TEXT':
        drawn = this.text(ent, m, layer, color);
        break;
      case 'ATTRIB':
        if (ent.flags & 1) return; // attribut invisible
        drawn = this.text(typeof ent.text === 'object' ? { ...ent.text } : ent, m, layer, color);
        break;
      case 'MTEXT':
        drawn = this.mtext(ent, m, layer, color);
        break;
      case 'INSERT':
        this.insert(ent, ctx, layer, color);
        break;
      case 'DIMENSION': // géométrie de la cote stockée dans un bloc anonyme *D…
        drawn = this.anonymousBlock(ent, ctx, layer, color, m) || this.dimension(ent, m, layer, color);
        break;
      case 'ACAD_TABLE': { // tableau : bloc anonyme *T… placé comme une insertion
        const p = ent.startPoint || { x: 0, y: 0, z: 0 };
        const d = ent.directionVector;
        const ok = d && Number.isFinite(d.x) && Number.isFinite(d.y) && Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-3;
        const tm = m.clone()
          .multiply(new Matrix4().makeTranslation(p.x, p.y, p.z || 0))
          .multiply(new Matrix4().makeRotationZ(ok ? Math.atan2(d.y, d.x) : 0));
        drawn = this.anonymousBlock(ent, ctx, layer, color, tm);
        break;
      }
      case 'ATTDEF': // définition d'attribut : invisible dans une insertion
      case 'VIEWPORT': // cadre de fenêtre de présentation : non tracé
        return;
      default:
        drawn = false;
    }
    this.count(drawn ? this.stats.drawn : this.stats.skipped, ent.type);
  }

  mline(ent, m, layer, color) {
    const verts = ent.vertices || [];
    if (verts.length < 2) return;
    const nLines = verts[0].lines?.length || 0;
    const closed = (ent.flags & 2) !== 0;
    for (let j = 0; j < nLines; j++) {
      const pts = verts.map((v) => {
        const off = v.lines?.[j]?.segmentParams?.[0] || 0;
        return [v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off,
          v.vertex.z + v.miterDirection.z * off];
      });
      this.polyline(pts, m, layer, color, closed);
    }
  }

  hatch(ent, m, layer, color) {
    const loops = hatchLoops(ent);
    if (!loops.length) return false;
    const om = this.withOcs(m, ent.extrusionDirection);
    for (const loop of loops) {
      this.recordShape({ type: 'HATCH', handle: ent.handle }, layer, color, loop.map((p) => this.tx(om, p)), true);
    }
    if (ent.solidFill === 1) {
      let fill = color;
      if (ent.gradientFlag === 1 && ent.gradientColors?.length) fill = ent.gradientColors[0].rgb & 0xffffff;
      this.triangles(triangulateLoops(loops), om, layer, fill);
      return true;
    }
    const segs = patternSegments(ent, loops);
    if (!segs) {
      for (const loop of loops) this.polyline(loop, om, layer, color, true);
      return true;
    }
    this.segments2d(segs, om, layer, color);
    return true;
  }

  // Transforme position, angle et hauteur d'un texte du repère local vers le monde.
  textFrame(m, pos, rot, h) {
    const p = this.tx(m, pos);
    const m3 = new Matrix3().setFromMatrix4(m);
    const ux = new Vector3(Math.cos(rot), Math.sin(rot), 0).applyMatrix3(m3);
    const uy = new Vector3(-Math.sin(rot), Math.cos(rot), 0).applyMatrix3(m3);
    const sy = uy.length() || 1;
    return { p, rot: Math.atan2(ux.y, ux.x), h: h * sy, stretch: ux.length() / sy };
  }

  text(ent, m, layer, color) {
    const str = plainText(ent.text);
    if (!str.trim() || !(ent.textHeight > 0)) return false;
    const halign = ent.halign || 0, valign = ent.valign || 0;
    const useEnd = (halign !== 0 || valign !== 0) && ent.endPoint;
    let base = useEnd ? ent.endPoint : ent.startPoint;
    if ((halign === 3 || halign === 5) && ent.endPoint) {
      base = { x: (ent.startPoint.x + ent.endPoint.x) / 2, y: (ent.startPoint.y + ent.endPoint.y) / 2 };
    }
    const om = this.withOcs(m, ent.extrusionDirection);
    const f = this.textFrame(om, [base.x, base.y, ent.elevation || 0], ent.rotation || 0, ent.textHeight);
    this.texts.push(makeText({
      pos: f.p, rot: f.rot, h: f.h, widthFactor: (ent.xScale || 1) * f.stretch, lines: [str],
      align: H_ALIGN[halign] || 'left', vAnchor: halign === 4 ? 'middle' : V_ANCHOR[valign] || 'baseline',
      color, layer,
    }));
    return true;
  }

  mtext(ent, m, layer, color) {
    const lines = parseMText(ent.text);
    if (!lines.some((l) => l.trim()) || !(ent.textHeight > 0)) return false;
    const d = ent.direction;
    const rot = d && (d.x || d.y) ? Math.atan2(d.y, d.x) : ent.rotation || 0;
    const f = this.textFrame(m, [ent.insertionPoint.x, ent.insertionPoint.y, ent.insertionPoint.z], rot, ent.textHeight);
    const [align, vAnchor] = MTEXT_ATTACH[ent.attachmentPoint] || MTEXT_ATTACH[1];
    this.texts.push(makeText({
      pos: f.p, rot: f.rot, h: f.h, lines, align, vAnchor,
      lineSpacing: ent.lineSpacing, wrapWidth: ent.rectWidth * (f.h / ent.textHeight),
      color, layer,
    }));
    return true;
  }

  insert(ent, ctx, layer, color) {
    const block = this.blocks.get(ent.name) || this.blocks.get(ent.name?.toUpperCase());
    if (!block || ctx.depth >= MAX_DEPTH || ctx.stack.includes(block.name)) {
      if (!block) this.stats.missingBlocks.add(ent.name);
      return;
    }
    if (!block.entities?.length) {
      if (block.flags & 4) this.stats.missingBlocks.add(`${ent.name} (réf. externe)`);
    }
    const base = block.basePoint || { x: 0, y: 0, z: 0 };
    const ins = ent.insertionPoint;
    const outer = this.withOcs(ctx.m, ent.extrusionDirection);
    const cols = Math.max(1, ent.columnCount || 1), rows = Math.max(1, ent.rowCount || 1);
    const child = {
      layer, byBlock: color, depth: ctx.depth + 1, stack: [...ctx.stack, block.name],
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        child.m = outer.clone()
          .multiply(new Matrix4().makeTranslation(ins.x, ins.y, ins.z))
          .multiply(new Matrix4().makeRotationZ(ent.rotation || 0))
          .multiply(new Matrix4().makeTranslation(c * (ent.columnSpacing || 0), r * (ent.rowSpacing || 0), 0))
          .multiply(new Matrix4().makeScale(ent.xScale || 1, ent.yScale || 1, ent.zScale || 1))
          .multiply(new Matrix4().makeTranslation(-base.x, -base.y, -base.z));
        for (const e of block.entities || []) this.entity(e, child);
      }
    }
    for (const a of ent.attribs || []) this.entity(a, ctx);
  }

  // Cote sans bloc précalculé (blocs dynamiques, DXF d'autres logiciels) :
  // on reconstruit lignes d'attache, ligne de cote, flèches et texte.
  // Seules les cotes alignées et linéaires sont gérées pour l'instant.
  dimension(ent, m, layer, color) {
    const p1 = ent.subDefinitionPoint1, p2 = ent.subDefinitionPoint2, d = ent.definitionPoint;
    if (!p1 || !p2 || !d) return false;
    const style = this.db.tables?.DIMSTYLE?.entries?.find((st) => st.name === ent.styleName) || {};
    const hdr = this.db.header || {};
    const scale = style.DIMSCALE || hdr.DIMSCALE || 1;
    const asz = (style.DIMASZ ?? hdr.DIMASZ ?? 0.18) * scale;
    const txt = (style.DIMTXT ?? hdr.DIMTXT ?? 0.18) * scale;
    const exe = (style.DIMEXE ?? hdr.DIMEXE ?? 0.18) * scale;
    const exo = (style.DIMEXO ?? hdr.DIMEXO ?? 0.0625) * scale;

    let ux, uy;
    if (ent.subclassMarker === 'AcDbRotatedDimension') {
      ux = Math.cos(ent.rotationAngle || 0); uy = Math.sin(ent.rotationAngle || 0);
    } else {
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      ux = (p2.x - p1.x) / len; uy = (p2.y - p1.y) / len;
    }
    const proj = (p) => {
      const t = (p.x - d.x) * ux + (p.y - d.y) * uy;
      return [d.x + ux * t, d.y + uy * t, d.z || 0];
    };
    const a = proj(p1), b = proj(p2);
    const ext = (p, q) => {
      const dx = q[0] - p.x, dy = q[1] - p.y, l = Math.hypot(dx, dy);
      if (l < 1e-12) return;
      const nx = dx / l, ny = dy / l;
      this.polyline([[p.x + nx * exo, p.y + ny * exo, q[2]], [q[0] + nx * exe, q[1] + ny * exe, q[2]]], m, layer, color);
    };
    ext(p1, a);
    ext(p2, b);
    this.polyline([a, b], m, layer, color);
    const dx = b[0] - a[0], dy = b[1] - a[1], span = Math.hypot(dx, dy);
    if (span > 1e-12) {
      const vx = dx / span, vy = dy / span, w = asz / 6;
      const arrow = (tip, sx, sy) => [
        [tip[0], tip[1]],
        [tip[0] + sx * asz - sy * w, tip[1] + sy * asz + sx * w],
        [tip[0] + sx * asz + sy * w, tip[1] + sy * asz - sx * w],
      ];
      this.triangles([...arrow(a, vx, vy), ...arrow(b, -vx, -vy)], m, layer, color);
    }
    const value = ent.measurement ?? span;
    const num = String(Math.round(value * 100) / 100);
    const label = ent.text && ent.text !== '<>' ? plainText(ent.text).replace('<>', num) : num;
    let rot = Math.atan2(uy, ux);
    if (rot > Math.PI / 2 + 1e-6 || rot <= -Math.PI / 2 + 1e-6) rot += Math.PI;
    const tp = ent.textPoint || { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    const f = this.textFrame(m, [tp.x, tp.y, a[2]], rot, txt);
    this.texts.push(makeText({
      pos: f.p, rot: f.rot, h: f.h, lines: [label], align: 'center', vAnchor: 'middle', color, layer,
    }));
    return true;
  }

  anonymousBlock(ent, ctx, layer, color, m) {
    const block = (ent.name && (this.blocks.get(ent.name) || this.blocks.get(ent.name.toUpperCase())))
      || this.blocksByHandle.get(ent.blockRecordHandle);
    if (!block?.entities?.length || ctx.stack.includes(block.name)) return false;
    const child = { m, layer, byBlock: color, depth: ctx.depth + 1, stack: [...ctx.stack, block.name] };
    for (const e of block.entities) this.entity(e, child);
    return true;
  }

  // Emprise robuste : ignore les quelques objets isolés très loin du dessin
  // (fréquents dans les DWG réels), qui rendraient le « zoom étendu » inutilisable.
  robustExtents() {
    const b = this.bbox;
    if (!Number.isFinite(b.minX)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    const n = this.sample.length / 2;
    if (n < 50) return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = this.sample[i * 2]; ys[i] = this.sample[i * 2 + 1]; }
    xs.sort(); ys.sort();
    const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))];
    const qx0 = q(xs, 0.005), qx1 = q(xs, 0.995), qy0 = q(ys, 0.005), qy1 = q(ys, 0.995);
    const qw = Math.max(qx1 - qx0, 1e-9), qh = Math.max(qy1 - qy0, 1e-9);
    const fw = b.maxX - b.minX, fh = b.maxY - b.minY;
    if (fw <= qw * 4 && fh <= qh * 4) return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
    const mx = qw * 0.05, my = qh * 0.05;
    return {
      minX: Math.max(b.minX, qx0 - mx), maxX: Math.min(b.maxX, qx1 + mx),
      minY: Math.max(b.minY, qy0 - my), maxY: Math.min(b.maxY, qy1 + my),
    };
  }
}
