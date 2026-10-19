# SPDX-License-Identifier: GPL-3.0-or-later
"""Lance les tests de « Traitement de plans » dans AutoCAD sans interface (accoreconsole).

Usage : python run_tests.py [-v]
  - assemble TraitementPlans.lsp (build.py) ;
  - charge le module puis tests.lsp sur un dessin vide ;
  - affiche chaque vérification et le bilan (code de sortie 1 en cas d'échec).
Le réglage SECURELOAD de l'utilisateur est rétabli après chaque lancement.
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

from secureload import preserved

sys.stdout.reconfigure(encoding="utf-8")
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
ACCORE = r"C:\Program Files\Autodesk\AutoCAD 2024\accoreconsole.exe"
CRLF = chr(13) + chr(10)


def run_accore(dwg, lisps, timeout=240):
    work = pathlib.Path(tempfile.mkdtemp(prefix="tp_tests_"))
    src = work / "dessin.dwg"
    shutil.copyfile(dwg, src)
    lines = ['(setvar "CMDECHO" 0)', '(setvar "SECURELOAD" 0)']
    lines += [f'(load "{p.as_posix()}")' for p in lisps]
    lines += ['(setvar "SECURELOAD" 1)', '(princ "\\nCV-FIN")']
    scr = work / "tests.scr"
    scr.write_text(CRLF.join(lines) + CRLF, encoding="ascii")
    with preserved():
        proc = subprocess.Popen([ACCORE, "/i", str(src), "/s", str(scr), "/l", "fr-FR"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            raw, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            raw, _ = proc.communicate()
            raw += "\n!! délai dépassé : AutoCAD attendait probablement une réponse\n".encode("latin-1")
    shutil.rmtree(work, ignore_errors=True)
    return raw.replace(b"\x00", b"").decode("latin-1", errors="replace")


def main():
    subprocess.run([sys.executable, str(ROOT / "build.py")], check=True)
    empty = HERE / "vide.dwg"
    if not empty.exists():
        # Non publié (un DWG enregistré par AutoCAD porte le nom de session de son auteur) : à créer une fois.
        sys.exit("Créez d'abord un dessin vide autocad-lt/tests/vide.dwg (AutoCAD : NOUVEAU, puis ENREGSOUS).")
    out = run_accore(empty, [ROOT / "TraitementPlans.lsp", HERE / "tests.lsp"])
    failed = False
    for line in out.splitlines():
        if "CV-RES=" in line:
            msg = line[line.index("CV-RES=") + 7:]
            print(msg)
            if msg.startswith("ECHEC"):
                failed = True
    if "CV-RES=BILAN" not in out:
        failed = True
        print("!! les tests ne sont pas allés au bout :")
        print(out[-3000:])
    elif "-v" in sys.argv:
        print(out[-3000:])
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
