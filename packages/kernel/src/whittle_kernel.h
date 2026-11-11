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
//   pushPull  (M2: planar faces of inputs.target at refs "/faces/<n>", values "/distance" mm along
//             each face's outward normal; prism + fuse/cut, naming.ts "M2 additions")
//   M3: shell, draft, sweep, loft, mirror, linearPattern, circularPattern, hole, import, thread,
//             axis, point and the M3 plane definitions (inputs per type: packages/kernel/README.md)
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

// Result<ShapeFingerprints> (contracts kernel.ts), TopExp order. Per face and edge memoised across
// handles (ADR-084): a sub-shape shared with an earlier result is not integrated again.
std::string fingerprints(ShapeHandle shape);

// Cheap shape summary for the regen engine (ADR-084): Result<{"bbox":{"min":[..],"max":[..]},
// "faceCount","edgeCount","vertexCount"}>. The bbox is exactly massProperties' (the same
// geometry-exact Bnd_Box, BRepBndLib::AddOptimal without the tolerance gap) and so are the counts,
// but nothing is integrated: no volume, area or inertia. Face boxes are memoised across handles.
std::string bounds(ShapeHandle shape);

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


// M2: exact measurement (contracts `Measurement`). queryJson: {"a": Target, "b"?: Target} with
// Target = {"shape":int,"kind":"face"|"edge"|"vertex"|"body","index":int} (a ResolvedRef) or
// {"point":[x,y,z]} (mm). One target: position (vertex/point), length (+ radius of circles) of
// an edge, area (+ radius of cylinders/spheres) of a face, area of a body. Two targets: minimum
// distance + closest points (BRepExtrema_DistShapeShape) and, for planar faces/straight edges,
// the angle in radians (conventions in whittle_measure.cpp). Returns Result<Measurement>.
std::string measure(const std::string& queryJson);

// M3 "convert entities": projects model edges onto a sketch plane. queryJson:
// {"shape":int,"edges":[int (TopExp edge ordinals)],"plane":Frame[,"exact":bool]}. Returns
// Result<[{"edge":int,"curves":ProjectedCurve[]}]> in the plane frame's local x/y (mm), where
// ProjectedCurve = {"kind":"line","a":[x,y],"b":[x,y]} | {"kind":"circle","c":[x,y],"r":number}
// | {"kind":"arc","c","r","start","end"} (counter-clockwise in plane coordinates)
// | {"kind":"polyline","points":[[x,y],…]} (approximated: ellipses, circles seen obliquely,
// splines; within ~1 µm). Edges that project to a point (along the normal) get no curves.
// M3.5: with "exact":true, conics and B-splines come back exactly (projection is affine):
// {"kind":"ellipse"|"ellipticArc","c","majorRadius","minorRadius","rotation"[,"start","end"]}
// and {"kind":"bspline","poles","degree","periodic","weights"?,"knots","multiplicities"}.
std::string projectEdges(const std::string& queryJson);

// M3: {"shape":int,"face":int (TopExp face ordinal),"plane":Frame[,"exact":bool]} →
// Result<{"outer":[{"edge","curves"}…],"inner":[[{"edge","curves"}…]…]}> (loops in wire order).
std::string projectFaceOutline(const std::string& queryJson);

// M4: exact geometry of one sub-shape (kind "face" | "edge" | "vertex", index in TopExp order), for
// the annotation resolver. Result<{"kind", …}>:
//   vertex  {"point"}
//   face    {"surface":"plane","origin","normal"(outward)} | {"surface":"cylinder","origin","axis",
//           "radius","extent":[v0,v1] (axial, from origin),"concave"} | {"surface":"cone","origin",
//           "axis","radius"(at origin),"semiAngle","apex","extent","concave"} | {"surface":"sphere",
//           "center","radius","concave"} | {"surface":"torus","origin","axis","majorRadius",
//           "minorRadius"} | other surfaces: {"surface"} only
//   edge    {"curve","start","end"} plus line {"point","direction","length"} | circle {"center",
//           "normal","xAxis","radius","startAngle","endAngle","full"} | ellipse {"center","normal",
//           "xAxis","majorRadius","minorRadius","startParameter","endParameter","full"}
// "concave": the outward normal points towards the axis or centre (a hole). Start/end and angles
// follow the curve's parametrisation, not the edge's orientation in a wire.
std::string subShapeGeometry(ShapeHandle shape, const std::string& kind, int32_t index);

// M4: HLR runs in the separate drawing kernel (drawing/cpp/wren_drawing.h, ADR-090 amendment).
// M5: exportStep with PMI — added by contract proposal.

// Releases a handle. Unknown handles are ignored.
void release(ShapeHandle shape);

// Number of live handles (leak checks in tests).
int32_t liveHandleCount();

}  // namespace whittle
