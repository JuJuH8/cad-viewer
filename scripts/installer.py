# SPDX-License-Identifier: GPL-3.0-or-later
"""Installateur de CAD Viewer (Windows, pour l'utilisateur courant, sans droits d'administrateur) : copie l'application
dans %LOCALAPPDATA%\\Programs\\CAD Viewer, crée les raccourcis (Bureau, menu Démarrer) et l'inscrit dans « Applications
installées » de Windows (désinstallation). Empaqueté en un seul « CAD-Viewer-Setup.exe » par scripts/build_installer.py,
avec l'application (archive app.zip) à l'intérieur.

Options : --dir DOSSIER (autre dossier), --silent (sans fenêtre), --no-desktop, --no-startmenu, --no-register,
          --no-launch, --uninstall (désinstaller).
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

APP = "CAD Viewer"
EXE = "CAD Viewer.exe"
REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\CADViewer"
DEFAULT_DIR = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home())) / "Programs" / APP
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def resource(name: str) -> pathlib.Path:
    return pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent)) / name


def powershell(script: str) -> None:
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                   check=True, capture_output=True, creationflags=NO_WINDOW)


def special_folder(name: str) -> pathlib.Path:
    r = subprocess.run(["powershell", "-NoProfile", "-Command", f"[Environment]::GetFolderPath('{name}')"],
                       capture_output=True, text=True, creationflags=NO_WINDOW)
    return pathlib.Path(r.stdout.strip())


def shortcut(lnk: pathlib.Path, target: pathlib.Path, icon: pathlib.Path) -> None:
    q = lambda p: str(p).replace("'", "''")
    powershell(f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{q(lnk)}'); $s.TargetPath = '{q(target)}'; "
               f"$s.WorkingDirectory = '{q(target.parent)}'; $s.IconLocation = '{q(icon)},0'; "
               f"$s.Description = 'CAD Viewer — DAO / MEP'; $s.Save()")


def version_of(zf: zipfile.ZipFile) -> str:
    try:
        return zf.read("CAD Viewer/VERSION.txt").decode("utf-8").split()[-1]
    except KeyError:
        return ""


def install(target: pathlib.Path, desktop=True, startmenu=True, register=True, progress=None) -> pathlib.Path:
    with zipfile.ZipFile(resource("app.zip")) as zf:
        version = version_of(zf)
        if target.exists():
            try:  # application ouverte : son exécutable ne peut pas être ouvert en écriture
                if (target / EXE).exists():
                    open(target / EXE, "r+b").close()
            except OSError as err:
                raise RuntimeError("CAD Viewer est ouvert : fermez-le, puis relancez l'installation.") from err
            shutil.rmtree(target / "_internal", ignore_errors=True)
        target.mkdir(parents=True, exist_ok=True)
        names = [n for n in zf.namelist() if n.startswith("CAD Viewer/") and not n.endswith("/")]
        for i, n in enumerate(names):
            dest = target / n[len("CAD Viewer/"):]
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(n) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
            if progress and i % 20 == 0:
                progress(i / len(names))
    # Désinstallateur : copie de cet installateur dans le dossier de l'application.
    me = pathlib.Path(sys.executable if getattr(sys, "frozen", False) else __file__)
    if getattr(sys, "frozen", False):
        shutil.copy2(me, target / "Désinstaller CAD Viewer.exe")
    exe, icon = target / EXE, target / "_internal" / "assets" / "icon.ico"
    if not icon.exists():
        icon = exe
    if desktop:
        shortcut(special_folder("Desktop") / f"{APP}.lnk", exe, icon)
    if startmenu:
        folder = special_folder("Programs")
        shortcut(folder / f"{APP}.lnk", exe, icon)
    if register:
        import winreg
        size_kb = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) // 1024
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_KEY) as k:
            for name, value in [("DisplayName", APP), ("DisplayVersion", version), ("Publisher", "CAD Viewer"),
                                ("DisplayIcon", str(icon)), ("InstallLocation", str(target)),
                                ("UninstallString", f'"{target / "Désinstaller CAD Viewer.exe"}" --uninstall')]:
                winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)
            winreg.SetValueEx(k, "EstimatedSize", 0, winreg.REG_DWORD, int(size_kb))
            winreg.SetValueEx(k, "NoModify", 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(k, "NoRepair", 0, winreg.REG_DWORD, 1)
    if progress:
        progress(1)
    return exe


def uninstall(target: pathlib.Path) -> None:
    # L'exécutable lancé depuis le dossier à supprimer se recopie d'abord dans %TEMP%.
    me = pathlib.Path(sys.executable)
    if getattr(sys, "frozen", False) and target in me.parents:
        tmp = pathlib.Path(tempfile.gettempdir()) / "cv-uninstall.exe"
        shutil.copy2(me, tmp)
        subprocess.Popen([str(tmp), "--uninstall", "--dir", str(target), *[a for a in sys.argv[1:] if a == "--silent"]])
        return
    for lnk in [special_folder("Desktop") / f"{APP}.lnk", special_folder("Programs") / f"{APP}.lnk"]:
        lnk.unlink(missing_ok=True)
    try:
        import winreg
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REG_KEY)
    except OSError:
        pass
    shutil.rmtree(target, ignore_errors=True)


def gui(target: pathlib.Path, opts: dict) -> int:
    import tkinter as tk
    from tkinter import ttk, messagebox
    root = tk.Tk()
    root.title("Installation de CAD Viewer")
    root.resizable(False, False)
    try:
        root.iconbitmap(str(resource("icon.ico")))
    except tk.TclError:
        pass
    ink, red, light = "#111110", "#DA291C", "#F2F1EC"
    root.configure(bg=light)
    frame = tk.Frame(root, bg=light, padx=24, pady=20)
    frame.pack()
    tk.Label(frame, text="INSTALLATION", font=("Segoe UI", 9), fg="#8A8A86", bg=light).pack(anchor="w")
    tk.Label(frame, text="CAD Viewer", font=("Segoe UI Semibold", 18), fg=ink, bg=light).pack(anchor="w")
    tk.Frame(frame, height=2, bg=ink, width=420).pack(fill="x", pady=(6, 12))
    tk.Label(frame, text=f"Dossier : {target}", font=("Segoe UI", 9), fg="#4A4A47", bg=light, wraplength=420, justify="left").pack(anchor="w")
    desk, menu, launch = tk.BooleanVar(value=opts["desktop"]), tk.BooleanVar(value=opts["startmenu"]), tk.BooleanVar(value=opts["launch"])
    for var, label in [(desk, "Créer un raccourci sur le Bureau"), (menu, "Ajouter au menu Démarrer"), (launch, "Lancer CAD Viewer à la fin")]:
        tk.Checkbutton(frame, text=label, variable=var, bg=light, fg=ink, activebackground=light, font=("Segoe UI", 10)).pack(anchor="w", pady=1)
    bar = ttk.Progressbar(frame, length=420, mode="determinate")
    bar.pack(pady=(14, 6))
    buttons = tk.Frame(frame, bg=light)
    buttons.pack(anchor="e", pady=(6, 0))

    def go():
        ok.config(state="disabled")
        try:
            exe = install(target, desk.get(), menu.get(), opts["register"], lambda f: (bar.config(value=f * 100), root.update()))
        except Exception as err:  # message clair plutôt qu'une trace
            messagebox.showerror("CAD Viewer", f"Installation impossible : {err}")
            ok.config(state="normal")
            return
        if launch.get():
            subprocess.Popen([str(exe)], cwd=str(exe.parent))
        messagebox.showinfo("CAD Viewer", "CAD Viewer est installé." + ("\nUn raccourci a été créé sur le Bureau." if desk.get() else ""))
        root.destroy()

    ok = tk.Button(buttons, text="Installer", command=go, bg=red, fg="white", activebackground="#B81F14", relief="flat", padx=16, pady=5, font=("Segoe UI Semibold", 10))
    ok.pack(side="right")
    tk.Button(buttons, text="Annuler", command=root.destroy, relief="flat", padx=12, pady=5, font=("Segoe UI", 10)).pack(side="right", padx=8)
    root.mainloop()
    return 0


def main() -> int:
    args = sys.argv[1:]
    target = pathlib.Path(args[args.index("--dir") + 1]) if "--dir" in args else DEFAULT_DIR
    opts = {"desktop": "--no-desktop" not in args, "startmenu": "--no-startmenu" not in args,
            "register": "--no-register" not in args, "launch": "--no-launch" not in args}
    if "--uninstall" in args:
        if "--silent" not in args:
            import tkinter as tk
            from tkinter import messagebox
            tk.Tk().withdraw()
            if not messagebox.askyesno("CAD Viewer", "Désinstaller CAD Viewer ?\n(vos dessins et réglages ne sont pas supprimés)"):
                return 0
        uninstall(target)
        return 0
    if "--silent" in args:
        install(target, opts["desktop"], opts["startmenu"], opts["register"])
        return 0
    return gui(target, opts)


if __name__ == "__main__":
    sys.exit(main())
