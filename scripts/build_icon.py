# SPDX-License-Identifier: GPL-3.0-or-later
"""Icône de l'application : assets/icon.svg rendu en PNG transparent (16, 32, 48, 256 px) par Edge sans fenêtre, puis
assemblé en assets/icon.ico (entrées PNG, Windows Vista et suivants). Le serveur de développement doit tourner
(python serve.py 8001) pour servir les pages out/icon-<taille>.html.

Usage : python -I scripts/build_icon.py [port]
"""
import pathlib
import struct
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SIZES = [256, 48, 32, 16]


def render(size: int, port: str) -> bytes:
    page = ROOT / "out" / f"icon-{size}.html"
    page.write_text(f'<!doctype html><style>html,body{{margin:0;background:transparent}}img{{display:block;width:{size}px;height:{size}px}}</style><img src="../assets/icon.svg">', encoding="utf-8")
    png = pathlib.Path(tempfile.gettempdir()) / f"cv-icon-{size}.png"
    prof = pathlib.Path(tempfile.gettempdir()) / "cv-icon-profile"
    subprocess.run([EDGE, "--headless=new", f"--user-data-dir={prof}", "--hide-scrollbars", "--default-background-color=00000000",
                    f"--window-size={size},{size}", f"--screenshot={png}", f"http://localhost:{port}/out/icon-{size}.html"],
                   capture_output=True, timeout=60)
    page.unlink()
    return png.read_bytes()


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else "8001"
    images = [(s, render(s, port)) for s in SIZES]
    for s, data in images:
        (ROOT / "assets" / f"icon-{s}.png").write_bytes(data)
    header = struct.pack("<HHH", 0, 1, len(images))
    entries, blobs, offset = b"", b"", 6 + 16 * len(images)
    for s, data in images:
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    (ROOT / "assets" / "icon.ico").write_bytes(header + entries + blobs)
    print("assets/icon.ico :", ", ".join(f"{s} px ({len(d)} o)" for s, d in images))
    return 0


if __name__ == "__main__":
    sys.exit(main())
