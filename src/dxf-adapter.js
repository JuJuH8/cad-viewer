// SPDX-License-Identifier: GPL-3.0-or-later
// Adaptateur : sortie de @mlightcad/dxf-json → même structure que le DwgDatabase
// de LibreDWG, pour que le reste de l'application ignore le format d'origine.
// Principales différences : en DXF les angles sont en degrés, quelques champs
// portent un autre nom, et les blocs sont listés à part.

import { scanDimAssoc } from './core/dimassoc.js';
import { scanLayerStates } from './core/layerstates.js';
import { scanFields } from './core/fields.js';
import { scanAcadDynamic } from './blocks/acad-dynamic.js';

const RAD = Math.PI / 180;
const rad = (deg) => (deg || 0) * RAD;

function edge(e) {
  if (e.type === 2 || e.type === 3) return { ...e, startAngle: rad(e.startAngle), endAngle: rad(e.endAngle) };
  return e;
}

function entity(e) {
  const out = { ...e };
  if (typeof out.color !== 'number') delete out.color;
  switch (e.type) {
    case 'ARC':
      out.startAngle = rad(e.startAngle);
      out.endAngle = rad(e.endAngle);
      break;
    case 'INSERT':
      out.rotation = rad(e.rotation);
      break;
    case 'TEXT':
      out.rotation = rad(e.rotation);
      if (e.obliqueAngle) out.obliqueAngle = rad(e.obliqueAngle);
      break;
    case 'MTEXT':
      out.rotation = rad(e.rotation);
      out.textHeight = e.height;
      out.rectWidth = e.width;
      break;
    case 'ATTDEF': // mêmes champs que TEXT chez dxf-json, plus le drapeau (1 = invisible)
      out.rotation = rad(e.rotation);
      if (e.obliqueAngle) out.obliqueAngle = rad(e.obliqueAngle);
      out.flags = e.attributeFlag || 0;
      break;
    case 'ATTRIB':
      out.flags = e.attributeFlag || 0;
      out.text = {
        text: e.text, startPoint: e.startPoint, endPoint: e.alignmentPoint, textHeight: e.textHeight,
        rotation: rad(e.rotation), xScale: e.scale || 1, halign: e.horizontalJustification || 0,
        valign: e.verticalJustification || 0, extrusionDirection: e.extrusionDirection,
      };
      break;
    case 'LWPOLYLINE':
      out.flag = (e.flag & 1) ? 512 : 0; // DXF : bit 1 = fermée ; LibreDWG : bit 512
      break;
    case 'POLYLINE':
      if (e.flag & (16 | 64)) out.type = 'POLYFACE_MESH'; // maillages : non gérés
      else out.type = (e.flag & 8) ? 'POLYLINE3D' : 'POLYLINE2D';
      break;
    case 'SOLID': {
      const p = e.points || [];
      Object.assign(out, { corner1: p[0], corner2: p[1], corner3: p[2], corner4: p[3] });
      break;
    }
    case 'DIMENSION':
      out.rotationAngle = rad(e.rotationAngle);
      break;
    case 'VIEWPORT':
      out.viewTwistAngle = rad(e.viewTwistAngle);
      break;
    case 'HATCH':
      out.boundaryPaths = (e.boundaryPaths || []).map((p) => (p.edges ? { ...p, edges: p.edges.map(edge) } : p));
      out.definitionLines = (e.definitionLines || []).map((d) => ({ ...d, angle: rad(d.angle) }));
      out.patternAngle = rad(e.patternAngle);
      break;
  }
  return out;
}

// En DXF, les attributs (ATTRIB) suivent leur insertion (INSERT) dans la liste des entités :
// on les rattache à l'insertion, comme le fait LibreDWG pour les DWG.
function attachAttribs(list) {
  const out = [];
  let insert = null;
  for (const e of list) {
    if (e.type === 'ATTRIB' && insert) { insert.attribs.push(e); continue; }
    if (e.type === 'SEQEND') { insert = null; continue; }
    if (e.type === 'INSERT') { e.attribs = e.attribs || []; insert = e; } else insert = null;
    out.push(e);
  }
  return out;
}

// dxf-json perd la hauteur du texte des MULTILEADER (code 41 du bloc CONTEXT_DATA) : on la relit dans le
// texte du fichier, seulement s'il y en a besoin. Renvoie poignée → hauteur.
export function mleaderTextHeights(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let handle = null, inMl = false, inCtx = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1].trim();
    if (code === '0') { inMl = value === 'MULTILEADER'; inCtx = false; handle = null; continue; }
    if (!inMl) continue;
    if (code === '5' && handle == null) handle = value;
    else if (code === '300' && value === 'CONTEXT_DATA{') inCtx = true;
    else if (code === '301' && value === '}') inCtx = false;
    else if (inCtx && code === '41' && handle != null && !out.has(handle)) out.set(handle, parseFloat(value));
  }
  return out;
}

