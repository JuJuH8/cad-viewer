# SPDX-License-Identifier: GPL-3.0-or-later
"""Lanceur de CAD Viewer (version installable) : serveur local intégré + fenêtre Microsoft Edge en mode application
(sans barre d'adresse, profil propre à l'appli). Le serveur s'arrête quand la fenêtre est fermée : processus Edge
terminé et plus aucun signe de vie de la page (/__ping) depuis IDLE secondes. Edge peut confier la fenêtre à un de
ses processus déjà lancé (arrière-plan) : le processus démarré se termine alors aussitôt, d'où le signe de vie.

Port fixe (réglages de l'appli conservés d'une séance à l'autre, ils sont liés à l'adresse) ; si une autre séance
de CAD Viewer tourne déjà, une nouvelle fenêtre s'ouvre sur son serveur.

Usage : python cadviewer.py   (ou « CAD Viewer.exe » de la version installable, voir scripts/build_exe.py)
"""
import http.server
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # serve.py, à côté du lanceur
import serve  # noqa: E402

PORT = 8765
IDLE = 150  # s sans signe de vie avant l'arrêt (onglet en arrière-plan : minuteries ralenties à 1 / min)
URL = f"http://localhost:{PORT}/"


def running() -> bool:
    """Un serveur CAD Viewer répond-il déjà sur le port ?"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/__dwg/status", timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


def edge_path():
    for var in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(var)
        if base:
            exe = pathlib.Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
            if exe.is_file():
                return exe
    found = shutil.which("msedge")
    return pathlib.Path(found) if found else None


def open_window():
    """Ouvre la fenêtre de l'appli ; renvoie le processus Edge (None : navigateur par défaut)."""
    exe = edge_path()
    if not exe:
        webbrowser.open(URL)
        return None
    profile = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home())) / "CAD Viewer" / "edge"
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([str(exe), f"--app={URL}", f"--user-data-dir={profile}", "--no-first-run",
                             "--no-default-browser-check", "--window-size=1600,1000"])


def main() -> int:
    # Version fenêtrée (PyInstaller --windowed) : pas de console, sys.stderr vaut None et le journal du serveur HTTP
    # échouerait à chaque requête. Journal dans %LOCALAPPDATA%\CAD Viewer\serveur.log (refait à chaque lancement).
    if sys.stderr is None or sys.stdout is None:
        logdir = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home())) / "CAD Viewer"
        logdir.mkdir(parents=True, exist_ok=True)
        log = open(logdir / "serveur.log", "w", encoding="utf-8", buffering=1)  # noqa: SIM115 (ouvert tant que l'appli tourne)
        sys.stderr = sys.stderr or log
        sys.stdout = sys.stdout or log
    if running():
        open_window()
        return 0
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    proc = open_window()
    serve.LAST_REQUEST = time.time()
    try:
        while True:
            time.sleep(2)
            if proc and proc.poll() is None:
                continue  # fenêtre ouverte par ce lanceur
            if time.time() - serve.LAST_REQUEST > IDLE:
                break  # fenêtre fermée (ou confiée à un autre processus Edge, puis fermée)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
