# SPDX-License-Identifier: GPL-3.0-or-later
"""Construit la version installable de CAD Viewer avec PyInstaller : dist/CAD Viewer/CAD Viewer.exe (+ dossier
_internal avec l'application et les bibliothèques), puis une archive ZIP à côté.
Prérequis : PyInstaller (python -m pip install pyinstaller).

Usage : python -I scripts/build_exe.py [version]
"""
import datetime
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from licenses import collect  # noqa: E402

DATA = ["index.html", "style.css", "README.md", "THIRD-PARTY.md", "LICENSE", "src", "vendor", "assets"]
# Modules exclus : OpenSSL (sa licence n'est pas compatible avec la GPL) n'est pas utile, l'application ne parlant
# qu'à http://127.0.0.1.
EXCLUDE = ["ssl", "_ssl", "_hashlib"]


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%Y.%m.%d")
    work = ROOT / "build"
    dist = ROOT / "dist"
    sep = ";"  # séparateur source;destination de --add-data sous Windows
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
            "--name", "CAD Viewer", "--icon", str(ROOT / "assets" / "icon.ico"), "--distpath", str(dist), "--workpath", str(work), "--specpath", str(work)]
    for d in DATA:
        args += ["--add-data", f"{ROOT / d}{sep}{d if (ROOT / d).is_dir() else '.'}"]
    for m in EXCLUDE:
        args += ["--exclude-module", m]
    args.append(str(ROOT / "cadviewer.py"))
    r = subprocess.run(args, cwd=ROOT)
    if r.returncode:
        return r.returncode
    out = dist / "CAD Viewer"
    (out / "VERSION.txt").write_text(f"CAD Viewer {version}\n", encoding="utf-8")
    collect(out / "licenses")  # textes de licence à côté de l'exe (CAD Viewer, tiers, Python, PyInstaller)
    archive = shutil.make_archive(str(dist / f"CAD-Viewer-{version}-windows"), "zip", dist, "CAD Viewer")
    print(f"Version installable : {out / 'CAD Viewer.exe'}")
    print(f"Archive : {archive}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
