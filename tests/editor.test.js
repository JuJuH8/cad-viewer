// SPDX-License-Identifier: GPL-3.0-or-later
// Tests des commandes : on pilote le vrai éditeur (rendu compris) en tapant des saisies
// et en simulant des clics, puis on vérifie le dessin obtenu.
import { test, assert, sample } from './harness.js';
import * as G from '../src/core/geom.js';
import { Document } from '../src/core/document.js';
import { Renderer } from '../src/render/renderer.js';
import { Editor } from '../src/editor/editor.js';
import { registerCommands } from '../src/editor/commands.js';
import { registerHatchCommands } from '../src/hatch/commands.js';
import { registerDimCommands } from '../src/editor/dims.js';
import { setGeometry } from '../src/ui/panels.js';

const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-2000px;top:0;width:800px;height:600px;';
document.body.appendChild(host);
const renderer = new Renderer(host);
const log = [];
const editor = new Editor(renderer, { print: (m) => log.push(m) });
registerCommands(editor);
registerHatchCommands(editor); // HACHURES en ligne de commande (sans la boîte)
registerDimCommands(editor);

const tick = () => new Promise((r) => setTimeout(r, 0));

function fresh() {
  const doc = new Document();
  renderer.setDocument(doc);
  editor.setDocument(doc);
  renderer.fit({ minX: -50, minY: -50, maxX: 250, maxY: 250 });
  log.length = 0;
  return doc;
}

async function type(...inputs) {
  for (const x of inputs) {
    editor.submit(x);
    await tick();
  }
}

async function run(cmd, ...inputs) {
  editor.run(cmd);
  await tick();
  await type(...inputs);
  await tick();
}

// Clic à la position monde p (avec accrochage si une commande attend un point).
async function click(p, shift = false) {
  const [sx, sy] = renderer.toScreen(p[0], p[1]);
  editor.computeCursor([sx, sy]);
  editor.click(shift);
  await tick();
}

const all = (doc) => [...doc.entities.values()];

test('commande LIGNE avec annUler et Clore', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '100,100', '200,200', 'u', 'c');
  const lines = all(doc);
  assert.equal(lines.length, 3);
  assert.point(lines[2].p1, [100, 100]);
  assert.point(lines[2].p2, [0, 0]);
  doc.undo();
  assert.equal(doc.entities.size, 0, 'une seule annulation retire toute la commande');
});

test('commande POLYLIGN avec un arc tangent', async () => {
  const doc = fresh();
  await run('PL', '0,0', '100,0', 'a', '100,100', '');
  const [pl] = all(doc);
  assert.equal(pl.type, 'LWPOLYLINE');
  assert.equal(pl.pts.length, 3);
  assert.near(pl.bulges[1], 1, 1e-9); // demi-cercle tangent à la direction +X
});

// Événements souris réels sur le canevas (position monde → écran).
function pointer(type, p, extra = {}) {
  const el = renderer.canvas, rect = el.getBoundingClientRect();
  const [sx, sy] = renderer.toScreen(p[0], p[1]);
  el.dispatchEvent(new PointerEvent(type, {
    clientX: rect.left + sx, clientY: rect.top + sy, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true, ...extra,
  }));
}

test('souris : point pris à l’appui, clics rapides jamais perdus (polyligne)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  editor.run('PL');
  await tick();
  const pts = [[0, 0], [100, 0], [100, 100], [0, 100], [50, 150]];
  // Cinq clics dans la même tâche, la souris bougeant de 30 unités (> 5 pixels) pendant chaque appui.
  for (const p of pts) {
    pointer('pointerdown', p);
    pointer('pointermove', [p[0] + 30, p[1] + 30]);
    pointer('pointerup', [p[0] + 30, p[1] + 30]);
  }
  await tick();
  await tick();
  editor.submit('');
  await tick();
  const [pl] = all(doc);
  assert.equal(pl?.pts.length, 5, 'aucun clic perdu');
  pts.forEach((p, i) => assert.point(pl.pts[i], p, 1e-6));
  editor.settings.osnap = true;
});

test('souris : poignée glissée-déposée, saisie tapée pendant le calcul d’une commande', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  let id;
  doc.transaction('l', () => { id = doc.add({ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [100, 0, 0] }).id; });
  editor.setSelection([id]);
  pointer('pointerdown', [100, 0]);
  pointer('pointermove', [150, 50]);
  pointer('pointerup', [150, 50]);
  await tick();
  assert.point(doc.get(id).p2, [150, 50], 1e-6, 'extrémité déplacée');
  assert.equal(editor.dragGrip, null);
  // Commande qui calcule avant de poser sa question : la saisie arrivée entre-temps n'est pas perdue.
  editor.register('LENT', async (ctx) => {
    await new Promise((r) => setTimeout(r, 20));
    const p = await ctx.getPoint('Point');
    ctx.doc.add({ type: 'POINT', layer: '0', p: [p[0], p[1], 0] });
  });
  editor.run('LENT');
  await tick();
  editor.submit('7,8');
  await new Promise((r) => setTimeout(r, 40));
  const pt = all(doc).find((e) => e.type === 'POINT');
  assert.point(pt?.p, [7, 8, 0], 1e-9);
  editor.settings.osnap = true;
});

test('commandes CERCLE (rayon, 2P, 3P), ARC, RECTANG', async () => {
  const doc = fresh();
  await run('C', '0,0', '25');
  await run('C', '2p', '0,0', '10,0');
  await run('C', '3p', '10,0', '0,10', '-10,0');
  await run('A', '10,0', '0,10', '-10,0');
  await run('REC', '0,0', '40,20');
  const [c1, c2, c3, a, r] = all(doc);
  assert.near(c1.r, 25);
  assert.near(c2.r, 5); assert.point(c2.c, [5, 0]);
  assert.near(c3.r, 10, 1e-9);
  assert.equal(a.type, 'ARC'); assert.near(a.r, 10, 1e-9);
  assert.ok(r.closed); assert.equal(r.pts.length, 4);
});

test('sélection au clic, par fenêtre et par capture', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  await run('L', '0,50', '100,50', '');
  await run('C', '200,0', '20');
  await click([50, 0]);
  assert.equal(editor.selection.size, 1);
  await click([50, 50]); // comme AutoCAD : un clic ajoute à la sélection
  assert.equal(editor.selection.size, 2);
  await click([50, 50], true); // Maj + clic : retire
  assert.equal(editor.selection.size, 1);
  editor.setSelection([]);
  // Fenêtre gauche → droite : seule la ligne du bas est entièrement dedans.
  await click([-10, -10]);
  await click([110, 10]);
  assert.equal(editor.selection.size, 1);
  editor.setSelection([]);
  // Capture droite → gauche : touche les deux lignes.
  await click([60, 60]);
  await click([40, -10]);
  assert.equal(editor.selection.size, 2);
});

test('DEPLACER, COPIER, ROTATION, ECHELLE, MIROIR avec présélection', async () => {
  const doc = fresh();
  await run('L', '0,0', '10,0', '');
  const id = all(doc)[0].id;
  editor.setSelection([id]);
  await run('M', '0,0', '5,5');
  assert.point(doc.get(id).p1, [5, 5]);
  assert.equal(editor.selection.size, 0, 'la sélection est vidée après la commande');
  editor.setSelection([id]);
  await run('CO', '0,0', '0,20', '0,40', '');
  assert.equal(doc.entities.size, 3);
  editor.setSelection([id]);
  await run('RO', '5,5', '90');
  assert.point(doc.get(id).p2, [5, 15], 1e-9);
  editor.setSelection([id]);
  await run('SC', '5,5', '2');
  assert.point(doc.get(id).p2, [5, 25], 1e-9);
  editor.setSelection([id]);
  await run('MI', '0,0', '0,10', '');
  assert.equal(doc.entities.size, 4, 'MIROIR garde la source par défaut');
  const m = all(doc)[3];
  assert.point(m.p1, [-5, 5], 1e-9);
});

test('DECALER, AJUSTER, PROLONGER par clics', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  await run('O', '10');
  await click([50, 0]);           // objet à décaler
  await click([50, 30]);          // côté
  await type('');                 // fin
  const off = all(doc)[1];
  assert.point(off.p1, [0, 10], 1e-9);
  // Deux coupants verticaux puis ajustement du milieu de la ligne du bas.
  await run('L', '30,-20', '30,20', '');
  await run('L', '70,-20', '70,20', '');
  const base = all(doc)[0].id;
  await run('TR');
  await click([50, 0]);
  await type('');
  const parts = all(doc).filter((e) => e.type === 'LINE' && Math.abs(e.p1[1]) < 1e-9 && Math.abs(e.p2[1]) < 1e-9);
  assert.equal(parts.length, 2, `ajuster doit laisser 2 morceaux (obtenu ${parts.length})`);
  assert.ok(!doc.get(base));
  // Prolonger la ligne décalée (y = 10) : déjà au-delà des coupants ; on crée une frontière.
  await run('L', '150,-20', '150,40', '');
  await run('EX');
  await click([95, 10]);
  await type('');
  assert.point(doc.get(off.id).p2, [150, 10], 1e-9);
});

test('RACCORD de rayon 5 et DECOMPOS / JOINDRE', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  await run('L', '120,20', '120,100', '');
  await run('F', 'r', '5');
  await click([50, 0]);
  await click([120, 60]);
  await tick();
  const arc = all(doc).find((e) => e.type === 'ARC');
  assert.ok(arc, 'un arc de raccord a été créé');
  assert.near(arc.r, 5);
  const ids = all(doc).map((e) => e.id);
  editor.setSelection(ids);
  await run('J');
  const pl = all(doc).find((e) => e.type === 'LWPOLYLINE');
  assert.ok(pl, 'les trois objets sont joints');
  assert.equal(doc.entities.size, 1);
  editor.setSelection([pl.id]);
  await run('X');
  assert.equal(doc.entities.size, 3);
});

test('poignée : étirer l’extrémité d’une ligne', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  const id = all(doc)[0].id;
  editor.setSelection([id]);
  await click([100, 0]); // clic sur la poignée d'extrémité
  assert.ok(editor.dragGrip, 'la poignée est active');
  editor.settings.osnap = false;
  await click([100, 40]);
  editor.settings.osnap = true;
  assert.point(doc.get(id).p2, [100, 40], 1e-6);
});

test('EFFACER, ANNULER, RETABLIR', async () => {
  const doc = fresh();
  await run('C', '0,0', '10');
  const id = all(doc)[0].id;
  editor.setSelection([id]);
  await run('E');
  assert.equal(doc.entities.size, 0);
  await run('U');
  assert.equal(doc.entities.size, 1);
  await run('REDO');
  assert.equal(doc.entities.size, 0);
});

test('accrochage : extrémité, milieu, intersection', async () => {
  fresh();
  await run('L', '0,0', '100,0', '');
  await run('L', '50,-50', '50,30', ''); // milieu en (50, -10), intersection en (50, 0)
  editor.run('L');
  await tick();
  assert.equal(editor.request?.kind, 'point', `requête en attente : ${editor.request?.kind} / osnap ${editor.settings.osnap}`);
  const near = (p) => { const [sx, sy] = renderer.toScreen(p[0], p[1]); editor.computeCursor([sx + 2, sy - 2]); return editor.cursor.snap || { k: `aucun (cache ${renderer.cache.size}, proches ${renderer.near(p, 5).length})` }; };
  assert.equal(near([100, 0]).k, 'end');
  assert.equal(near([50, -10]).k, 'mid');
  const s = near([50, 0]);
  assert.equal(s.k, 'int');
  assert.point(s.p, [50, 0], 1e-9);
  editor.cancel();
  await tick();
});

test('cotation : COTLIN horizontale et verticale, COTALI, COTRAYON', async () => {
  const doc = fresh();
  doc.header.annoScale = 1;
  editor.settings.osnap = false;
  await run('COTLIN', '0,0', '100,40', '50,80');       // curseur au-dessus : cote horizontale = 100
  await run('COTLIN', '0,0', '100,40', '150,20');      // curseur à droite : cote verticale = 40
  await run('COTALI', '0,0', '30,40', '0,60');         // cote alignée = 50
  await run('C', '200,0', '25');
  await click([225, 0]);                                // (sélection sans commande : on l'efface ensuite)
  editor.setSelection([]);
  editor.run('COTRAYON'); await tick();
  await click([225, 0]);
  await type('260,30');
  editor.settings.osnap = true;
  const dims = all(doc).filter((e) => e.type === 'BLOCKREF');
  assert.equal(dims.length, 4);
  assert.deepEqual(dims.map((d) => Math.round(d.meta.measurement * 100) / 100), [100, 40, 50, 25]);
  const text = (d) => doc.blocks.get(d.name).entities.find((x) => x.type === 'TEXT').text;
  assert.equal(text(dims[0]), '100');
  assert.equal(text(dims[3]), 'R25');
  // La cote se déplace comme un tout.
  editor.setSelection([dims[0].id]);
  await run('M', '0,0', '10,10');
  assert.deepEqual(doc.get(dims[0].id).m, [1, 0, 0, 1, 10, 10]);
});

test('ETIRER : seuls les sommets dans la fenêtre bougent (gaine MEP comprise)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('PL', '0,0', '100,0', '100,50', '');
  await run('L', '0,20', '100,20', '');
  await run('ETIRER', '90,-10', '110,60', '100,0', '130,0');
  editor.settings.osnap = true;
  const [pl, l] = all(doc);
  assert.point(pl.pts[0], [0, 0]);
  assert.point(pl.pts[1], [130, 0]);
  assert.point(pl.pts[2], [130, 50]);
  assert.point(l.p1, [0, 20]);
  assert.point(l.p2, [130, 20]);
});

