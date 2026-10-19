// SPDX-License-Identifier: GPL-3.0-or-later
// Supports et accessoires dont les paramètres MEP (XDATA) n'ont pas pu être relus — LibreDWG décode mal les
// XDATA de certains objets des DWG réenregistrés par AutoCAD, alors qu'elles y sont intactes : on les reconstruit
// depuis le réseau sur lequel ils sont posés (système, section, altitude, type d'après le nom du bloc).
import * as G from '../core/geom.js';
import { planWidth, sectionLabel, zAt } from './systems.js';
import { SUPPORT_BLOCK, supportSpacing, supportType } from './supports.js';
import { ACCESSORIES } from './accessories.js';

export function repairMepInserts(entities, unitMm = 1) {
  const runs = entities.filter((e) => e.mep && e.type === 'LWPOLYLINE' && e.pts?.length >= 2);
  let repaired = 0;
  for (const e of entities) {
    if (e.type !== 'INSERT' || e.mep || !e.p) continue;
    const acc = /^CV_ACC_([A-Z]+)$/i.exec(e.name || '');
    if (e.name !== SUPPORT_BLOCK && !acc) continue;
    let best = null;
    for (const r of runs) {
      const tol = (r.mep.kind === 'pipe' ? r.mep.d || 0 : planWidth(r.mep)) / 2 + 1e-6;
      let s = 0;
      for (let k = 1; k < r.pts.length; k++) {
        const c = G.closestOnSegment(e.p, r.pts[k - 1], r.pts[k]);
        const L = G.dist(r.pts[k - 1], r.pts[k]);
        if (c.d <= tol && (!best || c.d < best.d)) best = { r, d: c.d, s: s + c.t * L };
        s += L;
      }
    }
    if (!best) continue;
    const m = best.r.mep;
    if (acc) {
      const type = acc[1].toLowerCase();
      if (!ACCESSORIES[type]) continue;
      e.mep = { kind: 'accessory', type, label: ACCESSORIES[type].label, system: m.system, section: sectionLabel(m), z: m.z || 0 };
    } else {
      const mm = { ...m, w: (m.w || 0) * unitMm, h: (m.h || 0) * unitMm, d: (m.d || 0) * unitMm };
      e.mep = { kind: 'support', system: m.system, type: supportType(m), section: sectionLabel(m), z: m.z1 != null ? zAt(best.r, best.s) : m.z || 0, spacing: supportSpacing(mm) };
    }
    repaired++;
  }
  return repaired;
}
