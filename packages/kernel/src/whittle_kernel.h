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

// featureJson: a contracts `Feature`; inputsJson: a contracts `FeatureInputs` (refs pre-resolved
// by the regen engine; the kernel never resolves names). Handles every M1 feature type:
//   primitive (box | cylinder | sphere; op new/add/cut/intersect against inputs.target)
//   sketch    (inputs.frames.plane; entities already solved) -> compound of curve edges, points
//             and region faces, naming S…:e(), S…:p(), S…:region() (naming.ts)
//   extrude, revolve (profile region faces at refs "/profile/<n>"; revolve axis at refs "/axis"
//             or inputs.frames.axis; op new/add/cut/intersect against inputs.target and
//             inputs.shapes["scope…"])
//   fillet, chamfer (edges at refs "/edges/<n>"), boolean (refs "/target", "/tools/<n>"),
//   plane (offset from refs "/definition/from" or a frame)
// using Generated / Modified / IsDeleted history for names (PLAN §7.3).
// Returns Result<{"shape":int,"naming":NamingMap,"warnings":KernelError[]}> plus, where they
// apply: "frame" (sketch, plane), "regions" (sketch: region names) and "bodies" (cut/intersect
// over several scope bodies: [{"key":string,"shape":int,"naming":NamingMap}]).
std::string execFeature(const std::string& featureJson, const std::string& inputsJson);

// Tessellates (BRepMesh_IncrementalMesh) and fills `out`. optionsJson: contracts `MeshOptions`.
// A coarser request after a finer one re-meshes (the cached triangulation is dropped).
// Returns Result<{}> (buffers are in `out`).
std::string mesh(ShapeHandle shape, const std::string& optionsJson, MeshData& out);

// Returns Result<MassProperties> (GProp volume/area/centroid, Bnd_Box, topology counts). With
// densityKgPerMm3 > 0 also "mass" (kg) and "inertia" (kg·mm², about the centroid, row-major
// 3×3, axes parallel to world) — ADR-004. 0 = geometry only.
std::string massProperties(ShapeHandle shape, double densityKgPerMm3);

// Result<ShapeFingerprints> (contracts kernel.ts), TopExp order.
std::string fingerprints(ShapeHandle shape);

// format: "step" | "stl" | "brep"; optionsJson: contracts ExportOptions. Writes to MEMFS and
// returns Result<{"path":string,"files":[{"path":string,"name":string}]}> ("files" has one entry
// per written file: several for STL with stlPerBody); the worker reads the bytes and unlinks.
// shapesJson: [{"shape":int,"name":string,"color"?:"#rrggbb"}]. STEP goes through XCAF (product
// names + colours), schema per options.stepSchema (default AP214).
std::string exportShapes(const std::string& shapesJson, const std::string& format,
                         const std::string& optionsJson);

// Reads a MEMFS file; returns Result<{"bodies":[{"shape":int,"name"?:string}]}> (one body per
// solid; STEP assemblies are flattened with their placements; STL gives one mesh-only face).
std::string importFile(const std::string& path, const std::string& format);

// Threaded build: re-initialises OCCT's default thread pool (OSD_ThreadPool) with
// min(count, logical cores) threads; keep it within the pthread pool the module was started
// with. Single-threaded build: no-op. Returns Result<{"threads":int,"max":int}>.
std::string configureThreads(int32_t count);


// M3+: measure; M4: hlrProject; M5: exportStep with PMI — added by contract proposal.

// Releases a handle. Unknown handles are ignored.
void release(ShapeHandle shape);

// Number of live handles (leak checks in tests).
int32_t liveHandleCount();

}  // namespace whittle
