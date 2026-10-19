// SPDX-License-Identifier: GPL-3.0-or-later
// Tessellation des courbes DWG en polylignes, et repère OCS.
// Tous les points sont des tableaux [x, y, z]. Les angles sont en radians.

const TAU = Math.PI * 2;

function segmentsFor(sweep, base = 96) {
  return Math.max(4, Math.min(512, Math.ceil((Math.abs(sweep) / TAU) * base)));
}

// Algorithme de l'axe arbitraire (Arbitrary Axis Algorithm) : renvoie les axes
// X, Y, Z du repère objet (OCS) défini par la direction d'extrusion.
export function ocsAxes(extrusion) {
  if (!extrusion) return null;
  let { x: nx, y: ny, z: nz } = extrusion;
  const len = Math.hypot(nx, ny, nz);
  if (!len) return null;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null; // identité
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    ax = nz; ay = 0; az = -nx; // Wy × N
  } else {
    ax = -ny; ay = nx; az = 0; // Wz × N
  }
  const al = Math.hypot(ax, ay, az);
  ax /= al; ay /= al; az /= al;
  const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
  return [ax, ay, az, bx, by, bz, nx, ny, nz];
}

export function arcPoints(cx, cy, r, start, end, z = 0) {
  while (end <= start) end += TAU;
  const sweep = end - start;
  const n = segmentsFor(sweep);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return pts;
}

export function circlePoints(cx, cy, r, z = 0) {
  const n = 128;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (TAU * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return pts;
}

// Arc défini par un « bulge » entre deux sommets de polyligne (bulge = tan(angle/4)).
export function bulgePoints(x1, y1, x2, y2, bulge, z = 0) {
  if (!bulge || Math.abs(bulge) < 1e-10) return [[x2, y2, z]];
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [[x2, y2, z]];
  const sweep = 4 * Math.atan(bulge);
  const k = (1 - bulge * bulge) / (4 * bulge);
  const cx = (x1 + x2) / 2 - dy * k;
  const cy = (y1 + y2) / 2 + dx * k;
  const r = Math.hypot(x1 - cx, y1 - cy);
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = segmentsFor(sweep);
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  pts[pts.length - 1] = [x2, y2, z];
  return pts;
}

// Sommets {x, y, bulge} → points ; fermeture optionnelle.
export function bulgePolyline(vertices, closed, z = 0) {
  if (!vertices.length) return [];
  const pts = [[vertices[0].x, vertices[0].y, z]];
  const count = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < count; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    pts.push(...bulgePoints(a.x, a.y, b.x, b.y, a.bulge || 0, z));
  }
  return pts;
}

// Ellipse : centre, extrémité du grand axe (vecteur relatif), rapport des axes,
// paramètres de début et de fin.
export function ellipsePoints(center, major, ratio, start, end, normal) {
  let s = start ?? 0, e = end ?? TAU;
  while (e <= s) e += TAU;
  const n = normal && Math.hypot(normal.x, normal.y, normal.z) > 0 ? normal : { x: 0, y: 0, z: 1 };
  const minor = [
    (n.y * major.z - n.z * major.y) * ratio,
    (n.z * major.x - n.x * major.z) * ratio,
    (n.x * major.y - n.y * major.x) * ratio,
  ];
  const sweep = e - s;
  const count = segmentsFor(sweep, 128);
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = s + (sweep * i) / count;
    const c = Math.cos(t), si = Math.sin(t);
    pts.push([
      center.x + c * major.x + si * minor[0],
      center.y + c * major.y + si * minor[1],
      (center.z || 0) + c * major.z + si * minor[2],
    ]);
  }
  return pts;
}

