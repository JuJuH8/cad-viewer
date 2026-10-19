// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des fonds de plan : profils (format .tpp du module AutoCAD LT), table de calques, traitement,
// comparaison de versions, attacher / remplacer / retirer (annulables), index en grille des grosses références.
import { test, assert } from './harness.js';
import { Document } from '../src/core/document.js';
import { parseTpp, serializeTpp, builtinProfiles, defaults } from '../src/archi/profiles.js';
import { wcmatch, sourceMatches, parseLayerTable, exportLayerTable } from '../src/archi/layertable.js';
import { cleanDocument, unformatMtext, trimMtext, mtextPlain } from '../src/archi/clean.js';
import { compareEntities, changeZones, signature } from '../src/archi/compare.js';
import { attachFond, replaceFond, detachFond, listFonds, fondInserts, compareVersions, cloudZones, unitScale, FOND_LAYER } from '../src/archi/fonds.js';
import { buildGrid, gridItems } from '../src/render/seggrid.js';

// Profil écrit par le module AutoCAD LT (vl-prin1-to-string), avec accents et listes.
const TPP_LT = `;; Profil « Traitement de plans » : modifiable par la commande TP
(
 ("LIBERER")
 ("UNITE" . 4)
 ("ORIG_PT" 0.0 0.0 0.0)
 ("APLATIR" . T)
 ("TOL" . 0.5)
 ("XREF_MODE" . "NONREF")
 ("CALQUES_FILTRE" "MOB*" "Équipé")
 ("COUL_TABLE" (1 . 3) (256 . 8))
 ("TL_TABLE" ("DASHED" . "HIDDEN"))
 ("TABLE_CALQUES" . "C:\\\\Données\\\\table \\"v2\\".csv")
)
`;

test('profils : lecture d’un .tpp écrit par AutoCAD LT', () => {
  const c = parseTpp(TPP_LT);
  assert.equal(c.LIBERER, false);
  assert.equal(c.UNITE, 4);
  assert.deepEqual(c.ORIG_PT, [0, 0, 0]);
  assert.equal(c.APLATIR, true);
  assert.equal(c.TOL, 0.5);
  assert.equal(c.XREF_MODE, 'NONREF');
  assert.deepEqual(c.CALQUES_FILTRE, ['MOB*', 'Équipé']);
  assert.deepEqual(c.COUL_TABLE, [[1, 3], [256, 8]]);
  assert.deepEqual(c.TL_TABLE, [['DASHED', 'HIDDEN']]);
  assert.equal(c.TABLE_CALQUES, 'C:\\Données\\table "v2".csv');
  assert.equal(c.PURGE, true, 'clés absentes : valeur par défaut');
});

test('profils : écriture puis relecture à l’identique, format LISP', () => {
  const c = { ...builtinProfiles()['Fond de plan gris'], CALQUES_FILTRE: ['A-FURN*'], COUL_TABLE: [[5, 2]], TOL: 1, TABLE_CALQUES: 'C:\\x\\y.csv' };
  const text = serializeTpp(c);
  assert.ok(text.includes('("TOL" . 1.0)'), 'réel écrit avec un point décimal');
  assert.ok(text.includes('("COUL_TABLE" (5 . 2))'));
  assert.ok(text.includes('("APLATIR" . T)') && text.includes('("ORIGINE")'));
  assert.deepEqual(parseTpp(text), { ...defaults(), ...c });
});

test('motifs de calques (WCMATCH) et table CSV', () => {
  assert.ok(wcmatch('A-WALL-EXT', 'A-WALL*'));
  assert.ok(wcmatch('mob_chaise', '*MOB*'));
  assert.ok(!wcmatch('PORTEUR', 'PORTE'));
  assert.ok(wcmatch('Mur1', 'Mur#') && !wcmatch('MurA', 'Mur#'));
  assert.ok(wcmatch('B', 'A,B'));
  assert.ok(sourceMatches('Mur #1', 'MUR #1') && !sourceMatches('Mur #12', 'Mur #1'));
  assert.ok(sourceMatches('A-MUR.Porteur', 'a-mur*'));
  const rows = parseLayerTable('\ufeffCalque source;Calque cible;Couleur;Type de ligne;Epaisseur\r\nMUR*;Murs;1;;0,35\r\nMOB;SUPPRIMER;;;\r\n"A;B";X;;;');
  assert.deepEqual(rows, [
    { source: 'MUR*', target: 'Murs', color: 1, ltype: null, lweight: 35 },
    { source: 'MOB', target: 'SUPPRIMER', color: null, ltype: null, lweight: null },
    { source: 'A;B', target: 'X', color: null, ltype: null, lweight: null },
  ]);
});

