// SPDX-License-Identifier: GPL-3.0-or-later
// SCU (UCS) : origine, deux points (origine et axe X), rotation Z, aligné sur un objet, précédent, général, SCU
// nommés (enregistrer, restaurer, supprimer, liste). SCUICONE (UCSICON) : icône affichée ou non, à l'origine ou
// dans le coin. Raccourcis du ruban : SCUGENERAL, SCUOBJET, SCUPRECEDENT.
import * as G from '../core/geom.js';
import {
  WORLD, ucsOf, setUcs, previousUcs, ucsFromPoints, isWorld, ucsIconOf, spaceOf,
} from '../core/ucs.js';
import { polylineCurves } from '../core/entities.js';

const deg = (r) => Math.round(((r * 180) / Math.PI) * 1e6) / 1e6;
const key = (name) => String(name).toUpperCase();

// SCU aligné sur un objet désigné (ligne, polyligne, arc, cercle, texte, bloc).
export function ucsFromEntity(e, pick) {
  const P = (q) => [q[0], q[1]];
  switch (e.type) {
    case 'LINE': {
      // Origine à l'extrémité la plus proche du point désigné, axe X vers l'autre.
      const [a, b] = G.dist(pick, e.p1) <= G.dist(pick, e.p2) ? [e.p1, e.p2] : [e.p2, e.p1];
      return ucsFromPoints(P(a), P(b));
    }
    case 'LWPOLYLINE': {
      const segs = polylineCurves(e).filter((c) => c.k === 'seg');
      if (!segs.length) return null;
      const s = segs.reduce((best, c) => (G.distToSegment(pick, c.a, c.b) < G.distToSegment(pick, best.a, best.b) ? c : best), segs[0]);
      const [a, b] = G.dist(pick, s.a) <= G.dist(pick, s.b) ? [s.a, s.b] : [s.b, s.a];
      return ucsFromPoints(P(a), P(b));
    }
    case 'CIRCLE': return ucsFromPoints(P(e.c), pick);
    case 'ARC': {
      const p0 = G.polar(e.c, e.a0, e.r), p1 = G.polar(e.c, e.a1, e.r);
      return ucsFromPoints(P(e.c), G.dist(pick, p0) <= G.dist(pick, p1) ? p0 : p1);
    }
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'ATTDEF':
      return { origin: P(e.p), angle: G.normAngle(e.rot || 0), name: '' };
    default: return null;
  }
}