test('COUPURE : entre deux points, en un point, et sur un cercle', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  editor.run('COUPURE'); await tick();
  await click([30, 0]);
  await type('70,0');
  let lines = all(doc);
  assert.equal(lines.length, 2);
  assert.point(lines[0].p2, [30, 0], 1e-6);
  assert.point(lines[1].p1, [70, 0], 1e-6);
  editor.run('COUPURE'); await tick();
  await click([10, 0]);
  await type('@');
  assert.equal(all(doc).length, 3, 'coupure en un point : la ligne est scindée');
  await run('C', '200,0', '20');
  editor.run('COUPURE'); await tick();
  await click([220, 0]);
  await type('200,20');
  editor.settings.osnap = true;
  const arc = all(doc).find((e) => e.type === 'ARC');
  assert.ok(arc, 'le cercle devient un arc');
  assert.near(G.sweep(arc.a0, arc.a1), Math.PI * 1.5, 1e-6);
});

test('RESEAURECT, RESEAUPOLAIRE, CORRESPROP, copier-coller, HACHURES', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('C', '0,0', '5');
  const id = all(doc)[0].id;
  editor.setSelection([id]);
  await run('RESEAURECT', '2', '3', '20', '30');
  assert.equal(doc.entities.size, 6, '2 × 3 = 6 cercles');
  assert.ok(all(doc).some((e) => Math.abs(e.c[0] - 60) < 1e-9 && Math.abs(e.c[1] - 20) < 1e-9));
  editor.setSelection([id]);
  await run('RESEAUPOLAIRE', '100,0', '4', '360');
  assert.equal(doc.entities.size, 9, '3 copies polaires de plus');
  assert.ok(all(doc).some((e) => Math.abs(e.c[0] - 200) < 1e-9 && Math.abs(e.c[1]) < 1e-9), 'copie diamétralement opposée');
  // CORRESPROP : la couleur et le calque du premier cercle passent aux autres.
  doc.transaction('c', () => { doc.addLayer('ROUGE', { color: 1 }); doc.modify(id, (e) => { e.layer = 'ROUGE'; e.color = 3; }); });
  editor.run('MA'); await tick();
  await click([5, 0]);
  await click([65, 20]);
  await type('');
  const target = all(doc).find((e) => Math.abs(e.c[0] - 60) < 1e-9 && Math.abs(e.c[1] - 20) < 1e-9);
  assert.equal(target.layer, 'ROUGE'); assert.equal(target.color, 3);
  // Copier-coller avec point de base au coin bas-gauche de la sélection.
  editor.setSelection([id]);
  await run('COPIERPRESSE');
  await run('COLLER', '500,500');
  const pasted = all(doc).at(-1);
  assert.point(pasted.c, [505, 505], 1e-9);
  // Hachure pleine dans le cercle collé.
  await run('HACHURES', 'Plein', 'o');
  await click([510, 505]);
  await type('');
  const h = all(doc).find((e) => e.type === 'HATCH');
  assert.ok(h && h.solid, 'hachure pleine créée');
  editor.settings.osnap = true;
});

test('accrochage : coins d’un bloc inséré, mais pas les sommets d’arcs tessellés', async () => {
  const doc = fresh();
  doc.blocks.set('EQUIP', {
    name: 'EQUIP', base: [0, 0, 0], entities: [
      { type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[0, 0], [40, 0], [40, 20], [0, 20]], bulges: [0, 0, 0, 0], closed: true, z: 0 },
      { type: 'CIRCLE', layer: '0', color: 0, c: [20, 10, 0], r: 8 },
    ],
  });
  doc.transaction('i', () => doc.add({ type: 'INSERT', name: 'EQUIP', p: [100, 50, 0], sx: 1, sy: 1, sz: 1, rot: 0, attribs: [] }));
  editor.run('L'); await tick();
  const at = (x, y) => { const [sx, sy] = renderer.toScreen(x, y); editor.computeCursor([sx + 2, sy + 2]); return editor.cursor.snap; };
  const corner = at(140, 70);
  assert.equal(corner?.k, 'end');
  assert.point(corner.p, [140, 70], 1e-9);
  const onArc = at(120 + 8 * Math.cos(1), 60 + 8 * Math.sin(1));
  assert.ok(!onArc || onArc.k !== 'end', 'pas d’extrémité au milieu d’un cercle');
  editor.cancel(); await tick();
});

test('BLOC et INSERER : créer un bloc depuis une sélection puis l’insérer tourné', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('REC', '0,0', '20,10');
  await run('C', '10,5', '3');
  editor.setSelection([...doc.entities.keys()]);
  await run('BLOC', 'VANNE', '0,0');
  assert.ok(doc.blocks.has('VANNE'));
  assert.equal(doc.entities.size, 1, 'la sélection est remplacée par une insertion');
  assert.equal(all(doc)[0].type, 'INSERT');
  await run('INSERER', 'vanne', '100,100', '2', '90');
  editor.settings.osnap = true;
  const ins = all(doc).at(-1);
  assert.equal(ins.name, 'VANNE');
  assert.equal(ins.sx, 2);
  assert.near(ins.rot, Math.PI / 2, 1e-9);
  const box = renderer.cache.get(ins.id).box;
  assert.near(box.minX, 80, 1e-6); assert.near(box.maxX, 100, 1e-6); // 10 × 2 de large après rotation
  assert.near(box.maxY, 140, 1e-6);
});

test('PAS (F9) : le curseur s’accroche à la grille ; TEXTMULT crée un texte multiligne', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  editor.settings.snap = true; editor.settings.snapSize = 10;
  editor.run('L'); await tick();
  await click([13, 7]);
  await click([48, 2]);
  await type('');
  editor.settings.snap = false;
  const [l] = all(doc);
  assert.point(l.p1, [10, 10]);
  assert.point(l.p2, [50, 0]);
  await run('TEXTMULT', '0,100', '80,60', '5', 'Ligne 1|Ligne 2');
  editor.settings.osnap = true;
  const mt = all(doc).find((e) => e.type === 'MTEXT');
  assert.equal(mt.text, `Ligne 1${String.fromCharCode(92)}PLigne 2`); // code MTEXT \P = retour à la ligne
  assert.near(mt.width, 80);
  assert.equal(renderer.cache.get(mt.id).parts[0].texts[0].lines.length, 2);
});

test('ruban : chaque bouton correspond à une commande existante', async () => {
  const { RIBBON } = await import('../src/ui/ribbon.js');
  const { registerMepCommands } = await import('../src/mep/commands.js');
  registerMepCommands(editor);
  const { registerFondCommands } = await import('../src/archi/commands.js');
  if (!editor.findCommand('FOND')) registerFondCommands(editor, { loadDocument: async () => null });
  const { registerElecCommands } = await import('../src/elec/commands.js');
  if (!editor.findCommand('SYMBOLE')) registerElecCommands(editor);
  const { registerBlockCommands } = await import('../src/blocks/commands.js');
  if (!editor.findCommand('EDITBLOC')) registerBlockCommands(editor, { editing: false });
  const { registerUnderlayCommands } = await import('../src/underlay/commands.js');
  if (!editor.findCommand('PDFIMPORT')) registerUnderlayCommands(editor);
  const { registerClipCommands } = await import('../src/editor/xclip.js');
  if (!editor.findCommand('DECOUPXREF')) registerClipCommands(editor);
  const { registerLayerStateCommands } = await import('../src/ui/layerstates.js');
  if (!editor.findCommand('ETATCALQUE')) registerLayerStateCommands(editor);
  const { registerWipeoutCommands } = await import('../src/editor/wipeout.js');
  if (!editor.findCommand('MASQUE')) registerWipeoutCommands(editor);
  const { registerUcsCommands } = await import('../src/editor/ucs.js');
  if (!editor.findCommand('SCU')) registerUcsCommands(editor);
  const { registerFieldCommands } = await import('../src/editor/field-commands.js');
  if (!editor.findCommand('CHAMP')) registerFieldCommands(editor);
  const { registerExtractCommands } = await import('../src/blocks/extract-dialog.js');
  if (!editor.findCommand('EXTRACTATT')) registerExtractCommands(editor);
  // Commandes définies dans main.js (fichiers) : déclarées ici pour le test.
  for (const n of ['ENREGDXF', 'ENREGDWG', 'TRACER', 'PUBLIER', 'EXPORTIFC']) if (!editor.findCommand(n)) editor.register(n, () => {});
  const missing = [];
  for (const t of RIBBON) for (const g of t.groups) for (const [cmd] of g.items) {
    if (!cmd.startsWith('@') && !editor.findCommand(cmd)) missing.push(cmd);
  }
  assert.deepEqual(missing, []);
});

test('ISOLERCALQUE / ANNULISOLER', async () => {
  const doc = fresh();
  doc.transaction('c', () => { doc.addLayer('A'); doc.addLayer('B'); doc.addLayer('C'); });
  doc.transaction('e', () => { doc.add({ type: 'LINE', layer: 'A', p1: [0, 0, 0], p2: [1, 0, 0] }); doc.add({ type: 'LINE', layer: 'B', p1: [0, 1, 0], p2: [1, 1, 0] }); });
  const a = all(doc)[0].id;
  editor.setSelection([a]);
  await run('ISOLERCALQUE');
  assert.ok(doc.layers.get('A').on);
  assert.ok(!doc.layers.get('B').on && !doc.layers.get('C').on && !doc.layers.get('0').on);
  await run('ANNULISOLER');
  assert.ok(doc.layers.get('B').on && doc.layers.get('0').on);
});

test('CHANFREIN entre deux lignes, RACCORD ligne + polyligne (joint), option Polyligne', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  await run('L', '120,20', '120,100', '');
  await run('CHA', 'd', '10', '20');
  await click([50, 0]);
  await click([120, 60]);
  const link = all(doc).find((e) => e.type === 'LINE' && Math.abs(e.p1[0] - 110) < 1e-6);
  assert.ok(link, 'segment de chanfrein créé');
  assert.point(link.p2, [120, 20], 1e-6);
  // Polyligne ouverte en L puis ligne : raccord de rayon 5, le tout devient une seule polyligne.
  const d2 = fresh();
  await run('PL', '0,0', '100,0', '100,50', '');
  await run('L', '80,80', '0,80', '');
  await run('F', 'r', '5');
  await click([100, 30]);
  await click([40, 80]);
  assert.equal(d2.entities.size, 1, 'ligne jointe à la polyligne');
  const pl = all(d2)[0];
  assert.equal(pl.type, 'LWPOLYLINE');
  assert.ok(pl.bulges.some((b) => Math.abs(b) > 0.1), 'arc de raccord dans la polyligne');
  assert.point(pl.pts[pl.pts.length - 1], [0, 80], 1e-6);
  // Option Polyligne sur un rectangle : 4 arcs.
  const d3 = fresh();
  await run('REC', '0,0', '100,50');
  await run('F', 'r', '10', 'p');
  await click([50, 0]);
  const rect = all(d3)[0];
  assert.equal(rect.pts.length, 8);
  assert.equal(rect.bulges.filter((b) => b).length, 4);
  // Deux segments d'une même polyligne, en mode Multiple.
  const d4 = fresh();
  await run('PL', '0,0', '100,0', '100,100', '0,100', '');
  await run('CHA', 'd', '10', '10', 'm');
  await click([50, 0]);
  await click([100, 50]);
  await click([100, 50]);
  await click([50, 100]);
  await type('');
  assert.equal(all(d4)[0].pts.length, 6);
});

test('ELLIPSE, POLYGONE (inscrit, circonscrit, côté), SPLINE', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('EL', '0,0', '100,0', '25');
  let e = all(doc)[0];
  assert.equal(e.type, 'ELLIPSE');
  assert.point(e.c, [50, 0], 1e-9);
  assert.point(e.major, [50, 0], 1e-9);
  assert.near(e.ratio, 0.5, 1e-12);
  await run('EL', 'c', '0,0', '0,100', '200');
  e = all(doc)[1];
  assert.near(Math.hypot(...e.major), 200, 1e-9);
  assert.near(e.ratio, 0.5, 1e-12);
  await run('POL', '6', '0,0', 'i', '100,0');
  let p = all(doc)[2];
  assert.equal(p.pts.length, 6);
  assert.ok(p.closed);
  assert.point(p.pts[0], [100, 0], 1e-9);
  await run('POL', '4', '0,0', 'c', '100,0');
  p = all(doc)[3];
  assert.point(p.pts[0], [100, 100], 1e-9);
  await run('POL', '3', 'c', '0,0', '100,0');
  p = all(doc)[4];
  assert.point(p.pts[2], [50, 100 * Math.sin(Math.PI / 3)], 1e-9);
  await run('SPL', '0,0', '50,50', '100,0', '150,50', '');
  const s = all(doc)[5];
  assert.equal(s.type, 'SPLINE');
  assert.equal(s.fit.length, 4);
  assert.ok(renderer.cache.get(s.id).parts[0].segs.length > 30, 'spline dessinée');
  editor.settings.osnap = true;
});

test('PURGER : blocs, calques et types de ligne inutilisés (annulable)', async () => {
  const doc = fresh();
  const line = { type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [1, 0, 0] };
  doc.transaction('prep', () => {
    doc.addLayer('VIDE');
    doc.addLayer('DANS-BLOC');
    doc.addLayer('TIRETS', { ltype: 'DASHED' });
    doc.ltypes = new Map([['DASHED', { name: 'DASHED', dashes: [5, -2] }], ['CENTER', { name: 'CENTER', dashes: [10, -2, 2, -2] }]]);
    doc.blocks.set('UTILE', { name: 'UTILE', base: [0, 0, 0], entities: [line, { type: 'INSERT', name: 'IMBRIQUE', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [] }] });
    doc.blocks.set('IMBRIQUE', { name: 'IMBRIQUE', base: [0, 0, 0], entities: [{ ...line, layer: 'DANS-BLOC' }] });
    doc.blocks.set('INUTILE', { name: 'INUTILE', base: [0, 0, 0], entities: [line] });
    doc.add({ type: 'INSERT', name: 'UTILE', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [] });
    doc.add({ ...line, layer: 'TIRETS' });
  });
  await run('PU');
  assert.deepEqual([...doc.blocks.keys()].sort(), ['IMBRIQUE', 'UTILE']);
  assert.ok(!doc.layers.has('VIDE'));
  assert.ok(doc.layers.has('DANS-BLOC') && doc.layers.has('TIRETS'));
  assert.deepEqual([...doc.ltypes.keys()], ['DASHED']);
  await run('U');
  assert.ok(doc.blocks.has('INUTILE') && doc.layers.has('VIDE') && doc.ltypes.has('CENTER'), 'annuler restaure tout');
});