// Objets invisibles (code 60 = 1, p. ex. objets cachés par l'état de visibilité dans les blocs anonymes des blocs
// dynamiques d'AutoCAD), que dxf-json ne signale pas : poignées.
export function scanInvisible(text) {
  const out = new Set();
  if (!/\n\s*60\r?\n\s*1\r?\n/.test(text)) return out;
  const lines = text.split(/\r?\n/);
  let handle = null, section = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (code === '0') { handle = null; continue; }
    if (code === '2' && lines[i - 1]?.trim() === 'SECTION') { section = lines[i + 1].trim(); continue; }
    if (section !== 'ENTITIES' && section !== 'BLOCKS') continue;
    if (code === '5' && !handle) handle = lines[i + 1].trim().toUpperCase();
    else if (code === '60' && lines[i + 1].trim() === '1' && handle) out.add(handle);
  }
  return out;
}

// Fonds joints que dxf-json ne lit pas : références PDF (PDFUNDERLAY), définitions PDF (PDFDEFINITION) et
// d'images (IMAGEDEF, pour leur chemin). Lus dans le texte du fichier.
export function scanUnderlays(text) {
  const lines = text.split(/\r?\n/);
  const underlays = [], pdfDefs = [], imageDefs = [], filters = [], wipeouts = [], sortents = [], dictVars = [];
  let cur = null, kind = null, section = null;
  const close = () => {
    if (kind === 'WIPEOUT') wipeouts.push(cur);
    else if (kind === 'SORTENTSTABLE') sortents.push({ owner: cur.owner, pairs: cur.ents.map((h, i) => [h, cur.sorts[i]]).filter((p) => p[1]) });
    else if (kind === 'DICTIONARYVAR') dictVars.push(cur);
    else if (kind === 'PDFUNDERLAY') underlays.push(cur);
    else if (kind === 'PDFDEFINITION') pdfDefs.push(cur);
    else if (kind === 'IMAGEDEF') imageDefs.push(cur);
    else if (kind === 'SPATIAL_FILTER') filters.push({ handle: cur.handle, vertices: cur.vertices, invertBlockMatrix: cur.m.slice(0, 12), matrix: cur.m.slice(12, 24) });
    cur = null; kind = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10), value = lines[i + 1].replace(/\s+$/, '');
    if (code === 0) {
      if (cur) close();
      if (value === 'PDFUNDERLAY') { kind = value; cur = { type: 'PDFUNDERLAY', position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, flags: 11, contrast: 100, fade: 0, clip: [], xdata: [], section }; }
      else if (value === 'PDFDEFINITION' || value === 'IMAGEDEF') { kind = value; cur = { handle: null, path: '', page: '1' }; }
      else if (value === 'SPATIAL_FILTER') { kind = value; cur = { handle: null, vertices: [], m: [] }; }
      else if (value === 'WIPEOUT') { kind = value; cur = { handle: null, path: [], type: 2 }; }
      else if (value === 'SORTENTSTABLE') { kind = value; cur = { owner: null, ents: [], sorts: [], body: false }; }
      else if (value === 'DICTIONARYVAR') { kind = value; cur = { handle: null, value: null }; }
      continue;
    }
    if (code === 2 && lines[i - 2]?.trim() === '0' && lines[i - 1]?.trim() === 'SECTION') section = value.trim();
    if (!cur) continue;
    const v = value.trim(), n = parseFloat(v);
    // Masque : contour (14 / 24, coordonnées du pixel) que dxf-json ne lit pas.
    if (kind === 'WIPEOUT') {
      if (code === 5) cur.handle = v.toUpperCase();
      else if (code === 71) cur.type = parseInt(v, 10);
      else if (code === 14) cur.path.push({ x: n, y: 0 });
      else if (code === 24 && cur.path.length) cur.path[cur.path.length - 1].y = n;
      continue;
    }
    // Table de tri (ordre de tracé) : 330 enregistrement de bloc, puis paires 331 objet / 5 poignée de tri.
    if (kind === 'SORTENTSTABLE') {
      if (code === 100) cur.body = true;
      else if (cur.body && code === 330 && !cur.owner) cur.owner = v.toUpperCase();
      else if (cur.body && code === 331) cur.ents.push(v.toUpperCase());
      else if (cur.body && code === 5) cur.sorts[cur.ents.length - 1] = v.toUpperCase();
      continue;
    }
    if (kind === 'DICTIONARYVAR') {
      if (code === 5) cur.handle = v.toUpperCase();
      else if (code === 1) cur.value = v;
      continue;
    }
    if (kind === 'SPATIAL_FILTER') {
      if (code === 5) cur.handle = v;
      else if (code === 10) cur.vertices.push({ x: n, y: 0 });
      else if (code === 20 && cur.vertices.length) cur.vertices[cur.vertices.length - 1].y = n;
      else if (code === 40) cur.m.push(n);
      continue;
    }
    if (kind === 'PDFUNDERLAY') {
      if (code === 1001) { cur.xdata.push({ appName: v, value: [] }); continue; }
      if (cur.xdata.length) { if (code === 1000) cur.xdata[cur.xdata.length - 1].value.push(value.trim()); continue; }
      switch (code) {
        case 5: cur.handle = v; break;
        case 330: if (!cur.owner) cur.owner = v; break;
        case 8: cur.layer = v; break;
        case 62: cur.colorIndex = parseInt(v, 10); break;
        case 67: cur.isInPaperSpace = v === '1'; break;
        case 340: cur.defHandle = v; break;
        case 10: cur.position.x = n; break;
        case 20: cur.position.y = n; break;
        case 30: cur.position.z = n; break;
        case 41: cur.scale.x = n; break;
        case 42: cur.scale.y = n; break;
        case 43: cur.scale.z = n; break;
        case 50: cur.rotation = (n * Math.PI) / 180; break;
        case 280: cur.flags = parseInt(v, 10); break;
        case 281: cur.contrast = n; break;
        case 282: cur.fade = n; break;
        case 11: cur.clip.push([n, 0]); break;
        case 21: if (cur.clip.length) cur.clip[cur.clip.length - 1][1] = n; break;
      }
    } else {
      if (code === 5) cur.handle = v;
      else if (code === 1) cur.path = value.trim();
      else if (code === 2) cur.page = v;
      else if (code === 10) cur.w = n;
      else if (code === 20) cur.h = n;
      else if (code === 11) cur.pixel = n;
      else if (code === 281) cur.units = parseInt(v, 10);
    }
  }
  if (cur) close();
  // Cadres des masques : variable WIPEOUTFRAME du dictionnaire des variables.
  const m = /\n\s*3\r?\nWIPEOUTFRAME\r?\n\s*350\r?\n\s*([0-9A-Fa-f]+)/.exec(text);
  const fv = m && dictVars.find((d) => d.handle === m[1].toUpperCase());
  const wipeoutFrame = fv && Number.isFinite(parseInt(fv.value, 10)) ? parseInt(fv.value, 10) : undefined;
  return { underlays, pdfDefs, imageDefs, filters, wipeouts, sortents, wipeoutFrame };
}

