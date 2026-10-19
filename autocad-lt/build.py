# SPDX-License-Identifier: GPL-3.0-or-later
"""Assemble « TraitementPlans.lsp » (un seul fichier à charger dans AutoCAD LT) à partir de src/.

- src/traitement-plans.lsp : le code ;
- src/dialogues.dcl : les boîtes de dialogue, intégrées à la place de « ;;@DCL@ ».

Contrôles : parenthèses équilibrées, aucune fonction absente d'AutoCAD LT
(ActiveX/automation, Express Tools, .NET). Usage : python build.py
"""
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "TraitementPlans.lsp"

# Fonctions refusées : non disponibles dans AutoCAD LT, ou absentes de la console de test
# (ActiveX), ou dépendantes des Express Tools.
FORBIDDEN = [r"\bvla-", r"\bvlax-", r"\bvlr-", r"\bacet-", r"\bvl-load-com\b", r"\bdos_", r"\bstartapp\b"]


def lisp_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def dcl_block():
    lines = []
    for line in (SRC / "dialogues.dcl").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("//") or not line.strip():
            continue
        lines.append(line.rstrip())
    body = "\n  ".join(lisp_string(l) for l in lines)
    return "(setq tp:*dcl* '(\n  " + body + "))"


def check_parens(code):
    """Équilibre des parenthèses hors chaînes et commentaires ; renvoie la liste des problèmes."""
    depth, line, problems = 0, 1, []
    i, n = 0, len(code)
    top_start = None
    while i < n:
        c = code[i]
        if c == "\n":
            line += 1
        elif c == ";":
            while i < n and code[i] != "\n":
                i += 1
            continue
        elif c == '"':
            i += 1
            while i < n and code[i] != '"':
                if code[i] == "\\":
                    i += 1
                elif code[i] == "\n":
                    line += 1
                i += 1
        elif c == "(":
            if depth == 0:
                top_start = line
            depth += 1
        elif c == ")":
            depth -= 1
            if depth < 0:
                problems.append(f"ligne {line} : parenthèse fermante en trop")
                depth = 0
        i += 1
    if depth:
        problems.append(f"{depth} parenthèse(s) non fermée(s) (forme commencée ligne {top_start})")
    return problems


def check_forbidden(code):
    problems = []
    for num, raw in enumerate(code.splitlines(), 1):
        text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', raw.split(";", 1)[0] if '"' not in raw else raw)
        text = re.sub(r";.*$", "", re.sub(r'"(?:[^"\\]|\\.)*"', '""', raw))
        for pat in FORBIDDEN:
            if re.search(pat, text, re.IGNORECASE):
                problems.append(f"ligne {num} : fonction non disponible dans AutoCAD LT ({pat}) : {raw.strip()}")
    return problems


TILES = {"dialog", "row", "column", "boxed_row", "boxed_column", "radio_row", "radio_column",
         "boxed_radio_row", "boxed_radio_column", "radio_button", "toggle", "button", "edit_box",
         "popup_list", "list_box", "text", "spacer", "errtile", "ok_cancel", "ok_only", "image_button"}
ATTRS = {"label", "key", "width", "height", "fixed_width", "fixed_height", "is_default", "is_cancel",
         "edit_width", "edit_limit", "multiple_select", "alignment", "value", "mnemonic", "is_enabled",
         "children_alignment", "allow_accept", "list", "tabs", "is_bold", "color", "aspect_ratio"}


def parse_dcl(text):
    """Analyse le DCL ; renvoie ({dialogue: {clés}}, problèmes)."""
    text = re.sub(r"//[^\n]*", "", text)
    tokens = re.findall(r'"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[{}:;=]', text)
    pos, problems, protos, dialogs = 0, [], set(), {}
    implicit = {"errtile": ["error"], "ok_cancel": ["accept", "cancel"], "ok_only": ["accept"]}

    def expect(t):
        nonlocal pos
        if pos >= len(tokens) or tokens[pos] != t:
            problems.append(f"DCL : « {t} » attendu, trouvé « {tokens[pos] if pos < len(tokens) else 'fin'} »")
            raise ValueError
        pos += 1

    def body(keys):
        nonlocal pos
        expect("{")
        while tokens[pos] != "}":
            if tokens[pos] == ":":
                pos += 1
                kind = tokens[pos]
                pos += 1
                if kind not in TILES and kind not in protos:
                    problems.append(f"DCL : type de tuile inconnu « {kind} »")
                keys.extend(implicit.get(kind, []))
                body(keys)
            elif tokens[pos + 1] == "=":
                attr, value = tokens[pos], tokens[pos + 2]
                if attr not in ATTRS:
                    problems.append(f"DCL : attribut inconnu « {attr} »")
                if attr == "key":
                    keys.append(value.strip('"'))
                pos += 3
                expect(";")
            else:
                if tokens[pos] not in TILES and tokens[pos] not in protos:
                    problems.append(f"DCL : tuile inconnue « {tokens[pos]} »")
                keys.extend(implicit.get(tokens[pos], []))
                pos += 1
                expect(";")
        expect("}")

    try:
        while pos < len(tokens):
            name = tokens[pos]
            pos += 1
            expect(":")
            kind = tokens[pos]
            pos += 1
            keys = []
            body(keys)
            if kind == "dialog":
                dup = {k for k in keys if keys.count(k) > 1}
                if dup:
                    problems.append(f"DCL : clés en double dans {name} : {sorted(dup)}")
                dialogs[name] = set(keys)
            else:
                protos.add(name)
    except (ValueError, IndexError):
        problems.append("DCL : analyse interrompue")
    return dialogs, problems


def check_dialogs(code):
    """Les dialogues et clés utilisés par le code existent dans le DCL."""
    dialogs, problems = parse_dcl((SRC / "dialogues.dcl").read_text(encoding="utf-8"))
    all_keys = set().union(*dialogs.values()) if dialogs else set()
    for name in re.findall(r'\(new_dialog "([^"]+)"', code) + re.findall(r'\(tp:sub-open "([^"]+)"\)', code):
        if name not in dialogs:
            problems.append(f"dialogue « {name} » absent du DCL")
    # clés littérales (les \" des chaînes d'action comprises)
    for key in re.findall(r'\((?:set_tile|get_tile|action_tile|mode_tile|start_list)\s+\\?"([^"\\]+)\\?"', code):
        if key not in all_keys:
            problems.append(f"clé « {key} » absente du DCL")
    ops = re.search(r"\(setq tp:\*ops\*\s+'\(([^)]*)\)\)", code)
    main_keys = dialogs.get("tp_main", set())
    for key in re.findall(r'"([A-Z_0-9]+)"', ops.group(1)) if ops else []:
        if key not in main_keys:
            problems.append(f"opération « {key} » sans case dans tp_main")
    for key in sorted(k for k in main_keys if k.startswith("b_")):
        if f'"{key}"' not in code:
            problems.append(f"bouton « {key} » sans action")
    return problems


def main():
    code = (SRC / "traitement-plans.lsp").read_text(encoding="utf-8")
    if ";;@DCL@" not in code:
        sys.exit("marqueur ;;@DCL@ absent")
    problems = check_dialogs(code)
    code = code.replace(";;@DCL@", dcl_block())
    problems += check_parens(code) + check_forbidden(code)
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    # UTF-8 avec BOM : AutoCAD lit les accents, et le Bloc-notes reconnaît l'encodage.
    OUT.write_text(code.replace("\r\n", "\n").replace("\n", "\r\n"), encoding="utf-8-sig", newline="")
    print(f"{OUT.name} : {len(code.splitlines())} lignes")


if __name__ == "__main__":
    main()
