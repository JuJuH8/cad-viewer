# SPDX-License-Identifier: GPL-3.0-or-later
"""Produit « Traitement de plans - Lisez-moi.pdf » à partir de Lisez-moi.md.

Markdown → HTML mis en page (convertisseur limité aux éléments utilisés par la notice),
puis impression en PDF par Chrome ou Edge sans interface. Usage : python doc_pdf.py
"""
import html
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "Lisez-moi.md"
OUT = ROOT / "Traitement de plans - Lisez-moi.pdf"
BROWSERS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]

CSS = """
@page { size: A4; margin: 18mm 17mm 20mm 17mm;
        @bottom-center { content: "Traitement de plans — " counter(page) " / " counter(pages);
                         font: 8pt 'Segoe UI', sans-serif; color: #8a94a3; } }
* { box-sizing: border-box; }
body { font: 10pt/1.5 'Segoe UI', Calibri, Arial, sans-serif; color: #1f2733; margin: 0; }
header.titre { border-bottom: 3px solid #1d5fa8; padding-bottom: 10px; margin-bottom: 16px; }
header.titre h1 { font-size: 22pt; margin: 0 0 4px; color: #123c6b; }
header.titre p { margin: 0; color: #4b5869; }
header.titre .version { font-size: 9pt; color: #8a94a3; margin-top: 4px; }
h2 { font-size: 14pt; color: #123c6b; margin: 22px 0 8px; padding-bottom: 3px;
     border-bottom: 1px solid #d5dce6; break-after: avoid; }
h3 { font-size: 11pt; color: #1d5fa8; margin: 14px 0 4px; break-after: avoid; }
p { margin: 6px 0; }
ul, ol { margin: 4px 0 8px; padding-left: 22px; }
li { margin: 2px 0; }
li > ul, li > ol { margin: 2px 0; }
code { font: 9pt Consolas, 'Cascadia Mono', monospace; background: #eef2f7; padding: 1px 4px;
       border-radius: 3px; color: #123c6b; }
strong { color: #10223a; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 9.5pt; }
th { background: #1d5fa8; color: #fff; text-align: left; padding: 5px 8px; }
td { border-bottom: 1px solid #dde3ea; padding: 4px 8px; vertical-align: top; }
tr:nth-child(even) td { background: #f5f8fb; }
tr { break-inside: avoid; }
figure { margin: 10px 0 14px; text-align: center; break-inside: avoid; }
figure img { max-width: 78%; border: 1px solid #c9d2dd; border-radius: 4px; }
figcaption { font-size: 8.5pt; color: #6b7686; margin-top: 4px; }
"""


def inline(text):
    """Gras, code, liens (le texte est échappé, le code est protégé)."""
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for part in parts:
        if part.startswith("`") and part.endswith("`") and len(part) > 1:
            out.append("<code>" + html.escape(part[1:-1]) + "</code>")
            continue
        s = html.escape(part, quote=False)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
        out.append(s)
    return "".join(out)


def convert(md):
    lines = md.splitlines()
    body, i = [], 0
    title, intro = None, []
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if line.startswith("# "):
            title = line[2:].strip()
            i += 1
            # paragraphe d'introduction rattaché au titre
            while i < len(lines) and not lines[i].strip():
                i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"\s*([-*]|\d+\.)\s", lines[i]):
                intro.append(lines[i].strip())
                i += 1
            continue
        if line.startswith("### "):
            body.append(f"<h3>{inline(line[4:].strip())}</h3>")
            i += 1
            continue
        if line.startswith("## "):
            body.append(f"<h2>{inline(line[3:].strip())}</h2>")
            i += 1
            continue
        m = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if m:
            src = (ROOT / m.group(2)).resolve().as_uri()
            body.append(f'<figure><img src="{src}" alt="{html.escape(m.group(1))}">'
                        f"<figcaption>{inline(m.group(1))}</figcaption></figure>")
            i += 1
            continue
        if stripped.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            head, rest = rows[0], rows[1:]
            t = ["<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"]
            t += ["<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rest]
            body.append("".join(t) + "</tbody></table>")
            continue
        if re.match(r"\s*([-*]|\d+\.)\s", line):
            block = []
            while i < len(lines) and lines[i].strip() and (re.match(r"\s*([-*]|\d+\.)\s", lines[i]) or lines[i].startswith("  ")):
                block.append(lines[i])
                i += 1
            body.append(list_html(block))
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r"(#|\||!\[|\s*([-*]|\d+\.)\s)", lines[i]):
            para.append(lines[i].strip())
            i += 1
        body.append(f"<p>{inline(' '.join(para))}</p>")
    return title, " ".join(intro), "\n".join(body)


def list_html(block):
    """Listes imbriquées (indentation), à puces ou numérotées."""
    out, stack = [], []  # stack : (indentation, balise)
    for line in block:
        m = re.match(r"(\s*)([-*]|\d+\.)\s+(.*)", line)
        if not m:  # suite du texte de l'élément précédent
            out[-1] = out[-1][:-5] + " " + inline(line.strip()) + "</li>"
            continue
        indent, tag = len(m.group(1)), ("ol" if m.group(2)[0].isdigit() else "ul")
        while stack and indent < stack[-1][0]:
            out.append(f"</{stack.pop()[1]}></li>")
        if not stack or indent > stack[-1][0]:
            if stack:  # ouvre une sous-liste dans l'élément précédent
                out[-1] = out[-1][:-5]
            out.append(f"<{tag}>")
            stack.append((indent, tag))
        out.append(f"<li>{inline(m.group(3))}</li>")
    while stack:
        out.append(f"</{stack.pop()[1]}>")
        if stack:
            out.append("</li>")
    return "".join(out)


def main():
    title, intro, body = convert(SRC.read_text(encoding="utf-8"))
    page = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style></head><body>
<header class="titre"><h1>{html.escape(title)}</h1><p>{inline(intro)}</p>
<p class="version">Version 1.0 — octobre 2026</p></header>
{body}
</body></html>"""
    browser = next((b for b in BROWSERS if pathlib.Path(b).exists()), None)
    if not browser:
        sys.exit("Chrome ou Edge introuvable")
    work = pathlib.Path(tempfile.mkdtemp(prefix="tp_doc_"))
    page_file = work / "notice.html"
    page_file.write_text(page, encoding="utf-8")
    subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    f"--user-data-dir={work / 'profil'}", f"--print-to-pdf={OUT}", page_file.as_uri()],
                   capture_output=True, timeout=120)
    shutil.rmtree(work, ignore_errors=True)
    print(OUT.name, OUT.stat().st_size if OUT.exists() else "NON CRÉÉ")


if __name__ == "__main__":
    main()
