// SPDX-License-Identifier: GPL-3.0-or-later
// Hachures : contours → boucles 2D, remplissage plein (triangulation) et
// génération des motifs de hachure (lignes parallèles découpées par les contours).
import { ShapeUtils, Vector2 } from 'three';
import { arcPoints, bulgePolyline, ellipsePoints, splinePoints } from './curves.js';

const MAX_PATTERN_LINES = 20000;
const MAX_PATTERN_SEGMENTS = 300000;

// Edge types : 1 ligne, 2 arc, 3 arc elliptique, 4 spline.
function edgeLoop(edges) {
  const pts = [];
  const push = (list) => {
    for (const p of list) {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) pts.push(p);
    }
  };
  for (const e of edges) {
    if (e.type === 1) {
      push([[e.start.x, e.start.y, 0], [e.end.x, e.end.y, 0]]);
    } else if (e.type === 2) {
      push(e.isCCW === false
        ? arcPoints(e.center.x, e.center.y, e.radius, -e.endAngle, -e.startAngle).reverse()
        : arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle));
    } else if (e.type === 3) {
      const major = { x: e.end.x, y: e.end.y, z: 0 };
      const ratio = e.lengthOfMinorAxis;
      const center = { x: e.center.x, y: e.center.y, z: 0 };
      push(e.isCCW === false
        ? ellipsePoints(center, major, ratio, -e.endAngle, -e.startAngle).reverse()
        : ellipsePoints(center, major, ratio, e.startAngle, e.endAngle));
    } else if (e.type === 4) {
      const ctrl = (e.controlPoints || []).map((p) => ({ x: p.x, y: p.y, z: 0 }));
      const weights = (e.controlPoints || []).map((p) => p.weight ?? 1);
      push(splinePoints(e.degree, e.knots, ctrl, weights, e.fitDatum));
    }
  }
  return pts;
}

export function hatchLoops(hatch) {
  const loops = [];
  for (const path of hatch.boundaryPaths || []) {
    let pts;
    if (path.vertices) pts = bulgePolyline(path.vertices, true);
    else if (path.edges) pts = edgeLoop(path.edges);
    if (pts && pts.length >= 3) loops.push(pts.map((p) => [p[0], p[1]]));
  }
  return loops;
}

function signedArea(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    a += (loop[j][0] - loop[i][0]) * (loop[j][1] + loop[i][1]);
  }
  return a / 2;
}

function pointInLoop(x, y, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Triangulation pair-impair : chaque boucle de profondeur paire est un contour
// extérieur, les boucles de profondeur impaire qu'elle contient sont ses trous.
export function triangulateLoops(loops) {
  const info = loops.map((loop) => ({ loop, area: Math.abs(signedArea(loop)), depth: 0, parent: -1 }));
  for (let i = 0; i < info.length; i++) {
    const [x, y] = info[i].loop[0];
    let best = -1;
    for (let j = 0; j < info.length; j++) {
      if (i === j || info[j].area <= info[i].area) continue;
      if (pointInLoop(x, y, info[j].loop)) {
        info[i].depth++;
        if (best < 0 || info[j].area < info[best].area) best = j;
      }
    }
    info[i].parent = best;
  }
  const triangles = [];
  info.forEach((outer, oi) => {
    if (outer.depth % 2 !== 0) return;
    const holes = info.filter((h) => h.parent === oi && h.depth % 2 === 1).map((h) => h.loop);
    const contour = outer.loop.map(([x, y]) => new Vector2(x, y));
    const holeVecs = holes.map((h) => h.map(([x, y]) => new Vector2(x, y)));
    if (ShapeUtils.isClockWise(contour)) contour.reverse();
    holeVecs.forEach((h) => { if (!ShapeUtils.isClockWise(h)) h.reverse(); });
    const all = contour.concat(...holeVecs);
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holeVecs)) {
      triangles.push([all[a].x, all[a].y], [all[b].x, all[b].y], [all[c].x, all[c].y]);
    }
  });
  return triangles;
}

// Motif : pour chaque ligne de définition (angle, origine, décalage, tirets),
// on trace la famille de droites parallèles, on calcule les intersections avec
// tous les contours, et on garde les morceaux intérieurs (règle pair-impair).
export function patternSegments(hatch, loops) {
  const segments = [];
  for (const def of hatch.definitionLines || []) {
    let angle = def.angle || 0;
    if (Math.abs(angle) > Math.PI * 2 + 1e-6) angle = (angle * Math.PI) / 180;
    const dir = [Math.cos(angle), Math.sin(angle)];
    const nrm = [-dir[1], dir[0]];
    const off = def.offset || { x: 0, y: 0 };
    const spacing = off.x * nrm[0] + off.y * nrm[1];
    if (Math.abs(spacing) < 1e-9) continue;
    const base = def.base || { x: 0, y: 0 };

    let tMin = Infinity, tMax = -Infinity;
    for (const loop of loops) {
      for (const [x, y] of loop) {
        const t = (x - base.x) * nrm[0] + (y - base.y) * nrm[1];
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    let k0 = Math.ceil(tMin / spacing), k1 = Math.floor(tMax / spacing);
    if (k0 > k1) [k0, k1] = [k1, k0];
    if (k1 - k0 > MAX_PATTERN_LINES) return null; // motif trop dense : on renonce

    const dashes = def.dashLengths || [];
    const patternLen = dashes.reduce((s, d) => s + Math.abs(d), 0);

    for (let k = k0; k <= k1; k++) {
      const ox = base.x + k * off.x, oy = base.y + k * off.y;
      const us = [];
      for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const a = loop[j], b = loop[i];
          const da = (a[0] - ox) * nrm[0] + (a[1] - oy) * nrm[1];
          const db = (b[0] - ox) * nrm[0] + (b[1] - oy) * nrm[1];
          if ((da > 0) === (db > 0)) continue;
          const f = da / (da - db);
          const px = a[0] + (b[0] - a[0]) * f, py = a[1] + (b[1] - a[1]) * f;
          us.push((px - ox) * dir[0] + (py - oy) * dir[1]);
        }
      }
      us.sort((p, q) => p - q);
      for (let i = 0; i + 1 < us.length; i += 2) {
        const u0 = us[i], u1 = us[i + 1];
        const emit = (a, b) => segments.push(
          [ox + dir[0] * a, oy + dir[1] * a], [ox + dir[0] * b, oy + dir[1] * b]);
        if (!dashes.length || patternLen < 1e-9) {
          emit(u0, u1);
        } else {
          let pos = Math.floor(u0 / patternLen) * patternLen;
          let guard = 0;
          while (pos < u1 && guard++ < 10000) {
            for (const d of dashes) {
              const len = Math.abs(d);
              if (d >= 0) {
                const a = Math.max(pos, u0), b = Math.min(pos + (d === 0 ? patternLen * 0.002 : len), u1);
                if (b > a) emit(a, b);
              }
              pos += len;
              if (pos >= u1) break;
            }
          }
        }
        if (segments.length > MAX_PATTERN_SEGMENTS * 2) return segments;
      }
    }
  }
  return segments;
}