export function dxfToDatabase(dxf, readText = null) {
  // Texte brut du fichier, décodé une seule fois et seulement s'il sert.
  let rawText = null;
  const getText = readText && (() => (rawText ??= readText()));
  const lost = [...(dxf.entities || []), ...Object.values(dxf.blocks || {}).flatMap((b) => b.entities || [])]
    .filter((e) => e.type === 'MULTILEADER' && !(e.textHeight > 0) && e.textContent);
  if (lost.length && getText) {
    const heights = mleaderTextHeights(getText());
    for (const e of lost) if (heights.get(e.handle) > 0) e.textHeight = heights.get(e.handle);
  }
  const all = attachAttribs((dxf.entities || []).map(entity));
  const blocks = Object.values(dxf.blocks || {}).map((b) => ({
    name: b.name,
    handle: b.handle,
    brHandle: b.ownerHandle, // enregistrement de bloc (relie une présentation à son bloc)
    basePoint: b.position || { x: 0, y: 0, z: 0 },
    flags: b.type || 0,
    entities: attachAttribs((b.entities || []).map(entity)),
  }));
  // Entités de la présentation active : dans la section ENTITIES, marquées « espace papier ».
  const paper = all.filter((e) => e.isInPaperSpace);
  const ps = blocks.find((b) => /^\*paper_space$/i.test(b.name));
  if (paper.length) {
    if (ps) ps.entities = [...ps.entities, ...paper];
    else blocks.push({ name: '*Paper_Space', handle: 'paper', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: paper });
  }
  // Fonds PDF (et chemins des images) et états de calques : relus dans le texte du fichier.
  let extra = { underlays: [], pdfDefs: [], imageDefs: [], filters: [], wipeouts: [], sortents: [] };
  let layerStates = [];
  let acadDyn = null;
  let dimAssoc = null;
  let plotStyleNames = null;
  if (getText) {
    const text = getText();
    if (/\nPDFUNDERLAY\s*\n|\nIMAGEDEF\s*\n|\nSPATIAL_FILTER\s*\n|\nWIPEOUT\s*\n|\nSORTENTSTABLE\s*\n|\nWIPEOUTFRAME\s*\n/.test(text)) extra = scanUnderlays(text);
    layerStates = scanLayerStates(text);
    acadDyn = scanAcadDynamic(text); // blocs dynamiques d'AutoCAD (visibilité, nom effectif)
    dimAssoc = scanDimAssoc(text); // cotes associatives (objets DIMASSOC)
    plotStyleNames = scanPlotStyleNames(text); // styles de tracé nommés : poignée → nom
    const hidden = scanInvisible(text);
    if (hidden.size) {
      const mark = (e) => { if (hidden.has(String(e.handle).toUpperCase())) e.isVisible = false; };
      all.forEach(mark);
      // Définitions dynamiques : leurs objets invisibles sont ceux des autres états de visibilité, gardés (marqués).
      for (const b of blocks) {
        if (!acadDyn.defs.has(String(b.brHandle).toUpperCase())) b.entities.forEach(mark);
        else for (const e of b.entities) if (hidden.has(String(e.handle).toUpperCase())) e.defHidden = true;
      }
    }
    // Champs (FIELD) des textes et attributs : code et objets cités, rattachés par poignée.
    const fields = scanFields(text);
    if (fields.size) {
      const attach = (e) => {
        const f = fields.get(String(e.handle).toUpperCase());
        if (f) e.fieldInfo = f;
        for (const a of e.attribs || []) attach(a);
      };
      all.forEach(attach);
      for (const b of blocks) b.entities.forEach(attach);
    }
  }
  // Masques : contour relu dans le texte, rattaché par poignée.
  const wipe = new Map(extra.wipeouts.map((x) => [x.handle, x]));
  const fixWipe = (e) => {
    const x = e.type === 'WIPEOUT' && wipe.get(String(e.handle).toUpperCase());
    if (x) { e.clippingBoundaryPath = x.path; e.clippingBoundaryType = x.type; }
  };
  if (wipe.size) { all.forEach(fixWipe); for (const b of blocks) b.entities.forEach(fixWipe); }
  for (const u of extra.underlays) {
    if (u.section === 'BLOCKS') {
      const b = blocks.find((x) => x.brHandle === u.owner);
      if (b) b.entities.unshift(u);
    } else if (u.isInPaperSpace) {
      const target = blocks.find((b) => /^\*paper_space$/i.test(b.name));
      if (target) target.entities.unshift(u);
    } else all.unshift(u);
  }
  const layers = (dxf.tables?.LAYER?.entries || []).map((l) => ({
    ...l,
    colorIndex: Math.abs(l.colorIndex ?? 7),
    off: (l.colorIndex ?? 0) < 0,
    frozen: (l.standardFlag & 1) !== 0,
  }));
  return {
    source: 'dxf',
    header: dxf.header || {},
    tables: {
      LAYER: { entries: layers },
      DIMSTYLE: dxf.tables?.DIMSTYLE || { entries: [] },
      // Styles de texte (police, largeur, oblique en radians comme LibreDWG).
      STYLE: { entries: (dxf.tables?.STYLE?.entries || []).map((s) => ({ ...s, obliqueAngle: rad(s.obliqueAngle) })) },
      LTYPE: dxf.tables?.LTYPE || { entries: [] },
      UCS: dxf.tables?.UCS || { entries: [] },
      BLOCK_RECORD: { entries: blocks },
    },
    objects: {
      LAYOUT: dxf.objects?.byName?.LAYOUT || [], GROUP: dxf.objects?.byName?.GROUP || [],
      DICTIONARY: dxf.objects?.byName?.DICTIONARY || [], XRECORD: dxf.objects?.byName?.XRECORD || [],
      PDFDEFINITION: extra.pdfDefs, SPATIAL_FILTER: extra.filters, IMAGEDEF: extra.imageDefs.map((d) => ({ handle: d.handle, fileName: d.path, size: { x: d.w, y: d.h }, sizeOfOnePixel: { x: d.pixel, y: d.pixel }, resolutionUnits: d.units })),
    },
    entities: all.filter((e) => !e.isInPaperSpace),
    layerStates,
    sortents: extra.sortents,
    wipeoutFrame: extra.wipeoutFrame,
    acadDyn,
    dimAssoc,
    plotStyleNames,
  };
}

// Noms des styles de tracé (dictionnaires avec valeur par défaut, ACDBDICTIONARYWDFLT : ACAD_PLOTSTYLENAME) :
// Map(poignée de l'objet du style → nom).
export function scanPlotStyleNames(text) {
  const out = new Map();
  if (!text.includes('ACDBDICTIONARYWDFLT')) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== 'ACDBDICTIONARYWDFLT') continue;
    let name = null;
    for (let j = i + 2; j + 1 < lines.length && lines[j].trim() !== '0'; j += 2) {
      const c = lines[j].trim(), v = lines[j + 1].trim();
      if (c === '3') name = lines[j + 1].replace(/\r$/, '');
      else if (c === '350' && name != null) { out.set(v.toUpperCase(), name); name = null; }
    }
  }
  return out;
}
