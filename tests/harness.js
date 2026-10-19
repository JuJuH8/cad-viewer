// SPDX-License-Identifier: GPL-3.0-or-later
// Mini banc de tests exécuté dans le navigateur (aucune dépendance).
// Les résultats sont affichés dans la page et exposés dans window.__testResults.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export class AssertionError extends Error {}

// Test ignoré (fichier d'exemple absent : les dessins d'exemple d'AutoCAD ne sont pas publiés avec le projet).
class Skip extends Error {}
export function skip(msg) { throw new Skip(msg); }

// DWG de tests/fixtures enregistrés par AutoCAD : non publiés (ils portent le nom de session de leur auteur), seules
// leurs versions DXF le sont. Absents, les tests qui les lisent sont ignorés à cet endroit (la partie DXF, lue avant,
// a déjà été vérifiée).
if (typeof window !== 'undefined' && !window.__fixtureGuard) {
  window.__fixtureGuard = true;
  const fetch0 = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await fetch0(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (r.status === 404 && /fixtures\/[^?#]+\.dwg$/i.test(decodeURIComponent(url))) skip(`DWG de test « ${decodeURIComponent(url).split('/').pop()} » absent (non publié)`);
    return r;
  };
}

// Dessin de samples/ par son nom ; test ignoré s'il n'est pas là (dessins d'exemple d'AutoCAD, à copier soi-même
// depuis le dossier Sample d'AutoCAD pour lancer ces tests).
export async function sample(name) {
  const r = await fetch(`/samples/${encodeURIComponent(name)}`);
  if (!r.ok) skip(`exemple « ${name} » absent de samples/`);
  return r.arrayBuffer();
}

function fail(msg) {
  throw new AssertionError(msg);
}

export const assert = {
  ok(v, msg = 'valeur attendue vraie') {
    if (!v) fail(msg);
  },
  equal(a, b, msg) {
    if (a !== b) fail(msg || `attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`);
  },
  deepEqual(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) fail(msg || `attendu ${sb}, obtenu ${sa}`);
  },
  near(a, b, eps = 1e-9, msg) {
    if (!(Math.abs(a - b) <= eps)) fail(msg || `attendu ${b} ± ${eps}, obtenu ${a}`);
  },
  point(p, q, eps = 1e-9, msg) {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!(d <= eps)) fail(msg || `attendu (${q[0]}, ${q[1]}), obtenu (${p[0]}, ${p[1]})`);
  },
  throws(fn, msg = 'une exception était attendue') {
    try { fn(); } catch { return; }
    fail(msg);
  },
};

export async function run(output) {
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    window.__currentTest = t.name; // test en cours (diagnostic d'un test bloqué)
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: performance.now() - t0 });
    } catch (err) {
      if (err instanceof Skip) { results.push({ name: t.name, ok: true, skipped: err.message, ms: 0 }); continue; }
      results.push({ name: t.name, ok: false, error: err.message || String(err), stack: err.stack });
    }
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  window.__testResults = { total: results.length, failed: failed.length, skipped: skipped.length, results };
  if (output) {
    output.innerHTML = `<h1>${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} tests réussis${skipped.length ? ` (${skipped.length} ignoré(s))` : ''}</h1>`
      + results.map((r) => `<div class="${r.ok ? 'ok' : 'ko'}">${r.skipped ? '○' : r.ok ? '✔' : '✘'} ${r.name}`
        + `${r.skipped ? ` <small>ignoré : ${r.skipped}</small>` : r.ok ? ` <small>${r.ms.toFixed(1)} ms</small>` : `<pre>${r.error}</pre>`}</div>`).join('');
  }
  return window.__testResults;
}
