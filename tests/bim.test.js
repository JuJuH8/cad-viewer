// SPDX-License-Identifier: GPL-3.0-or-later
// Tests coordination BIM : export IFC4 (relu par web-ifc), conflits en BCF 2.1.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { symbolInsert } from '../src/elec/symbols.js';
import { writeIfc, ifcGuid, stepString } from '../src/io/ifc-writer.js';
import { ifcApi } from '../src/archi/ifc.js';

const tray = (pts, z = 2900) => ({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-CFO', color: 256, pts, bulges: pts.map(() => 0), closed: false, z, width: 0,
  mep: { kind: 'tray', system: 'CFO', shape: 'rect', w: 300, h: 60, z, elbow: 'radius', maker: 'OBO', ri: 150 } });

function bimDoc() {
  const doc = new Document();
  doc.header.insunits = 4;
  doc.transaction('i', () => {
    doc.add(tray([[0, 1000], [20000, 1000], [20000, 8000]]));
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-CVC-SOUF', color: 256, pts: [[0, -3000], [6000, -3000], [6000, 2000]], bulges: [0, 0, 0], closed: false, z: 2700, width: 0,
      mep: { kind: 'duct', system: 'SOUF', shape: 'rect', w: 400, h: 200, z: 2700 } });
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-PLB-EF', color: 256, pts: [[0, -5000], [8000, -5000]], bulges: [0, 0], closed: false, z: 2500, width: 0,
      mep: { kind: 'pipe', system: 'EF', shape: 'round', d: 32, z: 2500 } });
    doc.add({ type: 'LWPOLYLINE', layer: 'MEP-ELEC-TUB-CFO', color: 256, pts: [[3000, 1200], [3000, 6000]], bulges: [0, 0], closed: false, z: 2800, width: 0,
      mep: { kind: 'pipe', conduit: true, embed: 'dalle', system: 'TUB-CFO', shape: 'round', d: 20, z: 2800 } });
    doc.add(symbolInsert(doc, 'TABLEAU', [0, 0], { elec: { kind: 'board', board: 'TP', parent: '', circuits: [] } }));
    doc.add(symbolInsert(doc, 'LUM', [5000, 1500], { elec: { board: 'TP', circuit: 'L1' } }));
    doc.add(symbolInsert(doc, 'PR2', [8000, 500], { elec: { board: 'TP', circuit: 'P1' } }));
  });
  return doc;
}