test('SUPPRDOUBLONS : doublons, lignes superposées fusionnées, lignes bout à bout gardées', async () => {
  const doc = fresh();
  const L = (x1, y1, x2, y2, layer = '0') => doc.add({ type: 'LINE', layer, p1: [x1, y1, 0], p2: [x2, y2, 0] });
  doc.transaction('prep', () => {
    doc.addLayer('B');
    L(0, 0, 100, 0); L(100, 0, 0, 0);        // doublon inversé
    L(50, 0, 150, 0);                        // chevauche → fusion 0..150
    L(150, 0, 200, 0);                       // bout à bout : gardée
    L(0, 0, 100, 0, 'B');                    // autre calque : gardée
    L(0, 10, 100, 110); L(20, 30, 60, 70);   // incluse dans la diagonale
    doc.add({ type: 'CIRCLE', layer: '0', c: [5, 5, 0], r: 3 });
    doc.add({ type: 'CIRCLE', layer: '0', c: [5, 5 + 1e-9, 0], r: 3 });
  });
  editor.setSelection([]);
  await run('OVERKILL', '', '0.000001');
  const lines = all(doc).filter((e) => e.type === 'LINE');
  assert.equal(lines.length, 4, JSON.stringify(lines.map((l) => [l.layer, l.p1, l.p2])));
  const merged = lines.find((l) => l.layer === '0' && Math.abs(l.p1[1]) < 1e-9 && Math.max(l.p1[0], l.p2[0]) > 140 && Math.min(l.p1[0], l.p2[0]) < 1);
  assert.ok(merged, 'ligne fusionnée de 0 à 150');
  assert.equal(all(doc).filter((e) => e.type === 'CIRCLE').length, 1);
  const { quickSelect } = await import('../src/ui/qselect.js');
  assert.equal(quickSelect(all(doc), { type: 'LINE', layer: '0', color: '*', system: '*' }).length, 3);
  assert.equal(quickSelect(all(doc), { type: '*', layer: 'B', color: '*', system: '*' }).length, 1);
});

test('présentations : fenêtres (espace objet à l’échelle, découpé au cadre) et tracé PDF', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { viewportMatrix } = await import('../src/render/viewports.js');
  const apply = (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];
  // Le centre de vue tombe au centre de la fenêtre, à l'échelle hauteur / hauteur de vue.
  const v = { c: [10, 20], w: 8, h: 6, vc: [1000, 2000], vh: 600, twist: 0, target: [0, 0] };
  assert.point(apply(viewportMatrix(v), 1000, 2000), [10, 20], 1e-9);
  assert.near(viewportMatrix(v)[0], 0.01, 1e-12);
  // Torsion de 90° : le point objet dont l'image (coordonnées d'affichage) est le centre de vue.
  const tw = viewportMatrix({ ...v, twist: Math.PI / 2 });
  assert.point(apply(tw, 2000, -1000), [10, 20], 1e-9);
  // Référence AutoCAD 2024 (trans WCS → DCS → PSDCS) sur la fenêtre tournée de « Site Layout Plan ».
  const site = importDatabase(await readDrawing(await sample('Site Layout Plan.dwg'), 'x.dwg')).doc;
  const twisted = [...site.entities.values()].find((e) => e.type === 'VIEWPORT' && e.space === '*Paper_Space');
  assert.point(apply(viewportMatrix(twisted), 1000000, 100000), [-471.517, 455.906], 2e-3);
  assert.point(apply(viewportMatrix(twisted), 1001000, 100000), [-448.859, 445.341], 2e-3);
  const buf = await sample('Floor Plan Sample.dwg');
  const { doc, stats } = importDatabase(await readDrawing(buf, 'x.dwg'));
  assert.ok(!stats.skipped.has('VIEWPORT'), 'la feuille elle-même n’est pas comptée comme non importée');
  const vps = [...doc.entities.values()].filter((e) => e.type === 'VIEWPORT');
  assert.equal(vps.length, 1);
  renderer.setDocument(doc);
  editor.setDocument(doc);
  const layout = doc.spaces.find((s) => s.id !== 'model').id;
  renderer.setSpace(layout);
  assert.equal(renderer.viewports.length, 1);
  renderer.render(true);
  assert.ok(renderer.modelView && renderer.modelView.parts.length > 100, 'espace objet construit pour la fenêtre');
  const { plotPdf } = await import('../src/io/pdf.js');
  const r = await plotPdf(renderer, doc, { paper: 'A3', landscape: true, box: renderer.robustExtents(), scale: null, mono: true, title: 'test' });
  assert.ok(r.segments > 5000, `${r.segments} segments tracés (plan de la fenêtre compris)`);
  renderer.setSpace('model');
  assert.equal(renderer.viewports.length, 0);
});

test('HACHURES par point intérieur : contour fait de lignes, îlot, bouts pendants ignorés', async () => {
  const { findBoundary } = await import('../src/editor/boundary.js');
  const doc = fresh();
  editor.settings.osnap = false;
  // Pièce : 4 lignes qui se croisent aux coins (dépassements), une cloison pendante, un poteau rond.
  await run('L', '-10,0', '110,0', '');
  await run('L', '100,-10', '100,70', '');
  await run('L', '110,60', '-10,60', '');
  await run('L', '0,70', '0,-10', '');
  await run('L', '50,0', '50,25', '');          // cloison pendante : ignorée
  await run('C', '75,40', '8');                  // îlot
  await run('L', '200,0', '260,0', '260,40', ''); // hors de la pièce, ouvert
  const b = findBoundary(all(doc), [20, 30]);
  assert.ok(b, 'contour trouvé');
  const area = (poly) => Math.abs(poly.reduce((acc, p, i) => { const q = poly[(i + 1) % poly.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  assert.near(area(b.outer), 6000, 1e-6);
  assert.equal(b.islands.length, 1);
  assert.ok(Math.abs(area(b.islands[0]) - Math.PI * 64) < 2, 'îlot circulaire');
  assert.equal(findBoundary(all(doc), [230, 20]), null, 'zone ouverte : pas de contour');
  // Par la commande : point intérieur.
  await run('H', 'Plein');
  await click([20, 30]);
  await type('');
  const h = all(doc).find((e) => e.type === 'HATCH');
  assert.ok(h, 'hachure créée');
  assert.equal(h.loops.length, 2);
  assert.ok(renderer.cache.get(h.id).parts[0].tris.length > 0, 'remplissage dessiné');
  // Point dans l'îlot : seul le cercle est hachuré.
  const inIsland = findBoundary(all(doc).filter((e) => e.type !== 'HATCH'), [75, 40]);
  assert.ok(Math.abs(area(inIsland.outer) - Math.PI * 64) < 2);
  editor.settings.osnap = true;
});

test('DIVISER, MESURER (points et blocs alignés), LIGNEREPERE', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  await run('DIV');
  await click([50, 0]);
  await type('4');
  let pts = all(doc).filter((e) => e.type === 'POINT').map((e) => e.p[0]).sort((a, b) => a - b);
  assert.deepEqual(pts, [25, 50, 75]);
  // MESURER depuis l'extrémité droite (clic près de x = 100), pas de 30.
  await run('MES');
  await click([95, 0]);
  await type('30');
  pts = all(doc).filter((e) => e.type === 'POINT').map((e) => Math.round(e.p[0])).sort((a, b) => a - b);
  assert.deepEqual(pts, [10, 25, 40, 50, 70, 75]);
  // Blocs alignés le long d'un arc.
  doc.blocks.set('REP', { name: 'REP', base: [0, 0, 0], entities: [{ type: 'LINE', layer: '0', p1: [-1, 0, 0], p2: [1, 0, 0] }] });
  await run('ARC', 'c', '0,100', '50,100', '-50,100');
  const arc = all(doc).find((e) => e.type === 'ARC');
  await run('DIV');
  await click([0, 150]);
  await type('b', 'REP', 'o', '2');
  const ins = all(doc).filter((e) => e.type === 'INSERT');
  assert.equal(ins.length, 1);
  assert.point(ins[0].p, [0, 150], 1e-6);
  assert.near(Math.abs(Math.cos(ins[0].rot)), 1, 1e-3, 'bloc tangent à l’arc (horizontal au sommet)');
  void arc;
  // Ligne de repère : flèche, deux points, note.
  await run('LE', '200,0', '220,20', '', 'Gaine à calorifuger');
  const t = all(doc).find((e) => e.type === 'TEXT');
  assert.equal(t.text, 'Gaine à calorifuger');
  assert.ok(all(doc).some((e) => e.type === 'SOLID'), 'flèche');
  editor.settings.osnap = true;
});

test('PRESENTATION et FMULT : présentation A3 (mise en page, fenêtre automatique), fenêtre au 1:100, DXF', async () => {
  const doc = fresh();
  doc.header.insunits = 4;
  const switched = [];
  editor.ui.onSpaces = (id) => { switched.push(id); doc.currentSpace = id; renderer.setSpace(id); };
  await run('L', '0,0', '20000,0', '20000,10000', '');
  await run('PRESENTATION', 'Plan CVC', 'A3');
  assert.equal(switched.length, 1);
  const layout = doc.spaces.find((s) => s.label === 'Plan CVC');
  assert.ok(layout, 'présentation ajoutée');
  assert.deepEqual([layout.plot.paper, layout.plot.w, layout.plot.h], ['A3', 420, 297], 'mise en page A3 paysage');
  const auto = [...doc.entities.values()].filter((e) => e.space === layout.id);
  assert.equal(auto.length, 1, 'fenêtre automatique');
  assert.equal(auto[0].type, 'VIEWPORT');
  assert.near(auto[0].vh / auto[0].h, 50, 1e-9, 'échelle normalisée qui tient (1:50)');
  await run('FMULT', '20,20', '400,277', '100');
  const vp = [...doc.entities.values()].filter((e) => e.type === 'VIEWPORT').pop();
  assert.ok(vp && vp.space === layout.id);
  assert.near(vp.vh / vp.h, 100, 1e-9);
  assert.point(vp.vc, [10000, 5000], 1e-9);
  assert.equal(renderer.viewports.length, 2);
  doc.undo();
  doc.undo();
  assert.ok(!doc.spaces.some((s) => s.label === 'Plan CVC'), 'PRESENTATION annulée d’un coup (présentation et fenêtre)');
  doc.redo();
  doc.redo();
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const bl = back.spaces.find((s) => s.label === 'Plan CVC');
  assert.ok(bl);
  assert.deepEqual([bl.plot?.paper, bl.plot?.w, bl.plot?.h, ...bl.plot.origin], ['A3', 420, 297, 0, 0], 'mise en page relue');
  assert.equal([...back.entities.values()].filter((e) => e.type === 'VIEWPORT').length, 2);
  delete editor.ui.onSpaces;
  doc.currentSpace = 'model';
  renderer.setSpace('model');
});

test('mise en page : feuille personnalisée annulable, PDF de la feuille au 1:1, feuille lue des limites', async () => {
  const doc = fresh();
  doc.header.insunits = 4;
  editor.ui.onSpaces = (id) => { doc.currentSpace = id; renderer.setSpace(id); };
  await run('L', '0,0', '10000,0', '');
  await run('PRESENTATION', 'P', 'A3');
  const { sheetOf, printableRect, formatOf, fittingScale, scaleLabel } = await import('../src/layout/sheet.js');
  const spOf = () => doc.spaces.find((s) => s.label === 'P');
  const id = spOf().id;
  doc.transaction('Mise en page', () => doc.updateSpace(id, { plot: { ...spOf().plot, paper: 'Personnalisé', w: 1000, h: 600, margins: [5, 5, 5, 5] } }));
  assert.equal(sheetOf(spOf()).w, 1000);
  assert.deepEqual(printableRect(sheetOf(spOf())), { minX: 5, minY: 5, maxX: 995, maxY: 595 });
  doc.undo();
  assert.equal(sheetOf(spOf()).w, 420, 'mise en page annulée');
  doc.redo();
  const sheet = sheetOf(spOf());
  renderer.setSpace(id, sheet);
  assert.equal(renderer.sheet3d.children.length, 2, 'feuille et ombre affichées');
  const { plotPdf } = await import('../src/io/pdf.js');
  const r = await plotPdf(renderer, doc, { sheet, mono: true });
  const mb = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(await r.blob.text());
  assert.near(+mb[1], (1000 * 72) / 25.4, 1, 'largeur de page = feuille');
  assert.near(+mb[2], (600 * 72) / 25.4, 1);
  assert.ok(r.segments >= 4, `fenêtre tracée (${r.segments} traits)`);
  // Présentation d'un DWG : feuille prise dans les limites, format reconnu.
  const fromLimits = sheetOf({ id: 'x', limits: { min: [-0.79, -0.79], max: [840.21, 593.21] } });
  assert.deepEqual([fromLimits.paper, fromLimits.w, fromLimits.h], ['A1', 841, 594]);
  assert.equal(formatOf(297, 420), 'A3');
  assert.equal(fittingScale(20000, 8000, 400, 277, 1), 50);
  assert.equal(scaleLabel(1 / 100, 1), '1:100');
  delete editor.ui.onSpaces;
  doc.currentSpace = 'model';
  renderer.setSpace('model', null);
});

test('repérage d’accrochage : alignement sur un point acquis, intersection de deux alignements, distance tapée', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '100,50', '');
  editor.settings.osnap = true;
  editor.settings.otrack = true;
  editor.run('L');
  await tick();
  editor.acquire([0, 0]);
  const at = (x, y) => editor.computeCursor(renderer.toScreen(x, y));
  at(0.4, 80);
  assert.point(editor.cursor.world, [0, 80], 1e-9, 'alignement vertical sur (0,0)');
  editor.acquire([100, 50]);
  at(0.3, 49.6);
  assert.point(editor.cursor.world, [0, 50], 1e-9, 'intersection des deux alignements');
  // Distance tapée le long de l'alignement vertical de (0,0) : 30 vers le haut.
  at(0.4, 80);
  await type('30');
  await type('60,30', '');
  const l = all(doc).at(-1);
  assert.point(l.p1, [0, 30], 1e-9);
  assert.equal(editor.tracked.length, 0, 'points acquis oubliés en fin de commande');
});

test('repérage d’accrochage : survol repris après un départ, commandes successives, poignées et Échap', async () => {
  const doc = fresh();
  await run('L', '0,0', '100,0', '');
  editor.settings.osnap = true;
  editor.settings.otrack = true;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = (x, y) => editor.computeCursor(renderer.toScreen(x, y));
  editor.run('L');
  await tick();
  // Survol bref de (0,0), départ, puis retour prolongé : le point est acquis.
  at(0.2, 0.1); await wait(100);
  at(50, 40); await wait(50);
  at(0.2, 0.1); await wait(450);
  assert.equal(editor.tracked.length, 1, 'acquis au deuxième survol');
  // Survol à nouveau après être parti : abandon du point.
  at(50, 40); at(0.2, 0.1); await wait(450);
  assert.equal(editor.tracked.length, 0, 'abandonné au survol suivant');
  editor.cancel();
  await tick();
  // Commande suivante : le même point peut être acquis à nouveau.
  editor.run('L');
  await tick();
  at(0.2, 0.1); await wait(450);
  assert.equal(editor.tracked.length, 1, 'acquis dans la commande suivante');
  // Une nouvelle commande lancée par-dessus oublie les points acquis.
  editor.run('L');
  await tick();
  assert.equal(editor.tracked.length, 0, 'commande relancée');
  at(50, 40);
  editor.cancel();
  await tick();
  // Fin d'un étirement par poignée : points acquis oubliés.
  const line = all(doc)[0];
  editor.tracked = [[0, 0]];
  editor.dragGrip = { id: line.id, grip: { k: 'p2', p: [100, 0] } };
  at(100, 30);
  editor.click(false);
  assert.equal(editor.tracked.length, 0, 'étirement terminé');
  editor.tracked = [[0, 0]];
  editor.cancel();
  assert.equal(editor.tracked.length, 0, 'Échap');
});

test('cotes associatives : étirer, déplacer, rayon modifié, un seul annuler', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  const line = all(doc)[0];
  await run('COTLIN', '0,0', '100,0', '50,20');
  const dim = all(doc).find((e) => e.type === 'BLOCKREF');
  assert.ok(dim.meta.assoc[0] && dim.meta.assoc[1], 'points accrochés à la ligne');
  // Étirer l'extrémité droite à x = 150.
  doc.transaction('étirer', () => doc.update({ ...doc.get(line.id), p2: [150, 0, 0] }));
  let d = doc.get(dim.id);
  assert.near(d.meta.measurement, 150, 1e-9);
  assert.point(d.meta.loc, [50, 20], 1e-9, 'étirement : la ligne de cote reste en place');
  const texts = (blk) => blk.entities.filter((e) => e.type === 'TEXT' || e.type === 'MTEXT').map((e) => e.text).join(' ');
  assert.ok(texts(doc.blocks.get(d.name)).includes('150'), texts(doc.blocks.get(d.name)));
  // Annuler : la ligne ET la cote reviennent.
  doc.undo();
  d = doc.get(dim.id);
  assert.near(d.meta.measurement, 100, 1e-9);
  assert.ok(texts(doc.blocks.get(d.name)).includes('100'));
  // Déplacer la ligne seule : la cote suit.
  editor.setSelection([line.id]);
  await run('M', '0,0', '0,50');
  d = doc.get(dim.id);
  assert.point(d.meta.p1, [0, 50], 1e-9);
  assert.point(d.meta.loc, [50, 70], 1e-9);
  // Déplacer la ligne ET la cote : pas de double déplacement.
  editor.setSelection([line.id, dim.id]);
  await run('M', '0,0', '10,0');
  d = doc.get(dim.id);
  assert.point(G.applyPt(d.m, d.meta.p1), [10, 50], 1e-9);
  // Cote de rayon : le cercle grossit.
  await run('C', '300,0', '20');
  const circle = all(doc).find((e) => e.type === 'CIRCLE');
  editor.setSelection([]);
  await run('COTRAYON');
  await click([320, 0]);
  await type('340,30');
  const rd = all(doc).filter((e) => e.type === 'BLOCKREF').at(-1);
  doc.transaction('rayon', () => doc.update({ ...doc.get(circle.id), r: 35 }));
  assert.near(doc.get(rd.id).meta.measurement, 35, 1e-9);
  editor.settings.osnap = true;
});