test('textes multilignes : mise en forme retirée comme dans le module LT', () => {
  assert.equal(unformatMtext('{\\C1;\\fArial|b1;\\H2x;Bonjour}\\L\\Pmonde'), '{\\H2x;Bonjour}\\Pmonde');
  assert.equal(trimMtext(' \\P\\Pabc def\\P '), 'abc def');
  assert.equal(mtextPlain('{\\fArial;  }\\P').trim(), '');
  assert.equal(mtextPlain('\\S1^2;'), '1/2');
});

// Petit dessin d'architecte : murs, mobilier, objets nuls, textes, hachure pleine, bloc.
function archiDoc() {
  const d = new Document();
  d.header.insunits = 5; // centimètres
  d.layers.set('MURS', { name: 'MURS', color: 1, on: true, frozen: false, locked: false, ltype: 'Continuous', lweight: -3 });
  d.layers.set('MOBILIER', { name: 'MOBILIER', color: 4, on: true, frozen: false, locked: false, ltype: 'Continuous', lweight: -3 });
  d.layers.set('CACHE', { name: 'CACHE', color: 3, on: false, frozen: false, locked: false, ltype: 'Continuous', lweight: -3 });
  d.layers.set('PDF_Remplissages', { name: 'PDF_Remplissages', color: 7, on: true, frozen: false, locked: false, ltype: 'Continuous', lweight: -3 });
  d.blocks.set('CHAISE', { name: 'CHAISE', base: [0, 0, 0], entities: [{ type: 'CIRCLE', layer: '0', color: 3, c: [0, 0, 0], r: 20 }] });
  d.blocks.set('VIDE', { name: 'VIDE', base: [0, 0, 0], entities: [] });
  d.load([
    { type: 'LINE', layer: 'MURS', p1: [0, 0, 50], p2: [1000, 0, 50] },
    { type: 'LINE', layer: 'MURS', color: 5, p1: [1000, 0, 0], p2: [1000, 800, 0] },
    { type: 'LINE', layer: 'MURS', p1: [10, 10, 0], p2: [10, 10, 0] },
    { type: 'LINE', layer: 'MOBILIER', p1: [100, 100, 0], p2: [200, 100, 0] },
    { type: 'LINE', layer: 'CACHE', p1: [0, 500, 0], p2: [100, 500, 0] },
    { type: 'TEXT', layer: 'MURS', p: [50, 50, 0], h: 25, rot: 0, text: '  Séjour  ' },
    { type: 'TEXT', layer: 'MURS', p: [50, 90, 0], h: 25, rot: 0, text: '   ' },
    { type: 'MTEXT', layer: 'MURS', p: [50, 120, 0], h: 25, rot: 0, text: '{\\C1;Cuisine}\\P' },
    { type: 'HATCH', layer: 'MURS', solid: true, pattern: 'SOLID', loops: [[[0, 0], [50, 0], [50, 50]]], lines: [], z: 0 },
    { type: 'HATCH', layer: 'PDF_Remplissages', solid: true, pattern: 'SOLID', loops: [[[0, 0], [5, 0], [5, 5]]], lines: [], z: 0 },
    { type: 'INSERT', layer: 'MOBILIER', name: 'CHAISE', p: [300, 300, 0], sx: 1, sy: 1, sz: 1, rot: 0, cols: 1, rows: 1, attribs: [] },
    { type: 'INSERT', layer: 'MURS', name: 'VIDE', p: [0, 0, 0], sx: 1, sy: 1, sz: 1, rot: 0, cols: 1, rows: 1, attribs: [] },
    { type: 'LINE', layer: 'MURS', space: 'layout1', p1: [0, 0, 0], p2: [10, 0, 0] },
  ]);
  d.spaces.push({ id: 'layout1', label: 'Présentation1' });
  return d;
}

