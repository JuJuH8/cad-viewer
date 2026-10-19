// SPDX-License-Identifier: GPL-3.0-or-later
// Boîte « Hachures » (HACHURES, HACHEDIT) : galerie de motifs avec aperçus (intégrés, fichiers .pat de l'utilisateur,
// motifs importés), plein, échelle, angle, origine, contour (point intérieur ou objets), îlots, associativité,
// couleur de fond, calque.
import { BUILTIN, listPatFiles, loadPatFile, userPatterns, addUserPatterns, decodePat, patternLines, patternPeriod } from './patterns.js';
import { patternSegments } from '../hatch.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
const fmt = (v) => String(Math.round(v * 10000) / 10000).replace('.', ',');
const BG = [[null, 'Aucune'], [7, 'Blanc / noir'], [8, 'Gris 8'], [9, 'Gris 9'], [254, 'Gris clair 254'], [2, 'Jaune'], [4, 'Cyan'], [30, 'Orange 30'], [151, 'Bleu clair 151']];

let dlg = null;
const previews = new Map();

// Aperçu d'un motif dans un petit canevas (quelques périodes).
function previewOf(def, size = 54) {
  const key = `${def.name}|${def.lines.length}|${size}`;
  if (previews.has(key)) return previews.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const s = size / (5 * patternPeriod(def));
  const lines = patternLines(def, { scale: s });
  const segs = patternSegments({ definitionLines: lines.map((l) => ({ angle: l.angle, base: { x: l.base[0], y: l.base[1] }, offset: { x: l.offset[0], y: l.offset[1] }, dashLengths: l.dashes })) },
    [[[0, 0], [size, 0], [size, size], [0, size]]]) || [];
  ctx.strokeStyle = '#d6dbe3';
  ctx.fillStyle = '#d6dbe3';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i + 1 < segs.length; i += 2) {
    const [a, b] = [segs[i], segs[i + 1]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.6) { ctx.fillRect(a[0] - 0.7, size - a[1] - 0.7, 1.4, 1.4); continue; }
    ctx.moveTo(a[0], size - a[1]);
    ctx.lineTo(b[0], size - b[1]);
  }
  ctx.stroke();
  const url = c.toDataURL();
  previews.set(key, url);
  return url;
}