test('saisie semi-automatique : préfixes de noms et d’alias, libellés, accents ignorés', async () => {
  const { suggestCommands } = await import('../src/editor/suggest.js');
  const { registerMepCommands } = await import('../src/mep/commands.js');
  registerMepCommands(editor);
  const s = suggestCommands(editor, 'ga', { GAINE: 'Gaine' });
  assert.equal(s[0].name, 'GAINE', JSON.stringify(s));
  assert.equal(s[0].label, 'Gaine');
  assert.equal(suggestCommands(editor, 'L')[0].name, 'LIGNE', 'alias exact en premier');
  assert.ok(suggestCommands(editor, 'debit').some((x) => x.name === 'DEBITS'));
  assert.ok(suggestCommands(editor, 'élli').some((x) => x.name === 'ELLIPSE'), 'accents ignorés');
  assert.deepEqual(suggestCommands(editor, ''), []);
  assert.ok(suggestCommands(editor, 'c').length <= 8);
});

test('attributs : DEFATT, BLOC, INSERER demande les valeurs, conservés en DXF', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('REC', '0,0', '100,40');
  await run('DEFATT', 'repere', 'Repère du local', 'B-101', '10,15', '5');
  await run('DEFATT', 'surface', 'Surface (m²)', '', '10,5', '3');
  const defs = all(doc).filter((e) => e.type === 'ATTDEF');
  assert.equal(defs.length, 2);
  assert.equal(defs[0].tag, 'REPERE');
  editor.setSelection(all(doc).map((e) => e.id));
  await run('B', 'CARTOUCHE', '0,0');
  assert.ok(doc.blocks.get('CARTOUCHE').entities.some((e) => e.type === 'ATTDEF'), 'définitions dans le bloc');
  await run('I', 'CARTOUCHE', '500,500', '2', '0', '', '24,5');
  const ins = all(doc).filter((e) => e.type === 'INSERT').at(-1);
  assert.equal(ins.attribs.length, 2);
  assert.equal(ins.attribs[0].text, 'B-101', 'valeur par défaut acceptée');
  assert.equal(ins.attribs[1].text, '24,5');
  assert.point(ins.attribs[0].p, [520, 530], 1e-9, 'position transformée (échelle 2)');
  assert.ok(renderer.cache.get(ins.id).parts.some((p) => p.texts.some((t) => t.lines[0] === 'B-101')), 'valeur affichée, pas l’étiquette');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  await fetch('/__out/attributs.dxf', { method: 'POST', body: text });
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const bins = [...back.entities.values()].find((e) => e.type === 'INSERT' && e.p[0] === 500);
  assert.deepEqual(bins.attribs.map((a) => [a.tag, a.text]), [['REPERE', 'B-101'], ['SURFACE', '24,5']]);
  assert.equal([...back.blocks.values()].find((b) => b.name === 'CARTOUCHE').entities.filter((e) => e.type === 'ATTDEF').length, 2);
  editor.settings.osnap = true;
});

test('attributs : définition tournée, centrée et invisible conservée en DXF', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = fresh();
  doc.blocks.set('B', { name: 'B', base: [0, 0, 0], entities: [{ type: 'ATTDEF', layer: '0', color: 256, p: [10, 5, 0], h: 2.5,
    rot: Math.PI / 2, text: 'V', tag: 'T', prompt: 'P', invisible: true, align: 'center', valign: 'middle', wf: 1 }] });
  doc.transaction('i', () => doc.add({ type: 'INSERT', name: 'B', layer: '0', color: 256, p: [0, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [] }));
  const text = writeDxf(doc);
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const def = back.blocks.get('B').entities.find((e) => e.type === 'ATTDEF');
  assert.near(def.rot, Math.PI / 2, 1e-9, 'rotation (degrés en DXF)');
  assert.equal(def.invisible, true, 'invisible');
  assert.equal(def.align, 'center');
  assert.equal(def.valign, 'middle');
  assert.equal(def.prompt, 'P');
});

test('attributs invisibles : valeur demandée et conservée (DXF), non dessinée', async () => {
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const doc = fresh();
  doc.blocks.set('EQ', { name: 'EQ', base: [0, 0, 0], entities: [
    { type: 'LINE', layer: '0', color: 256, p1: [0, 0, 0], p2: [10, 0, 0] },
    { type: 'ATTDEF', layer: '0', color: 256, p: [0, 5, 0], h: 2.5, rot: 0, text: '', tag: 'REF', prompt: 'Référence', invisible: true, align: 'left', valign: 'baseline', wf: 1 },
  ] });
  editor.settings.osnap = false;
  await run('I', 'EQ', '100,0', '1', '0', 'VMC-01');
  editor.settings.osnap = true;
  const ins = all(doc).find((e) => e.type === 'INSERT');
  assert.equal(ins.attribs.length, 1);
  assert.equal(ins.attribs[0].text, 'VMC-01');
  assert.equal(ins.attribs[0].invisible, true);
  assert.ok(!renderer.cache.get(ins.id).parts.some((p) => p.texts.length), 'non dessiné');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(writeDxf(doc)).buffer, 'x.dxf')).doc;
  const bi = [...back.entities.values()].find((e) => e.type === 'INSERT');
  assert.deepEqual(bi.attribs.map((a) => [a.tag, a.text, !!a.invisible]), [['REF', 'VMC-01', true]], 'relu depuis le DXF');
});

test('RECHERCHER : textes et attributs, casse, mot entier, remplacement annulable', async () => {
  const { findTexts, replaceTexts } = await import('../src/ui/find.js');
  const doc = fresh();
  doc.transaction('prep', () => {
    doc.add({ type: 'TEXT', layer: '0', p: [0, 0, 0], h: 2.5, rot: 0, text: 'Gaine SOUF 400x200', align: 'left', valign: 'baseline', wf: 1 });
    doc.add({ type: 'MTEXT', layer: '0', p: [0, 10, 0], h: 2.5, rot: 0, text: 'Réseau souf principal', attach: 1, width: 0 });
    doc.add({ type: 'TEXT', layer: '0', p: [0, 20, 0], h: 2.5, rot: 0, text: 'SOUFFLAGE', align: 'left', valign: 'baseline', wf: 1 });
    doc.add({ type: 'INSERT', layer: '0', name: 'X', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [{ type: 'TEXT', tag: 'SYS', text: 'SOUF', p: [0, 0, 0], h: 2 }] });
  });
  assert.equal(findTexts(doc, 'souf').length, 4);
  assert.equal(findTexts(doc, 'souf', { matchCase: true }).length, 1);
  const word = findTexts(doc, 'souf', { wholeWord: true });
  assert.equal(word.length, 3, 'SOUFFLAGE exclu en mot entier');
  const n = replaceTexts(doc, word, 'souf', 'EXT', { wholeWord: true });
  assert.equal(n, 3);
  assert.ok(findTexts(doc, 'Gaine EXT 400x200').length === 1);
  assert.equal(all(doc).find((e) => e.type === 'INSERT').attribs[0].text, 'EXT');
  doc.undo();
  assert.equal(findTexts(doc, 'EXT').length, 0, 'un seul annuler');
});

test('RECHERCHER : codes de mise en forme des MTEXT ignorés, remplacement littéral', async () => {
  const { findTexts, replaceTexts } = await import('../src/ui/find.js');
  const doc = fresh();
  doc.transaction('prep', () => {
    doc.add({ type: 'MTEXT', layer: '0', p: [0, 0, 0], h: 2.5, rot: 0, text: '{\\fArial|b0|i0;Local}\\PAir neuf', attach: 1, width: 0 });
    doc.add({ type: 'TEXT', layer: '0', p: [0, 20, 0], h: 2.5, rot: 0, text: 'abc', align: 'left', valign: 'baseline', wf: 1 });
  });
  const [mt, tx] = all(doc);
  const m = findTexts(doc, 'air', { wholeWord: true });
  assert.equal(m.length, 1, 'mot entier juste après un saut de paragraphe');
  assert.equal(m[0].text, 'Local Air neuf', 'texte affiché sans codes');
  assert.equal(findTexts(doc, 'arial').length, 0, 'le nom de police n’est pas du texte');
  replaceTexts(doc, findTexts(doc, 'a'), 'a', 'o');
  assert.equal(doc.get(mt.id).text, '{\\fArial|b0|i0;Locol}\\Poir neuf', 'codes intacts');
  replaceTexts(doc, findTexts(doc, 'b'), 'b', '$&$1');
  assert.equal(doc.get(tx.id).text, 'o$&$1c', 'remplacement littéral');
});

test('ATTENUER : calques choisis mêlés au fond, puis retour à la normale', async () => {
  const doc = fresh();
  doc.transaction('c', () => { doc.addLayer('FOND', { color: 1 }); doc.addLayer('MEP', { color: 1 }); });
  doc.transaction('e', () => {
    doc.add({ type: 'LINE', layer: 'FOND', p1: [0, 0, 0], p2: [100, 0, 0] });
    doc.add({ type: 'LINE', layer: 'MEP', p1: [0, 10, 0], p2: [100, 10, 0] });
  });
  const [fond] = all(doc);
  const colorOf = (layer) => {
    const chunk = renderer.chunks.find((c) => c.layer === layer);
    const line = chunk.group.children.find((o) => o.isLineSegments);
    return [...line.geometry.attributes.color.array.slice(0, 3)];
  };
  const before = colorOf('FOND');
  editor.setSelection([fond.id]);
  await run('FADE', 'c', '50');
  const faded = colorOf('FOND');
  assert.ok(JSON.stringify(faded) !== JSON.stringify(before), 'couleur du fond atténuée');
  assert.deepEqual(colorOf('MEP'), before, 'les autres calques ne changent pas');
  await run('FADE', 'd');
  assert.deepEqual(colorOf('FOND'), before);
});

