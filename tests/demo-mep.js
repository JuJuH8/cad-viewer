// SPDX-License-Identifier: GPL-3.0-or-later
// Script de construction de « samples/Démo MEP.dxf » avec les commandes de l'application.
// À coller dans la console de l'application (http://localhost:8000/), ou : await import('/tests/demo-mep.js').
(async () => {
  document.querySelector('#recover button:last-child')?.click();
  window.cad.newDocument();
  const ed = window.cad.editor;
  const doc = window.cad.doc;
  doc.header.insunits = 4;
  ed.settings.osnap = false;
  const t = () => new Promise((r) => setTimeout(r, 15));
  const run = async (...a) => { ed.run(a[0]); await t(); for (const x of a.slice(1)) { ed.submit(x); await t(); } await t(); if (/^(GA|CA|CDC|TUBE)$/.test(a[0]) && ed.running) { ed.submit(''); await t(); await t(); } };
  const pick = async (id, p) => { ed.answer({ id, p }); await t(); };
  const last = () => [...doc.entities.values()].at(-1);

  // Fond de plan (calque A-MURS) : enveloppe, couloir, bureaux, open space, sanitaires, local technique.
  doc.transaction('calques', () => { doc.addLayer('A-MURS', { color: 8 }); doc.addLayer('A-TEXTE', { color: 7 }); doc.addLayer('MEP-NOTES', { color: 2 }); });
  doc.currentLayer = 'A-MURS';
  await run('REC', '-200,-200', '30200,16200');
  await run('REC', '0,0', '30000,16000');
  await run('L', '0,7000', '30000,7000', '');
  await run('L', '0,9000', '30000,9000', '');
  for (const x of [7500, 15000, 22500]) await run('L', `${x},9000`, `${x},16000`, '');
  for (const x of [15000, 21000]) await run('L', `${x},0`, `${x},7000`, '');
  doc.currentLayer = 'A-TEXTE';
  const label = async (x, y, s) => run('TX', `${x},${y}`, '250', '0', s, '');
  for (const [i, x] of [3750, 11250, 18750, 26250].entries()) await label(x - 700, 14800, `Bureau ${i + 1}`);
  await label(6000, 6200, 'Open space');
  await label(16500, 6200, 'Sanitaires');
  await label(23500, 6200, 'Local technique');
  await label(13500, 8350, 'Circulation');
  doc.currentLayer = 'A-MURS';
  await run('REC', '25500,2500', '28500,4500');
  doc.currentLayer = 'A-TEXTE';
  await label(26600, 3400, 'CTA');

  // Soufflage : colonne depuis la CTA puis réseau principal dans le couloir, piquages vers les bureaux et l'open space.
  await run('GA', 'SOUF', '600x300', '2800', '27000,4500', '27000,8000', '1500,8000', '');
  const main = last();
  const branches = [];
  for (const x of [3750, 11250, 18750]) { await run('GA', 'SOUF', '300x200', '2800', `${x},8000`, `${x},12500`, ''); branches.push(last()); }
  for (const x of [2500, 7500, 12500]) await run('GA', 'SOUF', '300x200', '2800', `${x},8000`, `${x},3500`, '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2800', '300', '3750,12500', '11250,12500', '18750,12500', '');
  await run('BOUCHE', 'DIFF', 'SOUF', '600x600', '2800', '450', '2500,3500', '7500,3500', '12500,3500', '');

  // Extraction des sanitaires (circulaire).
  await run('GA', 'EXT', 'Ø250', '2700', '21000,5500', '15500,5500', '');
  const ext = last();
  await run('BOUCHE', 'BOUCHE', 'EXT', '125', '2700', '60', '19500,5500', '17500,5500', '15500,5500', '');

  // Eau froide des sanitaires.
  await run('CA', 'EF', '32', '2300', '21000,1000', '15500,1000', '');
  const ef = last();
  for (const x of [20000, 18500, 17000]) await run('CA', 'EF', '20', '2300', `${x},1000`, `${x},2000`, '');
  await run('APP', 'LAVABO', 'EF', '900', '20000,2000', '18500,2000', '');
  await run('APP', 'WC', 'EF', '900', '17000,2000', '15500,1000', '');

  // Eaux usées : collecteur vers la chute (à l'est) et branchements des appareils.
  await run('CA', 'EU', '100', '0', '21500,300', '15800,300', '');
  const eu = last();
  for (const [x, d] of [[20000, 50], [18500, 50], [17000, 100]]) await run('CA', 'EU', String(d), '0', `${x},300`, `${x},1800`, '');

  // Dimensionnement et étiquettes.
  ed.run('DIMENSIONNER'); await t(); await pick(main.id, [27000, 4600]); ed.submit('4'); await t(); await t();
  ed.run('DIMENSIONNER'); await t(); await pick(ext.id, [20900, 5500]); ed.submit('3'); await t(); await t();
  ed.run('DIMENSIONNER'); await t(); await pick(ef.id, [20900, 1000]); ed.submit('1.5'); await t(); await t();
  // Pente des eaux usées : −0,40 m à la chute, 1 %.
  ed.run('PENTE'); await t(); await pick(eu.id, [21400, 300]); ed.submit('-400'); await t(); ed.submit('1'); await t(); await t();
  // Accessoires : registres sur les piquages des bureaux, clapets coupe-feu aux traversées de murs, vanne d'eau froide.
  ed.run('ACC'); await t(); ed.submit('r'); await t();
  for (const b of branches) await pick(b.id, [doc.get(b.id).pts[0][0], 9600]);
  ed.submit(''); await t();
  await run('ACC', 'm');
  ed.run('ACC'); await t(); ed.submit('v'); await t(); await pick(ef.id, [20600, 1000]); ed.submit(''); await t();
  // Supportage de tous les réseaux.
  await run('SUPPORTS', 'Tous', '0');
  const mainNow = doc.get(main.id);
  ed.run('ETIQMEP'); await t(); await pick(mainNow.id, [27000, 6000]); ed.submit('28500,6500'); await t(); ed.submit(''); await t();
  doc.currentLayer = 'MEP-NOTES';
  await run('LE', '25500,3500', '24000,1500', '', 'CTA double flux 2 250 m³/h');

  // Présentation A3 au 1:100.
  await run('PRESENTATION', 'Plan CVC et plomberie', 'A3');
  await run('FMULT', '20,40', '400,277', '100');
  doc.currentLayer = 'A-TEXTE';
  await run('TX', '20,22', '5', '0', 'Démo MEP — plan CVC et plomberie — 1:100 (dessin créé dans CAD Viewer)', '');
  ed.settings.osnap = true;
  const { writeDxf } = await import('/src/io/dxf-writer.js');
  await fetch('/__out/' + encodeURIComponent('Démo MEP.dxf'), { method: 'POST', body: writeDxf(doc) });
  window.__demoDone = { entities: doc.entities.size, spaces: doc.spaces.map((s) => s.label) };
})();
