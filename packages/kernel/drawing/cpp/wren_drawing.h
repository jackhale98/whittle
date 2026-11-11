// Wren drawing kernel façade — header (PLAN §3 drawings, ADR-090 §14). Hidden-line removal for the
// drawing worker, in its own trimmed Wasm build (drawing/libcascade.config.ts, ADR-090 amendment).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Build note: drawing/scripts/amalgamate.mjs concatenates, in this order,
//   src/whittle_kernel.h, drawing/cpp/wren_drawing.h, src/whittle_core.cpp,
//   drawing/cpp/wren_drawing_geom.cpp, drawing/cpp/wren_drawing_hlr.cpp,
//   drawing/cpp/wren_drawing_api.cpp, drawing/cpp/wren_drawing_bindings.cpp
// into drawing/.libcascade/wren_drawing_facade.cpp. The shared core (JSON, KernelError, `guarded`,
// the handle table) is the main kernel's whittle_core.cpp unchanged; everything that file does not
// use is dropped by the compiler and the linker, so the drawing build carries no modeling or data
// exchange code. Every OCCT header the drawing sources need is included here, at file scope,
// because whittle_core.cpp opens `namespace whittle { namespace {` and the files after it continue
// that anonymous namespace (wren_drawing_api.cpp closes it).
//
// The boundary is coarse, like the main façade (PLAN §7.1): one call loads a shape, one call
// projects one view. Inputs and outputs are JSON `Result<T>` strings; no exception crosses the
// boundary (every entry point runs inside `guarded`).

#pragma once

#include "whittle_kernel.h"

#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <HLRAlgo_BiPoint.hxx>
#include <HLRAlgo_EdgeIterator.hxx>
#include <HLRAlgo_EdgeStatus.hxx>
#include <HLRAlgo_Projector.hxx>
#include <HLRBRep_Algo.hxx>
#include <HLRBRep_Curve.hxx>
#include <HLRBRep_Data.hxx>
#include <HLRBRep_EdgeData.hxx>
#include <HLRBRep_FaceData.hxx>
#include <HLRBRep_FaceIterator.hxx>
#include <HLRBRep_PolyAlgo.hxx>
#include <HLRBRep_ShapeBounds.hxx>
#include <HLRTopoBRep_Data.hxx>
#include <HLRTopoBRep_OutLiner.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <gp.hxx>
#include <gp_Pnt2d.hxx>

#include <chrono>
#include <cstdint>
#include <map>
#include <string>
#include <tuple>

namespace whittle {

// {"ok":true,"value":{"occtVersion":"8.0.1","buildId":"…","threads":bool,"kind":"drawing"}}
std::string drawingInfo();

// Reads a BREP file from MEMFS (the worker writes `ShapeForDrawing.brep` there and unlinks it after
// the call). Encodes edge regularity (BRepLib::EncodeRegularity) so tangent and seam edges classify
// as smooth and sewn even when the writer did not store their continuity. TopExp::MapShapes order
// is unchanged, so `ShapeForDrawing.edgeNames[i]` names edge i of the loaded shape.
// Result<{"handle":int,"edges":int,"faces":int,"solids":int}>.
std::string loadShape(const std::string& path);

// Projects one view of a loaded shape. requestJson (built by src/drawing/request.ts):
//   {"frame":{"x":[3],"y":[3]}            view right/up, orthonormal (the viewer looks along −x×y)
//    "quality":"draft"|"exact"            HLRBRep_PolyAlgo on the tessellation | HLRBRep_Algo
//    "hidden":bool, "smooth":bool         include hidden lines; include smooth and sewn edges
//    "linearDeflection":mm, "angularDeflection":rad   draft tessellation
//    "sampleTolerance":mm                 chord tolerance of curves without an exact 2D form
//    "section"?:{"cut":[[3]…],"along":[3],"look":[3],"depth":"full"|"slice"}
//    "clip"?:{"center":[2],"radius":mm}}
// Result<{"curves":[{"role":"visible"|"hidden","edge":"sharp"|"smooth"|"outline"|"sewn",
//                    "index":int (input edge, TopExp order; −1 = none),
//                    "face":int (outlines: the input face outlined, TopExp order; −1 = none),
//                    "curve":Curve2}],
//         "sectionFaces":[{"segment":int,"loops":[[Curve2…]…]}],
//         "stats":{"hlrMs":number,"cutMs":number,"edges":int,"faces":int}}>
// Curve2 is contracts drawing.ts `Curve2`, in view-plane part mm (origin = projected part origin).
std::string project(ShapeHandle shape, const std::string& requestJson);

}  // namespace whittle