// B-spline (éventuellement rationnelle) évaluée par l'algorithme de de Boor.
// Spline cubique passant par les points de lissage (interpolation globale, paramétrage par la
// longueur des cordes : algorithme A9.1 du « NURBS Book »). Renvoie { degree, knots, ctrl } ou null.
export function interpolateFit(fit, degree = 3) {
  const pts = fit.filter((q, i) => i === 0 || Math.hypot(q.x - fit[i - 1].x, q.y - fit[i - 1].y, (q.z || 0) - (fit[i - 1].z || 0)) > 1e-12);
  const n = pts.length - 1;
  if (n < 2 || n > 400) return null;
  const p = Math.min(degree, n);
  const chords = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y, (q.z || 0) - (pts[i].z || 0)));
  const total = chords.reduce((a, b) => a + b, 0);
  const u = [0];
  for (let k = 1; k < n; k++) u.push(u[k - 1] + chords[k - 1] / total);
  u.push(1);
  const U = new Array(n + p + 2).fill(0);
  for (let j = n + 1; j < n + p + 2; j++) U[j] = 1;
  for (let j = 1; j <= n - p; j++) {
    let sum = 0;
    for (let i = j; i < j + p; i++) sum += u[i];
    U[j + p] = sum / p;
  }
  // Matrice des fonctions de base N[k][i] = N_i,p(u_k), puis élimination de Gauss.
  const basis = (i, t) => {
    // Cox–de Boor, avec t = 1 rattaché au dernier intervalle.
    const N = new Array(p + 1).fill(0);
    let span = p;
    if (t >= U[n + 1]) span = n;
    else while (span < n && t >= U[span + 1]) span++;
    N[0] = 1;
    const left = [], right = [];
    for (let j = 1; j <= p; j++) {
      left[j] = t - U[span + 1 - j];
      right[j] = U[span + j] - t;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const tmp = N[r] / (right[r + 1] + left[j - r]);
        N[r] = saved + right[r + 1] * tmp;
        saved = left[j - r] * tmp;
      }
      N[j] = saved;
    }
    const k = i - (span - p);
    return k >= 0 && k <= p ? N[k] : 0;
  };
  const A = [];
  for (let k = 0; k <= n; k++) {
    const row = new Array(n + 1);
    for (let i = 0; i <= n; i++) row[i] = basis(i, u[k]);
    A.push(row);
  }
  const B = pts.map((q) => [q.x, q.y, q.z || 0]);
  for (let c = 0; c <= n; c++) {
    let piv = c;
    for (let r = c + 1; r <= n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-14) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    for (let r = 0; r <= n; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let i = c; i <= n; i++) A[r][i] -= f * A[c][i];
      for (let m = 0; m < 3; m++) B[r][m] -= f * B[c][m];
    }
  }
  const ctrl = B.map((b, i) => ({ x: b[0] / A[i][i], y: b[1] / A[i][i], z: b[2] / A[i][i] }));
  return { degree: p, knots: U, ctrl };
}

export function splinePoints(degree, knots, ctrl, weights, fitPoints) {
  const n = ctrl ? ctrl.length : 0;
  if (n < 2 || !knots || knots.length < n + degree + 1) {
    const fit = fitPoints || [];
    const sp = fit.length >= 3 ? interpolateFit(fit, degree || 3) : null;
    if (sp) return splinePoints(sp.degree, sp.knots, sp.ctrl, null, null);
    return fit.map((p) => [p.x, p.y, p.z || 0]);
  }
  const p = Math.max(1, degree);
  const w = weights && weights.length === n ? weights : null;
  const t0 = knots[p], t1 = knots[n];
  const samples = Math.min(2000, Math.max(32, n * 12));
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j];
      const wt = w ? w[k - p + j] : 1;
      d.push([c.x * wt, c.y * wt, (c.z || 0) * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const idx = k - p + j;
        const denom = knots[idx + p - r + 1] - knots[idx];
        const alpha = denom === 0 ? 0 : (t - knots[idx]) / denom;
        for (let m = 0; m < 4; m++) d[j][m] = (1 - alpha) * d[j - 1][m] + alpha * d[j][m];
      }
    }
    const q = d[p];
    pts.push([q[0] / q[3], q[1] / q[3], q[2] / q[3]]);
  }
  return pts;
}