test('traitement : profil « Base architecte »', () => {
  const d = archiDoc();
  const r = cleanDocument(d, builtinProfiles()['Base architecte']);
  const ents = [...d.entities.values()];
  assert.ok(ents.every((e) => e.space === 'model'), 'présentations supprimées');
  assert.ok(!ents.some((e) => e.type === 'LINE' && e.p1[0] === 10), 'objet nul supprimé');
  assert.equal(ents.find((e) => e.type === 'LINE' && e.layer === 'MURS').p1[2], 0, 'aplati');
  assert.equal(ents.find((e) => e.type === 'TEXT').text, 'Séjour', 'texte rogné');
  assert.equal(ents.filter((e) => e.type === 'TEXT').length, 1, 'texte vide supprimé');
  assert.equal(ents.find((e) => e.type === 'MTEXT').text, '{Cuisine}', 'couleur retirée, \\P final rogné');
  assert.deepEqual(ents.filter((e) => e.type === 'HATCH').map((e) => e.layer), ['PDF_Remplissages'], 'hachure pleine supprimée sauf import PDF');
  assert.ok(r.warnings.some((w) => /import PDF/.test(w)));
  assert.ok(!ents.some((e) => e.name === 'VIDE'), 'référence de bloc vide supprimée');
  assert.ok(!d.blocks.has('VIDE'), 'bloc vide purgé');
  assert.equal(ents.find((e) => e.color === 5)?.color, 5, 'couleurs de l’architecte gardées');
  assert.equal(ents[0].type, 'HATCH', 'hachures en arrière-plan');
  assert.ok(r.lines[0].startsWith('Traitement de plans'));
});

test('traitement : fond gris, calques cachés, table de calques', () => {
  const d = archiDoc();
  const table = parseLayerTable('MURS;A-Murs;7;;0.5\nMOB*;SUPPRIMER');
  cleanDocument(d, { ...builtinProfiles()['Fond de plan gris'], CONV_CALQUES: true, CALQUES_CACHES: true }, { table });
  const ents = [...d.entities.values()];
  assert.ok(!ents.some((e) => e.layer === 'MOBILIER' || e.layer === 'CACHE'), 'mobilier (table) et calque éteint supprimés');
  assert.ok(ents.filter((e) => e.type === 'LINE').every((e) => e.layer === 'A-Murs'), 'murs convertis');
  assert.ok(ents.every((e) => (e.color ?? 256) === 256 && e.rgb == null), 'objets DuCalque');
  assert.equal(d.layers.get('A-Murs').lweight, 50);
  assert.ok([...d.layers.values()].every((l) => l.color === 8), 'tous les calques en couleur 8');
  assert.ok(!d.layers.has('MOBILIER') && !d.layers.has('MURS'), 'calques vidés purgés');
  assert.ok(!d.blocks.has('CHAISE'), 'bloc du mobilier purgé');
});

test('comparaison : ajouts, suppressions, objets inchangés (sens et arrondi tolérés)', () => {
  const tol = 1;
  const a = [
    { type: 'LINE', p1: [0, 0], p2: [100, 0] },
    { type: 'LINE', p1: [0, 10], p2: [100, 10] },
    { type: 'TEXT', p: [5, 5], h: 2, rot: 0, text: 'A' },
    { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10]], bulges: [0.5, 0, 0], closed: false },
    { type: 'CIRCLE', c: [50.5, 50], r: 3 },
  ];
  const b = [
    { type: 'LINE', p1: [100, 0], p2: [0, 0] },                 // même ligne, sens inverse
    { type: 'TEXT', p: [5, 5], h: 2, rot: 0, text: 'B' },       // texte changé
    { type: 'LWPOLYLINE', pts: [[10, 10], [10, 0], [0, 0]], bulges: [0, -0.5, 0], closed: false }, // inversée
    { type: 'CIRCLE', c: [50.49, 50], r: 3 },                   // arrondi de part et d'autre de 50,5
    { type: 'LINE', p1: [0, 20], p2: [100, 20] },               // nouvelle
  ];
  const r = compareEntities(a, b, { tol });
  assert.equal(r.same, 3);
  assert.deepEqual(r.added.map((e) => e.text || e.p1?.[1]), ['B', 20]);
  assert.deepEqual(r.removed.map((e) => e.text || e.p1?.[1]).sort(), [10, 'A'].sort());
  assert.equal(signature({ type: 'LINE', p1: [0, 0], p2: [1, 1] }, 1), signature({ type: 'LINE', p1: [1, 1], p2: [0, 0] }, 1));
  const zones = changeZones([{ e: b[4], kind: 'added' }, { e: a[1], kind: 'removed' }, { e: { type: 'POINT', p: [5000, 5000] }, kind: 'added' }], 50);
  assert.equal(zones.length, 2, 'changements voisins regroupés');
  assert.equal(zones[0].added + zones[0].removed, 2);
});

function baseDoc(shift = 0) {
  const x = archiDoc();
  cleanDocument(x, builtinProfiles().Express);
  if (shift) {
    const first = [...x.entities.values()].find((e) => e.type === 'LINE');
    first.p2 = [first.p2[0] + shift, first.p2[1], 0];
  }
  return x;
}

