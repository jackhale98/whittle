#!/usr/bin/env bash
# Spike S0: runs inside the libcascade image (see build.sh). /gmsh = Gmsh source (ro),
# /api = spikes/simulation/wasm (ro), /build = output. STAGE = configure | lib | link | all.
set -euo pipefail
OCC=/opencascade.js/build
jobs="${JOBS:-2}"
stage="${STAGE:-all}"

# Same codegen as the kernel's OCCT objects (build-flags.json): -O3, native Wasm EH, SIMD,
# OCCT_NO_DUMP. Threaded: pthreads (atomics + bulk memory) so the objects can share memory.
common="-fwasm-exceptions -msimd128 -DOCCT_NO_DUMP"
if [ "$VARIANT" = multi ]; then common="$common -pthread"; fi

# The OCCT toolkits Gmsh's CMake asks for (>= 7.8 names), plus what TKDESTEP/TKDEIGES pull in.
libs=""
for tk in TKDESTEP TKDEIGES TKDE TKXSBase TKOffset TKFeat TKFillet TKBool TKMesh TKHLR TKBO \
  TKPrim TKShHealing TKTopAlgo TKGeomAlgo TKBRep TKGeomBase TKG3d TKG2d TKMath TKernel; do
  libs="$libs;$OCC/occt-libraries/lib$tk.a"
done
libs="${libs#;}"

if [ "$stage" = all ] || [ "$stage" = configure ]; then
  # OCCT 8 headers need C++17 (std::optional, std::in_place); Gmsh 4.15.2 pins C++14 with a plain
  # set(), which -DCMAKE_CXX_STANDARD cannot override. Patch the fetched copy.
  sed -i 's/set(CMAKE_CXX_STANDARD 14)/set(CMAKE_CXX_STANDARD 17)/' /gmsh/CMakeLists.txt
  # Minimal Gmsh: OCC + mesh (Delaunay/Frontal 3D built in, HXT, Netgen frontal), Eigen for
  # linear algebra. No FLTK, PETSc, Fortran, OpenMP (Emscripten has none), MED/CGNS, parser,
  # post-processing or plugins.
  emcmake cmake -S /gmsh -B /build/gmsh -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DDEFAULT=0 -DENABLE_BUILD_LIB=1 \
    -DENABLE_MESH=1 -DENABLE_OCC=1 -DENABLE_OCC_STATIC=1 -DENABLE_OCC_CAF=0 \
    -DENABLE_HXT=1 -DENABLE_NETGEN=1 -DENABLE_EIGEN=1 -DENABLE_ANN=1 \
    -DENABLE_OPENMP=0 -DENABLE_GMP=0 -DENABLE_TINYOBJLOADER=0 -DENABLE_TESTS=0 \
    -DOCC_INC="$OCC/occt-includes" -DOCC_LIBS="$libs" \
    -DCMAKE_C_FLAGS="$common" \
    -DCMAKE_CXX_FLAGS="$common -I/api/occt8-compat -Wno-deprecated-declarations" \
    2>&1 | tee /build/configure.log | grep -E "Found OpenCASCADE|Gmsh .* has been configured|Build options|Error|error" || true
fi

if [ "$stage" = all ] || [ "$stage" = lib ]; then
  start=$(date +%s)
  emmake make -C /build/gmsh -j"$jobs" lib 2>&1 | tee /build/lib.log | grep -E "error|Error|\[100%\]" || true
  echo "lib build seconds: $(( $(date +%s) - start ))" | tee /build/lib-time.txt
fi

if [ "$stage" = all ] || [ "$stage" = link ]; then
  mkdir -p /build/out
  inc=""
  for d in /gmsh/src/*/ /gmsh/api /build/gmsh/src/common /gmsh/contrib/hxt/include; do inc="$inc -I$d"; done
  link_threads=""
  if [ "$VARIANT" = multi ]; then link_threads="-sSHARED_MEMORY=1 -sPTHREAD_POOL_SIZE=4"; fi
  start=$(date +%s)
  # shellcheck disable=SC2086
  em++ -std=c++17 -O3 $common -I"$OCC/occt-includes" $inc -Wno-deprecated-declarations \
    /api/wren_mesh.cpp /build/gmsh/libgmsh.a ${libs//;/ } \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWrenMesh \
    -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB \
    -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sMALLOC=mimalloc -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_FUNCTIONS=_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=FS,wasmMemory,UTF8ToString,stringToUTF8,lengthBytesUTF8,ccall,cwrap,HEAPU8,HEAPU32,HEAPF64 \
    $link_threads -o /build/out/wren-mesh.js 2>&1 | tee /build/link.log
  echo "link seconds: $(( $(date +%s) - start ))" | tee /build/link-time.txt
  ls -l /build/out
fi
