// SPDX-License-Identifier: GPL-3.0-or-later
// CHAMP (FIELD) : boîte de choix (type, format, aperçu), objet cité désigné si besoin (fenêtre, attribut d'un bloc,
// texte, objet pour l'aire ou la longueur), puis nouveau texte — ou ajout au texte choisi avant la commande.
// -CHAMP : même chose en ligne de commande. MAJCHAMP (UPDATEFIELD) : recalcul des champs choisis ou de tous.
import { newEntity } from './commands.js';
import { FIELD_KINDS, fieldCode, evaluateField, updateFields, hasField } from '../core/fields.js';
import { annoScaleOf } from '../core/drawing-settings.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kindOf = (key) => FIELD_KINDS.find((k) => k.key === key);
let last = { kind: 'filename', format: '%fn2' };

// Boîte CHAMP → Promise { kind, format } ou null.
export function openFieldDialog(doc) {
  let dlg = document.getElementById('field-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'field-dialog';
    dlg.className = 'qto field-dialog';
    document.body.appendChild(dlg);
  }
  const state = { ...last };
  const preview = () => {
    const k = kindOf(state.kind);
    if (k.pick) return '(objet à désigner ensuite)';
    return evaluateField(doc, { space: doc.currentSpace || 'model', field: { code: fieldCode(state.kind, state.format), refs: [] } }, {});
  };
  const render = () => {
    const k = kindOf(state.kind);
    if (!k.formats.some(([f]) => f === state.format)) state.format = k.formats[0][0];
    dlg.innerHTML = `<h2>Champ</h2>
      <div class="fd-body">
        <div class="fd-list" role="listbox">${FIELD_KINDS.map((x) => `<button class="fd-item ${x.key === state.kind ? 'sel' : ''}" data-kind="${x.key}">${esc(x.label)}</button>`).join('')}</div>
        <div class="fd-side">
          <label>Format <select data-f="format">${k.formats.map(([f, label]) => `<option value="${esc(f)}" ${f === state.format ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
          <div class="fd-preview"><span class="muted">Aperçu</span><div>${esc(preview())}</div></div>
          <div class="muted fd-code">${esc(fieldCode(state.kind, state.format))}</div>
        </div>
      </div>
      <div class="qto-actions"><button class="btn primary" data-act="ok">OK</button><button class="btn" data-act="cancel">Annuler</button></div>`;
  };
  render();
  return new Promise((resolve) => {
    const done = (v) => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(v); };
    dlg.onclose = () => done(null);
    dlg.onclick = (e) => {
      const kb = e.target.closest('[data-kind]');
      if (kb) { state.kind = kb.dataset.kind; render(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') done(null);
      else if (act === 'ok') { last = { ...state }; done({ ...state }); }
    };
    dlg.ondblclick = (e) => { if (e.target.closest('[data-kind]')) { last = { ...state }; done({ ...state }); } };
    dlg.onchange = (e) => { if (e.target.dataset.f === 'format') { state.format = e.target.value; render(); } };
    if (!dlg.open) dlg.showModal();
  });
}

// Objet cité par un champ (désigné) → ref { id } / { id, tag }, ou null.
async function pickRef(ctx, kind) {
  const { doc } = ctx;
  const k = kindOf(kind);
  const prompt = { VIEWPORT: 'Choisissez la fenêtre de présentation', ATTRIB: 'Choisissez le bloc (insertion avec attributs)', TEXT: 'Choisissez le texte', AREA: 'Choisissez l’objet (polyligne fermée, cercle, hachure)', LENGTH: 'Choisissez l’objet (ligne, polyligne, arc, cercle)' }[k.pick];
  const pick = await ctx.getEntity(prompt, { allowNone: true });
  if (!pick) return null;
  const e = doc.get(pick.id);
  const ok = {
    VIEWPORT: e?.type === 'VIEWPORT', ATTRIB: e?.type === 'INSERT' && e.attribs?.length, TEXT: e?.type === 'TEXT' || e?.type === 'MTEXT',
    AREA: e && (e.type === 'CIRCLE' || e.type === 'HATCH' || (e.type === 'LWPOLYLINE' && e.closed)), LENGTH: e && ['LINE', 'LWPOLYLINE', 'ARC', 'CIRCLE'].includes(e.type),
  }[k.pick];
  if (!ok) { ctx.print('Cet objet ne convient pas pour ce champ.'); return null; }
  if (k.pick !== 'ATTRIB') return { id: e.id };
  const tags = e.attribs.map((a) => a.tag);
  const tag = tags.length === 1 ? tags[0] : await ctx.getKeyword('Attribut', tags, { default: tags[0] });
  return tag ? { id: e.id, tag } : null;
}

// Pose d'un champ : ajouté au texte choisi, ou nouveau texte.
async function placeField(ctx, kind, format, target) {
  const { doc } = ctx;
  let refs = [];
  if (kindOf(kind).pick) {
    const r = await pickRef(ctx, kind);
    if (!r) return;
    refs = [r];
  }
  if (target) {
    // Ajout au texte existant : son contenu devient du texte fixe suivi du champ (objets renumérotés).
    const base = target.field?.code ?? String(target.text ?? '').replace(/%</g, '%​<');
    const offset = target.field?.refs?.length || 0;
    const code = `${base}${base && !/\s$/.test(base) ? ' ' : ''}${fieldCode(kind, format).replace(/%<\\_ObjIdx 0>%/g, `%<\\_ObjIdx ${offset}>%`)}`;
    const x = { ...target, field: { code, refs: [...(target.field?.refs || []), ...refs] } };
    x.text = evaluateField(doc, x, {});
    doc.transaction('Champ', () => doc.update(x));
    ctx.print(`Champ ajouté : ${x.text}`);
    return;
  }
  const p = await ctx.getPoint('Point de départ du texte');
  const h = await ctx.getDistance('Hauteur du texte', { base: p, default: doc.header?.textsize > 0 ? doc.header.textsize : 2.5 * annoScaleOf(doc) });
  if (!(h > 0)) return;
  const e = newEntity(doc, { type: 'TEXT', p: [p[0], p[1], 0], h, rot: 0, text: '', align: 'left', valign: 'baseline', wf: 1, field: { code: fieldCode(kind, format), refs } });
  e.text = evaluateField(doc, e, {});
  doc.transaction('Champ', () => doc.add(e));
  ctx.print(`Champ : ${e.text}`);
}

export function registerFieldCommands(ed) {
  ed.register('CHAMP', async (ctx) => {
    const sel = [...ed.selection].map((id) => ctx.doc.get(id));
    const target = sel.length === 1 && (sel[0]?.type === 'TEXT' || sel[0]?.type === 'MTEXT') ? sel[0] : null;
    const r = await openFieldDialog(ctx.doc);
    if (!r) return;
    await placeField(ctx, r.kind, r.format, target);
  }, { aliases: ['FIELD'], label: 'CHAMP', transaction: false });

  // Ligne de commande : type (et format par défaut du type).
  const KW = { Fichier: 'filename', Date: 'date', Enregistrement: 'savedate', Tracé: 'plotdate', Présentation: 'ctab', Échelle: 'scale', Attribut: 'attrib', Texte: 'text', Aire: 'area', Longueur: 'length' };
  ed.register('-CHAMP', async (ctx) => {
    const kw = await ctx.getKeyword('Type de champ', Object.keys(KW), { default: 'Fichier' });
    const kind = KW[kw];
    const k = kindOf(kind);
    let format = k.formats[0][0];
    if (k.formats.length > 1) {
      const labels = k.formats.map(([, l], i) => `F${i + 1}`);
      ctx.print(k.formats.map(([, l], i) => `F${i + 1} : ${l}`).join(' ; '));
      const f = await ctx.getKeyword('Format', labels, { default: 'F1' });
      format = k.formats[labels.indexOf(f)]?.[0] ?? format;
    }
    const sel = [...ed.selection].map((id) => ctx.doc.get(id));
    const target = sel.length === 1 && (sel[0]?.type === 'TEXT' || sel[0]?.type === 'MTEXT') ? sel[0] : null;
    await placeField(ctx, kind, format, target);
  }, { aliases: ['-FIELD'], label: '-CHAMP', transaction: false });

  ed.register('MAJCHAMP', (ctx) => {
    const { doc } = ctx;
    const ids = [...ed.selection].filter((id) => hasField(doc.get(id)));
    const n = doc.transaction('Mise à jour des champs', () => updateFields(doc, {}, { ids: ids.length ? ids : null }));
    ctx.print(`${n} champ(s) mis à jour.`);
  }, { aliases: ['UPDATEFIELD', 'MAJCHAMPS'], label: 'MAJCHAMP', transaction: false });
}
