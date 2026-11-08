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
// densityKgPerMm3 <= 0 means "geometry only" (no mass/inertia fields).
std::string massProperties(ShapeHandle shape, double densityKgPerMm3);

// ---- M1 ------------------------------------------------------------------------------------
// execFeature additionally handles (inputs per contracts FeatureInputs, refs pre-resolved):
//   sketch   (inputs.frames.plane; entities already solved) -> compound of wires + region faces,
//            naming per naming.ts (S…:e(), S…:p(), S…:region())
//   extrude, revolve (profile region faces in inputs.refs; op new/add/cut/intersect against
//            inputs.target/shapes.scope), fillet, chamfer, boolean, plane
// using BRepTools_History / Generated / Modified for names (PLAN §7.3).

// Result<ShapeFingerprints> (contracts kernel.ts).
std::string fingerprints(ShapeHandle shape);

// format: "step" | "stl" | "brep"; optionsJson: contracts ExportOptions. Writes to MEMFS and
// returns Result<{"path":string}>; the worker reads the bytes and unlinks the file.
// shapesJson: [{"shape":int,"name":string,"color"?:string}]
std::string exportShapes(const std::string& shapesJson, const std::string& format,
                         const std::string& optionsJson);

// Reads a MEMFS file; returns Result<{"bodies":[{"shape":int,"name"?:string}]}>.
std::string importFile(const std::string& path, const std::string& format);

// Threaded build only: caps OSD_ThreadPool / default thread count (kernel agent proposal).
std::string configureThreads(int32_t count);

// M3+: measure; M4: hlrProject; M5: exportStep with PMI — added by contract proposal.

// Releases a handle. Unknown handles are ignored.
void release(ShapeHandle shape);

// Number of live handles (leak checks in tests).
int32_t liveHandleCount();

}  // namespace whittle
