# SPDX-License-Identifier: GPL-3.0-or-later
"""Serveur local de l'application.

Sert le dossier du projet avec les bons types MIME (.js, .wasm), génère samples/index.json
(liste des fichiers DWG/DXF du dossier samples/) et, si AutoCAD est installé sur la machine,
convertit les DXF en DWG avec AutoCAD sans interface (accoreconsole).

Usage : python serve.py [port]
Variable d'environnement facultative : ACCORECONSOLE = chemin de accoreconsole.exe

Sécurité : le serveur n'écoute que sur 127.0.0.1 et ne doit jamais être exposé sur un réseau. Il refuse les requêtes
dont l'en-tête Host n'est pas localhost (DNS rebinding), les appels de ses routes /__* venant d'un autre site
(Sec-Fetch-Site, Origin) et limite la taille des envois. La route d'écriture /__out (tests) n'existe pas dans la
version installable et n'accepte que des types de fichiers de données.
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.parse

# Heure de la dernière requête (le lanceur de la version installable arrête le serveur quand l'appli ne donne plus
# signe de vie : la page appelle /__ping régulièrement).
LAST_REQUEST = time.time()

# Dossier de l'application ; version installable (PyInstaller) : fichiers embarqués dans sys._MEIPASS.
ROOT = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))


def find_accoreconsole():
    env = os.environ.get("ACCORECONSOLE")
    if env and pathlib.Path(env).is_file():
        return pathlib.Path(env)
    base = pathlib.Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Autodesk"
    if base.is_dir():
        found = sorted(base.glob("AutoCAD 20*/accoreconsole.exe"), reverse=True)  # version la plus récente
        if found:
            return found[0]
    return None


def font_dirs(extra=None):
    """Dossiers où chercher les polices SHX : dossier choisi, puis dossiers Fonts des AutoCAD installés et
    dossiers de support de l'utilisateur. Les polices sont lues sur place (jamais copiées dans l'appli)."""
    dirs = []
    if extra:
        d = pathlib.Path(extra)
        if d.is_absolute() and d.is_dir():
            dirs.append(d)
    base = pathlib.Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Autodesk"
    if base.is_dir():
        dirs += sorted(base.glob("AutoCAD*/Fonts"), reverse=True)
    appdata = os.environ.get("APPDATA")
    if appdata:
        dirs += sorted((pathlib.Path(appdata) / "Autodesk").glob("AutoCAD*/R*/*/Support"), reverse=True)
    return [d for d in dirs if d.is_dir()]


def pattern_files(extra=None):
    """Fichiers de motifs de hachures (.pat) : dossier choisi, dossiers de support de l'utilisateur et d'AutoCAD,
    applications installées (bibliothèques de l'utilisateur). Lus sur place, jamais copiés. Renvoie nom (minuscules) → chemin."""
    dirs = []
    if extra:
        d = pathlib.Path(extra)
        if d.is_absolute() and d.is_dir():
            dirs.append(d)
    appdata = os.environ.get("APPDATA")
    if appdata:
        dirs += sorted((pathlib.Path(appdata) / "Autodesk").glob("AutoCAD*/R*/*/Support"), reverse=True)
    base = pathlib.Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Autodesk"
    if base.is_dir():
        dirs += sorted(base.glob("AutoCAD*/Support"), reverse=True)
    found = {}
    for d in dirs:
        if d.is_dir():
            for f in d.glob("*.pat"):
                found.setdefault(f.name.lower(), f)
    plugins = base / "ApplicationPlugins"
    if plugins.is_dir():
        for f in plugins.rglob("*.pat"):
            found.setdefault(f.name.lower(), f)
    return found


def find_font(name, extra=None):
    """Chemin d'une police SHX par son nom (« romans », « romans.shx »), sans tenir compte de la casse."""
    stem = pathlib.Path(name).name
    if not stem.lower().endswith(".shx"):
        stem += ".shx"
    for d in font_dirs(extra):
        exact = d / stem
        if exact.is_file():
            return exact
        for f in d.glob("*.shx"):
            if f.name.lower() == stem.lower():
                return f
    return None


def dxf_to_dwg(dxf_bytes, version="2018"):
    """Convertit un DXF en DWG avec AutoCAD sans interface ; renvoie les octets du DWG."""
    exe = find_accoreconsole()
    if not exe:
        raise FileNotFoundError("AutoCAD (accoreconsole.exe) introuvable sur cette machine")
    with tempfile.TemporaryDirectory(prefix="cadviewer_") as tmp:
        tmp = pathlib.Path(tmp)
        src, out, scr = tmp / "in.dxf", tmp / "out.dwg", tmp / "conv.scr"
        src.write_bytes(dxf_bytes)
        script = (
            '(setvar "FILEDIA" 0)\n(setvar "EXPERT" 5)\n'
            f'(command "_.SAVEAS" "_{version}" "{out.as_posix()}")\n'
        )
        scr.write_text(script.replace("\n", "\r\n"), encoding="ascii")
        proc = subprocess.Popen([str(exe), "/i", str(src), "/s", str(scr)],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            proc.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise TimeoutError("AutoCAD n'a pas répondu à temps")
        if not out.exists():
            raise RuntimeError("AutoCAD n'a pas pu enregistrer le DWG (fichier refusé ?)")
        return out.read_bytes()


# Taille maximale d'un envoi (DXF à convertir, fichier de test).
MAX_BODY = 300 * 1024 * 1024
# Fichiers que la route de test /__out peut écrire (jamais de page ni de script).
OUT_SUFFIXES = (".dxf", ".dwg", ".ifc", ".bcfzip", ".pdf", ".png", ".txt", ".csv", ".json", ".ctb", ".stb", ".las", ".zip")
# Palettes d'outils : profondeur et nombre de dossiers parcourus au plus (pas de parcours de tout un disque).
PALETTE_MAX_DEPTH, PALETTE_MAX_DIRS = 6, 5000

# Dessins et fonds joints (PDF, images) lisibles par leur chemin local.
DRAWING_SUFFIXES = (".dwg", ".dxf", ".ifc", ".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp")


def tool_palettes(folder):
    """Palettes d'outils AutoCAD (.atc) d'un dossier (bibliothèque de symboles de l'utilisateur) : outils bloc → nom, bloc, calque, échelle,
    et bibliothèque de blocs (fichier source) retrouvée dans le dossier."""
    import xml.etree.ElementTree as ET
    root = pathlib.Path(folder)
    palettes, sources = [], set()
    atc = []
    for n, (dirpath, dirnames, filenames) in enumerate(os.walk(root)):
        if n >= PALETTE_MAX_DIRS:
            break
        if len(pathlib.Path(dirpath).relative_to(root).parts) >= PALETTE_MAX_DEPTH:
            dirnames[:] = []
        atc += [pathlib.Path(dirpath) / f for f in filenames if f.lower().endswith(".atc")]
    for f in sorted(atc)[:500]:
        raw = f.read_bytes()
        try:
            text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8", errors="replace")
            pal = ET.fromstring(text)
        except (ET.ParseError, UnicodeDecodeError):
            continue
        if pal.tag != "Palette":
            continue
        tools = []
        for t in pal.iter("Tool"):
            block = t.findtext(".//BlockName")
            if not block:
                continue
            prop = t.find("Data/GeneralProperties/Layer/BasicPropInfo/PropValue")
            layer = prop.get("value", "") if prop is not None else ""
            try:
                scale = float(t.findtext(".//Scale") or 1)
            except ValueError:
                scale = 1.0
            src = t.findtext(".//SourceFile") or ""
            if src:
                sources.add(src)
            tools.append({"name": t.findtext("Properties/ItemName") or block, "block": block, "layer": layer, "scale": scale,
                          "source": pathlib.PureWindowsPath(src).name if src else ""})
        if tools:
            palettes.append({"name": pal.findtext("Properties/ItemName") or f.stem, "tools": tools})
    library = {}
    for src in sources:
        name = pathlib.PureWindowsPath(src).name
        if pathlib.Path(src).is_file():
            library[name] = src
        else:
            found = next((pathlib.Path(d) / name for d, _, fs in os.walk(root) if name in fs), None)
            if found:
                library[name] = str(found)
    return {"palettes": palettes, "library": library}


def local_drawing(raw):
    """Chemin local absolu d'un dessin (DWG, DXF, IFC) ; None si le chemin est refusé."""
    if not raw:
        return None
    p = pathlib.Path(raw)
    if not p.is_absolute() or p.suffix.lower() not in DRAWING_SUFFIXES:
        return None
    return p


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def allowed(self, path):
        """Requête acceptée : Host local (pas de DNS rebinding) ; routes /__* appelées par la page elle-même
        (Sec-Fetch-Site), envois de la même origine. Sinon 403."""
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").lower()
        if host not in {f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}"}:
            self.send_error(403)
            return False
        if path.startswith("/__") and path != "/__ping":
            site = self.headers.get("Sec-Fetch-Site")
            if site and site not in ("same-origin", "none"):
                self.send_error(403)
                return False
            origin = self.headers.get("Origin")
            if origin and origin.lower() not in (f"http://localhost:{port}", f"http://127.0.0.1:{port}", f"http://[::1]:{port}"):
                self.send_error(403)
                return False
        return True

    def send_bytes(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        path = self.path.split("?")[0]
        if not self.allowed(path):
            return
        if path == "/__ping":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/samples/index.json":
            folder = ROOT / "samples"
            files = sorted(
                p.name for p in folder.glob("*") if p.suffix.lower() in (".dwg", ".dxf")
            ) if folder.is_dir() else []
            self.send_bytes(200, json.dumps(files).encode("utf-8"), "application/json")
            return
        # Polices SHX : liste des polices disponibles, ou une police par son nom (lue là où elle est).
        if path in ("/__polices", "/__police"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            extra = query.get("dossier", [""])[0] or None
            if path == "/__polices":
                names = sorted({f.name.lower() for d in font_dirs(extra) for f in d.glob("*.shx")})
                self.send_bytes(200, json.dumps(names).encode("utf-8"), "application/json")
                return
            found = find_font(query.get("nom", [""])[0], extra)
            if not found:
                self.send_bytes(404, "Police introuvable".encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_bytes(200, found.read_bytes(), "application/octet-stream")
            return
        # Motifs de hachures : liste des fichiers .pat trouvés, ou un fichier par son nom.
        if path in ("/__motifs", "/__motif"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            files = pattern_files(query.get("dossier", [""])[0] or None)
            if path == "/__motifs":
                self.send_bytes(200, json.dumps(sorted(files)).encode("utf-8"), "application/json")
                return
            f = files.get(pathlib.Path(query.get("nom", [""])[0]).name.lower())
            if not f:
                self.send_bytes(404, "Fichier de motifs introuvable".encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_bytes(200, f.read_bytes(), "application/octet-stream")
            return
        if path == "/__dwg/status":
            exe = find_accoreconsole()
            self.send_bytes(200, json.dumps({"available": bool(exe)}).encode("utf-8"), "application/json")
            return
        # Palettes d'outils (.atc) d'un dossier local : symboles d'une bibliothèque (bloc, calque, échelle).
        if path == "/__palettes":
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            folder = pathlib.Path(query.get("dossier", [""])[0])
            if not folder.is_absolute() or not folder.is_dir():
                self.send_bytes(400, "Dossier introuvable".encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_bytes(200, json.dumps(tool_palettes(folder)).encode("utf-8"), "application/json")
            return
        # Fonds de plan : lecture d'un dessin ou d'un fond joint par son chemin local (DWG, DXF, IFC, PDF, images),
        # pour recharger une base et détecter une nouvelle version (date de modification).
        if path in ("/__fichier", "/__fichier/info"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            target = local_drawing(query.get("chemin", [""])[0])
            if target is None:
                self.send_bytes(400, "Chemin refusé : seuls les dessins (.dwg, .dxf, .ifc) et les fonds (.pdf, images) sont lisibles".encode("utf-8"), "text/plain; charset=utf-8")
                return
            if path == "/__fichier/info":
                info = {"exists": target.is_file()}
                if info["exists"]:
                    st = target.stat()
                    info.update(size=st.st_size, mtime=int(st.st_mtime * 1000), name=target.name)
                self.send_bytes(200, json.dumps(info).encode("utf-8"), "application/json")
                return
            if not target.is_file():
                self.send_bytes(404, "Fichier introuvable".encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_bytes(200, target.read_bytes(), "application/octet-stream")
            return
        super().do_GET()

    def do_POST(self):
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        path = self.path.split("?")[0]
        if not self.allowed(path):
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.send_error(413)
            return
        data = self.rfile.read(length)
        # Conversion DXF → DWG par AutoCAD (si installé).
        if path == "/__dwg":
            try:
                dwg = dxf_to_dwg(data)
            except FileNotFoundError as err:
                self.send_bytes(501, str(err).encode("utf-8"), "text/plain; charset=utf-8")
                return
            except Exception as err:  # noqa: BLE001 — l'erreur est renvoyée telle quelle à l'interface
                self.send_bytes(500, str(err).encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_bytes(200, dwg, "application/acad")
            return
        # Route de développement : enregistre le corps de la requête dans out/<nom> (tests automatisés). Absente de la
        # version installable ; types de fichiers de données seulement.
        if path.startswith("/__out/") and not getattr(sys, "frozen", False):
            name = pathlib.Path(urllib.parse.unquote(path[len("/__out/"):])).name
            if not name or name.startswith(".") or pathlib.Path(name).suffix.lower() not in OUT_SUFFIXES:
                self.send_error(400)
                return
            out = ROOT / "out"
            out.mkdir(exist_ok=True)
            (out / name).write_bytes(data)
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_HEAD(self):
        if self.allowed(self.path.split("?")[0]):
            super().do_HEAD()

    def log_message(self, fmt, *args):
        if "/__ping" not in str(args[0] if args else ""):  # signe de vie de la page : pas dans le journal
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    exe = find_accoreconsole()
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"CAD Viewer : http://localhost:{PORT}")
        print(f"Enregistrement DWG : {'via ' + str(exe) if exe else 'indisponible (AutoCAD non trouvé)'}")
        httpd.serve_forever()
