// SPDX-License-Identifier: GPL-3.0-or-later
// Export IFC4 (ReferenceView) des réseaux MEP et de l'électricité, pour la coordination BIM (Revit, Navisworks) :
// gaines (IfcDuctSegment / IfcDuctFitting), canalisations (IfcPipeSegment / IfcPipeFitting), chemins de câbles et
// tubes (IfcCableCarrierSegment / IfcCableCarrierFitting), bouches (IfcAirTerminal…), appareils électriques
// (IfcLightFixture, IfcOutlet, IfcSwitchingDevice, IfcElectricDistributionBoard, IfcElectricAppliance).
// Géométrie : extrusions de la section le long de chaque tronçon (coudes à rayon découpés en morceaux de 10°),
// boîtes pour les appareils. Systèmes (IfcDistributionSystem) et circuits (IfcDistributionCircuit) en groupes.
// Propriétés communes dans le jeu « CV_Parametres » (liste IFC_PROPERTIES, extensible). Coordonnées en mm.

import { pathOf, pointAt } from '../core/path.js';
import { filletedAxis, elbowRadius } from '../mep/geometry.js';
import { systemByCode, sectionLabel, planWidth, vertexZ, kindLabel } from '../mep/systems.js';
import { unitMmOf } from '../mep/network.js';
import { SYMBOLS } from '../elec/symbols.js';
import { computeInstallation, heightOf, circuitTypeOf } from '../elec/circuits.js';
import { elecData } from '../elec/settings.js';
import { CIRCUIT_TYPES } from '../elec/nibt.js';

// Propriétés exportées (jeu CV_Parametres) : nom, type IFC, valeur tirée des informations de l'objet.
// Pour en ajouter : une ligne ici, et la valeur correspondante dans infoOf().
export const IFC_PSET = 'CV_Parametres';
export const IFC_PROPERTIES = [
  { name: 'Système', type: 'IFCLABEL', key: 'system' },
  { name: 'Section', type: 'IFCLABEL', key: 'section' },
  { name: 'Numéro de circuit', type: 'IFCLABEL', key: 'circuit' },
  { name: 'Numéro de tableau', type: 'IFCLABEL', key: 'board' },
  { name: 'Puissance', type: 'IFCPOWERMEASURE', key: 'power' },          // W
  { name: 'Intensité', type: 'IFCELECTRICCURRENTMEASURE', key: 'current' }, // A
  { name: 'Tension', type: 'IFCELECTRICVOLTAGEMEASURE', key: 'voltage' },   // V
];

// Type de système IFC selon le code du système de l'appli.
const SYSTEM_TYPES = {
  SOUF: 'VENTILATION', REP: 'VENTILATION', AN: 'VENTILATION', EXT: 'EXHAUST', REJ: 'EXHAUST',
  'CH-D': 'HEATING', 'CH-R': 'HEATING', 'EG-D': 'CHILLEDWATER', 'EG-R': 'CHILLEDWATER',
  EF: 'DOMESTICCOLDWATER', ECS: 'DOMESTICHOTWATER', BECS: 'DOMESTICHOTWATER', EU: 'WASTEWATER', EV: 'SEWAGE',
  EP: 'RAINWATER', GAZ: 'GAS', SPR: 'FIREPROTECTION', CFO: 'ELECTRICAL', 'TUB-CFO': 'ELECTRICAL',
  CFA: 'COMMUNICATION', 'TUB-CFA': 'COMMUNICATION',
};

// --- STEP ------------------------------------------------------------------------------------------------
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

// GlobalId IFC (22 caractères) déterministe à partir d'un texte : mêmes identifiants d'un export à l'autre.
export function ifcGuid(text) {
  let n = 0n;
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    n = (n << 32n) | BigInt(h);
  }
  let s = '';
  for (let i = 0; i < 22; i++) { s = ALPHABET[Number(n & 63n)] + s; n >>= 6n; }
  return s;
}