// Boîtes englobantes (m, repère du plan : x, y, z altitude) des maillages de web-ifc, par identifiant d'élément.
function meshBoxes(api, id) {
  const out = new Map();
  api.StreamAllMeshes(id, (mesh) => {
    const b = out.get(mesh.expressID) || { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (let g = 0; g < mesh.geometries.size(); g++) {
      const pg = mesh.geometries.get(g);
      const geom = api.GetGeometry(id, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      geom.delete();
      const T = pg.flatTransformation;
      for (let k = 0; k < v.length; k += 6) {
        const [x, y, z] = [v[k], v[k + 1], v[k + 2]];
        const X = T[0] * x + T[4] * y + T[8] * z + T[12], Yup = T[1] * x + T[5] * y + T[9] * z + T[13], Z = T[2] * x + T[6] * y + T[10] * z + T[14];
        const P = [X, -Z, Yup];
        b.x0 = Math.min(b.x0, P[0]); b.x1 = Math.max(b.x1, P[0]); b.y0 = Math.min(b.y0, P[1]); b.y1 = Math.max(b.y1, P[1]); b.z0 = Math.min(b.z0, P[2]); b.z1 = Math.max(b.z1, P[2]);
      }
    }
    out.set(mesh.expressID, b);
  });
  return out;
}

test('IFC : identifiants, textes STEP', () => {
  const g = ifcGuid('Projet|12:1');
  assert.equal(g.length, 22);
  assert.ok(/^[0-3][0-9A-Za-z_$]{21}$/.test(g));
  assert.equal(ifcGuid('Projet|12:1'), g, 'déterministe');
  assert.ok(ifcGuid('Projet|12:2') !== g);
  assert.equal(stepString("L'été"), "'L''\\X2\\00E9\\X0\\t\\X2\\00E9\\X0\\'");
  assert.equal(stepString(''), '$');
});

test('IFC : export des réseaux et de l’électricité relu par web-ifc (types, géométrie, propriétés, systèmes, circuits)', async () => {
  const doc = bimDoc();
  const r = writeIfc(doc, { project: 'Essai', now: new Date('2026-10-17T12:00:00Z') });
  assert.ok(r.text.startsWith('ISO-10303-21;') && r.text.includes("FILE_SCHEMA(('IFC4'));"));
  await fetch('/__out/essai.ifc', { method: 'POST', body: r.text }).catch(() => {});
  const { api, W } = await ifcApi();
  const id = api.OpenModel(new TextEncoder().encode(r.text), { COORDINATE_TO_ORIGIN: false });
  try {
    const count = (t) => api.GetLineIDsWithType(id, t).size();
    // Chemin de câbles : 2 tronçons + 1 coude ; tube : 1 tronçon (conduit) ; gaine : 2 + 1 ; canalisation : 1.
    assert.equal(count(W.IFCCABLECARRIERSEGMENT), 3);
    assert.equal(count(W.IFCCABLECARRIERFITTING), 1);
    assert.equal(count(W.IFCDUCTSEGMENT), 2);
    assert.equal(count(W.IFCDUCTFITTING), 1);
    assert.equal(count(W.IFCPIPESEGMENT), 1);
    assert.equal(count(W.IFCLIGHTFIXTURE), 1);
    assert.equal(count(W.IFCOUTLET), 1);
    assert.equal(count(W.IFCELECTRICDISTRIBUTIONBOARD), 1);
    assert.equal(count(W.IFCDISTRIBUTIONSYSTEM), 4, 'CFO, SOUF, EF, TUB-CFO');
    assert.equal(count(W.IFCDISTRIBUTIONCIRCUIT), 2, 'TP.L1 et TP.P1');
    // Géométrie : premier tronçon du chemin de câbles (0 → 20 m − tangente du coude 0,3 m), largeur 0,3 m,
    // dessous à 2,90 m, hauteur 0,06 m.
    const boxes = meshBoxes(api, id);
    const segs = api.GetLineIDsWithType(id, W.IFCCABLECARRIERSEGMENT);
    const first = boxes.get(segs.get(0));
    for (const [v, e] of [[first.x0, 0], [first.y0, 0.85], [first.y1, 1.15], [first.z0, 2.9], [first.z1, 2.96]]) assert.near(v, e, 1e-4);
    assert.ok(first.x1 >= 19.7 && first.x1 < 19.71, 'jusqu’au coude (joint de 6,5 mm avec le premier morceau du coude)');
    // Coude : quart de tore entre (19,7 ; 1) et (20 ; 1,3), rayon intérieur 0,15 m.
    const bend = boxes.get(api.GetLineIDsWithType(id, W.IFCCABLECARRIERFITTING).get(0));
    assert.near(bend.x0, 19.7, 0.025, 'morceaux de 10° prolongés aux joints');
    assert.near(bend.y1, 1.3, 0.025);
    assert.ok(bend.x1 <= 20.15 + 1e-3 && bend.y0 >= 0.85 - 1e-3);
    // Canalisation EF Ø32 à 2,50 m (axe).
    const pipe = boxes.get(api.GetLineIDsWithType(id, W.IFCPIPESEGMENT).get(0));
    for (const [v, e] of [[pipe.x0, 0], [pipe.x1, 8], [pipe.z0, 2.484], [pipe.z1, 2.516]]) assert.near(v, e, 1e-3);
    // Luminaire à la hauteur générale des luminaires (2,60 m).
    const lum = boxes.get(api.GetLineIDsWithType(id, W.IFCLIGHTFIXTURE).get(0));
    assert.near((lum.z0 + lum.z1) / 2, 2.6, 1e-6);
    // Propriétés (jeu CV_Parametres).
    const props = async (type) => {
      const sets = await api.properties.getPropertySets(id, api.GetLineIDsWithType(id, type).get(0), true);
      const ps = sets.find((s) => s.Name.value === 'CV_Parametres');
      return Object.fromEntries(ps.HasProperties.map((h) => [h.Name.value, h.NominalValue.value]));
    };
    const pl = await props(W.IFCLIGHTFIXTURE);
    assert.equal(pl['Numéro de circuit'], 'L1');
    assert.equal(pl['Numéro de tableau'], 'TP');
    assert.equal(pl.Puissance, 40);
    assert.equal(pl.Tension, 230);
    assert.near(pl['Intensité'], 40 / (230 * 0.95), 1e-5);
    const pt = await props(W.IFCCABLECARRIERSEGMENT);
    assert.equal(pt['Système'], 'CFO');
    assert.equal(pt.Section, 'CDC 300×60');
    assert.equal(pt['Numéro de circuit'], 'TP.L1, TP.P1', 'circuits passant dans le chemin');
    const pb = await props(W.IFCELECTRICDISTRIBUTIONBOARD);
    assert.equal(pb['Numéro de tableau'], 'TP');
    assert.equal(pb.Tension, 400);
    // Mêmes identifiants d'un export à l'autre.
    assert.equal(writeIfc(doc, { project: 'Essai', now: new Date('2026-10-17T12:00:00Z') }).text, r.text);
  } finally {
    api.CloseModel(id);
  }
});

test('ZIP : écriture (deflate et stocké) et relecture', async () => {
  const { writeZip, readZip, crc32 } = await import('../src/io/zip.js');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC-32 de référence');
  const big = 'é'.repeat(5000);
  const z = await writeZip([{ name: 'a.txt', data: big }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]);
  assert.equal(new TextDecoder('latin1').decode(z.subarray(0, 2)), 'PK');
  const back = await readZip(z);
  assert.equal(new TextDecoder().decode(back.get('a.txt')), big);
  assert.deepEqual([...back.get('dir/b.bin')], [1, 2, 3]);
  assert.ok(z.length < 2000, 'texte répétitif compressé');
});

test('BCF : conflits exportés (sujets, points de vue sur les éléments IFC, capture) et relus', async () => {
  const { writeBcf, readBcf } = await import('../src/io/bcf.js');
  const { findClashes } = await import('../src/mep/clash.js');
  const { writeZip } = await import('../src/io/zip.js');
  const doc = bimDoc();
  // Gaine traversant le chemin de câbles à la même altitude.
  doc.transaction('c', () => doc.add({ type: 'LWPOLYLINE', layer: 'MEP-CVC-REP', color: 256, pts: [[10000, -2000], [10000, 4000]], bulges: [0, 0], closed: false, z: 2930, width: 0,
    mep: { kind: 'duct', system: 'REP', shape: 'rect', w: 400, h: 200, z: 2930 } }));
  const clashes = findClashes([...doc.entities.values()]);
  assert.equal(clashes.length, 1);
  const bytes = await writeBcf(doc, clashes, { project: 'Essai', date: new Date('2026-10-17T12:00:00Z') });
  await fetch('/__out/essai.bcfzip', { method: 'POST', body: bytes }).catch(() => {});
  const bcf = await readBcf(bytes);
  assert.equal(bcf.version, '2.1');
  assert.equal(bcf.topics.length, 1);
  const t = bcf.topics[0];
  assert.equal(t.title, 'Interférence 1 : CFO / REP');
  assert.deepEqual([t.status, t.type, t.index, t.author], ['Open', 'Clash', 1, 'CAD Viewer']);
  assert.ok(/pénétration \d+ mm/.test(t.description));
  assert.equal(t.comments.length, 1);
  // Éléments désignés : ceux de l'export IFC des deux réseaux (mêmes GlobalId).
  const ifc = writeIfc(doc, { project: 'Essai' });
  const [ida, idb] = [clashes[0].a, clashes[0].b];
  assert.deepEqual(t.viewpoint.components, [...ifc.guids.get(ida), ...ifc.guids.get(idb)]);
  assert.ok(ifc.text.includes(`'${t.viewpoint.components[0]}'`));
  // Caméra : vise le conflit (x = 10 m, y = 1 m, z au milieu des deux axes).
  const target = t.viewpoint.target;
  assert.near(target[0], 10, 1e-6);
  assert.near(target[1], 1, 1e-6);
  assert.near(target[2], (2.93 + 2.93) / 2, 1e-6, 'axe de la gaine 2,93 m ; chemin de câbles 2,90 + 0,03 m');
  assert.ok(t.snapshot && new TextDecoder('latin1').decode(t.snapshot.subarray(1, 4)) === 'PNG', 'capture PNG');
  // BCF d'un autre logiciel : dossier sans index, caméra orthogonale, sujet fermé, deux commentaires.
  const other = await writeZip([
    { name: 'bcf.version', data: '<?xml version="1.0"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>' },
    { name: 'abc/markup.bcf', data: '<?xml version="1.0"?><Markup><Topic Guid="abc" TopicStatus="Closed"><Title>Réservation dalle</Title></Topic><Comment Guid="1"><Author>Archi</Author><Comment>OK</Comment></Comment><Comment Guid="2"><Author>CVSE</Author><Comment>Validé</Comment></Comment><Viewpoints Guid="v"><Viewpoint>v1.bcfv</Viewpoint></Viewpoints></Markup>' },
    { name: 'abc/v1.bcfv', data: `<?xml version="1.0"?><VisualizationInfo Guid="v"><Components><Selection><Component IfcGuid="${ifc.guids.get(ida)[0]}"/></Selection></Components><OrthogonalCamera><CameraViewPoint><X>1</X><Y>2</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>0</Y><Z>-1</Z></CameraDirection><CameraUpVector><X>0</X><Y>1</Y><Z>0</Z></CameraUpVector><ViewToWorldScale>10</ViewToWorldScale></OrthogonalCamera></VisualizationInfo>` },
  ]);
  const o = await readBcf(other);
  assert.deepEqual([o.topics[0].title, o.topics[0].status, o.topics[0].comments.map((c) => c.text)], ['Réservation dalle', 'Closed', ['OK', 'Validé']]);
  assert.deepEqual(o.topics[0].viewpoint.camera.position, [1, 2, 3]);
  assert.deepEqual(o.topics[0].viewpoint.components, [ifc.guids.get(ida)[0]]);
});

test('vue 3D : plans de découpe de la boîte de coupe et des plans de coupe (6 au plus)', async () => {
  const { Tools3D } = await import('../src/render/tools3d.js');
  const THREE = await import('three');
  const fake = {
    mode: '3d', canvas: document.createElement('canvas'), origin: { x: 0, y: 0, z: 0 }, extents: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    cache: new Map(), doc: null, perspective: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} },
    requestRender() {}, drawing: { visible: true }, underlays: { group: { visible: true } }, refreshMep3d() {},
  };
  const t = new Tools3D(fake);
  t.setBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 3)));
  const box = t.clipPlanes();
  assert.equal(box.length, 6);
  assert.equal(t.handles.length, 6, 'une poignée par face');
  const kept = (planes, p) => planes.every((pl) => pl.distanceToPoint(p) >= 0);
  assert.ok(kept(box, new THREE.Vector3(5, 5, 1)));
  assert.ok(!kept(box, new THREE.Vector3(11, 5, 1)) && !kept(box, new THREE.Vector3(5, 5, 4)));
  t.setBox(null);
  t.addPlane('z');
  t.planes[0].pos = 2;
  assert.ok(kept(t.clipPlanes(), new THREE.Vector3(0, 0, 1)) && !kept(t.clipPlanes(), new THREE.Vector3(0, 0, 3)), 'plan horizontal : garde le dessous');
  t.flipPlane(0);
  assert.ok(!kept(t.clipPlanes(), new THREE.Vector3(0, 0, 1)) && kept(t.clipPlanes(), new THREE.Vector3(0, 0, 3)), 'inversé : garde le dessus');
  for (let i = 0; i < 10; i++) t.addPlane('x');
  assert.equal(t.planes.length, 6, 'six plans au plus');
  t.clearAll();
  assert.equal(t.clipPlanes().length, 0);
  fake.mode = '2d';
  t.setBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)));
  assert.equal(t.clipPlanes().length, 0, 'aucune découpe en vue 2D');
});

