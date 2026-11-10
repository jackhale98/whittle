// Spike S0: tiny C API over Gmsh (built to Wasm against the kernel's OCCT 8.0.1 static libs).
//
// Flow (JS side: wasm/mesh-node.mjs):
//   FS.writeFile('/part.brep', bytes)
//   wm_load_brep('/part.brep')            -> face count (TopExp order), or -1
//   wm_name_face(i, name)                 -> physical surface group named after the Wren
//                                            persistent name of TopExp face i
//   wm_set_option('Mesh.MeshSizeMax', h)  -> any Gmsh numeric option
//   wm_set_face_size(i, h)                -> size at the points of face i
//   wm_mesh(order)                        -> 0 / -1; fills the result buffers
//   wm_count(kind, g), wm_ptr(kind, g)    -> kind 0 nodes (f64 xyz), 1 tet10 (u32, 0-based),
//                                            2 tri6 of named group g (u32), 3 group name (char*)
//   wm_last_error()                       -> JSON {"code","message"} of the last failure
//
// TopExp face index -> Gmsh tag is exact: the shape is handed to Gmsh by pointer
// (importShapesNativePointer binds the same TShapes), and every Gmsh face's native TopoDS_Face
// is looked up in TopExp::MapShapes(shape, FACE) (IsSame). Nothing is matched by geometry.
//
// Every entry point catches everything (OCCT 8 Standard_Failure derives from std::exception;
// Gmsh throws std::runtime_error with General.AbortOnError = 3) and returns -1 + an error JSON.
//
// SPDX-License-Identifier: GPL-3.0-or-later

#include <cstdint>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Shape.hxx>

#include "GEntity.h"
#include "GFace.h"
#include "GModel.h"
#include "gmsh.h"

#include <emscripten/emscripten.h>

namespace {

TopoDS_Shape g_shape;
TopTools_IndexedMapOfShape g_faces;
std::vector<int> g_faceTag;  // TopExp index -> Gmsh surface tag
struct Group {
  std::string name;
  int index;
};
std::vector<Group> g_groups;
std::vector<double> g_nodes;
std::vector<uint32_t> g_tets;
std::vector<std::vector<uint32_t>> g_tris;
std::string g_error = "{}";
bool g_init = false;

std::string jsonEscape(const std::string &s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      o += ' ';
    } else {
      o += c;
    }
  }
  return o;
}

int fail(const char *code, const std::string &msg) {
  g_error = std::string("{\"code\":\"") + code + "\",\"message\":\"" + jsonEscape(msg) + "\"}";
  return -1;
}

template <typename F>
int guarded(F &&f) {
  try {
    return f();
  } catch (const Standard_Failure &e) {
    return fail("OCCT_EXCEPTION", std::string(e.ExceptionType()) + ": " + e.what());
  } catch (const std::bad_alloc &) {
    return fail("OUT_OF_MEMORY", "allocation failed");
  } catch (const std::exception &e) {
    return fail("MESH_FAILED", e.what());
  } catch (...) {
    return fail("INTERNAL", "unknown exception");
  }
}