test('HACHURES : motifs Grille et Lignes', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('REC', '0,0', '100,50');
  await run('H', 'g', '10');
  await click([20, 20]);
  await type('');
  const h = all(doc).find((e) => e.type === 'HATCH');
  assert.equal(h.pattern, 'GRILLE');
  assert.equal(h.lines.length, 2);
  const segs = renderer.cache.get(h.id).parts.reduce((n, p) => n + p.segs.length / 6, 0);
  assert.ok(segs >= 4 + 9, `${segs} segments (lignes de la grille)`);
  editor.settings.osnap = true;
});

test('contours (relecture) : îlot sur la demi-droite compté une fois, îlot tracé depuis son coin haut gauche, grandes coordonnées', async () => {
  const { findBoundary } = await import('../src/editor/boundary.js');
  const rect = (x0, y0, x1, y1, startTopLeft = false) => ({
    type: 'LWPOLYLINE', layer: '0', closed: true, z: 0, bulges: [0, 0, 0, 0],
    pts: startTopLeft ? [[x0, y1], [x1, y1], [x1, y0], [x0, y0]] : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  });
  const area = (poly) => Math.abs(poly.reduce((acc, p, i) => { const q = poly[(i + 1) % poly.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  // Îlot à droite du point (sur la demi-droite) : une seule fois.
  let b = findBoundary([rect(0, 0, 100, 60), rect(50, 20, 70, 40)], [10, 30]);
  assert.equal(b.islands.length, 1, `îlots : ${b.islands.length}`);
  // Îlot hors de la demi-droite, tracé depuis son coin haut gauche (RECTANG) : trouvé.
  b = findBoundary([rect(0, 0, 100, 60), rect(30, 40, 50, 55, true)], [10, 10]);
  assert.equal(b.islands.length, 1, 'îlot hors demi-droite');
  assert.near(area(b.islands[0]), 300, 1e-6);
  // Grandes coordonnées (géoréférencées) : lignes croisées en dépassement.
  const X = 1.2e6, Y = 6.5e6;
  const L = (x1, y1, x2, y2) => ({ type: 'LINE', layer: '0', p1: [X + x1, Y + y1, 0], p2: [X + x2, Y + y2, 0] });
  b = findBoundary([L(-5, 0, 105, 0), L(100, -5, 100.0000001, 65), L(105, 60, -5, 60.0000002), L(0, 65, 0, -5)], [X + 50, Y + 30]);
  assert.ok(b, 'contour trouvé malgré les grandes coordonnées');
  assert.near(area(b.outer), 6000, 1e-2);
});

test('cotes associatives (relecture) : copie indépendante, rotation conservée', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  const line = all(doc)[0];
  await run('COTLIN', '0,0', '100,0', '50,20');
  const dim = all(doc).find((e) => e.type === 'BLOCKREF');
  // Copier la ligne et sa cote, puis étirer l'original : la copie ne bouge pas.
  editor.setSelection([line.id, dim.id]);
  await run('CO', '0,0', '0,50', '');
  const copy = all(doc).filter((e) => e.type === 'BLOCKREF').find((e) => e.id !== dim.id);
  assert.ok(!copy.meta.assoc, 'la copie n’est plus liée aux originaux');
  const copyBlock = copy.name;
  doc.transaction('étirer', () => doc.update({ ...doc.get(line.id), p2: [150, 0, 0] }));
  assert.near(doc.get(dim.id).meta.measurement, 150, 1e-9);
  assert.equal(doc.get(copy.id).name, copyBlock, 'bloc de la copie intact');
  assert.ok(doc.blocks.get(copyBlock).entities.some((e) => (e.text || '').includes('100')), 'la copie affiche toujours 100');
  // Tourner la ligne et sa cote de 90° : la cote mesure toujours la longueur.
  editor.setSelection([line.id, dim.id]);
  await run('RO', '0,0', '90');
  const d = doc.get(dim.id);
  assert.near(d.meta.measurement, 150, 1e-6, 'pas d’effondrement à 0');
  editor.settings.osnap = true;
});

test('PURGER / SUPPRDOUBLONS (relecture) : calque des attributs gardé, bouches empilées différentes gardées', async () => {
  const { findOverkill } = await import('../src/editor/cleanup.js');
  const doc = fresh();
  doc.transaction('prep', () => {
    doc.addLayer('ATTR');
    doc.blocks.set('CART', { name: 'CART', base: [0, 0, 0], entities: [{ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [10, 0, 0] }] });
    doc.add({ type: 'INSERT', name: 'CART', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [{ type: 'TEXT', layer: 'ATTR', tag: 'N', text: 'A', p: [0, 0, 0], h: 2 }] });
  });
  await run('PU');
  assert.ok(doc.layers.has('ATTR'), 'calque utilisé par un attribut conservé');
  const a = { id: 1, type: 'INSERT', name: 'T', layer: '0', p: [0, 0, 0], sx: 1, sy: 1, rot: 0, space: 'model', mep: { kind: 'terminal', system: 'SOUF', q: 100 } };
  const b = { ...a, id: 2, mep: { kind: 'terminal', system: 'SOUF', q: 200 } };
  assert.equal(findOverkill([a, b]).remove.length, 0, 'débits différents : pas un doublon');
  assert.equal(findOverkill([a, { ...a, id: 3 }]).remove.length, 1);
});

test('PUBLIER : une page PDF par présentation, vue rétablie', async () => {
  const { plotPages } = await import('../src/io/pdf.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { doc } = importDatabase(await readDrawing(await sample('Site Layout Plan.dwg'), 'x.dwg'));
  renderer.setDocument(doc);
  editor.setDocument(doc);
  const before = { ...renderer.center };
  const pages = doc.spaces.filter((s) => s.id !== 'model').map((s) => ({ space: s.id, paper: 'A3', landscape: true, mono: true, title: s.label }));
  const r = await plotPages(renderer, doc, pages);
  assert.equal(r.pages.length, 4);
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await r.blob.arrayBuffer()));
  assert.equal((txt.match(/\/Type \/Page\b/g) || []).length, 4, 'quatre pages');
  assert.equal(renderer.space, 'model', 'espace rétabli');
  assert.point([renderer.center.x, renderer.center.y], [before.x, before.y], 1e-9, 'vue rétablie');
});

test('Propriétés : position, rotation et échelle d’un bloc emmènent ses attributs', () => {
  const e = { type: 'INSERT', name: 'B', layer: '0', p: [0, 0], sx: 1, sy: 1, rot: 0,
    attribs: [{ type: 'TEXT', layer: '0', p: [10, 5, 0], h: 2.5, rot: 0, text: 'X', tag: 'T' }] };
  assert.ok(setGeometry(e, 'px', '100'));
  assert.point(e.attribs[0].p, [110, 5], 1e-9, 'position');
  assert.ok(setGeometry(e, 'rot', '90'));
  assert.point(e.attribs[0].p, [95, 10], 1e-9, 'rotation autour du point d’insertion');
  assert.near(e.attribs[0].rot, Math.PI / 2, 1e-9);
  assert.ok(setGeometry(e, 'sx', '2'));
  assert.ok(setGeometry(e, 'sy', '2'));
  assert.point(e.attribs[0].p, [90, 20], 1e-9, 'échelle');
  assert.near(e.attribs[0].h, 5, 1e-9, 'hauteur du texte mise à l’échelle');
});

test('invite de distance sans point de base : un point désigné demande un deuxième point (ATTENUER)', async () => {
  const doc = fresh();
  doc.transaction('e', () => doc.add({ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [100, 0, 0] }));
  editor.settings.osnap = false;
  await run('FADE', 'Xrefs', '0,0', '50,0');
  assert.near(renderer.fade.amount, 0.5, 1e-9, 'tapé : 50 entre les deux points');
  editor.run('FADE');
  await tick();
  await type('Xrefs');
  editor.computeCursor(renderer.toScreen(0, 0)); editor.click(false);
  await tick();
  editor.computeCursor(renderer.toScreen(30, 0)); editor.click(false);
  await tick(); await tick();
  assert.ok(Math.abs(renderer.fade.amount - 0.3) < 0.02, `cliqué : ${renderer.fade.amount}`);
  renderer.setFade(null);
  editor.settings.osnap = true;
});

test('RACCORD : ligne et cercle (cercle conservé), chanfrein refusé sur un arc, annuler', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('C', '0,0', '50');
  await run('L', '-200,-60', '200,-60', '');
  await run('F', 'r', '20');
  await click([150, -60]);
  await click([35.36, -35.36]);
  await tick();
  const arc = all(doc).find((e) => e.type === 'ARC');
  assert.ok(arc, 'arc de raccord');
  assert.near(arc.r, 20);
  assert.near(G.dist(arc.c, [0, 0]), 70, 1e-6, 'tangent au cercle');
  const line = all(doc).find((e) => e.type === 'LINE');
  assert.near(line.p1[0], Math.sqrt(70 * 70 - 40 * 40), 1e-6, 'ligne coupée');
  assert.ok(all(doc).some((e) => e.type === 'CIRCLE' && e.r === 50), 'cercle entier');
  doc.undo();
  assert.equal(all(doc).filter((e) => e.type === 'ARC').length, 0, 'un seul annuler');
  log.length = 0;
  await run('CHA', 'd', '10', '10');
  await click([150, -60]);
  await click([35.36, -35.36]);
  await tick();
  assert.ok(log.some((m) => m.includes('ne se chanfreinent pas')), log.join(' | '));
  editor.settings.osnap = true;
});

test('RESEAU : rectangulaire, polaire (avec et sans rotation), trajectoire, un seul annuler', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '10,0', '');
  const line = all(doc)[0];
  editor.setSelection([line.id]);
  await run('AR', 'r', '3', '2', '20', '50');
  let ls = all(doc).filter((e) => e.type === 'LINE');
  assert.equal(ls.length, 6, '3 colonnes × 2 lignes');
  assert.ok(ls.some((e) => G.dist(e.p1, [40, 50]) < 1e-9 && G.dist(e.p2, [50, 50]) < 1e-9), 'dernière copie en (40, 50)');
  doc.undo();
  assert.equal(all(doc).length, 1, 'un seul annuler');
  // Polaire : 4 éléments sur 360° autour de (0, 0), avec rotation.
  editor.setSelection([line.id]);
  await run('AR', 'p', '0,0', '4', '360', 'o');
  ls = all(doc).filter((e) => e.type === 'LINE');
  assert.equal(ls.length, 4);
  assert.ok(ls.some((e) => G.dist(e.p2, [0, 10]) < 1e-9), 'copie à 90°');
  assert.ok(ls.some((e) => G.dist(e.p2, [-10, 0]) < 1e-9), 'copie à 180°');
  doc.undo();
  // Polaire sans rotation, 3 éléments sur 180° : le centre de la ligne (5, 0) tourne, la ligne reste horizontale.
  editor.setSelection([line.id]);
  await run('AR', 'p', '0,0', '3', '180', 'n');
  ls = all(doc).filter((e) => e.type === 'LINE');
  assert.ok(ls.some((e) => G.dist(e.p1, [-5, 5]) < 1e-9 && G.dist(e.p2, [5, 5]) < 1e-9), 'à 90°, sans rotation');
  assert.ok(ls.some((e) => G.dist(e.p1, [-10, 0]) < 1e-9 && G.dist(e.p2, [0, 0]) < 1e-9), 'à 180°');
  doc.undo();
  // Trajectoire : 3 éléments le long d'une ligne verticale de 100, alignés.
  await run('L', '200,0', '200,100', '');
  const path = all(doc).find((e) => e.type === 'LINE' && e.p1[0] === 200);
  editor.setSelection([line.id]);
  editor.run('AR');
  await tick();
  await type('t');
  await click([200, 50]);
  await type('0,0', '3', 'n');
  await tick();
  ls = all(doc).filter((e) => e.type === 'LINE' && e.id !== path.id && e.id !== line.id);
  assert.deepEqual(ls.map((e) => [e.p1[0], e.p1[1]]).sort((a, b) => a[1] - b[1]), [[200, 0], [200, 50], [200, 100]]);
  editor.settings.osnap = true;
});

test('MODIFLONG (delta, pourcentage, total ; lignes et arcs), COUPUREPOINT, ECHLTP, ID, COUPERPRESSE', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  const line = all(doc)[0];
  await run('LEN', 'd', '50');
  await click([90, 0]);
  await type('');
  assert.point(doc.get(line.id).p2, [150, 0], 1e-9, 'delta +50 côté désigné');
  await run('LEN', 'p', '50');
  await click([5, 0]);
  await type('');
  assert.point(doc.get(line.id).p1, [75, 0], 1e-9, '50 % : départ déplacé');
  await run('LEN', 't', '200');
  await click([140, 0]);
  await type('');
  assert.near(G.dist(doc.get(line.id).p1, doc.get(line.id).p2), 200, 1e-9, 'longueur totale');
  // Arc de 90° R 100 : + 100 × π / 4 → 135°.
  await run('A', 'c', '0,500', '100,500', '0,600');
  const arc = all(doc).find((e) => e.type === 'ARC');
  await run('LEN', 'd', String((100 * Math.PI) / 4));
  await click([0, 600]);
  await type('');
  assert.near(G.sweep(doc.get(arc.id).a0, doc.get(arc.id).a1), (3 * Math.PI) / 4, 1e-9, 'arc allongé');
  // COUPUREPOINT : la ligne est scindée en deux.
  const n0 = all(doc).length;
  await run('BRP');
  await click([200, 0]);
  await type('200,0');
  assert.equal(all(doc).length, n0 + 1, 'deux morceaux');
  // ECHLTP.
  await run('LTS', '25');
  assert.equal(doc.header.ltscale, 25);
  // ID.
  log.length = 0;
  await run('ID', '12,34');
  assert.ok(log.some((m) => m.includes('X = 12') && m.includes('Y = 34')), log.join(' | '));
  // COUPERPRESSE : copie puis efface, un seul annuler.
  editor.setSelection([arc.id]);
  await run('CUTCLIP');
  assert.equal(doc.get(arc.id), undefined, 'coupé');
  doc.undo();
  assert.ok(doc.get(arc.id), 'annuler le rétablit');
  editor.settings.osnap = true;
});