test('fonds : attacher (unités, calque verrouillé), remplacer et comparer, retirer, annuler', () => {
  const doc = new Document();
  doc.header.insunits = 4; // mm ; la base est en cm
  assert.equal(unitScale(5, 4), 10);
  const name = attachFond(doc, { name: 'Base archi.dwg', xdoc: baseDoc(), meta: { file: 'Base archi.dwg', profile: 'Express' } });
  assert.equal(name, 'Base archi');
  const ins = fondInserts(doc, name)[0];
  assert.equal(ins.sx, 10, 'base en cm insérée dans un dessin en mm');
  assert.equal(ins.layer, FOND_LAYER(name));
  assert.ok(doc.layers.get(FOND_LAYER(name)).locked, 'calque du fond verrouillé');
  assert.ok(doc.layers.has('Base archi|MURS') && doc.blocks.has('Base archi|CHAISE'), 'calques et blocs préfixés');
  assert.equal(listFonds(doc).length, 1);
  assert.equal(doc.undoStack.length, 1, 'une seule étape d’annulation');
  const n1 = doc.blocks.get(name).entities.length;

  doc.setLayer('Base archi|MURS', { on: false }); // réglage de l'utilisateur, conservé au remplacement
  const r = replaceFond(doc, name, baseDoc(250), { file: 'Base archi v2.dwg' });
  const b = doc.blocks.get(name);
  assert.equal(b.fond.version, 2);
  assert.equal(b.fond.history.length, 1);
  assert.equal(b.fond.file, 'Base archi v2.dwg');
  assert.equal(doc.layers.get('Base archi|MURS').on, false, 'état du calque conservé');
  const cmp = compareVersions(doc, name, r.before, r.after);
  assert.equal(cmp.addedCount, 1);
  assert.equal(cmp.removedCount, 1);
  assert.equal(cmp.same, n1 - 1);
  assert.ok(cmp.zones.length >= 1);
  assert.ok(cmp.added[0].p2[0] > 10000, 'repères en coordonnées du dessin (échelle 10 appliquée)');
  assert.equal(cloudZones(doc, cmp.zones), cmp.zones.length);

  doc.undo(); // nuages
  doc.undo(); // nouvelle version
  assert.equal(doc.blocks.get(name).fond.version, 1, 'annuler rend la version précédente');
  doc.redo();
  assert.equal(doc.blocks.get(name).fond.version, 2);

  detachFond(doc, name);
  assert.ok(!doc.blocks.has(name) && !doc.blocks.has('Base archi|CHAISE'), 'définitions retirées');
  assert.ok(!doc.layers.has('Base archi|MURS') && !doc.layers.has(FOND_LAYER(name)), 'calques retirés');
  assert.equal(fondInserts(doc, name).length, 0);
  doc.undo();
  assert.ok(doc.blocks.has(name) && fondInserts(doc, name).length === 1, 'retrait annulable');
});

test('index en grille : mêmes segments proches que la recherche exhaustive', () => {
  const segs = [], tris = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
  for (let i = 0; i < 6000; i++) { const x = rnd(), y = rnd(); segs.push(x, y, 0, x + rnd() / 50, y + rnd() / 50, 0); }
  segs.push(-500, 500, 0, 1500, 500, 0); // segment long (liste à part)
  for (let i = 0; i < 300; i++) { const x = rnd(), y = rnd(); tris.push(x, y, 0, x + 5, y, 0, x, y + 5, 0); }
  const parts = [{ segs: segs.slice(0, 18000), tris: [] }, { segs: segs.slice(18000), tris }];
  const grid = buildGrid(parts, { minX: -500, minY: 0, maxX: 1500, maxY: 1020 });
  assert.ok(grid, 'grille construite au-delà de 4 000 éléments');
  const box = { minX: 400, minY: 480, maxX: 430, maxY: 520 };
  const hits = gridItems(grid, parts, box).segs;
  const inBox = (x1, y1, x2, y2) => Math.max(x1, x2) >= box.minX && Math.min(x1, x2) <= box.maxX && Math.max(y1, y2) >= box.minY && Math.min(y1, y2) <= box.maxY;
  const want = [];
  for (const p of parts) for (let i = 0; i < p.segs.length; i += 6) if (inBox(p.segs[i], p.segs[i + 1], p.segs[i + 3], p.segs[i + 4])) want.push(p.segs[i]);
  const got = [];
  for (let i = 0; i < hits.length; i += 4) if (inBox(hits[i], hits[i + 1], hits[i + 2], hits[i + 3])) got.push(hits[i]);
  assert.deepEqual(got.sort(), want.sort(), 'aucun segment de la boîte oublié');
  assert.ok(got.includes(-500), 'segment long trouvé');
  assert.ok(hits.length / 4 < 200, 'seuls des segments voisins sont renvoyés');
  assert.equal(buildGrid([{ segs: segs.slice(0, 600), tris: [] }], { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }), null, 'petite géométrie : pas d’index');
});