void ensureInit() {
  if (g_init) return;
  gmsh::initialize(0, nullptr, false, false);
  gmsh::option::setNumber("General.Terminal", 0);
  gmsh::option::setNumber("General.AbortOnError", 3);  // throw, never exit()
  g_init = true;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char *wm_version() {
  static std::string v;
  v = gmsh::GMSH_API_VERSION;
  return v.c_str();
}

EMSCRIPTEN_KEEPALIVE const char *wm_last_error() { return g_error.c_str(); }

EMSCRIPTEN_KEEPALIVE int wm_load_brep(const char *path) {
  return guarded([&] {
    ensureInit();
    gmsh::clear();
    g_groups.clear();
    g_shape = TopoDS_Shape();
    BRep_Builder builder;
    if (!BRepTools::Read(g_shape, path, builder) || g_shape.IsNull()) {
      return fail("INVALID_INPUT", "could not read the BRep");
    }
    g_faces.Clear();
    TopExp::MapShapes(g_shape, TopAbs_FACE, g_faces);
    gmsh::vectorpair dimTags;
    gmsh::model::occ::importShapesNativePointer(&g_shape, dimTags, false);
    gmsh::model::occ::synchronize();
    g_faceTag.assign(g_faces.Extent(), -1);
    gmsh::vectorpair faces;
    gmsh::model::getEntities(faces, 2);
    for (const auto &dt : faces) {
      GFace *gf = GModel::current()->getFaceByTag(dt.second);
      if (!gf || gf->getNativeType() != GEntity::OpenCascadeModel) continue;
      const auto *f = static_cast<const TopoDS_Shape *>(gf->getNativePtr());
      int i = g_faces.FindIndex(*f);  // 1-based, 0 = not found
      if (i > 0) g_faceTag[i - 1] = dt.second;
    }
    for (int i = 0; i < static_cast<int>(g_faceTag.size()); i++) {
      if (g_faceTag[i] < 0) return fail("INTERNAL", "face " + std::to_string(i) + " has no tag");
    }
    return static_cast<int>(g_faceTag.size());
  });
}

EMSCRIPTEN_KEEPALIVE int wm_face_tag(int index) {
  return index >= 0 && index < static_cast<int>(g_faceTag.size()) ? g_faceTag[index] : -1;
}

EMSCRIPTEN_KEEPALIVE int wm_name_face(int index, const char *name) {
  return guarded([&] {
    if (index < 0 || index >= static_cast<int>(g_faceTag.size())) {
      return fail("INVALID_INPUT", "face index out of range");
    }
    gmsh::model::addPhysicalGroup(2, {g_faceTag[index]}, -1, name);
    g_groups.push_back({name, index});
    return 0;
  });
}

EMSCRIPTEN_KEEPALIVE int wm_set_option(const char *name, double value) {
  return guarded([&] {
    ensureInit();
    gmsh::option::setNumber(name, value);
    return 0;
  });
}

EMSCRIPTEN_KEEPALIVE int wm_set_face_size(int index, double size) {
  return guarded([&] {
    if (index < 0 || index >= static_cast<int>(g_faceTag.size())) {
      return fail("INVALID_INPUT", "face index out of range");
    }
    gmsh::vectorpair pts;
    gmsh::model::getBoundary({{2, g_faceTag[index]}}, pts, false, false, true);
    gmsh::vectorpair points;
    for (const auto &p : pts)
      if (p.first == 0) points.push_back(p);
    gmsh::model::mesh::setSize(points, size);
    return 0;
  });
}

EMSCRIPTEN_KEEPALIVE int wm_mesh(int order) {
  return guarded([&] {
    g_nodes.clear();
    g_tets.clear();
    g_tris.clear();
    gmsh::vectorpair vols;
    gmsh::model::getEntities(vols, 3);
    if (vols.empty()) return fail("INVALID_INPUT", "the shape has no solid");
    std::vector<int> vt;
    for (const auto &v : vols) vt.push_back(v.second);
    gmsh::model::addPhysicalGroup(3, vt, -1, "solid");
    gmsh::option::setNumber("Mesh.ElementOrder", order);
    gmsh::model::mesh::generate(3);

    std::vector<std::size_t> tags;
    std::vector<double> coord, param;
    gmsh::model::mesh::getNodes(tags, coord, param, -1, -1, false, false);
    std::size_t maxTag = 0;
    for (auto t : tags) maxTag = t > maxTag ? t : maxTag;
    std::vector<uint32_t> index(maxTag + 1, 0);
    for (std::size_t i = 0; i < tags.size(); i++) index[tags[i]] = static_cast<uint32_t>(i);
    g_nodes.swap(coord);

    const int tetType = order == 2 ? 11 : 4;
    const int triType = order == 2 ? 9 : 2;
    std::vector<std::size_t> et, en;
    gmsh::model::mesh::getElementsByType(tetType, et, en);
    g_tets.reserve(en.size());
    for (auto n : en) g_tets.push_back(index[n]);
    for (const auto &g : g_groups) {
      std::vector<std::size_t> tt, tn;
      gmsh::model::mesh::getElementsByType(triType, tt, tn, g_faceTag[g.index]);
      std::vector<uint32_t> tri;
      tri.reserve(tn.size());
      for (auto n : tn) tri.push_back(index[n]);
      g_tris.push_back(std::move(tri));
    }
    return 0;
  });
}

EMSCRIPTEN_KEEPALIVE double wm_min_sicn() {
  try {
    std::vector<std::size_t> et, en;
    gmsh::model::mesh::getElementsByType(11, et, en);
    if (et.empty()) gmsh::model::mesh::getElementsByType(4, et, en);
    std::vector<double> q;
    gmsh::model::mesh::getElementQualities(et, q, "minSICN");
    double m = 1e30;
    for (double v : q) m = v < m ? v : m;
    return q.empty() ? -1 : m;
  } catch (...) {
    return -1;
  }
}

EMSCRIPTEN_KEEPALIVE int wm_count(int kind, int g) {
  switch (kind) {
    case 0: return static_cast<int>(g_nodes.size());
    case 1: return static_cast<int>(g_tets.size());
    case 2: return g >= 0 && g < static_cast<int>(g_tris.size()) ? static_cast<int>(g_tris[g].size()) : 0;
    case 3: return static_cast<int>(g_groups.size());
    default: return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const void *wm_ptr(int kind, int g) {
  switch (kind) {
    case 0: return g_nodes.data();
    case 1: return g_tets.data();
    case 2: return g >= 0 && g < static_cast<int>(g_tris.size()) ? g_tris[g].data() : nullptr;
    case 3: return g >= 0 && g < static_cast<int>(g_groups.size()) ? g_groups[g].name.c_str() : nullptr;
    default: return nullptr;
  }
}

EMSCRIPTEN_KEEPALIVE void wm_release() {
  g_nodes = {};
  g_tets = {};
  g_tris = {};
  try {
    if (g_init) gmsh::clear();
  } catch (...) {
  }
}

}  // extern "C"
