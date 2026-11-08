// Whittle kernel façade — normative C++ header (PLAN §7). Lead-owned contract.
//
// The JS<->Wasm boundary is coarse: one call = one whole operation. All structured inputs and
// outputs are JSON strings whose shapes mirror packages/contracts/src/kernel.ts:
//   - every call returns a JSON `Result<T>`: {"ok":true,"value":T} | {"ok":false,"error":KernelError}
//   - no OCCT exception may escape any function declared here (catch Standard_Failure and
//     std::exception and `...` at the boundary and convert to KernelError JSON).
// Shapes live in a process-wide handle table owned by the façade; JS only ever sees integer handles.
//
// Compiled into the libcascade (opencascade.js v3) build via `customBindings` (ADR-002);
// embind registrations live in whittle_bindings.cpp.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace whittle {

using ShapeHandle = int32_t;  // 0 is never valid

// Owned render buffers for one shape. Exposed to JS as typed_memory_view accessors; the worker
// copies them out of the Wasm heap once into transferable ArrayBuffers, then calls release().
class MeshData {
 public:
  std::vector<float> positions;       // xyz, mm
  std::vector<float> normals;         // xyz, unit
  std::vector<uint32_t> indices;      // triangles
  std::vector<uint32_t> faceRanges;   // [firstTriangle, count] per B-rep face (TopExp order)
  std::vector<float> edgePositions;   // xyz polyline points, concatenated
  std::vector<uint32_t> edgeRanges;   // [firstPoint, count] per B-rep edge (TopExp order)
  // JSON: {"faceNames":[...],"edgeNames":[...],"bbox":{"min":[..],"max":[..]}}
  std::string metaJson;
};

// Version/identity: {"ok":true,"value":{"occtVersion":"8.0.1","buildId":"...","threads":bool}}
std::string kernelInfo();

// featureJson: a contracts `Feature`; inputsJson: a contracts `FeatureInputs`.
// Returns Result<{"shape":int,"naming":NamingMap,"warnings":KernelError[]}>.
std::string execFeature(const std::string& featureJson, const std::string& inputsJson);

// Tessellates (BRepMesh_IncrementalMesh) and fills `out`. optionsJson: contracts `MeshOptions`.
// Returns Result<{}> (buffers are in `out`).
std::string mesh(ShapeHandle shape, const std::string& optionsJson, MeshData& out);

// Returns Result<MassProperties> (GProp volume/area/centroid, Bnd_Box, topology counts).
std::string massProperties(ShapeHandle shape);

// M1+: measure, exportStep, importFile, hlrProject (signatures per PLAN §7.1), added by
// contract proposal when first needed.

// Releases a handle. Unknown handles are ignored.
void release(ShapeHandle shape);

// Number of live handles (leak checks in tests).
int32_t liveHandleCount();

}  // namespace whittle
