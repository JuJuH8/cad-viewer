# SPDX-License-Identifier: GPL-3.0-or-later
"""Copie locale des bibliothèques tierces (fonctionnement sans Internet) : téléchargement depuis le CDN jsDelivr des
versions figées de l'application dans vendor/, avec leurs licences. Les modules « +esm » de jsDelivr sont
enregistrés dans vendor/esm/ et leurs imports statiques réécrits vers les copies locales (les imports dynamiques
non utilisés par l'application restent sur le CDN). Rien n'est exécuté : fichiers écrits tels quels.

Usage : python -I scripts/vendor.py
"""
import hashlib
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
CDN = "https://cdn.jsdelivr.net/npm/"
DATA = "https://data.jsdelivr.com/v1/packages/npm/"

# Paquet → fichiers (chemins dans le paquet, ou motifs « dossier/* » à lister).
PACKAGES = {
    "three@0.186.1": ["build/three.module.js", "examples/jsm/controls/OrbitControls.js", "examples/jsm/exporters/GLTFExporter.js",
                      "examples/jsm/lines/LineMaterial.js", "examples/jsm/lines/LineSegments2.js",
                      "examples/jsm/lines/LineSegmentsGeometry.js", "examples/jsm/utils/BufferGeometryUtils.js"],
    "@mlightcad/libredwg-web@0.7.14": ["dist/libredwg-web.js", "wasm/*"],
    "@mlightcad/dxf-json@1.2.8": ["dist/esm/bundle.mjs"],
    "pdfjs-dist@4.10.38": ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "cmaps/*", "standard_fonts/*"],
    "web-ifc@0.0.77": ["web-ifc-api.js", "web-ifc.wasm", "web-ifc-mt.wasm"],
}
ESM = ["jspdf@2.5.2", "rbush@4.0.1"]
# Fichiers isolés : police ISO 3098 libre de l'interface (osifont, LGPL-3.0 avec exception pour les polices).
DIRECT = {
    "osifont/osifont-lgpl3fe.ttf": "https://raw.githubusercontent.com/hikikomori82/osifont/master/osifont-lgpl3fe.ttf",
    "osifont/README.md": "https://raw.githubusercontent.com/hikikomori82/osifont/master/README.md",
    "osifont/COPYING.LESSER": "https://www.gnu.org/licenses/lgpl-3.0.txt",
    "osifont/COPYING": "https://www.gnu.org/licenses/gpl-3.0.txt",
}
# osifont n'a pas de version publiée : empreinte de la police vérifiée (version 0.1.20221020, avec l'exception pour les
# polices recopiée dans vendor/osifont/EXCEPTION.txt). Une autre empreinte : nouvelle version à revoir avant usage.
OSIFONT_SHA256 = "81880ba0a1ba2e15752f5ec536f227a69bec98b73ae8200780804b66750320b6"
# Les modules « +esm » de jsDelivr perdent les commentaires de licence du paquet d'origine : ceux-ci sont recopiés,
# tels quels, dans vendor/esm/licences/<paquet>/NOTICES.txt depuis le fichier d'origine indiqué.
ESM_NOTICES = {"jspdf@2.5.2": "dist/jspdf.es.min.js"}
LICENSE_BLOCK = re.compile(r"/\*[*!](?:(?!\*/).)*?(?:@license|@preserve|Copyright|\(c\))(?:(?!\*/).)*\*/", re.I | re.S)
# Paquets publiés sans fichier de licence : texte de leur licence (GPL-3.0 de LibreDWG) joint.
LICENSE_FALLBACK = {"@mlightcad/libredwg-web@0.7.14": ("COPYING", "https://www.gnu.org/licenses/gpl-3.0.txt")}
LICENSE_NAMES = re.compile(r"^/(LICEN[CS]E|COPYING)(\.md|\.txt)?$", re.I)


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "cad-viewer-vendor"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def listing(pkg: str) -> list:
    data = json.loads(get(f"{DATA}{pkg}?structure=flat"))
    return [f["name"] for f in data["files"]]


