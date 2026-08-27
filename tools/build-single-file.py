#!/usr/bin/env python3
"""Bundle Dr Beat 21 into a single self-contained HTML file.

    python3 tools/build-single-file.py            -> dist/drbeat21.html
    python3 tools/build-single-file.py --artifact -> dist/drbeat21-artifact.html

The standalone build is a complete document you can open from disk or hand to
someone as one file. The --artifact build omits the document skeleton, because
the Claude Artifact host supplies its own <head>/<body> wrapper.

Both builds are generated from the same css/ and js/ sources, so there is no
second copy of the app to keep in sync.
"""
import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    'family=Barlow:ital,wght@0,400;0,500;0,600;1,400&'
    'family=Barlow+Condensed:wght@500;600;700&'
    'family=Azeret+Mono:wght@600;700&display=swap">'
)

TITLE = "Dr Beat 21"


def read(rel):
    path = ROOT / rel
    if not path.exists():
        sys.exit(f"missing source file: {rel}")
    return path.read_text(encoding="utf-8")


def body_of(html):
    """The markup between the body tags, minus the external script tags.

    The head is stripped first: it contains prose and comments that can mention
    a literal body tag, and a plain search would happily match one of those and
    splice half a comment into the bundle.
    """
    html = re.sub(r"<head\b.*?</head\s*>", "", html, flags=re.S | re.I)
    match = re.search(r"<body[^>]*>(.*)</body\s*>", html, re.S | re.I)
    if not match:
        sys.exit("could not find the body element in index.html")
    body = match.group(1)
    return re.sub(r'\s*<script src="[^"]+"></script>', "", body).strip()


def script_order(html):
    """Keep the load order index.html declares rather than hardcoding it here."""
    return re.findall(r'<script src="([^"]+)"></script>', html)


def build(artifact: bool) -> str:
    index = read("index.html")
    css = read("css/style.css")

    scripts = []
    for src in script_order(index):
        scripts.append(f"/* ---- {src} ---- */\n{read(src)}")
    # Each file is its own <script> so a syntax error in one cannot take out the rest.
    script_tags = "\n".join(f"<script>\n{s}\n</script>" for s in scripts)

    parts = [
        f"<title>{TITLE}</title>",
        FONTS,
        f"<style>\n{css}\n</style>",
        body_of(index),
        script_tags,
    ]
    inner = "\n\n".join(parts)

    if artifact:
        return inner + "\n"

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"{parts[0]}\n{parts[1]}\n{parts[2]}\n</head>\n<body>\n"
        f"{parts[3]}\n\n{parts[4]}\n</body>\n</html>\n"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--artifact", action="store_true",
                    help="emit a fragment for the Artifact host instead of a full document")
    args = ap.parse_args()

    out_dir = ROOT / "dist"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / ("drbeat21-artifact.html" if args.artifact else "drbeat21.html")
    html = build(args.artifact)
    out.write_text(html, encoding="utf-8")
    print(f"{out.relative_to(ROOT)}  —  {len(html.encode('utf-8')) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
