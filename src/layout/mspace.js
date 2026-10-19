// SPDX-License-Identifier: GPL-3.0-or-later
// Travail dans une fenêtre de présentation (comme l'espace objet flottant d'AutoCAD) : double-clic dans une fenêtre →
// on travaille sur les objets de l'espace objet à travers elle (sélection, accrochages, poignées, toutes les commandes),
// la feuille reste affichée autour, estompée et figée ; les objets de la présentation ne sont plus accessibles.
// Molette / bouton du milieu : vue de la fenêtre (enregistrée à la sortie, sauf fenêtre verrouillée).
// Sortie : double-clic hors de la fenêtre, Échap sans sélection, ESPACEP, ou changement d'onglet.
//
// Mise en œuvre : le dessin passe en espace objet avec la vue exacte de la fenêtre (même échelle, même centre) ; une
// image de la feuille, percée à l'emplacement de la fenêtre, recouvre le reste du canevas.
import { viewportMatrix } from '../render/viewports.js';

export function installMspace({ editor, renderer, getDoc, sheetFor, onChange = () => {} }) {
  let st = null; // { layoutId, vpId, v (fenêtre à l'entrée), paper { center, scale }, overlay, locked, hole (écran) }

  // Point du papier → point de l'espace objet (et inversement) pour une fenêtre sans torsion.
  const toModel = (v, p) => { const [a, , , , e, f] = viewportMatrix(v); return [(p[0] - e) / a, (p[1] - f) / a]; };

  function snapshot() {
    renderer.render(true);
    const gl = renderer.canvas, tl = renderer.textLayer;
    const c = document.createElement('canvas');
    c.width = tl.width; c.height = tl.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(gl, 0, 0, c.width, c.height);
    ctx.drawImage(tl, 0, 0);
    return c;
  }

  function buildOverlay(img, v) {
    const ov = document.createElement('canvas');
    ov.className = 'overlay mspace-overlay';
    ov.width = img.width; ov.height = img.height;
    ov.style.width = `${renderer.width}px`;
    ov.style.height = `${renderer.height}px`;
    const ctx = ov.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Feuille estompée : voile clair (le contenu de la fenêtre, lui, reste vif).
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillRect(0, 0, ov.width, ov.height);
    const dpr = ov.width / renderer.width;
    const pts = (v.clip?.length >= 3 ? v.clip : [[v.c[0] - v.w / 2, v.c[1] - v.h / 2], [v.c[0] + v.w / 2, v.c[1] - v.h / 2], [v.c[0] + v.w / 2, v.c[1] + v.h / 2], [v.c[0] - v.w / 2, v.c[1] + v.h / 2]])
      .map((p) => renderer.toScreen(p[0], p[1]).map((x) => x * dpr));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000'; // opaque : trou entièrement transparent (le voile est à 45 %)
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = v.locked ? '#d97706' : '#2563eb';
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
    renderer.textLayer.parentNode.insertBefore(ov, renderer.uiLayer);
    return { ov, hole: pts.map((p) => [p[0] / dpr, p[1] / dpr]) };
  }

  const inPoly = (p, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Entre dans la fenêtre vpId de la présentation affichée. Faux si impossible (fenêtre tournée : ancien mode).
  function enter(vpId) {
    const doc = getDoc();
    const v = doc?.get(vpId);
    if (st || !v || v.type !== 'VIEWPORT' || renderer.mode !== '2d') return false;
    if (Math.abs(v.twist || 0) > 1e-9) return false;
    editor.cancel?.();
    editor.vpCommit?.();
    const layoutId = doc.currentSpace;
    const paper = { center: { ...renderer.center }, scale: renderer.scale };
    const img = snapshot();
    const { ov, hole } = buildOverlay(img, v); // contour de la fenêtre à l'écran : avec la vue de la feuille
    renderer.activeViewport = null;
    // Calques gelés dans cette fenêtre : masqués pendant le travail dans la fenêtre.
    renderer.vpHidden = v.frozen?.length ? new Set(v.frozen) : null;
    doc.currentSpace = 'model';
    editor.setSelection([]);
    renderer.setSpace('model', null);
    renderer.webgl.setClearColor(renderer.theme.sheet ?? renderer.theme.background); // fond : le papier, pas le pourtour
    const k = v.h / v.vh;
    const m = toModel(v, [paper.center.x, paper.center.y]);
    renderer.center = { x: m[0], y: m[1] };
    renderer.scale = paper.scale * k;
    renderer.autoFit = false;
    st = { layoutId, vpId, v, paper, overlay: ov, hole, locked: !!v.locked, k, w: renderer.width, h: renderer.height };
    renderer.requestRender(true);
    editor.print(`Travail dans la fenêtre${v.locked ? ' (affichage verrouillé : vue figée)' : ''} : les objets de l’espace objet se modifient ici. Double-clic hors de la fenêtre (ou Échap sans sélection) pour revenir à la présentation.`);
    onChange();
    editor.ui.onState?.();
    return true;
  }

  // Revient à la présentation ; la vue de la fenêtre suit le zoom / déplacement fait dedans (keepView faux : abandon).
  function exit(keepView = true) {
    if (!st) return;
    const s = st;
    st = null;
    editor.cancel?.();
    s.overlay.remove();
    renderer.vpHidden = null;
    renderer.webgl.setClearColor(renderer.theme.background);
    const doc = getDoc();
    const v = doc?.get(s.vpId);
    let nv = null;
    if (keepView && v && !s.locked) {
      // Centre du papier inchangé ; le point de l'espace objet vu là est le centre actuel de la vue.
      const k = renderer.scale / s.paper.scale;
      const vh = v.h / k;
      const t = v.target || [0, 0];
      const vc = [renderer.center.x - t[0] - (s.paper.center.x - v.c[0]) / k, renderer.center.y - t[1] - (s.paper.center.y - v.c[1]) / k];
      const tol = 1e-9 * Math.max(1, Math.abs(v.vh));
      if (Math.abs(vh - v.vh) > tol || Math.abs(vc[0] - v.vc[0]) > tol || Math.abs(vc[1] - v.vc[1]) > tol) nv = { ...v, vh, vc };
    }
    if (doc) {
      doc.currentSpace = s.layoutId;
      editor.setSelection([]);
      renderer.setSpace(s.layoutId, sheetFor(s.layoutId));
      if (nv) doc.transaction('Vue de la fenêtre', () => doc.update(nv));
      renderer.center = { ...s.paper.center };
      renderer.scale = s.paper.scale;
      renderer.autoFit = false;
      renderer.requestRender(true);
    }
    editor.print('Retour à la présentation.');
    onChange();
    editor.ui.onState?.();
  }

  const api = {
    enter, exit,
    get active() { return !!st; },
    get locked() { return !!st?.locked; },
    get layoutId() { return st?.layoutId ?? null; },
    get viewportId() { return st?.vpId ?? null; },
    contains: (screen) => !!st && inPoly(screen, st.hole),
    abort() { if (st) { st.overlay.remove(); renderer.vpHidden = null; renderer.webgl.setClearColor(renderer.theme.background); st = null; } },
  };
  editor.ui.mspace = api;
  // Taille du dessin changée : l'image de la feuille est refaite (sortie puis retour dans la même fenêtre).
  let resizeTimer = null;
  const refresh = () => {
    if (!st) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!st || editor.request || (st.w === renderer.width && st.h === renderer.height)) return;
      const id = st.vpId, quiet = editor.print;
      editor.print = () => {};
      try { exit(); enter(id); } finally { editor.print = quiet; }
    }, 250);
  };
  window.addEventListener('resize', refresh);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refresh).observe(renderer.textLayer.parentNode);

  editor.register('ESPACEP', () => { if (st) exit(); else editor.print('Vous êtes déjà sur la feuille de la présentation.'); }, { aliases: ['EP', 'PSPACE', 'PS'], label: 'ESPACEP', transaction: false });
  editor.register('ESPACEO', async (ctx) => {
    const doc = getDoc();
    if (st) { ctx.print('Vous travaillez déjà dans une fenêtre.'); return; }
    if ((doc.currentSpace || 'model') === 'model') { ctx.print('Commande utilisable dans une présentation.'); return; }
    const vps = [...doc.entities.values()].filter((e) => e.type === 'VIEWPORT' && e.space === doc.currentSpace && !e.off);
    if (!vps.length) { ctx.print('Aucune fenêtre dans cette présentation.'); return; }
    let v = vps.length === 1 ? vps[0] : null;
    while (!v) {
      const p = await ctx.getPoint('Cliquez dans la fenêtre où travailler');
      v = editor.viewportAt(p);
      if (!v) ctx.print('Ce point n’est dans aucune fenêtre.');
    }
    if (!enter(v.id)) ctx.print('Fenêtre tournée : seuls le zoom et le déplacement y sont possibles (double-clic).');
  }, { aliases: ['EO', 'MSPACE', 'MS'], label: 'ESPACEO', transaction: false });
  return api;
}
