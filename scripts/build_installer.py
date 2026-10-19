# SPDX-License-Identifier: GPL-3.0-or-later
"""Construit l'installateur « CAD-Viewer-Setup-<version>.exe » : l'application (dist/CAD Viewer, construite par
scripts/build_exe.py) en archive app.zip, embarquée avec scripts/installer.py dans un seul exécutable (PyInstaller).

Usage : python -I scripts/build_installer.py [version]
"""
import datetime
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from licenses import collect  # noqa: E402
# Modules exclus : OpenSSL (sa licence n'est pas compatible avec la GPL) n'est pas utile, l'application ne parlant
# qu'à http://127.0.0.1.
EXCLUDE = ["ssl", "_ssl", "_hashlib"]


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%Y.%m.%d")
    app = ROOT / "dist" / "CAD Viewer"
    if not (app / "CAD Viewer.exe").exists():
        print("!! construire d'abord l'application : python -I scripts/build_exe.py")
        return 1
    work = ROOT / "build" / "setup"
    work.mkdir(parents=True, exist_ok=True)
    archive = shutil.make_archive(str(work / "app"), "zip", ROOT / "dist", "CAD Viewer")
    icon = ROOT / "assets" / "icon.ico"
    name = f"CAD-Viewer-Setup-{version}"
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed", "--name", name,
            "--icon", str(icon), "--distpath", str(ROOT / "dist"), "--workpath", str(work / "pyi"), "--specpath", str(work),
            "--add-data", f"{archive};.", "--add-data", f"{icon};.",
            "--add-data", f"{collect(work / 'licenses', tk=True)};licenses"]
    for m in EXCLUDE:
        args += ["--exclude-module", m]
    args.append(str(ROOT / "scripts" / "installer.py"))
    r = subprocess.run(args, cwd=ROOT)
    if r.returncode:
        return r.returncode
    shutil.rmtree(ROOT / "build", ignore_errors=True)
    out = ROOT / "dist" / f"{name}.exe"
    print(f"Installateur : {out} ({out.stat().st_size / 1e6:.1f} Mo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
