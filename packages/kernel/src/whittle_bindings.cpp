// Embind registrations for the Whittle kernel façade (whittle_kernel.h).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The toolchain parses this TU twice: once for real with emcc (Wasm target), and once with
// libclang 18 against parse-only Embind stubs to extract registration names (any parse error
// aborts the build). The stubs know `function`, `class_` and `val`, but not `typed_memory_view`,
// so buffer views are only materialised when compiling for Wasm (`__wasm__`), and the parse sees
// a declaration-only stand-in with the same signature.
//
// JS surface (typed in src/facade.ts):
//   kernelInfo(): string
//   execFeature(featureJson: string, inputsJson: string): string
//   mesh(shape: number, optionsJson: string, out: MeshData): string
//   massProperties(shape: number, densityKgPerMm3: number): string
//   fingerprints(shape: number): string
//   bounds(shape: number): string
//   exportShapes(shapesJson: string, format: string, optionsJson: string): string
//   importFile(path: string, format: string): string
//   measure(queryJson: string): string
//   subShapeGeometry(shape: number, kind: string, index: number): string
//   projectEdges(queryJson: string): string
//   projectFaceOutline(queryJson: string): string
//   configureThreads(count: number): string
//   release(shape: number): void
//   liveHandleCount(): number
//   class MeshData { positions(), normals(), indices(), faceRanges(), edgePositions(),
//                    edgeRanges(): typed views into the Wasm heap; metaJson: string }

#include "whittle_kernel.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>
#include <vector>

namespace whittle {
namespace bindings {

#if defined(__wasm__)
// Views alias the Wasm heap: valid until the MeshData is mutated or deleted, or memory grows.
// The worker copies them out (TypedArray.prototype.slice) immediately. An empty vector may
// report a null data(); hand out a zero-length view of a static element instead.
template <typename T>
emscripten::val view(const std::vector<T>& v) {
  static const T empty{};
  if (v.empty()) return emscripten::val(emscripten::typed_memory_view(size_t{0}, &empty));
  return emscripten::val(emscripten::typed_memory_view(v.size(), v.data()));
}
#else
template <typename T>
emscripten::val view(const std::vector<T>& v);
#endif

emscripten::val meshPositions(const MeshData& m) { return view(m.positions); }
emscripten::val meshNormals(const MeshData& m) { return view(m.normals); }
emscripten::val meshIndices(const MeshData& m) { return view(m.indices); }
emscripten::val meshFaceRanges(const MeshData& m) { return view(m.faceRanges); }
emscripten::val meshEdgePositions(const MeshData& m) { return view(m.edgePositions); }
emscripten::val meshEdgeRanges(const MeshData& m) { return view(m.edgeRanges); }
std::string meshMetaJson(const MeshData& m) { return m.metaJson; }

std::string meshInto(ShapeHandle shape, const std::string& optionsJson, MeshData& out) {
  return whittle::mesh(shape, optionsJson, out);
}

}  // namespace bindings
}  // namespace whittle

EMSCRIPTEN_BINDINGS(whittle_kernel) {
  emscripten::class_<whittle::MeshData>("MeshData")
      .constructor<>()
      .function("positions", &whittle::bindings::meshPositions)
      .function("normals", &whittle::bindings::meshNormals)
      .function("indices", &whittle::bindings::meshIndices)
      .function("faceRanges", &whittle::bindings::meshFaceRanges)
      .function("edgePositions", &whittle::bindings::meshEdgePositions)
      .function("edgeRanges", &whittle::bindings::meshEdgeRanges)
      .function("metaJson", &whittle::bindings::meshMetaJson);

  emscripten::function("kernelInfo", &whittle::kernelInfo);
  emscripten::function("execFeature", &whittle::execFeature);
  emscripten::function("mesh", &whittle::bindings::meshInto);
  emscripten::function("massProperties", &whittle::massProperties);
  emscripten::function("fingerprints", &whittle::fingerprints);
  emscripten::function("bounds", &whittle::bounds);
  emscripten::function("exportShapes", &whittle::exportShapes);
  emscripten::function("importFile", &whittle::importFile);
  emscripten::function("measure", &whittle::measure);
  emscripten::function("subShapeGeometry", &whittle::subShapeGeometry);
  emscripten::function("projectEdges", &whittle::projectEdges);
  emscripten::function("projectFaceOutline", &whittle::projectFaceOutline);
  emscripten::function("configureThreads", &whittle::configureThreads);
  emscripten::function("release", &whittle::release);
  emscripten::function("liveHandleCount", &whittle::liveHandleCount);
}
