// SPDX-License-Identifier: GPL-3.0-or-later
// BCF 2.1 (BIM Collaboration Format) : conflits entre réseaux (INTERFERENCES) exportés en .bcfzip — un sujet par
// conflit (titre, description, statut, commentaire), point de vue (caméra en perspective sur le conflit, éléments
// IFC sélectionnés par leur GlobalId, identiques à ceux de l'export IFC) et capture du plan autour du conflit —,
// et relecture d'un .bcfzip (sujets, statuts, commentaires, points de vue), venant de l'appli ou d'un autre logiciel.

import { writeZip, readZip } from './zip.js';
import { writeIfc } from './ifc-writer.js';
import { mepGeometry } from '../mep/geometry.js';
import { sectionLabel, planWidth, vertexZ } from '../mep/systems.js';
import { unitMmOf } from '../mep/network.js';
import { pathOf, pointAt } from '../core/path.js';
import * as G from '../core/geom.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// GUID (8-4-4-4-12) déterministe à partir d'un texte.
export function uuidFrom(text) {
  let hex = '';
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    hex += h.toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Altitude de l'axe d'un réseau au point p (unités du dessin) : sommets interpolés, chemin de câbles au milieu de sa hauteur.
function axisZAt(e, p) {
  const vz = vertexZ(e);
  let best = { d: Infinity, z: vz[0] };
  for (let k = 1; k < e.pts.length; k++) {
    const r = G.closestOnSegment(p, e.pts[k - 1], e.pts[k]);
    if (r.d < best.d) best = { d: r.d, z: vz[k - 1] + (vz[k] - vz[k - 1]) * r.t };
  }
  return best.z + (e.mep.kind === 'tray' ? (e.mep.h || 60) / 2 : 0);
}

const label = (e) => (e ? `${e.mep.system} ${sectionLabel(e.mep)} (z ${Math.round(e.mep.z || 0)})` : '?');

// Capture PNG du plan autour du conflit : réseaux voisins en gris, les deux réseaux en conflit en couleur.
async function snapshot(doc, c, k) {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return null;
  const W = 800, H = 600;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  const half = Math.max(1500 / k, ...[c.a, c.b].map((id) => (planWidth(doc.get(id)?.mep || {}) || 0) * 3));
  const sc = W / (2 * half * 1.33);
  const X = (x) => W / 2 + (x - c.p[0]) * sc, Y = (y) => H / 2 - (y - c.p[1]) * sc;
  const draw = (pts) => { g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1])))); g.stroke(); };
  const box = { minX: c.p[0] - 2 * half, maxX: c.p[0] + 2 * half, minY: c.p[1] - 2 * half, maxY: c.p[1] + 2 * half };
  for (const e of doc.entities.values()) {
    if (!e.mep || e.type !== 'LWPOLYLINE' || (e.space || 'model') !== 'model') continue;
    if (!e.pts.some((q) => q[0] > box.minX && q[0] < box.maxX && q[1] > box.minY && q[1] < box.maxY) && e.id !== c.a && e.id !== c.b) continue;
    g.strokeStyle = e.id === c.a ? '#d62828' : e.id === c.b ? '#1d4ed8' : '#9ca3af';
    g.lineWidth = e.id === c.a || e.id === c.b ? 2 : 1;
    for (const l of mepGeometry(e).lines) {
      if (l.pts) draw(l.pts);
      else if (l.entity) {
        const pts = [];
        for (const cu of pathOf(l.entity).curves) for (let j = 0; j <= (cu.k === 'arc' ? 12 : 1); j++) pts.push(pointAt(cu, j / (cu.k === 'arc' ? 12 : 1)));
        draw(pts);
      }
    }
  }
  g.strokeStyle = '#d62828'; g.lineWidth = 2;
  g.beginPath(); g.arc(W / 2, H / 2, 24, 0, Math.PI * 2); g.stroke();
  g.font = '16px sans-serif';
  const title = `${label(doc.get(c.a))}  ×  ${label(doc.get(c.b))}`;
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(6, 6, g.measureText(title).width + 12, 26);
  g.fillStyle = '#111827';
  g.fillText(title, 12, 24);
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// Conflits → archive .bcfzip (Uint8Array). opts : { project, author, date (Date), snapshots (vrai par défaut), ifcName }.
export async function writeBcf(doc, clashes, opts = {}) {
  const k = unitMmOf(doc);
  const ifc = writeIfc(doc, { project: opts.project });
  const date = (opts.date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const author = opts.author || 'CAD Viewer';
  const files = [{ name: 'bcf.version', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n  <DetailedVersion>2.1</DetailedVersion>\n</Version>\n' }];
  files.push({ name: 'project.bcfp', data: `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectExtension xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n  <Project ProjectId="${uuidFrom(`${ifc.project}|projet`)}">\n    <Name>${esc(ifc.project)}</Name>\n  </Project>\n  <ExtensionSchema></ExtensionSchema>\n</ProjectExtension>\n` });
  for (const [i, c] of clashes.entries()) {
    const a = doc.get(c.a), b = doc.get(c.b);
    const topic = uuidFrom(`${ifc.project}|conflit|${c.a}|${c.b}`);
    const vp = uuidFrom(`${topic}|vue`);
    const z = ((a ? axisZAt(a, c.p) : 0) + (b ? axisZAt(b, c.p) : 0)) / 2;
    const T = [c.p[0] * k / 1000, c.p[1] * k / 1000, z * k / 1000];
    const pos = [T[0] - 4, T[1] - 4, T[2] + 3];
    const d = [4 / Math.sqrt(41), 4 / Math.sqrt(41), -3 / Math.sqrt(41)]; // vers le conflit, à √41 ≈ 6,4 m
    const up = (() => { const dz = d[2]; const v = [-dz * d[0], -dz * d[1], 1 - dz * dz]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
    const xyz = (tag, v) => `<${tag}><X>${v[0]}</X><Y>${v[1]}</Y><Z>${v[2]}</Z></${tag}>`;
    const comps = [...(ifc.guids.get(c.a) || []), ...(ifc.guids.get(c.b) || [])].map((g) => `<Component IfcGuid="${g}" />`).join('');
    const desc = `Interférence entre ${label(a)} et ${label(b)} : pénétration ${Math.round(c.depth)} mm, position ${Math.round(c.p[0])}, ${Math.round(c.p[1])}.`;
    const snap = opts.snapshots === false ? null : await snapshot(doc, c, k).catch(() => null);
    files.push({ name: `${topic}/markup.bcf`, data: `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Header>
    <File IfcProject="${ifc.projectGuid}" isExternal="true">
      <Filename>${esc(opts.ifcName || `${ifc.project}.ifc`)}</Filename>
      <Date>${date}</Date>
    </File>
  </Header>
  <Topic Guid="${topic}" TopicType="Clash" TopicStatus="Open">
    <Title>${esc(`Interférence ${i + 1} : ${a?.mep.system || '?'} / ${b?.mep.system || '?'}`)}</Title>
    <Priority>Normal</Priority>
    <Index>${i + 1}</Index>
    <Labels>MEP</Labels>
    <CreationDate>${date}</CreationDate>
    <CreationAuthor>${esc(author)}</CreationAuthor>
    <Description>${esc(desc)}</Description>
  </Topic>
  <Comment Guid="${uuidFrom(`${topic}|commentaire`)}">
    <Date>${date}</Date>
    <Author>${esc(author)}</Author>
    <Comment>${esc(desc)}</Comment>
    <Viewpoint Guid="${vp}" />
  </Comment>
  <Viewpoints Guid="${vp}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>${snap ? '\n    <Snapshot>snapshot.png</Snapshot>' : ''}
  </Viewpoints>
</Markup>
` });
    files.push({ name: `${topic}/viewpoint.bcfv`, data: `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vp}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Components>
    <Selection>${comps}</Selection>
    <Visibility DefaultVisibility="true" />
  </Components>
  <PerspectiveCamera>
    ${xyz('CameraViewPoint', pos)}
    ${xyz('CameraDirection', d)}
    ${xyz('CameraUpVector', up)}
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>
` });
    if (snap) files.push({ name: `${topic}/snapshot.png`, data: snap });
  }
  return writeZip(files);
}

// .bcfzip → { version, topics: [{ guid, title, status, type, priority, index, description, author, date, labels,
// comments: [{ author, date, text }], viewpoint: { camera: { position, direction, up }, target, components: [GlobalId] },
// snapshot (Uint8Array | null) }] }. target : point visé estimé (m), à √41 ≈ 6,4 m de la caméra (distance des points de vue de l’appli).
export async function readBcf(buffer) {
  const files = await readZip(buffer);
  const dec = new TextDecoder();
  const xml = (name) => (files.has(name) ? new DOMParser().parseFromString(dec.decode(files.get(name)), 'application/xml') : null);
  const text = (node, sel) => node?.querySelector(sel)?.textContent?.trim() ?? '';
  const version = xml('bcf.version')?.documentElement.getAttribute('VersionId') || '';
  const topics = [];
  for (const name of files.keys()) {
    if (!name.endsWith('/markup.bcf')) continue;
    const dir = name.slice(0, -'markup.bcf'.length);
    const m = xml(name);
    const t = m.querySelector('Topic');
    const vps = [...m.querySelectorAll('Viewpoints')];
    const vpFile = vps.length ? text(vps[0], 'Viewpoint') || 'viewpoint.bcfv' : files.has(`${dir}viewpoint.bcfv`) ? 'viewpoint.bcfv' : '';
    const snapFile = vps.length ? text(vps[0], 'Snapshot') : '';
    let viewpoint = null;
    const v = vpFile ? xml(`${dir}${vpFile}`) : null;
    if (v) {
      const vec = (sel) => { const n = v.querySelector(sel); return n ? ['X', 'Y', 'Z'].map((a) => Number(text(n, a))) : null; };
      const cam = v.querySelector('PerspectiveCamera') || v.querySelector('OrthogonalCamera');
      const position = cam && vec(`${cam.tagName} > CameraViewPoint`), direction = cam && vec(`${cam.tagName} > CameraDirection`);
      const camera = cam ? { position, direction, up: vec(`${cam.tagName} > CameraUpVector`) } : null;
      const target = position && direction ? position.map((x, i) => x + direction[i] * Math.sqrt(41)) : null;
      viewpoint = { camera, target, components: [...v.querySelectorAll('Selection > Component')].map((c) => c.getAttribute('IfcGuid')).filter(Boolean) };
    }
    topics.push({
      guid: t?.getAttribute('Guid') || dir.replace(/\/$/, ''), title: text(t, 'Title'), status: t?.getAttribute('TopicStatus') || '',
      type: t?.getAttribute('TopicType') || '', priority: text(t, 'Priority'), index: Number(text(t, 'Index')) || null,
      description: text(t, 'Description'), author: text(t, 'CreationAuthor'), date: text(t, 'CreationDate'),
      labels: [...(t?.querySelectorAll('Labels') || [])].map((l) => l.textContent.trim()),
      comments: [...m.querySelectorAll('Markup > Comment')].map((c) => ({ author: text(c, 'Author'), date: text(c, 'Date'), text: text(c, 'Comment') })),
      viewpoint, snapshot: snapFile && files.has(`${dir}${snapFile}`) ? files.get(`${dir}${snapFile}`) : null,
    });
  }
  topics.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.title.localeCompare(b.title, 'fr'));
  return { version, topics };
}
