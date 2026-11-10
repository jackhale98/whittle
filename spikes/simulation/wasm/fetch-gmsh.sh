#!/usr/bin/env bash
# Spike S0: fetch the pinned Gmsh source (GPL-2.0-or-later) into spikes/simulation/build/.
# Never committed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${GMSH_SRC_DIR:-$here/../build/gmsh-src}"
version=4.15.2
sha=be3f66f225d27ba9fa014f07e83169285da8a051b0e8ab7103d88066b39bdd3e
if [ -f "$dest/gmsh-$version-source/CMakeLists.txt" ]; then echo "$dest/gmsh-$version-source"; exit 0; fi
mkdir -p "$dest"
tgz="$dest/gmsh-$version-source.tgz"
curl -sSfL -o "$tgz" "https://gmsh.info/src/gmsh-$version-source.tgz"
echo "$sha  $tgz" | sha256sum -c - >&2
tar -xzf "$tgz" -C "$dest"
rm -f "$tgz"
echo "$dest/gmsh-$version-source"