def save(path: pathlib.Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


REL_IMPORT = re.compile(rb"""(?:from\s*|import\s*\(?\s*)["'](\.{1,2}/[^"']+)["']""")


def fetch_package(pkg: str, wanted: list) -> int:
    files = listing(pkg)
    names = set()
    for w in wanted:
        if w.startswith("*."):  # fichiers de la racine du paquet ayant cette extension
            names.update(f for f in files if f.count("/") == 1 and f.endswith(w[1:]))
        elif w.endswith("/*"):  # contenu d'un dossier (sans sous-dossiers)
            pre = "/" + w[:-1]
            names.update(f for f in files if f.startswith(pre) and "/" not in f[len(pre):])
        else:
            names.add("/" + w)
    names.update(f for f in files if LICENSE_NAMES.match(f))
    if not any(LICENSE_NAMES.match(f) for f in names) and pkg in LICENSE_FALLBACK:
        fname, url = LICENSE_FALLBACK[pkg]
        save(VENDOR / pkg / fname, get(url))
    todo, done = sorted(names), set()
    while todo:
        name = todo.pop()
        if name in done:
            continue
        done.add(name)
        data = get(f"{CDN}{pkg}{name}")
        save(VENDOR / pkg / name.lstrip("/"), data)
        # Imports relatifs (three/addons…) : suivis dans le même paquet.
        if name.endswith((".js", ".mjs")):
            for m in REL_IMPORT.finditer(data):
                rel = (pathlib.PurePosixPath(name).parent / m.group(1).decode()).as_posix()
                parts = []
                for p in rel.split("/"):
                    if p == "..":
                        parts.pop()
                    elif p not in ("", "."):
                        parts.append(p)
                target = "/" + "/".join(parts)
                if target not in done:
                    todo.append(target)
    return len(done)


ESM_IMPORT = re.compile(r"""(from\s*|import\s*)(["'])/npm/([^"']+?)/\+esm\2""")
ESM_DYNAMIC = re.compile(r"""import\(\s*(["'])/npm/([^"']+?)/\+esm\1\s*\)""")


def esm_name(spec: str) -> str:
    return re.sub(r"[^A-Za-z0-9@._-]", "_", spec) + ".mjs"


def fetch_esm(spec: str, done: set) -> None:
    if spec in done:
        return
    done.add(spec)
    text = get(f"{CDN}{spec}/+esm").decode("utf-8")
    deps = [m.group(3) for m in ESM_IMPORT.finditer(text)]
    text = ESM_IMPORT.sub(lambda m: f"{m.group(1)}{m.group(2)}./{esm_name(m.group(3))}{m.group(2)}", text)
    text = ESM_DYNAMIC.sub(lambda m: f'import({m.group(1)}{CDN}{m.group(2)}/+esm{m.group(1)})', text)
    text = re.sub(r"//# sourceMappingURL=\S+", "", text)
    save(VENDOR / "esm" / esm_name(spec), text.encode("utf-8"))
    base = spec.split("/")[0] if not spec.startswith("@") else "/".join(spec.split("/")[:2])
    for f in listing(base):
        if LICENSE_NAMES.match(f):
            save(VENDOR / "esm" / "licences" / base / f.lstrip("/"), get(f"{CDN}{base}{f}"))
    if spec in ESM_NOTICES:
        original = get(f"{CDN}{spec}/{ESM_NOTICES[spec]}").decode("utf-8", errors="replace")
        blocks = list(dict.fromkeys(m.group(0) for m in LICENSE_BLOCK.finditer(original)))
        head = (f"Avis de licence et de droit d'auteur du paquet {spec} ({ESM_NOTICES[spec]}), recopiés tels quels :\n"
                "le module vendor/esm/ correspondant, réécrit par jsDelivr, ne les contient plus.\n\n")
        save(VENDOR / "esm" / "licences" / base / "NOTICES.txt", (head + "\n\n".join(blocks) + "\n").encode("utf-8"))
    for d in deps:
        fetch_esm(d, done)


def main() -> int:
    total = 0
    for pkg, wanted in PACKAGES.items():
        n = fetch_package(pkg, wanted)
        print(f"{pkg} : {n} fichier(s)")
        total += n
    done = set()
    for spec in ESM:
        fetch_esm(spec, done)
    print(f"modules ESM : {', '.join(sorted(done))}")
    for dest, url in DIRECT.items():
        data = get(url)
        if dest.endswith(".ttf") and hashlib.sha256(data).hexdigest() != OSIFONT_SHA256:
            print(f"!! {dest} : version différente de celle vérifiée (licence et exception à revoir) — non remplacée")
            continue
        save(VENDOR / dest, data)
    print(f"fichiers isolés : {len(DIRECT)}")
    size = sum(f.stat().st_size for f in VENDOR.rglob("*") if f.is_file()) / 1e6
    print(f"vendor/ : {total + len(done)} fichiers principaux, {size:.1f} Mo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
