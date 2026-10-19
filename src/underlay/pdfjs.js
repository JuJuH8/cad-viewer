// SPDX-License-Identifier: GPL-3.0-or-later
// pdf.js (Mozilla, licence Apache 2.0) : lecture et rendu des PDF des fonds, chargé à la première demande.
const BASE = new URL('../../vendor/pdfjs-dist@4.10.38/', import.meta.url).href; // copie locale (scripts/vendor.py)

let loading = null;
export function pdfjs() {
  if (!loading) {
    loading = import(`${BASE}build/pdf.min.mjs`).then((lib) => {
      // Worker d'une autre origine : pdf.js le démarre lui-même par un petit module intermédiaire.
      lib.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;
      return lib;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// Ouverture d'un PDF depuis ses octets (copiés : pdf.js transfère le tampon à son worker).
export async function openPdf(bytes) {
  const lib = await pdfjs();
  const data = new Uint8Array(bytes.byteLength);
  data.set(new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset || 0, bytes.byteLength));
  return lib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
  }).promise;
}