test('COTCONT et COTLIGNEBASE : cotes enchaînées et décalées', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('DLI', '0,0', '100,0', '50,20');
  await run('DCO', '250,0', '400,0', '');
  const dims = () => all(doc).filter((e) => e.type === 'BLOCKREF' && e.kind === 'DIMENSION').map((e) => e.meta);
  let d = dims();
  assert.deepEqual(d.map((m) => Math.round(m.measurement)), [100, 150, 150]);
  assert.point(d[1].p1, [100, 0], 1e-9, 'continue depuis la 2e ligne d’attache');
  assert.point(d[2].p1, [250, 0], 1e-9);
  assert.ok(d.every((m) => Math.abs(m.loc[1] - 20) < 1e-9), 'même ligne de cote');
  // Ligne de base depuis la première cote (la dernière créée est la base par défaut : on choisit la première).
  const first = all(doc).find((e) => e.kind === 'DIMENSION' && Math.round(e.meta.measurement) === 100);
  editor.run('DBA');
  await tick();
  await type('c');
  editor.setSelection([]);
  await click([50, 20]);
  await type('250,0', '400,0', '');
  d = dims().slice(3);
  assert.deepEqual(d.map((m) => Math.round(m.measurement)), [250, 400]);
  assert.ok(d.every((m) => G.dist(m.p1, [0, 0]) < 1e-9), 'toutes depuis la première ligne d’attache');
  assert.ok(d[0].loc[1] > 20 && d[1].loc[1] > d[0].loc[1], 'décalées vers l’extérieur');
  assert.ok(first);
  editor.settings.osnap = true;
});

test('NUAGEREV : rectangle et objet (cercle), arcs vers l’extérieur', async () => {
  const { revisionCloud } = await import('../src/editor/commands.js');
  const c = revisionCloud([[0, 0], [1000, 0], [1000, 500], [0, 500]], 100);
  assert.equal(c.pts.length, 30, 'périmètre 3000 / 100');
  assert.ok(c.closed && c.bulges.every((b) => b === 0.5));
  // Sommets sur le contour, et le milieu de chaque arc à l'extérieur du rectangle.
  const onEdge = (p) => Math.min(Math.abs(p[0]), Math.abs(p[0] - 1000), Math.abs(p[1]), Math.abs(p[1] - 500)) < 1e-9;
  assert.ok(c.pts.every(onEdge));
  const inside = (p) => p[0] > 1e-6 && p[0] < 1000 - 1e-6 && p[1] > 1e-6 && p[1] < 500 - 1e-6;
  for (let i = 0; i < c.pts.length; i++) {
    const a = c.pts[i], b = c.pts[(i + 1) % c.pts.length];
    const arc = G.bulgeToArc(a, b, 0.5);
    const mid = G.polar(arc.c, G.arcMidAngle(arc.a0, arc.a1), arc.r);
    assert.ok(!inside(mid), `arc ${i} vers l’extérieur`);
  }
  // Sens horaire en entrée : retourné.
  assert.equal(revisionCloud([[0, 0], [0, 500], [1000, 500], [1000, 0]], 100).pts.length, 30);
  // Commande sur un cercle : remplacé par une polyligne fermée.
  const doc = fresh();
  editor.settings.osnap = false;
  await run('C', '0,0', '100');
  const circ = all(doc)[0];
  await run('NUAGEREV', 'l', '50');
  editor.run('NUAGEREV');
  await tick();
  await type('o');
  await click([100, 0]);
  await tick();
  const pl = doc.get(circ.id);
  assert.equal(pl.type, 'LWPOLYLINE');
  assert.ok(pl.closed && pl.pts.length >= 12 && pl.pts.length <= 13, `${pl.pts.length} arcs`);
  assert.ok(!('c' in pl) && !('r' in pl), 'plus de centre ni de rayon');
  editor.settings.osnap = true;
});

test('ALIGNER (déplacement, rotation, mise à l’échelle) et MODIFTEXTE (texte, attributs)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  const l = all(doc)[0];
  editor.setSelection([l.id]);
  await run('AL', '0,0', '500,500', '100,0', '500,700', 'o');
  let e = doc.get(l.id);
  assert.point(e.p1, [500, 500], 1e-9);
  assert.point(e.p2, [500, 700], 1e-9, 'tournée de 90° et mise à l’échelle × 2');
  editor.setSelection([l.id]);
  await run('AL', '500,500', '0,0', '');
  e = doc.get(l.id);
  assert.point(e.p1, [0, 0], 1e-9, 'déplacement seul');
  assert.point(e.p2, [0, 200], 1e-9);
  // MODIFTEXTE.
  doc.transaction('t', () => {
    doc.add({ type: 'TEXT', layer: '0', p: [1000, 0, 0], h: 10, rot: 0, text: 'Ancien', align: 'left', valign: 'baseline', wf: 1 });
    doc.add({ type: 'INSERT', layer: '0', name: 'X', p: [2000, 0, 0], sx: 1, sy: 1, rot: 0, attribs: [{ type: 'TEXT', layer: '0', tag: 'REF', text: 'A', p: [2000, 0, 0], h: 10, rot: 0 }] });
  });
  const tx = all(doc).find((x) => x.type === 'TEXT');
  editor.run('ED');
  await tick();
  await click([1010, 3]);
  await type('Nouveau');
  await type('');
  assert.equal(doc.get(tx.id).text, 'Nouveau');
  editor.settings.osnap = true;
});

test('Relecture : RECHERCHER (caractères codés, échappement MTEXT, compte), épaisseur DuBloc imbriquée, raccord au bout d’un arc, crochet en erreur', async () => {
  const { findTexts, replaceTexts } = await import('../src/ui/find.js');
  const doc = fresh();
  doc.transaction('prep', () => {
    doc.add({ type: 'MTEXT', layer: '0', p: [0, 0, 0], h: 2.5, rot: 0, text: 'R\\U+00E9seau %%c250', attach: 1, width: 0 });
    doc.add({ type: 'TEXT', layer: '0', p: [0, 20, 0], h: 2.5, rot: 0, text: 'Gaine %%c250', align: 'left', valign: 'baseline', wf: 1 });
  });
  const [mt, tx] = all(doc);
  assert.equal(findTexts(doc, 'Ø250').length, 2, 'trouvé sur le texte décodé (TEXT et MTEXT)');
  assert.equal(replaceTexts(doc, findTexts(doc, 'Ø250'), 'Ø250', 'X'), 0, 'caractère codé : rien de modifié ni compté');
  replaceTexts(doc, findTexts(doc, 'u'), 'u', 'v');
  assert.equal(doc.get(mt.id).text, 'R\\U+00E9seav %%c250', 'code \\U+ intact');
  replaceTexts(doc, findTexts(doc, 'c'), 'c', 'k');
  assert.equal(doc.get(tx.id).text, 'Gaine %%c250', '%%c intact');
  replaceTexts(doc, findTexts(doc, 'seav'), 'seav', 'a{b}\\c');
  assert.equal(doc.get(mt.id).text, 'R\\U+00E9a\\{b\\}\\\\c %%c250', 'remplacement échappé dans le MTEXT');
  // Épaisseur DuBloc dans un bloc imbriqué sur le calque 0 : celle du calque de l'insertion extérieure.
  const { Tessellator } = await import('../src/core/tessellate.js');
  const { partLineweight } = await import('../src/core/document.js');
  doc.blocks.set('INNER', { name: 'INNER', base: [0, 0, 0], entities: [{ type: 'LINE', layer: '0', color: 256, lweight: -2, p1: [0, 0, 0], p2: [10, 0, 0] }] });
  doc.blocks.set('OUTER', { name: 'OUTER', base: [0, 0, 0], entities: [{ type: 'INSERT', name: 'INNER', layer: '0', color: 256, p: [0, 0, 0], sx: 1, sy: 1, rot: 0 }] });
  doc.transaction('x', () => { doc.addLayer('XL', { lweight: 25 }); doc.add({ type: 'INSERT', name: 'OUTER', layer: 'XL', color: 256, p: [0, 0, 0], sx: 1, sy: 1, rot: 0 }); });
  const ins = all(doc).find((e) => e.name === 'OUTER');
  assert.deepEqual(new Tessellator(doc).entity(ins).map((p) => partLineweight(doc, p)), [25]);
  // Raccord : point désigné juste au-delà du bout de l'arc (5° pour un arc 10° → 180°).
  const { filletCurves } = await import('../src/core/path.js');
  const arc = { type: 'ARC', layer: '0', c: [0, 0, 0], r: 50, a0: (10 * Math.PI) / 180, a1: Math.PI };
  const vline = { type: 'LINE', layer: '0', p1: [55, -100, 0], p2: [55, 100, 0] };
  const r = filletCurves(arc, [49.8, 4.4], vline, [55, 60], 10);
  assert.near((r.e1.a0 * 180) / Math.PI, 10, 1e-6, 'bout conservé');
  assert.near((r.e1.a1 * 180) / Math.PI, (Math.atan2(Math.sqrt(3600 - 2025), 45) * 180) / Math.PI, 1e-6, 'coupé au point de tangence');
  // Crochet en erreur : la transaction se termine quand même et reste annulable.
  const d2 = fresh();
  d2.commitHooks.push(() => { throw new Error('test'); });
  d2.transaction('a', () => d2.add({ type: 'LINE', layer: '0', p1: [0, 0, 0], p2: [1, 0, 0] }));
  assert.equal(d2.tx, null, 'transaction fermée');
  assert.equal(d2.entities.size, 1);
  d2.undo();
  assert.equal(d2.entities.size, 0, 'annulable');
});

test('EDITPOLY (fermer, largeur, décurver, joindre, ligne convertie), CALQCOUR, CORRESPCALQUE', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('PL', '0,0', '100,0', '100,100', '');
  const pl = all(doc)[0];
  await run('L', '100,100', '0,100', '');
  const ln = all(doc).find((e) => e.type === 'LINE');
  editor.run('PE'); await tick();
  await click([50, 0]);
  await type('f');
  assert.equal(doc.get(pl.id).closed, true, 'fermée');
  await type('o');
  assert.equal(doc.get(pl.id).closed, false, 'ouverte');
  await type('l', '5');
  assert.equal(doc.get(pl.id).width, 5, 'largeur');
  await type('j');
  editor.setSelection([]);
  await click([50, 100]);
  await type('');
  await type('');
  assert.equal(doc.get(ln.id), undefined, 'ligne jointe');
  assert.equal(doc.get(pl.id).pts.length, 4);
  // Ligne seule convertie en polyligne.
  await run('L', '0,500', '100,500', '');
  const l2 = all(doc).find((e) => e.type === 'LINE');
  editor.run('PE'); await tick();
  await click([50, 500]);
  await type('');
  assert.equal(doc.get(l2.id).type, 'LWPOLYLINE');
  // CALQCOUR / CORRESPCALQUE.
  doc.transaction('c', () => doc.addLayer('MURS', {}));
  doc.transaction('l', () => doc.add({ type: 'LINE', layer: 'MURS', p1: [0, 900, 0], p2: [100, 900, 0] }));
  await run('CALQCOUR');
  await click([50, 900]);
  assert.equal(doc.currentLayer, 'MURS');
  editor.setSelection([l2.id]);
  editor.run('CORRESPCALQUE'); await tick();
  await click([50, 900]);
  await tick();
  assert.equal(doc.get(l2.id).layer, 'MURS');
  editor.settings.osnap = true;
});

test('DROITE / DEMIDROITE : création, emprise du dessin inchangée, déplacement', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,50', '');
  await run('XL', '0,0', '100,100', '0,100', '');
  await run('RAY', '50,0', '50,-10', '');
  const xl = all(doc).filter((e) => e.type === 'XLINE');
  assert.equal(xl.length, 3);
  assert.equal(xl.filter((e) => e.ray).length, 1);
  const ext = renderer.robustExtents();
  assert.ok(ext.maxX - ext.minX < 1000, `emprise sans les droites : ${JSON.stringify(ext)}`);
  editor.setSelection([xl[0].id]);
  await run('M', '0,0', '10,0');
  assert.point(doc.get(xl[0].id).p, [10, 0], 1e-9);
  editor.settings.osnap = true;
});

test('VPCALQUE : calques gelés par fenêtre (affichage, PDF, Propriétés, DXF)', async () => {
  const doc = fresh();
  doc.header.insunits = 4;
  editor.ui.onSpaces = (id) => { doc.currentSpace = id; renderer.setSpace(id); };
  doc.transaction('c', () => { doc.addLayer('ARCHI', {}); doc.addLayer('MEP', {}); });
  doc.transaction('e', () => {
    doc.add({ type: 'LINE', layer: 'ARCHI', p1: [0, 0, 0], p2: [20000, 0, 0] });
    doc.add({ type: 'LINE', layer: 'MEP', p1: [0, 5000, 0], p2: [20000, 5000, 0] });
  });
  await run('PRESENTATION', 'P1', 'A3');
  const vp = all(doc).find((e) => e.type === 'VIEWPORT'); // fenêtre automatique (10 mm du bord)
  editor.settings.osnap = false;
  editor.run('VPCALQUE'); await tick();
  await click([10, 150]);
  await type('g', 'ARCH*');
  editor.settings.osnap = true;
  assert.deepEqual(doc.get(vp.id).frozen, ['ARCHI']);
  // Affichage : groupe du calque masqué pendant le rendu de la fenêtre, puis rétabli.
  renderer.renderViewports();
  const mv = renderer.modelView;
  assert.ok(mv.layerGroups.has('ARCHI') && mv.layerGroups.get('ARCHI').visible, 'rétabli après le rendu');
  // PDF : la ligne du calque gelé n'est pas tracée.
  const { plotPdf } = await import('../src/io/pdf.js');
  const seg = async () => (await plotPdf(renderer, doc, { paper: 'A3', landscape: true, box: { minX: 0, minY: 0, maxX: 420, maxY: 297 }, scale: 1, mono: true, title: 'T' })).segments;
  const n1 = await seg();
  const { setGeometry } = await import('../src/ui/panels.js');
  const e = structuredClone(doc.get(vp.id));
  setGeometry(e, 'vpFrozen', '');
  doc.transaction('libérer', () => doc.update(e));
  assert.equal(doc.get(vp.id).frozen, undefined, 'Propriétés : liste vidée');
  renderer.modelView.dirty = true;
  const n2 = await seg();
  assert.equal(n2, n1 + 1, `une ligne de plus sans gel (${n1} → ${n2})`);
  doc.undo();
  assert.deepEqual(doc.get(vp.id).frozen, ['ARCHI']);
  // DXF : codes 331 vers le calque, relus.
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const text = writeDxf(doc);
  await fetch('/__out/vpfreeze.dxf', { method: 'POST', body: text });
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.deepEqual([...back.entities.values()].find((x) => x.type === 'VIEWPORT')?.frozen, ['ARCHI'], 'relu depuis le DXF');
  delete editor.ui.onSpaces;
  doc.currentSpace = 'model';
  renderer.setSpace('model');
});