test('fonds : enregistrement DXF (référence externe à chemin connu, réglages relus) ou fond lié', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const doc = new Document();
  doc.header.insunits = 4;
  const name = attachFond(doc, {
    name: 'Base', xdoc: baseDoc(),
    meta: { file: 'Base.dwg', source: { kind: 'path', path: 'C:\Projets\Archi\Base é.dwg' }, profile: 'Base architecte', table: 'calques.csv', ifc: { storey: 'Etage', cut: 1.2 } },
  });
  const text = writeDxf(doc);
  assert.ok(text.includes('Base é.dwg') || text.includes('Base \u00e9.dwg'), 'chemin écrit');
  assert.ok(!text.includes('Base$0$MURS'), 'calques de la base non écrits (ils viennent de la référence)');
  // Écrit dans out/ pour la validation AutoCAD.
  await fetch('/__out/fond-xref.dxf', { method: 'POST', body: text }).catch(() => {});
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const b = back.blocks.get(name);
  assert.ok(b?.xref, 'relu comme référence externe');
  assert.equal(b.entities.length, 0, 'contenu à recharger depuis le chemin');
  assert.equal(b.fond.source.path, 'C:\Projets\Archi\Base é.dwg');
  assert.equal(b.fond.profile, 'Base architecte');
  assert.equal(b.fond.table, 'calques.csv');
  assert.deepEqual(b.fond.ifc, { storey: 'Etage', cut: 1.2 }, 'niveau IFC relu (pas de question à la réouverture)');
  assert.equal([...back.entities.values()].filter((e) => e.type === 'INSERT' && e.name === name).length, 1);
  assert.ok(back.layers.has(FOND_LAYER(name)));

  // Sans chemin (fichier choisi dans le navigateur) : le fond est lié (contenu écrit), réglages conservés.
  const doc2 = new Document();
  const n2 = attachFond(doc2, { name: 'Lié', xdoc: baseDoc(), meta: { file: 'Lié.dwg', profile: 'Express' } });
  const back2 = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc2)).buffer, 'y.dxf')).doc;
  const b2 = back2.blocks.get(n2);
  assert.ok(b2.entities.length > 5, 'contenu lié');
  assert.equal(b2.fond.profile, 'Express');
});

test('IFC : plan d’un niveau (mur coupé, dalle vue, nom du local), en millimètres', async () => {
  const { ifcToDocument, ifcStoreys } = await import('../src/archi/ifc.js');
  const buf = await fetch('fixtures/mini.ifc').then((r) => r.arrayBuffer());
  const storeys = await ifcStoreys(buf);
  assert.deepEqual(storeys.map((s) => [s.name, s.elevation]), [['Rez', 0], ['Etage', 3]], 'niveaux en mètres');
  const doc = await ifcToDocument(buf, { storey: 'Rez', cut: 1.1 });
  assert.equal(doc.header.insunits, 4);
  assert.deepEqual(doc.ifc.storey, 'Rez');
  const ents = [...doc.entities.values()];
  const len = (layer) => ents.filter((e) => e.layer === layer && e.type === 'LINE').reduce((s, e) => s + Math.hypot(e.p2[0] - e.p1[0], e.p2[1] - e.p1[1]), 0);
  assert.near(len('IFC-Murs'), 2 * (5000 + 200), 1, 'contour du mur coupé (mm)');
  assert.near(len('IFC-Dalles (vue)'), 2 * (5000 + 4000), 1, 'contour de la dalle vue en dessous');
  const wall = ents.filter((e) => e.layer === 'IFC-Murs');
  assert.ok(wall.every((e) => e.p1[0] >= -1 && e.p1[0] <= 5001 && e.p1[1] >= -1 && e.p1[1] <= 201), 'mur à sa place (x 0–5000, y 0–200)');
  const label = ents.find((e) => e.type === 'TEXT');
  assert.equal(label?.text, 'R01 Bureau');
  assert.point(label.p, [2500, 2100], 1, 'nom au centre du local');
  assert.equal(doc.layers.get('IFC-Murs').lweight, 50, 'murs coupés en trait épais');
  // Niveau supérieur : rien n'y est coupé.
  const up = await ifcToDocument(buf, { storey: 'Etage', cut: 1.1 });
  assert.equal([...up.entities.values()].filter((e) => e.layer === 'IFC-Murs').length, 0);
});
