#!/usr/bin/env bash
# Installs the CI-only DXF interop tools (ADR-091 amendment): LibreCAD (headless dxf2pdf), xvfb and
# poppler-utils (pdfinfo). Same shape as ci-install-browsers.sh (ADR-083 amendment): the Ubuntu
# mirrors are sometimes unreachable from the runners and apt then hangs on DNS timeouts, so each
# attempt is time-boxed (4 minutes), there is one retry, and the failure message says what happened.
# Usage: scripts/ci-install-dxf-tools.sh
set -uo pipefail
packages=(librecad xvfb poppler-utils)
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

attempt() {
  $SUDO timeout 240 apt-get update -o Acquire::Retries=0 -o Acquire::http::Timeout=20 &&
    $SUDO timeout 240 env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      -o Acquire::Retries=0 -o Acquire::http::Timeout=20 "${packages[@]}"
}

for n in 1 2; do
  if attempt; then
    exit 0
  fi
  echo "::warning::apt attempt $n of 2 for ${packages[*]} failed (mirrors unreachable?)" >&2
  sleep 10
done
echo "::error::Could not install ${packages[*]} after 2 time-boxed attempts. The Ubuntu mirrors are probably unreachable from this runner; re-run the job. This is an infrastructure failure, not a DXF failure." >&2
exit 1
