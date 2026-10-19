# SPDX-License-Identifier: GPL-3.0-or-later
"""Prépare une version à diffuser de CAD Viewer : copie des fichiers de l'application dans dist/CAD-Viewer-<version>/
puis archive ZIP à côté. Exclus : samples/, out/, tests/, docs/, dist/, scripts/, caches Python, fichiers de travail.

Usage : python -I scripts/release.py [version]      (version par défaut : date du jour, AAAA.MM.JJ)
"""
import datetime
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Fichiers et dossiers de l'application (le reste n'est pas diffusé).
INCLUDE = ["index.html", "style.css", "serve.py", "Lancer CAD Viewer.bat", "README.md", "THIRD-PARTY.md", "LICENSE", "src", "vendor", "assets", "autocad-lt"]
EXCLUDE_DIRS = {"__pycache__", "tests", "node_modules", ".git"}
EXCLUDE_SUFFIXES = {".pyc", ".bak", ".tmp", ".log"}


def wanted(path: pathlib.Path) -> bool:
    if any(part in EXCLUDE_DIRS for part in path.parts):
        return False
    return path.suffix.lower() not in EXCLUDE_SUFFIXES


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%Y.%m.%d")
    name = f"CAD-Viewer-{version}"
    dist = ROOT / "dist"
    target = dist / name
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    count = 0
    for item in INCLUDE:
        src = ROOT / item
        if not src.exists():
            print(f"!! absent : {item}")
            continue
        files = [src] if src.is_file() else [p for p in sorted(src.rglob("*")) if p.is_file()]
        for f in files:
            rel = f.relative_to(ROOT)
            if not wanted(rel):
                continue
            dst = target / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
            count += 1
    (target / "VERSION.txt").write_text(f"CAD Viewer {version}\n", encoding="utf-8")
    archive = dist / f"{name}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(target.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(dist))
    size = archive.stat().st_size / 1024
    print(f"{count + 1} fichiers dans {target}")
    print(f"Archive : {archive} ({size:.0f} Ko)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
