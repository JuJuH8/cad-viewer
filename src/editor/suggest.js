// SPDX-License-Identifier: GPL-3.0-or-later
// Saisie semi-automatique de la ligne de commande (comme AutoCAD) : commandes dont le nom ou un alias
// commence par le texte tapé, puis celles dont le nom ou le libellé le contient.
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// labels : nom de commande → libellé lisible (ex. « Raccord »). Renvoie [{ name, alias, label }].
export function suggestCommands(editor, text, labels = {}, max = 8) {
  const q = norm(text.trim());
  if (!q || /\s/.test(q)) return [];
  const best = new Map(); // nom → { score, alias }
  const offer = (name, alias, score) => {
    const cur = best.get(name);
    if (!cur || score < cur.score) best.set(name, { score, alias });
  };
  for (const [alias, name] of editor.aliases) {
    const a = norm(alias);
    if (a === q) offer(name, alias, alias === name ? 0 : 1);
    else if (a.startsWith(q)) offer(name, alias, alias === name ? 2 : 3);
  }
  for (const name of editor.commands.keys()) {
    if (best.has(name)) continue;
    if (norm(name).includes(q) || (labels[name] && norm(labels[name]).includes(q))) offer(name, name, 4);
  }
  return [...best]
    .sort((x, y) => x[1].score - y[1].score || x[0].length - y[0].length || x[0].localeCompare(y[0]))
    .slice(0, max)
    .map(([name, { alias }]) => ({ name, alias: alias !== name ? alias : '', label: labels[name] || '' }));
}
