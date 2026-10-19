# Composants tiers

CAD Viewer (GPL-3.0-or-later, voir [`LICENSE`](LICENSE)) utilise les bibliothèques suivantes, copiées dans `vendor/`
avec leurs licences (`python -I scripts/vendor.py` les retélécharge depuis le CDN jsDelivr, versions figées) :
l'application fonctionne sans Internet. Elles restent la propriété de leurs auteurs, sous leur licence propre. Les
fichiers de `vendor/` sont identiques à ceux publiés (aucune modification).

| Composant | Version | Licence | Usage | Avis de licence dans `vendor/` |
|---|---|---|---|---|
| [three.js](https://threejs.org/) (et `examples/jsm`) | 0.186.1 | MIT | rendu 2D / 3D (WebGL) | `three@0.186.1/LICENSE`, bandeau dans `build/` |
| [@mlightcad/libredwg-web](https://www.npmjs.com/package/@mlightcad/libredwg-web), compilation WebAssembly de [LibreDWG](https://www.gnu.org/software/libredwg/) 0.13.3 (révision 0c9ab, avec correctifs de l'auteur du paquet) | 0.7.14 | **GPL-3.0** (LibreDWG : GPL-3.0-or-later, © Free Software Foundation) | lecture des DWG | `@mlightcad/libredwg-web@0.7.14/COPYING` (texte GPL-3.0 joint : le paquet n'en contient pas) |
| [@mlightcad/dxf-json](https://www.npmjs.com/package/@mlightcad/dxf-json) | 1.2.8 | **GPL-3.0** | lecture des DXF | `@mlightcad/dxf-json@1.2.8/LICENSE` |
| [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | 4.10.38 | Apache-2.0 (© Mozilla Foundation) | fonds de plan PDF, PDFIMPORT | `pdfjs-dist@4.10.38/LICENSE`, bandeaux dans `build/` |
| — tables CMap de PDF.js | 4.10.38 | BSD-3-Clause (© Adobe Systems) | textes des PDF | `pdfjs-dist@4.10.38/cmaps/LICENSE` |
| — polices standard de PDF.js : Foxit | 4.10.38 | BSD-3-Clause (PDFium) | textes des PDF | `standard_fonts/LICENSE_FOXIT` |
| — polices standard de PDF.js : Liberation Sans | 1.07.4 | SIL OFL 1.1 selon PDF.js (`LICENSE_LIBERATION`) ; les métadonnées des fichiers indiquent la « Liberation Fonts license » 1.x (GPL-2.0 avec exception pour les polices) | textes des PDF | `standard_fonts/LICENSE_LIBERATION` |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | 0.0.77 | MPL-2.0 ; le WebAssembly embarque aussi tinynurbs (BSD-3-Clause), glm, spdlog et fmt (MIT) | lecture des IFC | `web-ifc@0.0.77/LICENSE.md` |
| [jsPDF](https://github.com/parallax/jsPDF) | 2.5.2 | MIT ; composants inclus sous leurs licences (encodeur JPEG d'Adobe : BSD-3-Clause, omggif, décodeur WebP, Bidi…) | tracé PDF | `esm/licences/jspdf@2.5.2/LICENSE` et `NOTICES.txt` (avis du paquet d'origine) |
| [fflate](https://github.com/101arrowz/fflate), `@babel/runtime` (typeof) | 0.8.2, 7.25.6 | MIT, MIT | compression PDF (dépendances de jsPDF) | `esm/licences/` |
| [rbush](https://github.com/mourner/rbush), [quickselect](https://github.com/mourner/quickselect) | 4.0.1, 3.0.0 | MIT, ISC | index spatial | `esm/licences/` |
| [osifont](https://github.com/hikikomori82/osifont) (police ISO 3098) | 0.1.20221020 | LGPL-3.0 avec exception pour les polices | titres et sur-titres de l'interface | `osifont/COPYING.LESSER`, `COPYING`, `EXCEPTION.txt` |

## Sources correspondantes (GPL, MPL)

Les composants livrés sous forme compilée ou minifiée sont accompagnés de l'indication de leurs sources :

- **libredwg-web 0.7.14** : sources du paquet (lien depuis sa page npm) et de LibreDWG 0.13.3
  (<https://www.gnu.org/software/libredwg/>, <https://github.com/LibreDWG/libredwg>, révision 0c9ab).
- **dxf-json 1.2.8** : sources du paquet (lien depuis sa page npm), version 1.2.8.
- **web-ifc 0.0.77** : <https://github.com/ThatOpen/engine_web-ifc>, version 0.0.77 (MPL-2.0, § 3.2).
- **osifont** : sources FontForge (.sfd) sur <https://github.com/hikikomori82/osifont>.

Pour chaque version publiée de CAD Viewer, une archive de ces sources est à joindre aux fichiers de la version
(GPL-3.0 § 6), afin qu'elles restent disponibles même si les dépôts d'origine changent.

## Version Windows installable

Le `.exe` (PyInstaller) embarque en plus, avec leurs textes de licence dans le dossier `licenses/` de l'application :

| Composant | Licence |
|---|---|
| Python 3 (interpréteur et bibliothèque standard ; bzip2, xz, libmpdec, expat, zlib, Tcl/Tk pour l'installateur) | PSF License et licences listées dans `LICENSE.txt` de Python |
| PyInstaller (chargeur et modules d'exécution) | GPL-2.0-or-later avec exception pour le chargeur ; Apache-2.0 pour une partie des modules |
| Tcl/Tk (fenêtre de l'installateur) | licence BSD de Tcl/Tk (`license.terms`) |
| Microsoft Visual C++ Runtime (`VCRUNTIME140.dll`) | redistribuable selon les conditions de Microsoft Visual Studio |

OpenSSL n'est pas embarqué (le lanceur ne communique qu'avec `http://127.0.0.1`). Microsoft Edge, utilisé comme
fenêtre de l'application, n'est pas fourni : c'est celui installé avec Windows.

## Compatibilité

Toutes ces licences (MIT, ISC, BSD-3-Clause, Apache-2.0, MPL-2.0 sans « Exhibit B », LGPL-3.0, GPL-3.0, OFL pour
des polices utilisées comme données) sont compatibles avec la diffusion de l'ensemble sous GPL-3.0. LibreDWG et
dxf-json étant sous GPL-3.0, une diffusion fermée de l'application est impossible sans les remplacer.

## Fichiers non fournis

- Polices (SHX, TrueType), motifs de hachures (.pat), tables de tracé (.ctb, .stb), bibliothèques de blocs, palettes
  d'outils et gabarits de tiers : lus en place sur le poste de l'utilisateur, depuis les dossiers des logiciels
  installés ou ceux qu'il indique ; jamais copiés dans l'application ni dans ce dépôt.
- Dessins d'exemple d'AutoCAD : non fournis (quelques tests les utilisent s'ils sont copiés dans `samples/`).
- jsPDF peut charger à la demande html2canvas, DOMPurify et canvg depuis le CDN (rendu HTML / SVG) : l'application
  n'utilise pas ces fonctions, ils ne sont ni copiés ni chargés.