test('fenêtres : réglages propres (calques, hachures, échelle, verrouillage), épaisseurs affichées, PDF, DXF, zoom dans la fenêtre', async () => {
  const doc = fresh();
  doc.header.insunits = 4;
  editor.ui.onSpaces = (id) => { doc.currentSpace = id; renderer.setSpace(id); };
  doc.transaction('c', () => { doc.addLayer('MURS', { color: 8, lweight: 50 }); doc.addLayer('GAINES', { color: 1, lweight: 25 }); doc.addLayer('HACH', { color: 3 }); });
  doc.transaction('e', () => {
    doc.add({ type: 'LINE', layer: 'MURS', p1: [0, 0, 0], p2: [12000, 0, 0] });
    doc.add({ type: 'LINE', layer: 'GAINES', p1: [0, 4000, 0], p2: [12000, 4000, 0] });
    doc.add({ type: 'HATCH', layer: 'HACH', solid: true, pattern: 'SOLID', loops: [[[2000, 1000], [5000, 1000], [5000, 3000], [2000, 3000]]], lines: [], z: 0 });
  });
  await run('PRESENTATION', 'VP', 'A3');
  const id = all(doc).find((e) => e.type === 'VIEWPORT').id;
  const { setViewportLayer, overrideCount } = await import('../src/layout/vplayers.js');
  let v = setViewportLayer(doc.get(id), 'GAINES', 'color', 5);
  v = setViewportLayer(v, 'GAINES', 'lweight', 100);
  v = setViewportLayer(v, 'MURS', 'transparency', 50);
  v = setViewportLayer(v, 'HACH', 'frozen', false);
  doc.transaction('Calques de la fenêtre', () => doc.update({ ...v, hatchAlpha: 60 }));
  assert.deepEqual(doc.get(id).layerOvr, { GAINES: { color: 5, lweight: 100 }, MURS: { transparency: 50 } });
  assert.equal(overrideCount(doc.get(id)), 2);
  assert.equal(setViewportLayer(doc.get(id), 'MURS', 'transparency', null).layerOvr.MURS, undefined, 'réglage retiré');
  // Affichage : traits épais par épaisseur, réglages appliqués pendant le rendu de la fenêtre puis rétablis.
  const { sheetOf } = await import('../src/layout/sheet.js');
  const sheet = sheetOf(doc.spaces.find((s) => s.id === doc.currentSpace));
  renderer.setSpace(doc.currentSpace, sheet);
  renderer.setLwDisplay(true);
  const mv = renderer.ensureModelView();
  assert.ok(mv.fat, 'contenu des fenêtres en traits épais');
  const gaine = mv.layerGroups.get('GAINES').children.find((c) => c.userData.kind === 'fat');
  assert.near(gaine.userData.mm, 0.25, 1e-9);
  renderer.applyViewportOverrides(mv, doc.get(id));
  assert.equal(gaine.material.color.getHex(), 0x0000ff, 'couleur imposée');
  assert.near(gaine.material.userData.mm, 1, 1e-9, 'épaisseur imposée');
  const fill = mv.layerGroups.get('HACH').children.find((c) => c.userData.kind === 'fill');
  assert.near(fill.material.opacity, 0.4, 1e-9, 'hachures transparentes à 60 %');
  const mur = mv.layerGroups.get('MURS').children.find((c) => c.userData.kind === 'fat');
  assert.near(mur.material.opacity, 0.5, 1e-9);
  renderer.applyViewportOverrides(mv, null);
  assert.equal(gaine.material, gaine.userData.base, 'rétabli après la fenêtre');
  renderer.renderViewports();
  // PDF : couleur, épaisseur, transparence.
  const { plotPdf } = await import('../src/io/pdf.js');
  const r = await plotPdf(renderer, doc, { sheet, mono: false, lineweights: true });
  const pdfText = await r.blob.text();
  assert.ok(/\/ca 0\.4/.test(pdfText), 'transparence des hachures dans le PDF');
  assert.ok(/1(\.0+)? w/.test(pdfText.replace(/\r/g, '')) || pdfText.includes('2.83 w'), 'épaisseur 1 mm dans le PDF');
  // Échelle normalisée, verrouillage (Propriétés).
  const { setGeometry } = await import('../src/ui/panels.js');
  const e1 = structuredClone(doc.get(id));
  setGeometry(e1, 'vpStd', '100', doc);
  setGeometry(e1, 'vpLock', true, doc);
  doc.transaction('p', () => doc.update(e1));
  assert.near(doc.get(id).vh / doc.get(id).h, 100, 1e-9);
  assert.ok(doc.get(id).locked);
  // Zoom dans une fenêtre verrouillée : refusé ; déverrouillée : une seule étape d'annulation.
  editor.setActiveViewport(id);
  const [sx, sy] = renderer.toScreen(doc.get(id).c[0], doc.get(id).c[1]);
  assert.equal(editor.vpZoom(sx, sy, 2), false, 'verrouillée');
  doc.transaction('p', () => doc.update({ ...doc.get(id), locked: undefined }));
  const vh0 = doc.get(id).vh;
  editor.vpZoom(sx, sy, 2);
  editor.vpZoom(sx, sy, 2);
  editor.vpPan(20, 0);
  assert.near(doc.get(id).vh, vh0 / 4, 1e-6);
  editor.vpCommit();
  doc.undo();
  assert.near(doc.get(id).vh, vh0, 1e-6, 'une annulation rétablit la vue');
  editor.setActiveViewport(null);
  // DXF : réglages de la fenêtre et affichage des épaisseurs relus.
  doc.transaction('p', () => doc.update({ ...doc.get(id), locked: true }));
  doc.header.lwdisplay = true;
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const text = writeDxf(doc);
  await fetch('/__out/vpreglages.dxf', { method: 'POST', body: text });
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  const bv = [...back.entities.values()].find((x) => x.type === 'VIEWPORT');
  assert.deepEqual(bv.layerOvr, { GAINES: { color: 5, lweight: 100 }, MURS: { transparency: 50 } });
  assert.equal(bv.hatchAlpha, 60);
  assert.ok(bv.locked, 'verrouillage (drapeau AutoCAD)');
  assert.ok(back.header.lwdisplay, 'LWDISPLAY');
  renderer.setLwDisplay(false);
  delete editor.ui.onSpaces;
  doc.currentSpace = 'model';
  renderer.setSpace('model', null);
});

test('GROUPE / DEGROUPER : sélection du groupe entier, copie hors groupe, DXF (AutoCAD) relu et réécrit', async () => {
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  // Groupe créé par AutoCAD.
  const ad = importDatabase(await readDrawing(await (await fetch('/tests/fixtures/group.dxf')).arrayBuffer(), 'g.dxf')).doc;
  assert.deepEqual([...ad.entities.values()].filter((e) => e.group).map((e) => [e.type, e.group]).sort(), [['CIRCLE', 'GRP1'], ['LINE', 'GRP1']]);
  // Dans l'application.
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  await run('C', '50,50', '20');
  await run('L', '0,200', '100,200', '');
  const [l1, c1, l2] = all(doc);
  editor.setSelection([l1.id, c1.id]);
  await run('G', 'TUYAUX');
  assert.equal(doc.get(l1.id).group, 'TUYAUX');
  editor.setSelection([]);
  await click([50, 0]);
  assert.deepEqual([...editor.selection].sort(), [l1.id, c1.id].sort(), 'un clic sélectionne tout le groupe');
  await run('CO', '0,0', '0,500', '');
  assert.ok(all(doc).filter((e) => e.group === 'TUYAUX').length === 2, 'les copies ne rejoignent pas le groupe');
  const text = writeDxf(doc);
  await fetch('/__out/groupes.dxf', { method: 'POST', body: text });
  const back = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc;
  assert.equal([...back.entities.values()].filter((e) => e.group === 'TUYAUX').length, 2, 'relu depuis notre DXF');
  editor.setSelection([]);
  editor.run('DEGROUPER'); await tick();
  await click([50, 0]);
  assert.equal(all(doc).filter((e) => e.group).length, 0, 'dissous');
  assert.ok(l2);
  editor.settings.osnap = true;
});

test('FUSIONCALQUE (LAYMRG) et SUPPRCALQUE (LAYDEL) : objets, blocs, calques supprimés, un seul annuler', async () => {
  const doc = fresh();
  doc.transaction('c', () => { doc.addLayer('A-MUR', {}); doc.addLayer('A-CLOISON', {}); doc.addLayer('A-MOBILIER', {}); });
  doc.blocks.set('TABLE', { name: 'TABLE', base: [0, 0, 0], entities: [{ type: 'LINE', layer: 'A-MOBILIER', p1: [0, 0, 0], p2: [10, 0, 0] }, { type: 'LINE', layer: 'A-CLOISON', p1: [0, 5, 0], p2: [10, 5, 0] }] });
  doc.transaction('e', () => {
    doc.add({ type: 'LINE', layer: 'A-MUR', p1: [0, 0, 0], p2: [100, 0, 0] });
    doc.add({ type: 'LINE', layer: 'A-CLOISON', p1: [0, 50, 0], p2: [100, 50, 0] });
    doc.add({ type: 'LINE', layer: 'A-MOBILIER', p1: [0, 100, 0], p2: [100, 100, 0] });
    doc.add({ type: 'INSERT', name: 'TABLE', layer: '0', p: [500, 500, 0], sx: 1, sy: 1, rot: 0, attribs: [] });
  });
  const [mur, cloison] = all(doc);
  editor.settings.osnap = false;
  editor.setSelection([cloison.id]);
  editor.run('LAYMRG'); await tick();
  await click([50, 0]);
  await tick();
  assert.equal(doc.get(cloison.id).layer, 'A-MUR', 'objet déplacé');
  assert.ok(!doc.layers.has('A-CLOISON'), 'calque supprimé');
  assert.ok(doc.blocks.get('TABLE').entities.some((e) => e.layer === 'A-MUR'), 'objets des blocs aussi');
  doc.undo();
  assert.ok(doc.layers.has('A-CLOISON') && doc.get(cloison.id).layer === 'A-CLOISON', 'un seul annuler');
  assert.ok(doc.blocks.get('TABLE').entities.some((e) => e.layer === 'A-CLOISON'), 'bloc rétabli');
  // SUPPRCALQUE : A-MOBILIER et ses objets disparaissent (y compris dans le bloc).
  const mob = all(doc).find((e) => e.layer === 'A-MOBILIER');
  editor.setSelection([mob.id]);
  await run('LAYDEL', 'o');
  assert.ok(!doc.layers.has('A-MOBILIER'));
  assert.equal(doc.get(mob.id), undefined);
  assert.ok(!doc.blocks.get('TABLE').entities.some((e) => e.layer === 'A-MOBILIER'));
  assert.ok(doc.get(mur.id), 'les autres objets restent');
  editor.settings.osnap = true;
});

test('COPIERBASE / COLLER (point de base), COLLERORIG (coordonnées d’origine, d’un dessin à l’autre)', async () => {
  let doc = fresh();
  editor.settings.osnap = false;
  await run('L', '100,100', '200,100', '');
  const l = all(doc)[0];
  editor.setSelection([l.id]);
  await run('COPYBASE', '100,100');
  await run('PASTECLIP', '1000,1000');
  assert.ok(all(doc).some((e) => e.id !== l.id && G.dist(e.p1, [1000, 1000]) < 1e-9 && G.dist(e.p2, [1100, 1000]) < 1e-9), 'collé par rapport au point de base');
  doc = fresh();
  await run('PASTEORIG');
  const e = all(doc)[0];
  assert.point(e.p1, [100, 100], 1e-9, 'collé aux coordonnées d’origine dans un autre dessin');
  editor.settings.osnap = true;
});

test('ISOLEROBJETS / MASQUEROBJETS / FINISOLEROBJETS : masquage temporaire (vue seulement)', async () => {
  const doc = fresh();
  editor.settings.osnap = false;
  await run('L', '0,0', '100,0', '');
  await run('L', '0,50', '100,50', '');
  await run('L', '0,100', '100,100', '');
  const [a, b, c] = all(doc);
  editor.setSelection([a.id]);
  await run('ISOLEROBJETS');
  assert.ok(renderer.cache.has(a.id) && !renderer.cache.has(b.id) && !renderer.cache.has(c.id), 'seul l’objet isolé est affiché');
  assert.equal(renderer.pick([50, 50], 5), null, 'un objet masqué ne se désigne pas');
  // Un objet modifié pendant l'isolement reste masqué ; un nouvel objet est visible.
  doc.transaction('m', () => doc.update({ ...doc.get(b.id), p2: [200, 50, 0] }));
  assert.ok(!renderer.cache.has(b.id));
  await run('L', '0,200', '100,200', '');
  const d = all(doc).at(-1);
  assert.ok(renderer.cache.has(d.id));
  await run('FINISOLEROBJETS');
  assert.ok([a, b, c, d].every((e) => renderer.cache.has(e.id)), 'tout réaffiché');
  editor.setSelection([c.id]);
  await run('MASQUEROBJETS');
  assert.ok(!renderer.cache.has(c.id) && renderer.cache.has(a.id));
  await run('FINISOLER');
  assert.equal(doc.entities.size, 4, 'le dessin n’est pas modifié');
  editor.settings.osnap = true;
});

