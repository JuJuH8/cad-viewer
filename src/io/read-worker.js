// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker de lecture : le décodage DWG/DXF se fait hors du fil principal,
// l'interface reste fluide même sur un gros fichier. Avec { part, parts }, le worker ne
// convertit que sa part des entités (lecture en parallèle, réunie par mergeParts).
import { readRaw, readDwgPart, warmUp } from './read.js';

self.onmessage = async ({ data }) => {
  const { id, buffer, name, part, parts } = data;
  try {
    if (data.warm) { await warmUp(); self.postMessage({ id, result: true }); return; }
    if (parts > 1) {
      const result = await readDwgPart(buffer, part, parts);
      self.postMessage({ id, result }, [result.handles.buffer, result.order.buffer]);
    } else {
      self.postMessage({ id, result: await readRaw(buffer, name) });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