export function registerUcsCommands(ed) {
  const describe = (u) => (isWorld(u) && !u.name ? 'SCU général' : `SCU${u.name ? ` « ${u.name} »` : ''} : origine ${+u.origin[0].toFixed(4)}, ${+u.origin[1].toFixed(4)}, axe X à ${deg(u.angle)}°`);
  const apply = (ctx, u, label) => {
    ctx.doc.transaction(label, () => setUcs(ctx.doc, u));
    ctx.print(describe(ucsOf(ctx.doc)));
  };

  async function byObject(ctx) {
    const pick = await ctx.getEntity('Choisissez l’objet qui définit le SCU', { allowNone: true });
    if (!pick) return;
    const e = ctx.doc.get(pick.id);
    const u = e && ucsFromEntity(e, pick.p || ctx.editor?.cursor?.raw || [0, 0]);
    if (!u) { ctx.print('Objet non géré (ligne, polyligne, arc, cercle, texte ou bloc).'); return; }
    apply(ctx, u, 'SCU objet');
  }

  ed.register('SCU', async (ctx) => {
    const { doc } = ctx;
    const cur = ucsOf(doc);
    const first = await ctx.getPoint('Origine du SCU', { keywords: ['NOmmé', 'OBjet', 'Précédent', 'Général', 'Z', 'ORigine'], allowNone: true });
    if (first === null || first === 'Général') { apply(ctx, WORLD, 'SCU général'); return; }
    if (first === 'Précédent') {
      const u = doc.transaction('SCU précédent', () => previousUcs(doc));
      ctx.print(u ? describe(ucsOf(doc)) : 'Aucun SCU précédent.');
      return;
    }
    if (first === 'OBjet') { await byObject(ctx); return; }
    if (first === 'ORigine') {
      const o = await ctx.getPoint('Nouvelle origine');
      apply(ctx, { origin: [o[0], o[1]], angle: cur.angle, name: '' }, 'Origine du SCU');
      return;
    }
    if (first === 'Z') {
      const a = await ctx.getAngle('Angle de rotation autour de l’axe Z', { default: Math.PI / 2 });
      if (typeof a !== 'number') return;
      apply(ctx, { origin: [...cur.origin], angle: cur.angle + a, name: '' }, 'Rotation du SCU');
      return;
    }
    if (first === 'NOmmé') {
      const kw = await ctx.getKeyword('SCU nommé', ['Restaurer', 'Enregistrer', 'Supprimer', 'Liste'], { default: 'Restaurer' });
      const list = [...(doc.ucsTable?.values() || [])].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      if (kw === 'Liste') {
        ctx.print(list.length ? list.map(describe).join('\n') : 'Aucun SCU nommé.');
        return;
      }
      const name = (await ctx.getString(kw === 'Enregistrer' ? 'Nom du SCU à enregistrer' : 'Nom du SCU'))?.trim();
      if (!name) return;
      if (kw === 'Enregistrer') {
        if (/[<>/\\":;?*|,=`]/.test(name)) { ctx.print('Nom non valide.'); return; }
        doc.transaction('SCU nommé', () => {
          doc.setTableEntry('ucsTable', key(name), { name, origin: [...cur.origin], angle: cur.angle });
          setUcs(doc, { ...cur, name });
        });
        ctx.print(`SCU « ${name} » enregistré.`);
        return;
      }
      const u = doc.ucsTable?.get(key(name));
      if (!u) { ctx.print(`SCU « ${name} » introuvable.`); return; }
      if (kw === 'Supprimer') {
        doc.transaction('Supprimer le SCU nommé', () => {
          doc.setTableEntry('ucsTable', key(name), null);
          if (key(cur.name || '') === key(name)) setUcs(doc, { ...cur, name: '' });
        });
        ctx.print(`SCU « ${u.name} » supprimé.`);
      } else apply(ctx, { ...u }, 'Restaurer le SCU');
      return;
    }
    // Origine désignée, puis point de l'axe X (Entrée : orientation gardée).
    const xp = await ctx.getPoint('Point sur l’axe X positif (Entrée : orientation gardée)', { base: first, allowNone: true });
    apply(ctx, ucsFromPoints(first, xp, cur.angle), 'SCU');
  }, { aliases: ['UCS', 'SCUNOMME', 'DDUCS'], label: 'SCU', transaction: false });

  ed.register('SCUGENERAL', (ctx) => apply(ctx, WORLD, 'SCU général'), { aliases: ['UCSWORLD'], label: 'SCUGENERAL', transaction: false });
  ed.register('SCUOBJET', (ctx) => byObject(ctx), { aliases: ['UCSOBJECT'], label: 'SCUOBJET', transaction: false });
  ed.register('SCUPRECEDENT', (ctx) => {
    const u = ctx.doc.transaction('SCU précédent', () => previousUcs(ctx.doc));
    ctx.print(u ? describe(ucsOf(ctx.doc)) : 'Aucun SCU précédent.');
  }, { aliases: ['UCSPREV'], label: 'SCUPRECEDENT', transaction: false });

  ed.register('SCUICONE', async (ctx) => {
    const { doc } = ctx;
    const icon = ucsIconOf(doc);
    const kw = await ctx.getKeyword('Icône du SCU', ['Activé', 'Désactivé', 'Origine', 'Non-origine'], { default: icon.on ? 'Désactivé' : 'Activé' });
    const next = { ...icon, ...{ Activé: { on: true }, Désactivé: { on: false }, Origine: { origin: true }, 'Non-origine': { origin: false } }[kw] };
    doc.transaction('Icône du SCU', () => doc.setHeader({ ucsIcon: next }, { light: true }));
    ctx.editor?.r?.requestRender?.(true);
  }, { aliases: ['UCSICON'], label: 'SCUICONE', transaction: false });
}

export { spaceOf };
