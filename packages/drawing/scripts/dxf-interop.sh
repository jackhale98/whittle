#!/usr/bin/env bash
# DXF interop checks (PLAN §12 M4 Accept, ADR-091 amendment): the same ones CI runs.
#   1. ezdxf structure audit (test/dxf.test.ts, needs python3 with ezdxf==1.4.5),
#   2. headless LibreCAD `dxf2pdf` of both goldens and a fresh export, then `pdfinfo` page count.
# A missing tool is reported by name and its check is skipped, unless WREN_REQUIRE_INTEROP=1 (CI),
# which makes a missing tool a failure.
# Usage: pnpm --filter @wren-cad/drawing dxf:interop
set -uo pipefail
pkg="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
require="${WREN_REQUIRE_INTEROP:-0}"
failed=0
missing=()

have() { command -v "$1" >/dev/null 2>&1; }
fail() { echo "FAIL: $*" >&2; failed=1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Real exports, written by a test so the TypeScript sources need no separate build.
mkdir -p "$work/in"
cp "$pkg/test/golden/basic-r12.dxf" "$work/in/golden-r12.dxf"
cp "$pkg/test/golden/basic-r2000.dxf" "$work/in/golden-r2000.dxf"
(cd "$pkg" && WREN_DXF_EXPORT_DIR="$work/in" npx vitest run test/dxf-export.test.ts) || fail "could not generate the export fixtures"

# 1. ezdxf
if python3 -I -c 'import ezdxf' >/dev/null 2>&1; then
  echo "== ezdxf $(python3 -I -c 'import ezdxf; print(ezdxf.__version__)')"
  (cd "$pkg" && WREN_REQUIRE_EZDXF=1 npx vitest run test/dxf.test.ts -t 'ezdxf audit') || fail "ezdxf audit"
else
  missing+=("ezdxf (python3 -m venv .venv-dxf && .venv-dxf/bin/pip install ezdxf==1.4.5, then put .venv-dxf/bin first on PATH)")
fi

# 2. LibreCAD
for tool in librecad xvfb-run pdfinfo; do
  have "$tool" || missing+=("$tool (apt: librecad, xvfb, poppler-utils; CI uses scripts/ci-install-dxf-tools.sh)")
done
if have librecad && have xvfb-run && have pdfinfo; then
  echo "== LibreCAD dxf2pdf"
  for dxf in "$work"/in/*.dxf; do
    rm -f "${dxf%.dxf}.pdf"
    name="$(basename "$dxf" .dxf)"
    # No `-o`: LibreCAD 2.2.0 writes <name>.pdf beside the input and ignores -o for a single file.
    pdf="$work/in/$name.pdf"
    if ! timeout 120 xvfb-run -a librecad dxf2pdf -a "$dxf"; then
      fail "$name: librecad dxf2pdf exited non-zero"
      continue
    fi
    if [ ! -s "$pdf" ]; then fail "$name: no PDF produced, or it is empty"; continue; fi
    pages="$(pdfinfo "$pdf" 2>/dev/null | awk '/^Pages:/ {print $2}')"
    if [ -z "$pages" ] || [ "$pages" -lt 1 ]; then fail "$name: pdfinfo reports no pages"; continue; fi
    echo "ok $name: $pages page(s), $(stat -c %s "$pdf") bytes"
  done
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing tools, checks skipped:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  if [ "$require" = "1" ]; then fail "WREN_REQUIRE_INTEROP=1 and tools are missing"; fi
fi
if [ "$failed" -eq 0 ]; then echo "dxf:interop passed"; fi
exit "$failed"
