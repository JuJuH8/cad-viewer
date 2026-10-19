# SPDX-License-Identifier: GPL-3.0-or-later
"""Textes de licence joints aux versions Windows (dossier licenses/) : licence de CAD Viewer, composants tiers,
Python (PSF, avec les bibliothèques qu'il embarque), PyInstaller et, pour l'installateur, Tcl/Tk.

Utilisé par scripts/build_exe.py et scripts/build_installer.py.
"""
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def pyinstaller_licenses() -> list:
    """Fichiers de licence du paquet PyInstaller installé (dossier .dist-info/licenses)."""
    r = subprocess.run([sys.executable, "-c", "import PyInstaller, os; print(os.path.dirname(PyInstaller.__file__))"],
                       capture_output=True, text=True)
    if r.returncode:
        return []
    site = pathlib.Path(r.stdout.strip()).parent
    out = []
    for info in site.glob("pyinstaller-*.dist-info"):
        out += [f for f in (info / "licenses").glob("*") if f.is_file()]
        out += [f for f in info.glob("*") if f.is_file() and f.name.upper().startswith(("COPYING", "LICENSE"))]
    return out


def collect(dest: pathlib.Path, tk: bool = False) -> pathlib.Path:
    """Copie les textes de licence dans dest (recréé) ; renvoie dest."""
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    shutil.copy2(ROOT / "LICENSE", dest / "CAD-Viewer-LICENSE.txt")
    shutil.copy2(ROOT / "THIRD-PARTY.md", dest / "THIRD-PARTY.md")
    base = pathlib.Path(sys.base_prefix)
    if (base / "LICENSE.txt").is_file():
        shutil.copy2(base / "LICENSE.txt", dest / "Python-LICENSE.txt")
    for f in pyinstaller_licenses():
        shutil.copy2(f, dest / f"PyInstaller-{f.name}")
    if tk:
        terms = next(iter(sorted((base / "tcl").glob("*/license.terms"))), None)
        if terms:
            shutil.copy2(terms, dest / "Tcl-Tk-license.terms")
    missing = [n for n in ("Python-LICENSE.txt",) if not (dest / n).exists()]
    if not any(p.name.startswith("PyInstaller-") for p in dest.iterdir()):
        missing.append("PyInstaller")
    if missing:
        print(f"!! licences introuvables : {', '.join(missing)}")
    return dest