test('vue 3D : maquette IFC d’un fond en volumes (placée comme le plan, niveau du plan ou tout le bâtiment)', async () => {
  const THREE = await import('three');
  const { buildIfc3d, installIfc3d } = await import('../src/archi/ifc3d.js');
  const doc = bimDoc();
  doc.transaction('haut', () => doc.add(tray([[0, 20000], [5000, 20000]], 7000))); // au-dessus de la dalle du niveau
  const buffer = new TextEncoder().encode(writeIfc(doc, { project: 'Essai' }).text).buffer;
  const bounds = (g) => new THREE.Box3().setFromObject(g);
  // Plan du fond inséré en (100 m, 50 m), tourné de 90°, scène d'origine (100 m, 50 m) : x' = −y, y' = x.
  const place = (x, y, z) => [100000 + -y - 100000, 50000 + x - 50000, z];
  const r = await buildIfc3d(buffer, place, { storey: 'Niveau' });
  assert.ok(r.triangles > 100, `${r.triangles} triangles`);
  assert.equal(r.storey, 'Niveau');
  const b = bounds(r.group);
  assert.ok(Math.abs(b.max.y - 20150) < 200 && b.min.y < 500, `y (x du plan) ${b.min.y} → ${b.max.y}`);
  const ident = bounds((await buildIfc3d(buffer, (x, y, z) => [x, y, z], { storey: 'Niveau' })).group);
  assert.ok(Math.abs(b.min.x + ident.max.y) < 1 && Math.abs(b.max.y - ident.max.x) < 1, 'rotation de 90°');
  assert.ok(b.max.z < 4000 && b.min.z > -150, `altitudes ${b.min.z} → ${b.max.z} : chemin à 7 m exclu`);
  const all = await buildIfc3d(buffer, place, { storey: 'Niveau', all: true });
  assert.ok(bounds(all.group).max.z > 6900, 'tout le bâtiment : chemin à 7 m inclus');
  for (const m of r.group.children) assert.ok(m.isMesh && m.material.side === THREE.DoubleSide);

  // Gestionnaire : volumes ajoutés en 3D, cachés en 2D, refaits quand l'option change ; pris dans l'emprise des outils 3D.
  const scene = new THREE.Scene();
  const fake = { mode: '3d', scene, origin: { x: 0, y: 0, z: 0 }, requestRender() {} };
  const opts = { show: true, all: false };
  doc.transaction('fond', () => doc.setTableEntry('blocks', 'Archi', { name: 'Archi', base: [0, 0, 0], entities: [], fond: { ifc: { storey: 'Niveau' }, version: 1 } }));
  const msgs = [];
  const m = installIfc3d(fake, { getDoc: () => doc, getBuffer: async () => buffer, insertOf: () => ({ p: [1000, 0, 0], sx: 1, rot: 0 }), options: () => opts, print: (s) => msgs.push(s) });
  await m.refresh();
  assert.ok(fake.ifc3d && scene.children.includes(fake.ifc3d), msgs.join(' | '));
  assert.ok(Math.abs(bounds(fake.ifc3d).min.x - ident.min.x - 1000) < 1, `insertion en x : ${bounds(fake.ifc3d).min.x}`);
  const first = fake.ifc3d;
  fake.mode = '2d';
  await m.refresh();
  assert.ok(!fake.ifc3d && !first.visible, 'caché en 2D');
  fake.mode = '3d';
  await m.refresh();
  assert.equal(fake.ifc3d, first, 'retour en 3D sans relecture');
  opts.all = true;
  await m.refresh();
  assert.ok(fake.ifc3d !== first && bounds(fake.ifc3d).max.z > 6900, 'tous les niveaux');
  const { Tools3D } = await import('../src/render/tools3d.js');
  const t = new Tools3D({ ...fake, extents: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, cache: new Map(), canvas: document.createElement('canvas'),
    perspective: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} }, drawing: { visible: true }, underlays: { group: { visible: true } }, refreshMep3d() {} });
  assert.ok(t.sceneBounds().max.z > 6900, 'emprise des outils 3D avec la maquette');
});
