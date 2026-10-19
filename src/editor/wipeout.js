// SPDX-License-Identifier: GPL-3.0-or-later
// MASQUE (WIPEOUT) : polygone de la couleur du fond qui cache ce qui est dessous dans l'ordre de tracé (étiquettes
// lisibles sur un réseau, partie d'un fond de plan masquée) ; cadres affichés, cachés ou affichés sans être tracés.
// ORDRETRACE (DRAWORDER), TEXTEPREMIERPLAN (TEXTTOFRONT), HACHURESARRIERE (HATCHTOBACK) : ordre de tracé.
import { newEntity } from './commands.js';
import { askClosed } from './xclip.js';
import { bringToFront, sendToBack, placeAbove, placeUnder } from '../core/draworder.js';

const FRAME_MODES = { Désactivés: 0, Activés: 1, Affichés: 2 };

export function registerWipeoutCommands(ed) {
  ed.register('MASQUE', async (ctx) => {
    const { doc } = ctx;
    const preview = (list) => [newEntity(doc, { type: 'WIPEOUT', id: -1, pts: list.map((q) => [q[0], q[1]]), z: 0 })];
    const first = await ctx.getPoint('Premier point du masque', { keywords: ['Cadres', 'Polyligne'] });
    if (first === 'Cadres') {
      const cur = doc.header?.wipeoutFrame ?? 1;
      const kw = await ctx.getKeyword('Cadres des masques (Affichés : visibles mais non tracés)', Object.keys(FRAME_MODES), { default: Object.keys(FRAME_MODES).find((k) => FRAME_MODES[k] === cur) });
      doc.transaction('Cadres des masques', () => doc.setHeader({ wipeoutFrame: FRAME_MODES[kw] }));
      return;
    }
    let pts, src = null;
    if (first === 'Polyligne') {
      const r = await askClosed(ctx);
      if (!r) return;
      pts = r.pts;
      const erase = await ctx.getKeyword('Effacer la polyligne', ['Oui', 'Non'], { default: 'Non' });
      if (erase === 'Oui') src = r.id;
    } else {
      const list = [first];
      while (true) {
        const q = await ctx.getPoint('Point suivant (Entrée pour terminer)', { base: list[list.length - 1], allowNone: true, preview: (c) => preview([...list, c]) });
        if (!q) break;
        list.push(q);
      }
      if (list.length < 3) { ctx.print('Il faut au moins trois points.'); return; }
      pts = list.map((q) => [q[0], q[1]]);
    }
    doc.transaction('Masque', () => {
      doc.add(newEntity(doc, { type: 'WIPEOUT', pts, z: 0 }));
      if (src != null) doc.remove(src);
    });
    ctx.print('Masque créé.');
  }, { aliases: ['WIPEOUT', 'MASK'], label: 'MASQUE', transaction: false });

  // Objets choisis (sélection courante, sinon demandée).
  const pick = async (ctx, prompt) => {
    const sel = [...ed.selection];
    return sel.length ? sel : ctx.getSelection(prompt);
  };

  ed.register('ORDRETRACE', async (ctx) => {
    const { doc } = ctx;
    const ids = await pick(ctx, 'Objets à déplacer dans l’ordre de tracé');
    if (!ids.length) return;
    const kw = await ctx.getKeyword('Ordre de tracé', ['Au-dessus', 'Au-dessous', 'Premier-plan', 'Arrière-plan'], { default: 'Arrière-plan' });
    let refs = null;
    if (kw === 'Au-dessus' || kw === 'Au-dessous') {
      ed.setSelection([]);
      refs = await ctx.getSelection('Objets de référence');
      if (!refs.length) return;
    }
    const n = doc.transaction('Ordre de tracé', () => {
      if (kw === 'Premier-plan') return bringToFront(doc, ids);
      if (kw === 'Arrière-plan') return sendToBack(doc, ids);
      if (kw === 'Au-dessus') return placeAbove(doc, ids, refs);
      return placeUnder(doc, ids, refs);
    });
    ctx.print(`${n} objet(s) déplacé(s) ${{ 'Premier-plan': 'au premier plan', 'Arrière-plan': 'à l’arrière-plan', 'Au-dessus': 'au-dessus des objets de référence', 'Au-dessous': 'au-dessous des objets de référence' }[kw]}.`);
  }, { aliases: ['DRAWORDER', 'DR', 'ORDRE'], label: 'ORDRETRACE', transaction: false });

  // Raccourcis du ruban : premier plan / arrière-plan de la sélection.
  ed.register('PREMIERPLAN', async (ctx) => {
    const ids = await pick(ctx, 'Objets à mettre au premier plan');
    if (ids.length) ctx.doc.transaction('Premier plan', () => bringToFront(ctx.doc, ids));
  }, { aliases: ['BRINGTOFRONT'], label: 'PREMIERPLAN', transaction: false });
  ed.register('ARRIEREPLAN', async (ctx) => {
    const ids = await pick(ctx, 'Objets à mettre à l’arrière-plan');
    if (ids.length) ctx.doc.transaction('Arrière-plan', () => sendToBack(ctx.doc, ids));
  }, { aliases: ['SENDTOBACK'], label: 'ARRIEREPLAN', transaction: false });

  // Textes, cotes et repères au premier plan (dans l'espace affiché).
  ed.register('TEXTEPREMIERPLAN', async (ctx) => {
    const { doc } = ctx;
    const kw = await ctx.getKeyword('Mettre au premier plan', ['Textes', 'Cotes', 'Repères', 'Tous'], { default: 'Tous' });
    const space = doc.currentSpace || 'model';
    const isText = (e) => e.type === 'TEXT' || e.type === 'MTEXT';
    const isDim = (e) => e.type === 'BLOCKREF' && e.kind === 'DIMENSION';
    const isLeader = (e) => e.type === 'BLOCKREF' && (e.kind === 'LEADER' || e.kind === 'MLEADER');
    const test = { Textes: isText, Cotes: isDim, Repères: isLeader, Tous: (e) => isText(e) || isDim(e) || isLeader(e) }[kw];
    const ids = [...doc.entities.values()].filter((e) => (e.space || 'model') === space && test(e)).map((e) => e.id);
    if (!ids.length) { ctx.print('Aucun objet de ce type.'); return; }
    doc.transaction('Textes au premier plan', () => bringToFront(doc, ids));
    ctx.print(`${ids.length} objet(s) au premier plan.`);
  }, { aliases: ['TEXTTOFRONT'], label: 'TEXTEPREMIERPLAN', transaction: false });

  ed.register('HACHURESARRIERE', (ctx) => {
    const { doc } = ctx;
    const space = doc.currentSpace || 'model';
    const ids = [...doc.entities.values()].filter((e) => (e.space || 'model') === space && e.type === 'HATCH').map((e) => e.id);
    if (!ids.length) { ctx.print('Aucune hachure.'); return; }
    doc.transaction('Hachures à l’arrière-plan', () => sendToBack(doc, ids));
    ctx.print(`${ids.length} hachure(s) à l’arrière-plan.`);
  }, { aliases: ['HATCHTOBACK'], label: 'HACHURESARRIERE', transaction: false });
}
