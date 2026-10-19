# SPDX-License-Identifier: GPL-3.0-or-later
"""Garde le réglage SECURELOAD d'AutoCAD intact pendant les tests.

Les tests chargent le module depuis un dossier non approuvé : la console AutoCAD doit
passer SECURELOAD à 0, et ce réglage est enregistré dans le profil de l'utilisateur.
`preserved()` relit la valeur avant le lancement et la réécrit ensuite, quoi qu'il arrive.
"""
import contextlib
import winreg

ROOT = r"Software\Autodesk\AutoCAD"


def _variables_keys():
    """Chemins des clés « Variables » de tous les profils AutoCAD de l'utilisateur."""
    found = []

    def children(path):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
                i = 0
                while True:
                    try:
                        yield winreg.EnumKey(k, i)
                    except OSError:
                        return
                    i += 1
        except OSError:
            return

    for release in children(ROOT):
        for product in children(f"{ROOT}\\{release}"):
            profiles = f"{ROOT}\\{release}\\{product}\\Profiles"
            for profile in children(profiles):
                found.append(f"{profiles}\\{profile}\\Variables")
    return found


def read():
    values = {}
    for path in _variables_keys():
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
                values[path] = winreg.QueryValueEx(k, "SECURELOAD")
        except OSError:
            pass
    return values


def restore(values):
    for path, (value, kind) in values.items():
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "SECURELOAD", 0, kind, value)


@contextlib.contextmanager
def preserved():
    saved = read()
    try:
        yield
    finally:
        restore(saved)