// opts : { doc, layers, currentLayer, defaultScale(source), edit (valeurs d'une hachure à modifier), last }
// Renvoie { solid, pattern, source, def, scale, angle (rad), origin: 'defaut' | 'ecran' | 'contour', mode: 'point' |
// 'objets', islands: 'normal' | 'ignorer', assoc, bg (couleur d'index ou null), layer } ou null.
export function openHatchDialog(opts) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'hatch-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const last = opts.edit || opts.last || {};
  const st = {
    solid: last.solid ?? false, source: last.source || 'intégré', pattern: last.pattern || 'ANSI31',
    scale: last.scale ?? opts.defaultScale?.('intégré') ?? 1, angle: last.angle ?? 0, origin: last.originMode || 'defaut',
    mode: last.mode || 'point', islands: last.islands || 'normal', assoc: last.assoc !== false, bg: last.bg ?? null,
    layer: last.layer || opts.currentLayer, filter: '', files: [], userScale: !!opts.edit,
  };
  const sources = () => {
    const out = [['intégré', BUILTIN]];
    const u = userPatterns();
    if (u.size) out.push(['importé', u]);
    for (const f of st.files) out.push([f, null]);
    return out;
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    let pats = BUILTIN;
    const current = () => pats?.get(String(st.pattern).toUpperCase()) || null;

    const render = () => {
      // SOLID d'un fichier .pat = remplissage plein (option « Plein »), pas un motif.
      const list = pats ? [...pats.values()].filter((p) => !/^solid$/i.test(p.name) && (!st.filter || `${p.name} ${p.desc}`.toLowerCase().includes(st.filter.toLowerCase()))) : [];
      const cur = current();
      dlg.innerHTML = `<h2>${opts.edit ? 'Modifier la hachure' : 'Hachures'}</h2>
        <div class="hatch-layout"><div>
          <div class="fond-row"><label><input type="radio" name="hk" data-k="solid" value="0" ${st.solid ? '' : 'checked'}> Motif</label>
            <label><input type="radio" name="hk" data-k="solid" value="1" ${st.solid ? 'checked' : ''}> Plein</label>
            <select data-k="source" ${st.solid ? 'disabled' : ''}>${sources().map(([k]) => `<option value="${esc(k)}" ${k === st.source ? 'selected' : ''}>${k === 'intégré' ? 'Motifs intégrés' : k === 'importé' ? 'Motifs importés' : esc(k)}</option>`).join('')}</select>
            <input data-k="filter" value="${esc(st.filter)}" placeholder="Chercher…" size="10" ${st.solid ? 'disabled' : ''}>
            <button class="btn small" data-act="import" title="Ajouter les motifs d’un fichier .pat">Importer .pat…</button></div>
          <div class="hatch-gallery ${st.solid ? 'off' : ''}">${pats ? list.map((p) => `<button class="hatch-tile ${p.name.toUpperCase() === String(st.pattern).toUpperCase() ? 'sel' : ''}" data-pat="${esc(p.name)}" title="${esc(p.desc || p.name)}"><img src="${previewOf(p)}" alt=""><span>${esc(p.name)}</span></button>`).join('') : '<p class="muted">Lecture du fichier…</p>'}</div>
          <p class="muted">${st.solid ? 'Remplissage plein (couleur de l’objet).' : cur ? `${esc(cur.name)} — ${esc(cur.desc)}` : 'Choisissez un motif.'}</p>
        </div><div class="ps-grid hatch-opts">
          <label>Échelle <input data-k="scale" value="${fmt(st.scale)}" size="7" ${st.solid ? 'disabled' : ''}></label>
          <label>Angle (°) <input data-k="angle" value="${fmt((st.angle * 180) / Math.PI)}" size="5" ${st.solid ? 'disabled' : ''}></label>
          <label>Origine <select data-k="origin" ${st.solid ? 'disabled' : ''}><option value="defaut" ${st.origin === 'defaut' ? 'selected' : ''}>0,0 du dessin</option><option value="contour" ${st.origin === 'contour' ? 'selected' : ''}>Coin inférieur gauche du contour</option><option value="ecran" ${st.origin === 'ecran' ? 'selected' : ''}>Point à désigner</option></select></label>
          ${opts.edit ? '' : `<label>Contour <select data-k="mode"><option value="point" ${st.mode === 'point' ? 'selected' : ''}>Point intérieur</option><option value="objets" ${st.mode === 'objets' ? 'selected' : ''}>Objets fermés</option></select></label>
          <label>Îlots <select data-k="islands"><option value="normal" ${st.islands === 'normal' ? 'selected' : ''}>Détectés (normal)</option><option value="ignorer" ${st.islands === 'ignorer' ? 'selected' : ''}>Ignorés (contour extérieur)</option></select></label>`}
          <label>Couleur de fond <select data-k="bg">${BG.map(([v, l]) => `<option value="${v ?? ''}" ${v === st.bg ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Calque <select data-k="layer">${opts.layers.map((n) => `<option ${n === st.layer ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label><input type="checkbox" data-k="assoc" ${st.assoc ? 'checked' : ''}> Associative (suit son contour)</label>
        </div></div>
        <div class="qto-actions"><span class="muted grow">${opts.edit ? '' : 'Après OK : cliquez dans les zones à hachurer (Entrée pour finir).'}</span>
          <button class="btn primary" data-act="ok" ${!st.solid && !cur ? 'disabled' : ''}>OK</button><button class="btn" data-act="cancel">Annuler</button></div>`;
    };

    const setSource = async (src) => {
      st.source = src;
      if (src === 'intégré') pats = BUILTIN;
      else if (src === 'importé') pats = userPatterns();
      else { pats = null; render(); pats = await loadPatFile(src); }
      if (!st.userScale) st.scale = opts.defaultScale?.(src) ?? st.scale;
      if (!current() || /^solid$/i.test(st.pattern)) st.pattern = [...(pats?.keys() || [])].find((k) => k !== 'SOLID') || st.pattern;
      render();
    };

    dlg.onclick = async (ev) => {
      const tile = ev.target.closest('[data-pat]');
      if (tile && !st.solid) { st.pattern = tile.dataset.pat; render(); return; }
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      if (act === 'import') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pat';
        input.onchange = async () => {
          const f = input.files[0];
          if (!f) return;
          const n = addUserPatterns(decodePat(await f.arrayBuffer()));
          if (n) await setSource('importé');
        };
        input.click();
      }
      if (act === 'ok') {
        const cur = current();
        if (!st.solid && !cur) return;
        finish({
          solid: st.solid, pattern: st.solid ? 'SOLID' : cur.name, source: st.source, def: st.solid ? null : cur,
          scale: st.scale, angle: st.angle, origin: st.origin, mode: st.mode, islands: st.islands, assoc: st.assoc, bg: st.bg, layer: st.layer,
        });
      }
    };
    dlg.onchange = (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
      if (k === 'solid') st.solid = v === '1';
      else if (k === 'source') { setSource(v); return; }
      else if (k === 'scale') { st.scale = Math.max(1e-9, num(v, st.scale)); st.userScale = true; }
      else if (k === 'angle') st.angle = (num(v, 0) * Math.PI) / 180;
      else if (k === 'bg') st.bg = v === '' ? null : +v;
      else st[k] = v;
      render();
    };
    dlg.oninput = (ev) => {
      if (ev.target.dataset.k !== 'filter') return;
      st.filter = ev.target.value;
      const pos = ev.target.selectionStart;
      render();
      const f = dlg.querySelector('[data-k="filter"]');
      f.focus();
      f.setSelectionRange(pos, pos);
    };
    dlg.oncancel = (ev) => { ev.preventDefault(); finish(null); };
    render();
    if (!dlg.open) dlg.showModal();
    listPatFiles().then((list) => { st.files = list; if (st.source !== 'intégré' && list.includes(st.source)) setSource(st.source); else render(); }).catch(() => {});
  });
}