test('ECHLTP, UNITES, ECHELLEANNO : annulables et rétablissables', async () => {
  const doc = fresh();
  doc.header = { ...doc.header, ltscale: 1, insunits: 4 };
  await run('LTS', '20');
  await run('UN', 'Mètres');
  await run('ECH', '100');
  assert.equal(doc.header.ltscale, 20);
  assert.equal(doc.header.insunits, 6);
  assert.equal(doc.header.annoScale, 100);
  doc.undo();
  assert.equal(doc.header.annoScale, undefined, 'échelle d’annotation annulée');
  doc.undo();
  assert.equal(doc.header.insunits, 4, 'unités annulées');
  doc.undo();
  assert.equal(doc.header.ltscale, 1, 'échelle des types de ligne annulée');
  doc.redo();
  assert.equal(doc.header.ltscale, 20, 'rétabli');
});

test('réglages du dessin : style de point, style de cote, objets courants, précision, formats, DXF', async () => {
  const doc = fresh();
  doc.header.insunits = 4;
  const { Tessellator } = await import('../src/core/tessellate.js');
  const { pointSize, dimStyleOf } = await import('../src/core/drawing-settings.js');
  const { dimSizes, linearDimension } = await import('../src/core/dimension.js');
  // Points : style 34 (plus + cercle), taille relative 3 mm au 1:50.
  doc.setHeader({ pdmode: 34, pdsize: -3 });
  assert.equal(pointSize(doc), 150);
  const pt = { type: 'POINT', layer: '0', p: [0, 0, 0] };
  const parts = new Tessellator(doc).entity(pt);
  assert.equal(parts[0].pts.length, 0, 'pas de point simple');
  assert.ok(parts[0].segs.length > 24, 'plus et cercle dessinés');
  doc.setHeader({ pdmode: 1 });
  assert.equal(new Tessellator(doc).entity(pt).reduce((s, p) => s + p.segs.length + p.pts.length, 0), 0, 'style « rien »');
  // Cotes : traits obliques, mesure en mètres, suffixe.
  doc.setHeader({ dimstyle: { DIMBLK: 'oblique', DIMLFAC: 0.001, DIMPOST: ' m', DIMDEC: 2 } });
  const r = linearDimension({ p1: [0, 0], p2: [4250, 0], loc: [0, 500], rotation: 0, sizes: dimSizes(50, dimStyleOf(doc)) });
  assert.equal(r.entities.find((e) => e.type === 'TEXT').text, '4.25 m');
  assert.ok(!r.entities.some((e) => e.type === 'SOLID'), 'pas de flèches pleines');
  assert.equal(r.entities.filter((e) => e.type === 'LINE').length, 5, 'lignes d’attache, ligne de cote, deux traits obliques');
  // Objets courants : couleur, type de ligne, épaisseur appliqués aux nouveaux objets.
  doc.setHeader({ cecolor: 1, celtype: 'CACHE', celweight: 50 });
  await run('L', '0,0', '100,0', '');
  const l = all(doc).find((e) => e.type === 'LINE');
  assert.deepEqual([l.color, l.ltype, l.lweight], [1, 'CACHE', 50]);
  // Précision d'affichage.
  const { setDisplayPrecision, fmt } = await import('../src/editor/editor.js');
  setDisplayPrecision(2);
  assert.equal(fmt(1.23456), '1.23');
  setDisplayPrecision(4);
  assert.equal(fmt(1.23456), '1.2346');
  // Formats ajoutés par l'utilisateur.
  const sheet = await import('../src/layout/sheet.js');
  const saved = localStorage.getItem('cadviewer.formats');
  sheet.saveUserFormats([{ name: 'Long 1000', w: 1000, h: 297 }]);
  assert.deepEqual(sheet.allFormats()['Long 1000'], [1000, 297]);
  assert.deepEqual([sheet.makePlot('Long 1000', false).w, sheet.makePlot('Long 1000', false).h], [297, 1000], 'portrait');
  assert.equal(sheet.formatOf(297, 1000), 'Long 1000');
  if (saved == null) localStorage.removeItem('cadviewer.formats'); else localStorage.setItem('cadviewer.formats', saved);
  // DXF : réglages relus.
  doc.setHeader({ luprec: 2, auprec: 1, pdmode: 34, pdsize: -3, textsize: 175, celweight: 50 });
  const { writeDxf } = await import('../src/io/dxf-writer.js');
  const { readDrawing } = await import('../src/dwg-loader.js');
  const { importDatabase } = await import('../src/io/importer.js');
  const text = writeDxf(doc);
  await fetch('/__out/reglages.dxf', { method: 'POST', body: text });
  const h = importDatabase(await readDrawing(new TextEncoder().encode(text).buffer, 'x.dxf')).doc.header;
  assert.deepEqual([h.luprec, h.auprec, h.pdmode, h.pdsize, h.textsize, h.cecolor, h.celtype, h.celweight], [2, 1, 34, 150, 175, 1, 'CACHE', 50]);
  assert.deepEqual([h.dimstyle.DIMBLK, h.dimstyle.DIMLFAC, h.dimstyle.DIMPOST, h.dimstyle.DIMDEC, h.dimstyle.DIMTXT], ['oblique', 0.001, ' m', 2, 2.5]);
  assert.equal(h.dimscale, 50, 'échelle des annotations');
  // Commandes de l'onglet Format : la boîte demandée par l'interface, sur le bon onglet.
  const opened = [];
  editor.ui.openSettings = (tab) => opened.push(tab);
  for (const c of ['REGLAGES', 'TYPELIGNE', 'STYLEPOINT', 'STYLECOTE', 'STYLETEXTE', 'FORMATS', 'PREFERENCES']) await run(c);
  assert.deepEqual(opened, ['unites', 'lignes', 'points', 'cotes', 'textes', 'formats', 'preferences']);
  delete editor.ui.openSettings;
});

test('palette Propriétés : mesures (longueur 3D, aires avec arcs), résumé de sélection, champs ajoutés', async () => {
  const { measures, lwpolyArea, selectionRows, setDetail, vertexCursor, detailRows } = await import('../src/ui/props-info.js');
  assert.near(measures({ type: 'LINE', p1: [0, 0, 0], p2: [300, 400, 50] }).length, Math.hypot(300, 400, 50), 1e-9);
  assert.near(measures({ type: 'CIRCLE', c: [0, 0, 0], r: 10 }).area, Math.PI * 100, 1e-9);
  // Carré 10 × 10 (sens trigonométrique) dont un côté est un demi-cercle extérieur (bulge 1) : 100 + π × 5² / 2 ;
  // bulge −1 : demi-cercle rentrant, 100 − π × 5² / 2.
  const pl = { type: 'LWPOLYLINE', pts: [[0, 0], [10, 0], [10, 10], [0, 10]], bulges: [0, 1, 0, 0], closed: true };
  assert.near(lwpolyArea({ ...pl, bulges: [0, -1, 0, 0] }), 100 - (Math.PI * 25) / 2, 1e-9);
  assert.near(lwpolyArea(pl), 100 + (Math.PI * 25) / 2, 1e-9);
  assert.near(measures(pl).length, 30 + Math.PI * 5, 1e-9);
  // Arc : aire du segment (fermé par la corde) d'un quart de cercle de rayon 2.
  assert.near(measures({ type: 'ARC', c: [0, 0, 0], r: 2, a0: 0, a1: Math.PI / 2 }).area, 2 * (Math.PI / 2 - 1), 1e-9);
  const row = (l, f, v) => `<div class="row"><label>${l}</label><span class="ro">${v}</span></div>`;
  const html = selectionRows([{ type: 'LINE', p1: [0, 0], p2: [3, 4] }, { type: 'CIRCLE', c: [0, 0], r: 1 }, { type: 'LINE', p1: [0, 0], p2: [1, 0] }], { row, fmt: (v) => String(Math.round(v * 1000) / 1000) });
  assert.ok(html.includes('<label>Ligne</label><span class="ro">2</span>') && html.includes('Cercle'));
  assert.ok(html.includes(`Longueur totale</label><span class="ro">${Math.round((5 + 1 + 2 * Math.PI) * 1000) / 1000} · 3 objets`));
  // Champs ajoutés : Z, sommet courant d'une polyligne, inclinaison du texte, échelle du type de ligne.
  const ln = { type: 'LINE', p1: [0, 0, 0], p2: [1, 1, 0] };
  assert.equal(setDetail(ln, 'p2z', '7,5'), true);
  assert.deepEqual(ln.p2, [1, 1, 7.5]);
  const poly = { id: 9, type: 'LWPOLYLINE', pts: [[0, 0], [5, 0], [5, 5]], bulges: [0, 0, 0] };
  vertexCursor.set(9, 1);
  assert.equal(setDetail(poly, 'vtxy', '2'), true);
  assert.deepEqual(poly.pts[1], [5, 2]);
  const t = { type: 'TEXT', text: 'a', p: [0, 0, 0], h: 1 };
  assert.equal(setDetail(t, 'obl', '15'), true);
  assert.near(t.obl, (15 * Math.PI) / 180, 1e-12);
  assert.equal(setDetail(ln, 'ltscale', '1'), true);
  assert.equal(ln.ltscale, undefined, 'échelle 1 : valeur par défaut');
  assert.equal(setDetail(ln, 'text', 'x'), null, 'champ traité ailleurs');
  const h = detailRows({ type: 'ELLIPSE', c: [0, 0, 0], major: [10, 0], ratio: 0.5, a0: 0, a1: Math.PI * 2 }, { styles: new Map() }, { row, fmt: (v) => String(Math.round(v * 100) / 100), esc: (x) => x });
  assert.ok(h.includes('Grand rayon') && h.includes(String(Math.round(Math.PI * 10 * 5 * 100) / 100)), 'aire de l’ellipse complète');
});

test('présentation : double-clic dans une fenêtre = travail sur l’espace objet à travers elle (ESPACEO / ESPACEP)', async () => {
  const { installMspace } = await import('../src/layout/mspace.js');
  const { viewportMatrix } = await import('../src/render/viewports.js');
  const { makePlot } = await import('../src/layout/sheet.js');
  const doc = new Document();
  doc.header.insunits = 4;
  const plot = makePlot('A3', true);
  let line, vp;
  doc.transaction('i', () => {
    doc.addLayer('MASQUE', {});
    line = doc.add({ type: 'LINE', layer: '0', color: 256, space: 'model', p1: [0, 0, 0], p2: [10000, 0, 0] });
    doc.add({ type: 'LINE', layer: 'MASQUE', color: 256, space: 'model', p1: [0, 2000, 0], p2: [10000, 2000, 0] });
    doc.setSpaces([...doc.spaces, { id: '*Paper_Space_T', label: 'Feuille', order: 1, plot }]);
    vp = doc.add({ type: 'VIEWPORT', layer: '0', color: 256, space: '*Paper_Space_T', c: [210, 148.5, 0], w: 400, h: 277, vc: [5000, 0], vh: 27700, twist: 0, target: [0, 0], off: false, frozen: ['MASQUE'] });
    doc.add({ type: 'LINE', layer: '0', color: 256, space: '*Paper_Space_T', p1: [10, 10, 0], p2: [100, 10, 0] });
  });
  renderer.setDocument(doc);
  editor.setDocument(doc);
  doc.currentSpace = '*Paper_Space_T';
  renderer.setSpace('*Paper_Space_T', plot);
  const ms = editor.ui.mspace || installMspace({ editor, renderer, getDoc: () => doc, sheetFor: () => plot });
  // Un point de la feuille dans la fenêtre reste au même endroit de l'écran une fois dans la fenêtre.
  const P = [300, 150];
  const sp = renderer.toScreen(P[0], P[1]);
  const [a, , , , e, f] = viewportMatrix(vp);
  const m = [(P[0] - e) / a, (P[1] - f) / a];
  assert.ok(ms.enter(vp.id), 'entrée');
  assert.equal(renderer.space, 'model');
  assert.equal(doc.currentSpace, 'model', 'les objets créés vont dans l’espace objet');
  const sm = renderer.toScreen(m[0], m[1]);
  assert.near(sm[0], sp[0], 1e-6); assert.near(sm[1], sp[1], 1e-6);
  assert.equal(renderer.pick([5000, 0], 50), line.id, 'objet de l’espace objet sélectionnable');
  assert.ok(!renderer.layerVisible('MASQUE'), 'calque gelé dans la fenêtre : masqué');
  assert.ok(ms.contains(sp), `dans la fenêtre ${sp}`);
  assert.ok(!ms.contains([1, 1]), 'hors de la fenêtre');
  // Sortie sans zoom : vue inchangée ; zoom ×2 dedans : la fenêtre montre deux fois moins large.
  ms.exit();
  assert.equal(renderer.space, '*Paper_Space_T');
  assert.equal(doc.get(vp.id).vh, 27700);
  assert.ok(renderer.layerVisible('MASQUE'), 'calque visible sur la feuille');
  ms.enter(vp.id);
  renderer.scale *= 2;
  ms.exit();
  assert.near(doc.get(vp.id).vh, 13850, 1e-6);
  // Fenêtre verrouillée : vue jamais modifiée.
  doc.transaction('lock', () => doc.update({ ...doc.get(vp.id), locked: true }));
  ms.enter(vp.id);
  assert.ok(ms.locked, 'verrouillée');
  renderer.scale *= 3;
  ms.exit();
  assert.near(doc.get(vp.id).vh, 13850, 1e-6);
  doc.currentSpace = 'model';
  renderer.setSpace('model', null);
});
