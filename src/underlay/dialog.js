// SPDX-License-Identifier: GPL-3.0-or-later
// Boîtes des fonds : « Joindre un fond PDF / une image » (fichier, page avec aperçus, échelle, rotation, calque)
// et « Calques du PDF » (calques du fond affichés / masqués).
import { addSource, ensureSource, getSource, nativeSize, reloadSource } from './sources.js';
import { renderRegion } from './raster.js';
import { kindOfPath, fileName } from './underlay.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, def) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : def; };
const fmtMm = (v) => v.toFixed(v >= 100 ? 0 : 1).replace('.', ',');
const FORMATS = [['A0', 1189, 841], ['A1', 841, 594], ['A2', 594, 420], ['A3', 420, 297], ['A4', 297, 210]];
function formatName(w, h) {
  const [a, b] = w >= h ? [w, h] : [h, w];
  const f = FORMATS.find(([, x, y]) => Math.abs(a - x) < 3 && Math.abs(b - y) < 3);
  return f ? `${f[0]} ${w >= h ? 'paysage' : 'portrait'}` : `${fmtMm(w)} × ${fmtMm(h)} mm`;
}

let dlg = null;
function dialog(id) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  dlg.id = id;
  return dlg;
}

// Choix d'un fichier PDF / image sur le disque : { file, handle? } ou null.
export async function pickFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'fonds-joints',
        types: [{ description: 'Fonds (PDF, images)', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'] } }],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.png,.jpg,.jpeg,.bmp,.gif,.webp';
    input.onchange = () => resolve(input.files[0] ? { file: input.files[0] } : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// opts : { doc, unitMm (mm par unité du dessin), layers: [noms], currentLayer, storeHandle(path, handle), last }
// Renvoie { path, kind, page, mode: 'plan' | 'facteur' | 'largeur' | 'reference', plan, factor, width, rot (degrés),
//           origin (au point 0,0), layer, newLayer } ou null.
export function openAttachDialog(opts) {
  const d = dialog('attach-dialog');
  const last = opts.last || {};
  const st = {
    path: last.path || '', page: 1, mode: last.mode || 'plan', plan: last.plan || 50, factor: 1, width: 0,
    rot: 0, origin: false, newLayer: last.newLayer !== false, layer: opts.currentLayer, status: '', thumbs: new Map(),
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const src = () => (st.path ? getSource(st.path) : null);

    const render = async () => {
      const s = src();
      const kind = kindOfPath(st.path);
      let info = '';
      let pages = '';
      if (s?.status === 'ok') {
        if (s.kind === 'pdf') {
          const size = await nativeSize(s, st.page);
          info = `PDF, ${s.pageCount} page(s) — page ${st.page} : ${formatName(size[0], size[1])}${s.ocg?.length ? ` — ${s.ocg.length} calque(s)` : ''}`;
          if (s.pageCount > 1) {
            pages = `<div class="att-pages">${Array.from({ length: Math.min(s.pageCount, 60) }, (_, i) => i + 1)
              .map((n) => `<button class="att-page ${n === st.page ? 'sel' : ''}" data-page="${n}" title="Page ${n}"><canvas data-thumb="${n}" width="96" height="68"></canvas><span>${n}</span></button>`).join('')}</div>`;
          }
        } else {
          info = `Image ${s.width} × ${s.height} pixels${s.dpi ? ` — ${Math.round(s.dpi)} ppp` : ' — résolution inconnue'}`;
        }
      } else if (s?.status === 'loading') info = 'Lecture du fichier…';
      else if (s?.status === 'missing') info = '<span class="del">Fichier introuvable : choisissez-le avec « Parcourir… » (ou relancez le serveur de l’appli pour les chemins complets).</span>';
      else if (s?.status === 'error') info = `<span class="del">Fichier illisible : ${esc(s.error)}</span>`;
      const pdf = kind !== 'image';
      d.innerHTML = `<h2>Joindre un fond ${pdf ? 'PDF' : 'image'}</h2>
        <div class="ps-grid att-grid">
          <label class="wide">Fichier <span class="fond-row"><input data-k="path" value="${esc(st.path)}" placeholder="Chemin complet (C:\\…\\plan.pdf) ou « Parcourir… »" size="54">
            <button class="btn small" data-act="browse">Parcourir…</button><button class="btn small" data-act="load" title="Lire le fichier à ce chemin (serveur de l’appli)">Lire</button></span></label>
          <div class="wide muted att-info">${info}</div>
          ${pages ? `<div class="wide">${pages}</div>` : ''}
          <label>Échelle <select data-k="mode">
            ${pdf ? `<option value="plan" ${st.mode === 'plan' ? 'selected' : ''}>Échelle du plan</option>` : ''}
            <option value="facteur" ${st.mode === 'facteur' ? 'selected' : ''}>Facteur d’échelle</option>
            ${pdf ? '' : `<option value="largeur" ${st.mode === 'largeur' ? 'selected' : ''}>Largeur de l’image</option>`}
            <option value="reference" ${st.mode === 'reference' ? 'selected' : ''}>Par référence (2 points + longueur réelle)</option></select></label>
          ${st.mode === 'plan' && pdf ? `<label>Plan au 1: <input data-k="plan" value="${st.plan}" size="7"></label>` : ''}
          ${st.mode === 'facteur' ? `<label>Facteur <input data-k="factor" value="${st.factor}" size="7"></label>` : ''}
          ${st.mode === 'largeur' ? `<label>Largeur (unités du dessin) <input data-k="width" value="${st.width || ''}" size="9"></label>` : ''}
          ${st.mode === 'reference' ? '<div class="muted">Après la pose : deux points sur le fond (accrochage aux traits du PDF), puis leur longueur réelle.</div>' : ''}
          <label>Rotation (°) <input data-k="rot" value="${st.rot}" size="6"></label>
          <label><input type="checkbox" data-k="origin" ${st.origin ? 'checked' : ''}> Au point 0,0 (sinon : point d’insertion à l’écran)</label>
          <label><input type="checkbox" data-k="newLayer" ${st.newLayer ? 'checked' : ''}> Calque propre au fond (« ${esc(layerName(st.path))} »)</label>
          ${st.newLayer ? '' : `<label>Calque <select data-k="layer">${opts.layers.map((n) => `<option ${n === st.layer ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`}
        </div>
        <div class="qto-actions"><span class="muted grow">${esc(st.status)}</span>
          <button class="btn primary" data-act="ok" ${s?.status === 'ok' ? '' : 'disabled'}>OK</button><button class="btn" data-act="cancel">Annuler</button></div>`;
      if (s?.status === 'ok' && s.kind === 'pdf' && s.pageCount > 1) drawThumbs(s);
    };

    const drawThumbs = async (s) => {
      for (const c of d.querySelectorAll('canvas[data-thumb]')) {
        const n = +c.dataset.thumb;
        let img = st.thumbs.get(n);
        if (!img) {
          const size = await nativeSize(s, n);
          const k = Math.min(96 / size[0], 68 / size[1]);
          img = await renderRegion(s, { s0: 0, t0: 0, s1: 1, t1: 1 }, size[0] * k * 2, size[1] * k * 2, { page: n }).catch(() => null);
          st.thumbs.set(n, img);
        }
        if (!img || !c.isConnected) continue;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        const w = img.width / 2, h = img.height / 2;
        ctx.fillRect((96 - w) / 2, (68 - h) / 2, w, h);
        ctx.drawImage(img, (96 - w) / 2, (68 - h) / 2, w, h);
      }
    };

    const load = async (fromPath) => {
      if (!st.path) return;
      st.thumbs.clear();
      st.page = 1;
      if (fromPath) reloadSource(st.path); else ensureSource(st.path);
      render();
      await ensureSource(st.path);
      render();
    };

    d.onclick = async (ev) => {
      const pg = ev.target.closest('[data-page]');
      if (pg) { st.page = +pg.dataset.page; render(); return; }
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      if (act === 'browse') {
        const r = await pickFile();
        if (!r) return;
        // Chemin : celui saisi s'il désigne ce fichier, sinon le nom du fichier (cherché à côté du dessin).
        const typed = st.path && fileName(st.path).toLowerCase() === r.file.name.toLowerCase() ? st.path : r.file.name;
        st.path = typed;
        st.thumbs.clear();
        st.page = 1;
        if (r.handle) opts.storeHandle?.(st.path, r.handle);
        render();
        await addSource(st.path, await r.file.arrayBuffer());
        render();
      }
      if (act === 'load') load(true);
      if (act === 'ok') {
        const s = src();
        if (s?.status !== 'ok') return;
        if (st.mode === 'largeur' && !(st.width > 0)) { st.status = 'Indiquez la largeur.'; render(); return; }
        finish({
          path: st.path, kind: s.kind, page: st.page, mode: st.mode, plan: st.plan, factor: st.factor, width: st.width,
          rot: st.rot, origin: st.origin, layer: st.newLayer ? layerName(st.path) : st.layer, newLayer: st.newLayer,
        });
      }
    };
    d.onchange = (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
      if (k === 'path') { st.path = String(v).trim().replace(/^"|"$/g, ''); load(false); return; }
      if (k === 'plan') st.plan = Math.max(1e-6, num(v, st.plan));
      else if (k === 'factor') st.factor = Math.max(1e-9, num(v, st.factor));
      else if (k === 'width') st.width = Math.max(0, num(v, 0));
      else if (k === 'rot') st.rot = num(v, 0);
      else st[k] = v;
      render();
    };
    d.oncancel = (ev) => { ev.preventDefault(); finish(null); };
    render();
    if (st.path) load(false);
    if (!d.open) d.showModal();
  });
}

// Calque proposé pour un fond : « PDF-plan » / « IMAGE-photo » (caractères interdits remplacés).
export function layerName(path) {
  const base = fileName(path).replace(/\.[^.]+$/, '').replace(/[<>/\\":;?*|=,`]/g, '_').slice(0, 60) || 'fond';
  return `${kindOfPath(path) === 'image' ? 'IMAGE' : 'PDF'}-${base}`;
}

// Calques du PDF d'un fond : cases à cocher (visible / masqué). onApply(listeDesMasqués).
export function openPdfLayers(e, onApply) {
  const d = dialog('pdf-layers');
  const s = getSource(e.path);
  const groups = s?.ocg || [];
  const off = new Set(e.ocgOff || []);
  const render = () => {
    d.innerHTML = `<h2>Calques du PDF — ${esc(fileName(e.path))}</h2>
      ${groups.length ? `<div class="pdf-layers">${groups.map((g, i) => `<label><input type="checkbox" data-i="${i}" ${off.has(g.name) ? '' : 'checked'}> ${esc(g.name)}</label>`).join('')}</div>
        <div class="fond-row"><button class="btn small" data-act="all">Tout afficher</button><button class="btn small" data-act="none">Tout masquer</button></div>`
    : `<p class="muted">${s?.status === 'ok' ? 'Ce PDF n’a pas de calques.' : 'Fichier non chargé.'}</p>`}
      <div class="qto-actions"><button class="btn primary" data-act="ok">OK</button><button class="btn" data-act="cancel">Annuler</button></div>`;
  };
  d.onclick = (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') d.close();
    if (act === 'all') { off.clear(); render(); }
    if (act === 'none') { for (const g of groups) off.add(g.name); render(); }
    if (act === 'ok') { d.close(); onApply([...off]); }
  };
  d.onchange = (ev) => {
    const i = ev.target.dataset.i;
    if (i == null) return;
    const name = groups[+i].name;
    if (ev.target.checked) off.delete(name); else off.add(name);
  };
  d.oncancel = null;
  render();
  if (!d.open) d.showModal();
}
