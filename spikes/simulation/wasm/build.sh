#!/usr/bin/env bash
# Spike S0: build Gmsh 4.15.2 to WebAssembly against the Wren kernel's OCCT 8.0.1 static
# libraries, inside the same digest-pinned libcascade 3.1.0 images the kernel uses (Emscripten
# 6.0.5, -O3, native Wasm exceptions, SIMD). Output: spikes/simulation/build/<variant>/out/
# wren-mesh.{js,wasm}.
#
#   spikes/simulation/wasm/build.sh [single|multi]
#
# Resource rules: one container, at most 2 cores (JOBS, default 2), nice 19 inside.
set -euo pipefail
variant="${1:-single}"
here="$(cd "$(dirname "$0")" && pwd)"
build="$(cd "$here/.." && pwd)/build/$variant"
src="$("$here/fetch-gmsh.sh")"
case "$variant" in
  single) image=ghcr.io/taucad/opencascade.js@sha256:d7bf97ada840afb0f0e0f6bba04b1b55dd0d276e1679a3e40c1431a2cf44900b ;;
  multi) image=ghcr.io/taucad/opencascade.js@sha256:10b1b3c60c88d090bef61f27f00ad838af233066a8d2e04541557c71599e9373 ;;
  *) echo "variant must be single or multi" >&2; exit 2 ;;
esac
mkdir -p "$build"
exec docker run --rm --cpus "${JOBS:-2}" --tmpfs /tmp \
  -e VARIANT="$variant" -e JOBS="${JOBS:-2}" -e STAGE="${STAGE:-all}" \
  -v "$src:/gmsh" -v "$here:/api:ro" -v "$build:/build" \
  --entrypoint nice "$image" -n 19 bash /api/build-in-container.sh