// Texte STEP : apostrophes doublées, caractères non ASCII en \X2\…\X0\.
export function stepString(v) {
  if (v == null || v === '') return '$';
  let out = '';
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''");
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) < 128) { out += s[i++]; continue; }
    let hex = '';
    while (i < s.length && s.charCodeAt(i) >= 128) hex += s.charCodeAt(i++).toString(16).toUpperCase().padStart(4, '0');
    out += `\\X2\\${hex}\\X0\\`;
  }
  return `'${out}'`;
}

const real = (v) => {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0.';
  const s = (+v.toFixed(6)).toString();
  if (/e/i.test(s)) return v.toFixed(6);
  return s.includes('.') ? s : `${s}.`;
};

class Step {
  constructor() { this.lines = []; this.cache = new Map(); }
  add(s) { this.lines.push(s); return `#${this.lines.length}`; }
  once(key, s) { if (!this.cache.has(key)) this.cache.set(key, this.add(s)); return this.cache.get(key); }
  point(p) { return this.once(`P${p.map(real).join(',')}`, `IFCCARTESIANPOINT((${p.map(real).join(',')}))`); }
  dir(d) { return this.once(`D${d.map(real).join(',')}`, `IFCDIRECTION((${d.map(real).join(',')}))`); }
  text(header) {
    return `ISO-10303-21;\nHEADER;\n${header}\nENDSEC;\nDATA;\n${this.lines.map((l, i) => `#${i + 1}=${l};`).join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  }
}

const norm = (v) => { const l = Math.hypot(...v); return l > 1e-12 ? v.map((x) => x / l) : v; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// --- géométrie ----------------------------------------------------------------------------------------------
// Extrusion d'un profil (rectangle w × h décalé de dy vers le haut, ou cercle de rayon r) de A à B (mm), prolongée
// de e0 / e1 aux extrémités.
function sweep(S, A, B, prof, e0 = 0, e1 = 0) {
  const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const L = Math.hypot(...d);
  if (L < 1e-6) return null;
  const Z = d.map((x) => x / L);
  let X = norm([-Z[1], Z[0], 0]);
  if (Math.hypot(X[0], X[1]) < 1e-9) X = [1, 0, 0]; // tronçon vertical
  const start = A.map((v, i) => v - Z[i] * e0);
  const place = S.add(`IFCAXIS2PLACEMENT3D(${S.point(start)},${S.dir(Z)},${S.dir(X)})`);
  const p2 = S.once(`A2${prof.dy || 0}`, `IFCAXIS2PLACEMENT2D(${S.point([0, prof.dy || 0])},$)`);
  const profile = prof.r
    ? S.once(`C${prof.r}`, `IFCCIRCLEPROFILEDEF(.AREA.,$,${p2},${real(prof.r)})`)
    : S.once(`R${prof.w},${prof.h},${prof.dy || 0}`, `IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${real(prof.w)},${real(prof.h)})`);
  return S.add(`IFCEXTRUDEDAREASOLID(${profile},${place},${S.dir([0, 0, 1])},${real(L + e0 + e1)})`);
}

function boxSolid(S, c, sx, sy, sz, rot = 0) {
  const place = S.add(`IFCAXIS2PLACEMENT3D(${S.point(c)},${S.dir([0, 0, 1])},${S.dir([Math.cos(rot), Math.sin(rot), 0])})`);
  const p2 = S.once('A20', `IFCAXIS2PLACEMENT2D(${S.point([0, 0])},$)`);
  const profile = S.once(`R${sx},${sy},c`, `IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${real(sx)},${real(sy)})`);
  return S.add(`IFCEXTRUDEDAREASOLID(${profile},${place},${S.dir([0, 0, 1])},${real(sz)})`);
}

// Morceaux d'un réseau : [{ a, b (mm, 3D), curve (indice de la courbe de l'axe), arc, corner (sommet vif à la fin) }].
function runPieces(e, k) {
  const m = e.mep;
  const vz = vertexZ(e);
  const flat = vz.every((z) => Math.abs(z - vz[0]) < 1e-9);
  const R = elbowRadius(e); // canalisation : 0 ; tube souple : courbes
  const out = [];
  if (flat && R > 0 && e.pts.length > 2) {
    const axis = filletedAxis(e, R);
    const corners = new Set(axis.corners || []);
    pathOf(axis).curves.forEach((c, ci) => {
      const n = c.k === 'arc' ? Math.max(1, Math.ceil(Math.abs(c.sw) / (Math.PI / 18))) : 1;
      for (let j = 0; j < n; j++) {
        const a = pointAt(c, j / n), b = pointAt(c, (j + 1) / n);
        out.push({ a: [a[0] * k, a[1] * k, vz[0] * k], b: [b[0] * k, b[1] * k, vz[0] * k], curve: ci, arc: c.k === 'arc', corner: j === n - 1 && corners.has(ci + 1) });
      }
    });
  } else {
    for (let i = 1; i < e.pts.length; i++) {
      out.push({ a: [e.pts[i - 1][0] * k, e.pts[i - 1][1] * k, vz[i - 1] * k], b: [e.pts[i][0] * k, e.pts[i][1] * k, vz[i] * k], curve: i - 1, arc: false, corner: i < e.pts.length - 1 });
    }
  }
  return out;
}

// --- export -------------------------------------------------------------------------------------------------
// doc → texte IFC. opts : { fileName, project, now (Date) }.
export function writeIfc(doc, opts = {}) {
  const S = new Step();
  const k = unitMmOf(doc); // mm par unité du dessin
  const name = opts.project || (opts.fileName || doc.fileName || 'Projet').replace(/\.[^.]+$/, '');
  const key = (s) => ifcGuid(`${name}|${s}`);
  const now = opts.now || new Date();
  // Contexte, unités, structure spatiale.
  const origin = S.add(`IFCAXIS2PLACEMENT3D(${S.point([0, 0, 0])},${S.dir([0, 0, 1])},${S.dir([1, 0, 0])})`);
  const ctx = S.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${origin},$)`);
  const body = S.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = [
    "IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)", "IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)", "IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)",
    "IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)", "IFCSIUNIT(*,.POWERUNIT.,$,.WATT.)", "IFCSIUNIT(*,.ELECTRICCURRENTUNIT.,$,.AMPERE.)",
    "IFCSIUNIT(*,.ELECTRICVOLTAGEUNIT.,$,.VOLT.)",
  ].map((u) => S.add(u));
  const unitAssign = S.add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const project = S.add(`IFCPROJECT('${key('projet')}',$,${stepString(name)},$,$,$,$,(${ctx}),${unitAssign})`);
  const lpSite = S.add(`IFCLOCALPLACEMENT($,${origin})`);
  const site = S.add(`IFCSITE('${key('site')}',$,'Site',$,$,${lpSite},$,$,.ELEMENT.,$,$,$,$,$)`);
  const lpBuilding = S.add(`IFCLOCALPLACEMENT(${lpSite},${origin})`);
  const building = S.add(`IFCBUILDING('${key('batiment')}',$,${stepString('Bâtiment')},$,$,${lpBuilding},$,$,.ELEMENT.,$,$,$)`);
  const lpStorey = S.add(`IFCLOCALPLACEMENT(${lpBuilding},${origin})`);
  const storey = S.add(`IFCBUILDINGSTOREY('${key('niveau')}',$,'Niveau',$,$,${lpStorey},$,$,.ELEMENT.,0.)`);
  S.add(`IFCRELAGGREGATES('${key('agg1')}',$,$,$,${project},(${site}))`);
  S.add(`IFCRELAGGREGATES('${key('agg2')}',$,$,$,${site},(${building}))`);
  S.add(`IFCRELAGGREGATES('${key('agg3')}',$,$,$,${building},(${storey}))`);
  const elementPlacement = S.add(`IFCLOCALPLACEMENT(${lpStorey},${origin})`);

  const elements = [];
  const systems = new Map(); // code → [ids]
  const circuits = new Map(); // « TP.L1 » → { ids, label }
  const psets = []; // [élément, infos]
  const counts = {};
  const guids = new Map(); // id de l'objet du dessin → GlobalId des éléments IFC (pour les points de vue BCF)
  const note = (ref, g) => { const id = Number(String(ref).split(':')[0]); if (!guids.has(id)) guids.set(id, []); guids.get(id).push(g); };
  const product = (cls, label, solids, pre, info, ref) => {
    note(ref, key(ref));
    const rep = solids.length ? S.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${S.add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solids.join(',')}))`)}))`) : '$';
    const id = S.add(`${cls}('${key(ref)}',$,${stepString(label)},$,${stepString(info.type)},${elementPlacement},${rep},${stepString(info.tag)},.${pre}.)`);
    elements.push(id);
    counts[cls] = (counts[cls] || 0) + 1;
    psets.push([id, info]);
    return id;
  };
  const group = (map, k2, id) => { if (!map.has(k2)) map.set(k2, []); map.get(k2).push(id); };

  // Électricité : circuits dimensionnés (intensité, tension) et cheminement (circuits passant dans chaque chemin).
  const data = elecData(doc);
  const inst = computeInstallation(doc, { unitM: k / 1000, data });
  const circuitOf = new Map(), trayCircuits = new Map();
  for (const [bname, info] of inst) {
    for (const c of info.circuits) {
      for (const d of c.devices) circuitOf.set(d.id, { board: bname, c });
      for (const id of c.route?.trays?.keys() || []) {
        if (!trayCircuits.has(id)) trayCircuits.set(id, []);
        trayCircuits.get(id).push(`${bname}.${c.def.id}`);
      }
    }
  }

  const model = [...doc.entities.values()].filter((e) => (e.space || 'model') === 'model');
  for (const e of model) {
    const m = e.mep;
    if (m && e.type === 'LWPOLYLINE' && e.pts.length >= 2 && ['duct', 'pipe', 'tray'].includes(m.kind)) {
      const round = m.kind === 'pipe' || m.shape === 'round';
      const w = (round ? m.d : planWidth(m)) * k, h = (round ? m.d : m.h || (m.kind === 'tray' ? 60 / k : planWidth(m))) * k;
      const prof = round ? { r: w / 2 } : { w, h, dy: m.kind === 'tray' ? h / 2 : 0 };
      const [segCls, fitCls, segType, fitType] = m.kind === 'duct' ? ['IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'RIGIDSEGMENT', 'BEND']
        : m.kind === 'tray' ? ['IFCCABLECARRIERSEGMENT', 'IFCCABLECARRIERFITTING', 'CABLETRAYSEGMENT', 'BEND']
          : m.conduit ? ['IFCCABLECARRIERSEGMENT', 'IFCCABLECARRIERFITTING', 'CONDUITSEGMENT', 'BEND'] : ['IFCPIPESEGMENT', 'IFCPIPEFITTING', 'RIGIDSEGMENT', 'BEND'];
      const info = { system: m.system, section: sectionLabel(m), type: kindLabel(m), tag: String(e.id), circuit: trayCircuits.get(e.id)?.join(', ') };
      const pieces = runPieces(e, k);
      // Prolongement aux jonctions (demi-largeur × tan(déviation / 2), au plus la demi-largeur).
      const ext = pieces.map((p, i) => {
        const q = pieces[i + 1];
        if (!q) return 0;
        const u = norm([p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]]), v = norm([q.b[0] - q.a[0], q.b[1] - q.a[1], q.b[2] - q.a[2]]);
        const ang = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
        return Math.min(1, Math.tan(ang / 2)) * w / 2;
      });
      let i = 0, n = 0;
      while (i < pieces.length) {
        const cur = pieces[i];
        const solids = [];
        let j = i;
        // Tube souple : un seul segment, courbes comprises (il se cintre, pas de pièce de coude).
        while (j < pieces.length && (m.conduit || pieces[j].curve === cur.curve)) {
          const s = sweep(S, pieces[j].a, pieces[j].b, prof, j > 0 ? ext[j - 1] : 0, ext[j]);
          if (s) solids.push(s);
          j++;
        }
        n++;
        const label = `${sectionLabel(m)} ${m.system}`;
        const fitting = cur.arc && !m.conduit;
        product(fitting ? fitCls : segCls, label, solids, fitting ? fitType : segType, info, `${e.id}:${n}`);
        group(systems, m.system, elements[elements.length - 1]);
        // Coude à onglet (angle vif) : pièce de forme sans géométrie propre (les tronçons se rejoignent).
        if (pieces[j - 1].corner && !m.conduit) { n++; product(fitCls, `Coude ${label}`, [], fitType, info, `${e.id}:${n}`); group(systems, m.system, elements[elements.length - 1]); }
        i = j;
      }
      continue;
    }
    if (m?.kind === 'terminal' && e.type === 'INSERT') {
      const w = (m.w || m.d || 300) * k, d = (m.h || m.d || 300) * k;
      const s = boxSolid(S, [e.p[0] * k, e.p[1] * k, (m.z || 0) * k], w, d, 60, e.rot || 0);
      const cls = m.water || m.hydro ? 'IFCFLOWTERMINAL' : 'IFCAIRTERMINAL';
      const info = { system: m.system, section: m.d ? `Ø${m.d}` : `${m.w}×${m.h}`, type: m.terminal || 'Terminal', tag: String(e.id) };
      if (cls === 'IFCFLOWTERMINAL') {
        note(e.id, key(e.id));
        const id = S.add(`IFCFLOWTERMINAL('${key(e.id)}',$,${stepString(info.type)},$,$,${elementPlacement},${S.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${S.add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${s}))`)}))`)},${stepString(info.tag)})`);
        elements.push(id); psets.push([id, info]); counts.IFCFLOWTERMINAL = (counts.IFCFLOWTERMINAL || 0) + 1;
      } else product(cls, info.type, [s], 'DIFFUSER', info, e.id);
      group(systems, m.system, elements[elements.length - 1]);
      continue;
    }
    if (e.type === 'INSERT' && e.elec && SYMBOLS[e.elec.sym]) {
      const sym = SYMBOLS[e.elec.sym];
      const board = e.elec.kind === 'board';
      const z = heightOf(e, data) * 1000;
      const ref = circuitOf.get(e.id);
      const r = ref?.c.r;
      const ph = e.elec.ph === 3 || r?.ph === 3 ? 3 : 1;
      const p = e.elec.p || 0;
      const cos = r?.cosphi ?? CIRCUIT_TYPES[circuitTypeOf(e)]?.cosphi ?? 1;
      const info = {
        type: e.elec.label || sym.label || e.elec.sym, tag: String(e.id), system: board ? 'Tableau' : CIRCUIT_TYPES[circuitTypeOf(e)]?.label,
        circuit: board ? undefined : e.elec.circuit, board: board ? e.elec.board : e.elec.board || undefined,
        power: board ? inst.get(e.elec.board)?.p : p || undefined,
        current: board ? inst.get(e.elec.board)?.supply?.ib : p ? (ph === 3 ? p / (Math.sqrt(3) * data.network.un * cos) : p / (data.network.u0 * cos)) : undefined,
        voltage: board || ph === 3 ? data.network.un : circuitTypeOf(e) ? data.network.u0 : undefined,
      };
      const [cls, pre] = board ? ['IFCELECTRICDISTRIBUTIONBOARD', 'DISTRIBUTIONBOARD']
        : sym.cat === 'LUMIERE' || sym.cat === 'ECL_SEC' ? ['IFCLIGHTFIXTURE', sym.cat === 'ECL_SEC' ? 'SECURITYLIGHTING' : 'POINTSOURCE']
          : sym.cat === 'COMMANDE' ? ['IFCSWITCHINGDEVICE', 'TOGGLESWITCH']
            : sym.cat === 'FORCE' && sym.outlets ? ['IFCOUTLET', 'POWEROUTLET']
              : sym.cat === 'TT_INFO' ? ['IFCOUTLET', 'DATAOUTLET']
                : ['IFCELECTRICAPPLIANCE', 'NOTDEFINED'];
      const solid = board ? boxSolid(S, [e.p[0] * k, e.p[1] * k, z - 1200], 600, 250, 1200, e.rot || 0)
        : boxSolid(S, [e.p[0] * k, e.p[1] * k, z - 50], 200, 200, 100, e.rot || 0);
      const id = product(cls, `${info.type}${info.circuit ? ` ${info.board}.${info.circuit}` : board ? ` ${e.elec.board}` : ''}`, [solid], pre, info, e.id);
      if (!board && e.elec.board && e.elec.circuit) {
        const ck = `${e.elec.board}.${e.elec.circuit}`;
        if (!circuits.has(ck)) circuits.set(ck, { ids: [], label: ref?.c.def.label || CIRCUIT_TYPES[ref?.c.def.type]?.label || '' });
        circuits.get(ck).ids.push(id);
      }
    }
  }
  if (elements.length) S.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${key('contenu')}',$,$,$,(${elements.join(',')}),${storey})`);
  // Systèmes et circuits.
  for (const [code, ids] of systems) {
    const sys = systemByCode(code);
    const g = S.add(`IFCDISTRIBUTIONSYSTEM('${key(`sys:${code}`)}',$,${stepString(sys?.label || code)},$,${stepString(code)},$,.${SYSTEM_TYPES[code] || 'NOTDEFINED'}.)`);
    S.add(`IFCRELASSIGNSTOGROUP('${key(`grp:${code}`)}',$,$,$,(${ids.join(',')}),$,${g})`);
  }
  for (const [ck, c] of circuits) {
    const g = S.add(`IFCDISTRIBUTIONCIRCUIT('${key(`cir:${ck}`)}',$,${stepString(ck)},$,${stepString(c.label)},$,.ELECTRICAL.)`);
    S.add(`IFCRELASSIGNSTOGROUP('${key(`grpc:${ck}`)}',$,$,$,(${c.ids.join(',')}),$,${g})`);
  }
  // Jeu de propriétés CV_Parametres de chaque élément.
  psets.forEach(([id, info], i) => {
    const props = IFC_PROPERTIES.filter((p) => info[p.key] != null && info[p.key] !== '').map((p) => {
      const v = info[p.key];
      const val = p.type === 'IFCLABEL' ? `IFCLABEL(${stepString(v)})` : `${p.type}(${real(+v)})`;
      return S.add(`IFCPROPERTYSINGLEVALUE(${stepString(p.name)},$,${val},$)`);
    });
    if (!props.length) return;
    const ps = S.add(`IFCPROPERTYSET('${key(`pset:${i}`)}',$,'${IFC_PSET}',$,(${props.join(',')}))`);
    S.add(`IFCRELDEFINESBYPROPERTIES('${key(`rdp:${i}`)}',$,$,$,(${id}),${ps})`);
  });
  const header = [
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${stepString(`${name}.ifc`)},'${now.toISOString().slice(0, 19)}',(''),(''),'CAD Viewer','CAD Viewer','');`,
    "FILE_SCHEMA(('IFC4'));",
  ].join('\n');
  return { text: S.text(header), counts, elements: elements.length, guids, project: name, projectGuid: key('projet') };
}
