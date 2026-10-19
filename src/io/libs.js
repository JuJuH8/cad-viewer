// SPDX-License-Identifier: GPL-3.0-or-later
// Adresses des bibliothèques de lecture (versions figées, copiées dans vendor/ par scripts/vendor.py). Utilisées
// par la page et par le Web Worker de lecture, où l'import map de la page ne s'applique pas.
const vendor = (path) => new URL(`../../vendor/${path}`, import.meta.url).href;
export const LIBREDWG_URL = vendor('@mlightcad/libredwg-web@0.7.14/dist/libredwg-web.js');
export const LIBREDWG_WASM_DIR = vendor('@mlightcad/libredwg-web@0.7.14/wasm');
export const DXFJSON_URL = vendor('@mlightcad/dxf-json@1.2.8/dist/esm/bundle.mjs');
