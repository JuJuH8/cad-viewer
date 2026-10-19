// SPDX-License-Identifier: GPL-3.0-or-later
// RECHERCHER (comme FIND d'AutoCAD) : chercher / remplacer dans les textes, textes multilignes et
// valeurs d'attributs, avec la liste des résultats (clic = zoom et sélection).
import { parseMText, plainText } from '../text.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pattern(query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return null;
  const body = wholeWord ? `(?<![\\p{L}\\p{N}_])${reEsc(query)}(?![\\p{L}\\p{N}_])` : reEsc(query);
  return new RegExp(body, `gu${matchCase ? '' : 'i'}`);
}

// Codes jamais recherchés ni remplacés : mise en forme des MTEXT (police, hauteur, couleur, paragraphe,
// groupes), caractères codés (\U+00E9, \M+…, %%c, %%d, %%127…).
const SPECIAL = String.raw`%%(?:\d{3}|[^\d])|\\U\+[0-9A-Fa-f]{4}|\\M\+[0-9A-Fa-f]{5}`;
const MTEXT_CODE = new RegExp(String.raw`\\[PN~]|\\\\|\\[{}]|\\S[^;]*;|\\[fFHWQTACcpa][^;]*;|\\[LlOoKkX]|[{}]|` + SPECIAL, 'g');
const TEXT_CODE = new RegExp(SPECIAL, 'g');

// Remplacement morceau par morceau entre les codes.
function replaceOutside(s, codes, re, rep) {
  let out = '', last = 0;
  for (const m of s.matchAll(codes)) {
    out += s.slice(last, m.index).replace(re, rep) + m[0];
    last = m.index + m[0].length;
  }
  return out + s.slice(last).replace(re, rep);
}

// Occurrences : [{ id, attr (indice d'attribut ou null), text }].
export function findTexts(doc, query, opts = {}, ids = null) {
  const re = pattern(query, opts);
  if (!re) return [];
  const out = [];
  const test = (s) => { re.lastIndex = 0; return re.test(s || ''); };
  for (const e of ids ? ids.map((id) => doc.get(id)).filter(Boolean) : doc.entities.values()) {
    if (e.type === 'TEXT') { const plain = plainText(e.text); if (test(plain)) out.push({ id: e.id, attr: null, text: plain }); }
    if (e.type === 'MTEXT') {
      const plain = parseMText(e.text).join('\n');
      if (test(plain)) out.push({ id: e.id, attr: null, text: plain.replace(/\n/g, ' ') });
    }
    if (e.type === 'INSERT') (e.attribs || []).forEach((a, i) => { const plain = plainText(String(a.text ?? '')); if (test(plain)) out.push({ id: e.id, attr: i, text: plain, tag: a.tag }); });
  }
  return out;
}

// Remplace dans toutes les occurrences (une seule étape d'annulation). Renvoie le nombre d'objets modifiés.
export function replaceTexts(doc, matches, query, replacement, opts = {}) {
  const re = pattern(query, opts);
  if (!re) return 0;
  const ids = [...new Set(matches.map((m) => m.id))];
  const rep = () => replacement; // texte littéral ($&, $1… non interprétés)
  // Dans un MTEXT, « \ », « { » et « } » du texte de remplacement sont échappés (sinon ce seraient des codes).
  const mrep = () => replacement.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => `\\${c}`);
  let n = 0;
  doc.transaction('Remplacer', () => {
    for (const id of ids) {
      const e = doc.get(id);
      if (!e) continue;
      const next = { ...e };
      if (e.type === 'TEXT') next.text = replaceOutside(e.text, TEXT_CODE, re, rep);
      if (e.type === 'MTEXT') next.text = replaceOutside(e.text, MTEXT_CODE, re, mrep);
      if (e.attribs) next.attribs = e.attribs.map((a) => ({ ...a, text: replaceOutside(String(a.text ?? ''), TEXT_CODE, re, rep) }));
      // Seuls les objets réellement changés (une occurrence dans un caractère codé n'est pas remplacée).
      if (next.text !== e.text || (e.attribs && next.attribs.some((a, i) => a.text !== e.attribs[i].text))) { doc.update(next); n++; }
    }
  });
  return n;
}

export function showFind(doc, editor) {
  let dlg = document.getElementById('find-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'find-dialog';
    dlg.className = 'qto';
    document.body.appendChild(dlg);
  }
  const field = 'width:100%;padding:5px 8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px';
  dlg.innerHTML = `<h2>Rechercher et remplacer</h2>
    <label class="qs-row"><span>Rechercher</span><input data-k="q" style="${field}"></label>
    <label class="qs-row"><span>Remplacer par</span><input data-k="r" style="${field}"></label>
    <label><input type="checkbox" data-k="case"> Respecter la casse</label>
    <label style="margin-left:14px"><input type="checkbox" data-k="word"> Mot entier</label>
    <label style="margin-left:14px"><input type="checkbox" data-k="sel" ${editor.selection.size ? 'checked' : ''}> Dans la sélection</label>
    <p class="qs-count"></p>
    <div class="qto-scroll"><table><tbody class="find-results"></tbody></table></div>
    <div class="qto-actions"><button class="btn primary" data-act="find">Rechercher</button><button class="btn" data-act="replace">Remplacer tout</button><button class="btn" data-act="close">Fermer</button></div>`;
  const $ = (k) => dlg.querySelector(`[data-k="${k}"]`);
  const scope = editor.selection.size ? [...editor.selection] : null;
  let matches = [];
  const opts = () => ({ matchCase: $('case').checked, wholeWord: $('word').checked });
  const search = () => {
    matches = findTexts(doc, $('q').value, opts(), $('sel').checked ? scope : null);
    dlg.querySelector('.qs-count').textContent = $('q').value ? `${matches.length} occurrence(s)` : '';
    dlg.querySelector('.find-results').innerHTML = matches.slice(0, 500).map((m, i) => `<tr class="clickable" data-i="${i}">
      <td>${m.attr != null ? `Attribut ${esc(m.tag || '')}` : esc(doc.get(m.id)?.type === 'MTEXT' ? 'Texte multiligne' : 'Texte')}</td><td>${esc(m.text)}</td></tr>`).join('');
  };
  dlg.oninput = (e) => { if (e.target.dataset.k === 'q') search(); };
  dlg.onchange = (e) => { if (['case', 'word', 'sel'].includes(e.target.dataset.k)) search(); };
  dlg.onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'find') { search(); return; }
    if (act === 'replace') {
      search();
      const n = replaceTexts(doc, matches, $('q').value, $('r').value, opts());
      const objs = new Set(matches.map((m) => m.id)).size;
      editor.print(`${n} objet(s) modifié(s)${n < objs ? ` ; ${objs - n} occurrence(s) dans des caractères codés (%%c, \\U+…) non remplacée(s)` : ''}.`);
      search();
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const m = matches[+tr.dataset.i];
    const box = editor.r.cache.get(m.id)?.box;
    if (box) {
      const pad = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1) * 3;
      editor.r.fit({ minX: box.minX - pad, maxX: box.maxX + pad, minY: box.minY - pad, maxY: box.maxY + pad });
    }
    editor.setSelection([m.id]);
  };
  if (!dlg.open) dlg.showModal();
  $('q').focus();
  return dlg;
}
