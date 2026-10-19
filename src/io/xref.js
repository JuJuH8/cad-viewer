// SPDX-License-Identifier: GPL-3.0-or-later
// Références externes (xref) : le contenu d'un autre dessin devient la définition du bloc xref.
// Comme dans AutoCAD, ses calques, blocs et types de ligne sont préfixés « nomxref|… ».

export function missingXrefs(doc) {
  // Les fonds de plan (bases architecte) sont rechargés par leur propre chemin, avec leur traitement.
  return [...doc.blocks.values()].filter((b) => b.xref && !b.entities.length && !b.fond).map((b) => b.name);
}

// Nom de fichier → nom de xref correspondant (sans extension, sans tenir compte de la casse).
export function matchXref(doc, fileName) {
  const base = fileName.replace(/\.(dwg|dxf)$/i, '').toLowerCase();
  return missingXrefs(doc).find((n) => n.toLowerCase() === base || n.toLowerCase().endsWith(`\\${base}`)) || null;
}

export function attachXref(doc, name, xdoc) {
  const block = doc.blocks.get(name);
  if (!block) return 0;
  const prefix = `${name}|`;
  const layerMap = new Map();
  for (const l of xdoc.layers.values()) {
    const ln = l.name === '0' ? '0' : prefix + l.name;
    layerMap.set(l.name, ln);
    if (!doc.layers.has(ln)) doc.layers.set(ln, { ...l, name: ln, ltype: l.ltype && !/^continuous$/i.test(l.ltype) ? prefix + l.ltype : l.ltype });
  }
  if (!doc.ltypes) doc.ltypes = new Map();
  for (const t of xdoc.ltypes?.values() || []) {
    const n = prefix + t.name;
    if (!doc.ltypes.has(n.toUpperCase())) doc.ltypes.set(n.toUpperCase(), { ...t, name: n });
  }
  const blockMap = new Map([...xdoc.blocks.keys()].map((n) => [n, prefix + n]));
  const rename = (e) => {
    const c = structuredClone(e);
    delete c.id;
    delete c.space;
    delete c.handle;
    c.layer = layerMap.get(c.layer) ?? c.layer;
    if (c.ltype && !/^(bylayer|byblock|continuous)$/i.test(c.ltype)) c.ltype = prefix + c.ltype;
    if ((c.type === 'INSERT' || c.type === 'BLOCKREF') && blockMap.has(c.name)) c.name = blockMap.get(c.name);
    if (c.attribs) c.attribs = c.attribs.map(rename);
    return c;
  };
  for (const b of xdoc.blocks.values()) {
    doc.blocks.set(blockMap.get(b.name), { ...b, name: blockMap.get(b.name), entities: b.entities.map(rename), xref: false });
  }
  block.entities = [...xdoc.entities.values()].filter((e) => e.space === 'model').map(rename);
  block.xrefLoaded = true;
  doc.blockVersion++;
  doc.emit({ added: new Set(), removed: new Set(), modified: new Set(), layers: new Set(), reset: true });
  return block.entities.length;
}
