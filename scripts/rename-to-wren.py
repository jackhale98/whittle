#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
One-off rename of the project from "Whittle" to "Wren" (Wren CAD), ADR-032.

Idempotent and repeatable: run it on the main branch and on any branch that predates the rename,
before merging that branch, so both sides carry identical edits.

    python3 scripts/rename-to-wren.py            # rewrite tracked files and git-mv renamed paths
    python3 scripts/rename-to-wren.py --check    # list what would change, change nothing

Kept on purpose (see ADR-032):
  * browser storage names and keys (IndexedDB databases, localStorage/sessionStorage keys,
    service-worker cache names), so existing libraries, settings and caches survive;
  * material library ids stored in documents (`whittle:aluminium-6061-t6`, ...);
  * the kernel's internal C++/Wasm names (`whittle_*.cpp`, `whittle::`, `WhittleKernelModule`,
    `whittle-kernel*` artefacts), renamed separately if ever;
  * this script and the ADR that explains the rename.
Old project files (`.whittle`, `whittle.project.json`, `format: "whittle-project"`) still open:
the readers accept both names (hand-written, not done by this script).
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECK = "--check" in sys.argv

SKIP_FILES = {
    "scripts/rename-to-wren.py",
    "pnpm-lock.yaml",
}
SKIP_PREFIXES = ("packages/kernel/src/",)
BINARY = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".wasm", ".zip", ".woff", ".woff2",
          ".ttf", ".otf", ".pdf", ".step", ".stp", ".stl", ".glb", ".3mf", ".brep", ".igs", ".iges"}

# Substrings that must not change. Swapped for placeholders before the rewrite, restored after.
PROTECT = [
    re.compile(r"whittle:[A-Za-z0-9_$.{}-]*"),           # storage keys, material ids, marks
    re.compile(r"whittle\.(?:theme|lastTools|nestSketches|diagnostics)\b"),  # localStorage keys
    re.compile(r"whittle-(?:library|folders|save|vault|repo-|precache|srv-|kernel)[A-Za-z0-9_$.{}-]*"),
    re.compile(r"whittle-<kind>"),
    re.compile(r"whittle_[A-Za-z0-9_]+"),                 # kernel C++ identifiers and file names
    re.compile(r"whittle::"),
    re.compile(r"WhittleKernel[A-Za-z]*"),
    re.compile(r"ADR-032[^\n]*"),                         # the rename ADR quotes the old names
]

# Ordered rewrites (first match wins per position; applied as one combined pass).
RULES: list[tuple[str, str]] = [
    (r"@whittle/", "@wren-cad/"),
    (r"jackhale98\.github\.io/whittle", "jackhale98.github.io/wren-cad"),
    (r"jackhale98/whittle", "jackhale98/wren-cad"),
    (r"(?<![A-Za-z0-9_.-])/whittle/", "/wren-cad/"),
    (r"\.whittle-history", ".wren-history"),
    (r"whittle\.project\.json", "wren.project.json"),
    (r"\.whittle/", ".wren/"),
    (r"\.whittle(?![A-Za-z0-9_-])", ".wrencad"),
    (r"__whittle", "__wren"),
    (r"WHITTLE_", "WREN_"),
    (r"Whittle(?=[A-Z])", "Wren"),
    (r"whittle(?=[A-Z])", "wren"),
    (r"Whittle", "Wren"),
    (r"WHITTLE", "WREN"),
    (r"whittle", "wren"),
]
COMBINED = re.compile("|".join(f"(?P<r{i}>{pat})" for i, (pat, _) in enumerate(RULES)))


def rewrite(text: str) -> str:
    saved: list[str] = []

    def stash(m: re.Match[str]) -> str:
        saved.append(m.group(0))
        return f"\x00{len(saved) - 1}\x00"

    for p in PROTECT:
        text = p.sub(stash, text)

    def sub(m: re.Match[str]) -> str:
        for i, (_, repl) in enumerate(RULES):
            if m.group(f"r{i}") is not None:
                return repl
        return m.group(0)

    text = COMBINED.sub(sub, text)
    return re.sub(r"\x00(\d+)\x00", lambda m: saved[int(m.group(1))], text)


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True)
    return [p for p in out.stdout.decode().split("\0") if p]


def renamed_path(path: str) -> str:
    if path.startswith(SKIP_PREFIXES) or path in SKIP_FILES:
        return path
    parts = path.split("/")
    parts[-1] = re.sub(r"^whittle-", "wren-", parts[-1])
    parts[-1] = re.sub(r"^Whittle", "Wren", parts[-1])
    return "/".join(parts)


def main() -> int:
    changed = 0
    moves: list[tuple[str, str]] = []
    for path in tracked():
        if path in SKIP_FILES or path.startswith(SKIP_PREFIXES):
            continue
        full = ROOT / path
        if not full.is_file() or full.suffix.lower() in BINARY:
            continue
        try:
            text = full.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        new = rewrite(text)
        if new != text:
            changed += 1
            if CHECK:
                print(f"edit  {path}")
            else:
                full.write_text(new, encoding="utf-8")
        target = renamed_path(path)
        if target != path:
            moves.append((path, target))
    for src, dst in moves:
        print(f"move  {src} -> {dst}")
        if not CHECK:
            subprocess.run(["git", "mv", "-k", src, dst], cwd=ROOT, check=True)
    print(f"{changed} files {'would change' if CHECK else 'changed'}, {len(moves)} moved")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
