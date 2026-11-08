// Whittle kernel façade — core: includes, JSON, errors, handle table, naming helpers (PLAN §7).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Build note: the libcascade toolchain compiles `scope: 'main'` custom bindings by concatenating
// their *contents* into one translation unit, so relative includes cannot be resolved there.
// scripts/amalgamate.mjs inlines, in this order:
//   whittle_kernel.h, whittle_core.cpp, whittle_modeling.cpp, whittle_io.cpp,
//   whittle_kernel.cpp, whittle_bindings.cpp
// into .libcascade/whittle_facade.cpp, which is what libcascade.config.ts points at. The files
// after this one share its anonymous namespace helpers and are not standalone TUs.

#include "whittle_kernel.h"

#include <BOPAlgo_BuilderFace.hxx>
#include <BOPAlgo_Operation.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_BuilderAlgo.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <DESTEP_Parameters.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_Line.hxx>
#include <Geom_Plane.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_List.hxx>
#include <NCollection_Sequence.hxx>
#include <OSD_Parallel.hxx>
#include <OSD_ThreadPool.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangle.hxx>
#include <Poly_Triangulation.hxx>
#include <Precision.hxx>
#include <Quantity_Color.hxx>
#include <RWStl.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_StepModelType.hxx>
#include <Standard_Failure.hxx>
#include <Standard_Version.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Elips.hxx>
#include <gp_Lin.hxx>
#include <gp_Mat.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#ifndef WHITTLE_BUILD_ID
#define WHITTLE_BUILD_ID "dev"
#endif

namespace whittle {
namespace {

// OCCT 8 deprecates the TopTools_* collection typedefs in favour of the NCollection templates.
using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
using ShapeList = NCollection_List<TopoDS_Shape>;
using ShapeListMap = NCollection_IndexedDataMap<TopoDS_Shape, ShapeList, TopTools_ShapeMapHasher>;

// ---------------------------------------------------------------------------------------------
// Minimal JSON DOM (parse + serialise). Inputs are small (one feature), so clarity beats speed.
// Avoids std::from_chars/to_chars for doubles: the toolchain also parses this TU with libclang 18
// against an older libc++ (see README), and strtod/snprintf are locale-stable ("C") in Wasm.
// ---------------------------------------------------------------------------------------------

struct Json;
using JsonPtr = std::shared_ptr<Json>;

struct Json {
  enum class Kind { Null, Bool, Number, String, Array, Object };
  Kind kind = Kind::Null;
  bool boolean = false;
  double number = 0.0;
  std::string string;
  std::vector<JsonPtr> array;
  std::vector<std::pair<std::string, JsonPtr>> object;  // insertion order preserved

  const Json* get(const std::string& key) const {
    if (kind != Kind::Object) return nullptr;
    for (const auto& entry : object) {
      if (entry.first == key) return entry.second.get();
    }
    return nullptr;
  }
  bool isNumber() const { return kind == Kind::Number; }
  bool isString() const { return kind == Kind::String; }
  bool isObject() const { return kind == Kind::Object; }
  bool isArray() const { return kind == Kind::Array; }
};

class JsonParseError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& text) : s_(text) {}

  JsonPtr parseDocument() {
    JsonPtr value = parseValue(0);
    skipWs();
    if (pos_ != s_.size()) fail("trailing characters");
    return value;
  }

 private:
  const std::string& s_;
  size_t pos_ = 0;

  [[noreturn]] void fail(const char* what) const {
    throw JsonParseError(std::string("JSON parse error at offset ") + std::to_string(pos_) + ": " +
                         what);
  }

  void skipWs() {
    while (pos_ < s_.size()) {
      const char c = s_[pos_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++pos_;
      } else {
        break;
      }
    }
  }

  bool consumeLiteral(const char* literal) {
    const size_t n = std::strlen(literal);
    if (s_.compare(pos_, n, literal) == 0) {
      pos_ += n;
      return true;
    }
    return false;
  }

  JsonPtr parseValue(int depth) {
    if (depth > 64) fail("nesting too deep");
    skipWs();
    if (pos_ >= s_.size()) fail("unexpected end of input");
    auto value = std::make_shared<Json>();
    const char c = s_[pos_];
    if (c == '{') {
      value->kind = Json::Kind::Object;
      ++pos_;
      skipWs();
      if (pos_ < s_.size() && s_[pos_] == '}') {
        ++pos_;
        return value;
      }
      for (;;) {
        skipWs();
        if (pos_ >= s_.size() || s_[pos_] != '"') fail("expected object key");
        std::string key = parseString();
        skipWs();
        if (pos_ >= s_.size() || s_[pos_] != ':') fail("expected ':'");
        ++pos_;
        JsonPtr member = parseValue(depth + 1);
        value->object.emplace_back(std::move(key), std::move(member));
        skipWs();
        if (pos_ < s_.size() && s_[pos_] == ',') {
          ++pos_;
          continue;
        }
        if (pos_ < s_.size() && s_[pos_] == '}') {
          ++pos_;
          return value;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c == '[') {
      value->kind = Json::Kind::Array;
      ++pos_;
      skipWs();
      if (pos_ < s_.size() && s_[pos_] == ']') {
        ++pos_;
        return value;
      }
      for (;;) {
        value->array.push_back(parseValue(depth + 1));
        skipWs();
        if (pos_ < s_.size() && s_[pos_] == ',') {
          ++pos_;
          continue;
        }
        if (pos_ < s_.size() && s_[pos_] == ']') {
          ++pos_;
          return value;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c == '"') {
      value->kind = Json::Kind::String;
      value->string = parseString();
      return value;
    }
    if (consumeLiteral("true")) {
      value->kind = Json::Kind::Bool;
      value->boolean = true;
      return value;
    }
    if (consumeLiteral("false")) {
      value->kind = Json::Kind::Bool;
      return value;
    }
    if (consumeLiteral("null")) return value;
    if (c == '-' || (c >= '0' && c <= '9')) {
      const size_t start = pos_;
      if (s_[pos_] == '-') ++pos_;
      while (pos_ < s_.size()) {
        const char d = s_[pos_];
        if ((d >= '0' && d <= '9') || d == '.' || d == 'e' || d == 'E' || d == '+' || d == '-') {
          ++pos_;
        } else {
          break;
        }
      }
      const std::string token = s_.substr(start, pos_ - start);
      char* end = nullptr;
      const double number = std::strtod(token.c_str(), &end);
      if (end == nullptr || *end != '\0') fail("invalid number");
      value->kind = Json::Kind::Number;
      value->number = number;
      return value;
    }
    fail("unexpected character");
  }

  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  uint32_t parseHex4() {
    if (pos_ + 4 > s_.size()) fail("truncated \\u escape");
    uint32_t cp = 0;
    for (int i = 0; i < 4; ++i) {
      const char h = s_[pos_++];
      cp <<= 4;
      if (h >= '0' && h <= '9') {
        cp |= static_cast<uint32_t>(h - '0');
      } else if (h >= 'a' && h <= 'f') {
        cp |= static_cast<uint32_t>(h - 'a' + 10);
      } else if (h >= 'A' && h <= 'F') {
        cp |= static_cast<uint32_t>(h - 'A' + 10);
      } else {
        fail("invalid \\u escape");
      }
    }
    return cp;
  }

  std::string parseString() {
    ++pos_;  // opening quote
    std::string out;
    while (pos_ < s_.size()) {
      const char c = s_[pos_++];
      if (c == '"') return out;
      if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= s_.size()) break;
      const char e = s_[pos_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = parseHex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 1 < s_.size() && s_[pos_] == '\\' &&
              s_[pos_ + 1] == 'u') {
            pos_ += 2;
            const uint32_t low = parseHex4();
            if (low >= 0xDC00 && low <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            } else {
              fail("invalid surrogate pair");
            }
          }
          appendUtf8(out, cp);
          break;
        }
        default: fail("invalid escape");
      }
    }
    fail("unterminated string");
  }
};

void writeJsonString(std::string& out, const std::string& value) {
  out.push_back('"');
  for (const char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned>(c));
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('"');
}

void writeJsonNumber(std::string& out, double value) {
  if (!std::isfinite(value)) {
    out += "null";
    return;
  }
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.17g", value);
  out += buf;
}

std::string jsonString(const std::string& value) {
  std::string out;
  writeJsonString(out, value);
  return out;
}

std::string jsonNumber(double value) {
  std::string out;
  writeJsonNumber(out, value);
  return out;
}

std::string jsonVec3(const gp_XYZ& v) {
  return "[" + jsonNumber(v.X()) + "," + jsonNumber(v.Y()) + "," + jsonNumber(v.Z()) + "]";
}


constexpr double kPi = 3.14159265358979323846;

std::string jsonPoint(const gp_Pnt& p) { return jsonVec3(p.XYZ()); }

std::string jsonFrame(const gp_Ax3& frame) {
  return "{\"origin\":" + jsonVec3(frame.Location().XYZ()) +
         ",\"z\":" + jsonVec3(frame.Direction().XYZ()) +
         ",\"x\":" + jsonVec3(frame.XDirection().XYZ()) + "}";
}

std::string jsonStringArray(const std::vector<std::string>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i > 0) out.push_back(',');
    writeJsonString(out, values[i]);
  }
  out.push_back(']');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------------------------

struct KernelError {
  std::string code;
  std::string message;
  std::string hint;
  std::vector<std::string> entityRefs;
  std::string detail;
};

std::string errorObjectJson(const KernelError& e) {
  std::string out = "{\"code\":" + jsonString(e.code) + ",\"message\":" + jsonString(e.message);
  if (!e.hint.empty()) out += ",\"hint\":" + jsonString(e.hint);
  if (!e.entityRefs.empty()) out += ",\"entityRefs\":" + jsonStringArray(e.entityRefs);
  if (!e.detail.empty()) out += ",\"detail\":" + jsonString(e.detail);
  out.push_back('}');
  return out;
}

std::string okJson(const std::string& valueJson) { return "{\"ok\":true,\"value\":" + valueJson + "}"; }

std::string errJson(const KernelError& e) {
  return "{\"ok\":false,\"error\":" + errorObjectJson(e) + "}";
}

// Thrown inside the façade to bail out with a structured error.
class FacadeError : public std::exception {
 public:
  explicit FacadeError(KernelError e) : error_(std::move(e)) {}
  const KernelError& error() const { return error_; }
  const char* what() const noexcept override { return error_.message.c_str(); }

 private:
  KernelError error_;
};

[[noreturn]] void raiseError(const char* code, std::string message, std::string hint = {},
                             std::string detail = {}, std::vector<std::string> entityRefs = {}) {
  KernelError e;
  e.code = code;
  e.message = std::move(message);
  e.hint = std::move(hint);
  e.detail = std::move(detail);
  e.entityRefs = std::move(entityRefs);
  throw FacadeError(std::move(e));
}

// Emergency heap reserve, released when an allocation fails so the error JSON can still be built
// (the catch handlers below allocate). If even that fails, the boundary returns an empty string,
// which never allocates; the worker reports it as a malformed (INTERNAL) result.
constexpr size_t kEmergencyReserveBytes = 256 * 1024;
char* g_emergencyReserve = static_cast<char*>(std::malloc(kEmergencyReserveBytes));

void releaseEmergencyReserve() noexcept {
  std::free(g_emergencyReserve);
  g_emergencyReserve = nullptr;
}

void restoreEmergencyReserve() noexcept {
  if (g_emergencyReserve == nullptr) {
    g_emergencyReserve = static_cast<char*>(std::malloc(kEmergencyReserveBytes));
  }
}

constexpr const char* kOutOfMemoryJson =
    "{\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"The geometry kernel ran out "
    "of memory\"}}";

std::string safeErrJson(const char* code, const char* operation, const char* message,
                        const char* detail) noexcept {
  try {
    KernelError err;
    err.code = code;
    err.message = std::string(operation) + message;
    if (detail != nullptr) err.detail = detail;
    return errJson(err);
  } catch (...) {
    releaseEmergencyReserve();
    try {
      return std::string(kOutOfMemoryJson);
    } catch (...) {
      return std::string();
    }
  }
}

std::string safeErrJson(const KernelError& e) noexcept {
  try {
    return errJson(e);
  } catch (...) {
    releaseEmergencyReserve();
    try {
      return std::string(kOutOfMemoryJson);
    } catch (...) {
      return std::string();
    }
  }
}

// Runs `body` and converts every exception into Result JSON. No exception escapes (header
// contract): Standard_Failure, std::exception and anything else are all caught here, and the
// handlers themselves cannot throw (see safeErrJson).
template <typename Body>
std::string guarded(const char* operation, Body&& body) noexcept {
  try {
    restoreEmergencyReserve();
    return body();
  } catch (const FacadeError& e) {
    return safeErrJson(e.error());
  } catch (const JsonParseError& e) {
    return safeErrJson("INVALID_INPUT", operation, ": malformed JSON input", e.what());
  } catch (const Standard_Failure& e) {
    try {
      KernelError err;
      err.code = "OCCT_EXCEPTION";
      err.message = std::string(operation) + " failed inside the geometry kernel";
      const char* type = e.ExceptionType();
      const char* what = e.what();
      err.detail = std::string(type != nullptr ? type : "Standard_Failure") + ": " +
                   (what != nullptr ? what : "");
      return safeErrJson(err);
    } catch (...) {
      return safeErrJson("OCCT_EXCEPTION", operation, " failed inside the geometry kernel",
                         nullptr);
    }
  } catch (const std::bad_alloc&) {
    releaseEmergencyReserve();
    return safeErrJson("INTERNAL", operation, ": out of memory", "bad_alloc");
  } catch (const std::exception& e) {
    return safeErrJson("INTERNAL", operation, " failed", e.what());
  } catch (...) {
    return safeErrJson("INTERNAL", operation, " failed with an unknown exception", nullptr);
  }
}

// ---------------------------------------------------------------------------------------------
// Handle table
// ---------------------------------------------------------------------------------------------

struct NamingEntry {
  std::string name;
  const char* kind;  // "face" | "edge" | "vertex"
  int index;         // 0-based TopExp map index
};

// TopExp maps of one shape (1-based OCCT indices; names are 0-based vectors).
struct Topo {
  ShapeMap faces;
  ShapeMap edges;
  ShapeMap vertices;
  explicit Topo(const TopoDS_Shape& shape) {
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    TopExp::MapShapes(shape, TopAbs_EDGE, edges);
    TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  }
};

struct ShapeRecord {
  TopoDS_Shape shape;
  std::vector<std::string> faceNames;    // by TopExp face index
  std::vector<std::string> edgeNames;    // by TopExp edge index
  std::vector<std::string> vertexNames;  // by TopExp vertex index
  // Additional names for the same sub-shape (e.g. coincident sketch points).
  std::vector<NamingEntry> aliases;
  // Placement frame of planar results (sketch plane, datum plane); extrude direction source.
  bool hasFrame = false;
  gp_Ax3 frame;
  // Triangulation-only geometry (STL import): never re-meshed.
  bool meshOnly = false;
  // Lazily built TopExp maps (records are immutable once stored; the kernel is single-threaded
  // at the façade level, see whittle_kernel.h).
  mutable std::shared_ptr<Topo> topoCache;

  const Topo& topo() const {
    if (!topoCache) topoCache = std::make_shared<Topo>(shape);
    return *topoCache;
  }
};

class HandleTable {
 public:
  ShapeHandle insert(ShapeRecord record) {
    auto stored = std::make_shared<ShapeRecord>(std::move(record));
    std::lock_guard<std::mutex> lock(mutex_);
    // Handles cycle through 1..INT32_MAX without signed overflow; live handles are skipped.
    for (;;) {
      const ShapeHandle handle = next_;
      next_ = next_ == INT32_MAX ? 1 : next_ + 1;
      if (records_.find(handle) == records_.end()) {
        records_.emplace(handle, std::move(stored));
        return handle;
      }
    }
  }

  std::shared_ptr<const ShapeRecord> find(ShapeHandle handle) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = records_.find(handle);
    if (it == records_.end()) return nullptr;
    return it->second;
  }

  void erase(ShapeHandle handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    records_.erase(handle);
  }

  int32_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return static_cast<int32_t>(records_.size());
  }

 private:
  mutable std::mutex mutex_;
  ShapeHandle next_ = 1;
  std::unordered_map<ShapeHandle, std::shared_ptr<ShapeRecord>> records_;
};

HandleTable& handles() {
  static HandleTable table;
  return table;
}

std::shared_ptr<const ShapeRecord> requireShape(ShapeHandle handle) {
  auto record = handles().find(handle);
  if (record == nullptr) {
    raiseError("INVALID_HANDLE", "Shape handle " + std::to_string(handle) + " is not live",
               "The shape was released or never created; re-evaluate the feature.");
  }
  return record;
}

// ---------------------------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------------------------

std::string requireString(const Json& obj, const char* key, const char* context) {
  const Json* v = obj.get(key);
  if (v == nullptr || !v->isString()) {
    raiseError("INVALID_INPUT", std::string(context) + ": missing string field '" + key + "'");
  }
  return v->string;
}

std::string optString(const Json& obj, const char* key, const std::string& fallback) {
  const Json* v = obj.get(key);
  return v != nullptr && v->isString() ? v->string : fallback;
}

double requireValue(const Json& values, const std::string& pointer, const std::string& label) {
  const Json* v = values.get(pointer);
  if (v == nullptr || !v->isNumber()) {
    raiseError("INVALID_INPUT", "Missing resolved value for " + label,
               "inputs.values must contain a number for \"" + pointer + "\"");
  }
  if (!std::isfinite(v->number)) raiseError("INVALID_INPUT", label + " is not a finite number");
  return v->number;
}

bool hasValue(const Json& values, const std::string& pointer) {
  const Json* v = values.get(pointer);
  return v != nullptr && v->isNumber();
}

gp_XYZ requireVec3(const Json& obj, const char* key, const char* context) {
  const Json* v = obj.get(key);
  if (v == nullptr || !v->isArray() || v->array.size() != 3) {
    raiseError("INVALID_INPUT", std::string(context) + "." + key + " must be a [x, y, z] array");
  }
  double xyz[3];
  for (int i = 0; i < 3; ++i) {
    const Json& c = *v->array[static_cast<size_t>(i)];
    if (!c.isNumber() || !std::isfinite(c.number)) {
      raiseError("INVALID_INPUT",
                 std::string(context) + "." + key + " must contain finite numbers");
    }
    xyz[i] = c.number;
  }
  return gp_XYZ(xyz[0], xyz[1], xyz[2]);
}

// Placement frame (contracts `Frame`): origin + Z + X, right-handed. Default: world.
gp_Ax2 parseFrame(const Json* frame) {
  if (frame == nullptr || frame->kind == Json::Kind::Null) return gp_Ax2();
  if (!frame->isObject()) raiseError("INVALID_INPUT", "frame must be an object");
  const gp_XYZ origin = requireVec3(*frame, "origin", "frame");
  const gp_XYZ z = requireVec3(*frame, "z", "frame");
  const gp_XYZ x = requireVec3(*frame, "x", "frame");
  const double tiny = 1e-12;
  if (z.Modulus() < tiny || x.Modulus() < tiny) {
    raiseError("INVALID_INPUT", "frame axes must be non-zero vectors");
  }
  const gp_Dir zd(z);
  const gp_Dir xd(x);
  if (zd.IsParallel(xd, 1e-9)) {
    raiseError("INVALID_INPUT", "frame.x must not be parallel to frame.z");
  }
  // gp_Ax2 projects X onto the plane normal to Z, so a slightly skewed X is tolerated.
  return gp_Ax2(gp_Pnt(origin), zd, xd);
}

const Json* inputsObject(const Json& inputs, const char* key) {
  const Json* v = inputs.get(key);
  if (v == nullptr || v->kind == Json::Kind::Null) return nullptr;
  if (!v->isObject()) raiseError("INVALID_INPUT", std::string("inputs.") + key + " must be an object");
  return v;
}

const Json& valuesOf(const Json& inputs) {
  static const Json empty = [] {
    Json j;
    j.kind = Json::Kind::Object;
    return j;
  }();
  const Json* v = inputsObject(inputs, "values");
  return v != nullptr ? *v : empty;
}

const Json* frameInput(const Json& inputs, const char* role) {
  const Json* frames = inputsObject(inputs, "frames");
  if (frames == nullptr) return nullptr;
  const Json* f = frames->get(role);
  return f != nullptr && f->kind != Json::Kind::Null ? f : nullptr;
}

int optHandle(const Json& obj, const char* key) {
  const Json* v = obj.get(key);
  if (v == nullptr || v->kind == Json::Kind::Null) return 0;
  if (!v->isNumber() || v->number != std::floor(v->number) || v->number < INT32_MIN ||
      v->number > INT32_MAX) {
    raiseError("INVALID_INPUT", std::string(key) + " must be an integer shape handle");
  }
  return static_cast<int>(v->number);
}

// A resolved reference (contracts `ResolvedRef`) turned into the concrete sub-shape.
struct RefTarget {
  std::shared_ptr<const ShapeRecord> record;
  ShapeHandle handle = 0;
  std::string kind;  // face | edge | vertex | body
  int index = 0;     // 0-based
  TopoDS_Shape sub;
  std::string name;  // persistent name of the sub-shape in its record ("" if unnamed)
};

RefTarget resolveRef(const Json& ref, const std::string& pointer) {
  if (!ref.isObject()) raiseError("INVALID_INPUT", "inputs.refs[\"" + pointer + "\"] must be an object");
  RefTarget t;
  t.handle = optHandle(ref, "shape");
  t.record = requireShape(t.handle);
  t.kind = requireString(ref, "kind", "resolved reference");
  const Json* idx = ref.get("index");
  if (idx == nullptr || !idx->isNumber() || idx->number < 0 || idx->number != std::floor(idx->number)) {
    raiseError("INVALID_INPUT", "inputs.refs[\"" + pointer + "\"].index must be a non-negative integer");
  }
  t.index = static_cast<int>(idx->number);
  if (t.kind == "body") {
    t.sub = t.record->shape;
    return t;
  }
  const Topo& topo = t.record->topo();
  const ShapeMap* map = nullptr;
  const std::vector<std::string>* names = nullptr;
  if (t.kind == "face") {
    map = &topo.faces;
    names = &t.record->faceNames;
  } else if (t.kind == "edge") {
    map = &topo.edges;
    names = &t.record->edgeNames;
  } else if (t.kind == "vertex") {
    map = &topo.vertices;
    names = &t.record->vertexNames;
  } else {
    raiseError("INVALID_INPUT", "inputs.refs[\"" + pointer + "\"].kind must be face, edge, vertex or body");
  }
  if (t.index >= map->Extent()) {
    raiseError("UNRESOLVED_REFERENCE",
               "Reference " + pointer + " points at " + t.kind + " " + std::to_string(t.index) +
                   ", which does not exist",
               "Re-pick the entity.");
  }
  t.sub = (*map)(t.index + 1);
  const size_t i = static_cast<size_t>(t.index);
  if (i < names->size()) t.name = (*names)[i];
  return t;
}

// The refs at `prefix` itself or at `prefix/<n>` (n = 0, 1, ...), in index order.
std::vector<RefTarget> refsAt(const Json& inputs, const std::string& prefix) {
  std::vector<RefTarget> out;
  const Json* refs = inputsObject(inputs, "refs");
  if (refs == nullptr) return out;
  std::vector<std::pair<long, const Json*>> found;
  for (const auto& entry : refs->object) {
    const std::string& key = entry.first;
    if (key == prefix) {
      found.emplace_back(-1, entry.second.get());
    } else if (key.size() > prefix.size() + 1 && key.compare(0, prefix.size(), prefix) == 0 &&
               key[prefix.size()] == '/') {
      const std::string rest = key.substr(prefix.size() + 1);
      if (rest.empty() || rest.find_first_not_of("0123456789") != std::string::npos) continue;
      found.emplace_back(std::strtol(rest.c_str(), nullptr, 10), entry.second.get());
    }
  }
  std::sort(found.begin(), found.end(),
            [](const std::pair<long, const Json*>& a, const std::pair<long, const Json*>& b) {
              return a.first < b.first;
            });
  for (const auto& f : found) {
    out.push_back(resolveRef(*f.second, f.first < 0 ? prefix : prefix + "/" + std::to_string(f.first)));
  }
  return out;
}

bool hasRef(const Json& inputs, const std::string& pointer) {
  const Json* refs = inputsObject(inputs, "refs");
  return refs != nullptr && refs->get(pointer) != nullptr;
}

// ---------------------------------------------------------------------------------------------
// Naming (contracts naming.ts): geometric keys, split suffixes, edges/vertices from faces
// ---------------------------------------------------------------------------------------------

// Deterministic geometric key: centroid x, then y, then z, rounded to 1e-6 mm.
struct GeoKey {
  long long x = 0;
  long long y = 0;
  long long z = 0;
  bool operator<(const GeoKey& o) const {
    if (x != o.x) return x < o.x;
    if (y != o.y) return y < o.y;
    return z < o.z;
  }
};

GeoKey geoKey(const gp_Pnt& p) {
  auto r = [](double v) { return static_cast<long long>(std::llround(v * 1e6)); };
  return GeoKey{r(p.X()), r(p.Y()), r(p.Z())};
}

gp_Pnt boxCenter(const TopoDS_Shape& s) {
  Bnd_Box box;
  BRepBndLib::Add(s, box);
  if (box.IsVoid()) return gp_Pnt();
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return gp_Pnt((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

gp_Pnt faceCentroid(const TopoDS_Face& f) {
  GProp_GProps props;
  BRepGProp::SurfaceProperties(f, props);
  if (std::fabs(props.Mass()) > 1e-300) return props.CentreOfMass();
  return boxCenter(f);
}

gp_Pnt edgeCentroid(const TopoDS_Edge& e) {
  if (BRep_Tool::Degenerated(e)) {
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(e, v1, v2);
    if (!v1.IsNull()) return BRep_Tool::Pnt(v1);
    return boxCenter(e);
  }
  GProp_GProps props;
  BRepGProp::LinearProperties(e, props);
  if (std::fabs(props.Mass()) > 1e-300) return props.CentreOfMass();
  return boxCenter(e);
}

double edgeLength(const TopoDS_Edge& e) {
  if (BRep_Tool::Degenerated(e)) return 0.0;
  GProp_GProps props;
  BRepGProp::LinearProperties(e, props);
  return props.Mass();
}

// "X#3" -> "X"; names without a trailing split suffix are returned unchanged.
std::string stripSplitSuffix(const std::string& name) {
  const size_t hash = name.rfind('#');
  if (hash == std::string::npos || hash + 1 >= name.size()) return name;
  if (name.find_first_not_of("0123456789", hash + 1) != std::string::npos) return name;
  return name.substr(0, hash);
}

std::vector<size_t> sortedByKey(std::vector<size_t> indices, const std::vector<GeoKey>& keys) {
  std::sort(indices.begin(), indices.end(), [&](size_t a, size_t b) {
    if (keys[a] < keys[b]) return true;
    if (keys[b] < keys[a]) return false;
    return a < b;
  });
  return indices;
}

// Fresh names (edges, vertices): every name shared by several sub-shapes gets "#k".
void suffixDuplicates(std::vector<std::string>& names, const std::vector<GeoKey>& keys) {
  std::map<std::string, std::vector<size_t>> groups;
  for (size_t i = 0; i < names.size(); ++i) {
    if (!names[i].empty()) groups[names[i]].push_back(i);
  }
  for (auto& g : groups) {
    if (g.second.size() < 2) continue;
    const std::vector<size_t> order = sortedByKey(g.second, keys);
    for (size_t k = 0; k < order.size(); ++k) {
      names[order[k]] = g.first + "#" + std::to_string(k);
    }
  }
}

// Inherited face names: names that survive one-to-one are kept verbatim. When an operation splits
// a face (several faces inherit one name), every face whose name has the same base (suffix
// stripped) is re-indexed "#0…" by geometric key, so names stay grammatical (one "#k" level).
void resolveFaceNames(std::vector<std::string>& names, const std::vector<GeoKey>& keys) {
  std::map<std::string, std::vector<size_t>> byBase;
  for (size_t i = 0; i < names.size(); ++i) byBase[stripSplitSuffix(names[i])].push_back(i);
  for (auto& g : byBase) {
    std::set<std::string> seen;
    bool duplicate = false;
    for (size_t i : g.second) {
      if (!seen.insert(names[i]).second) duplicate = true;
    }
    if (!duplicate) continue;
    const std::vector<size_t> order = sortedByKey(g.second, keys);
    for (size_t k = 0; k < order.size(); ++k) names[order[k]] = g.first + "#" + std::to_string(k);
  }
}

struct NamedShape {
  TopoDS_Shape shape;
  std::vector<std::string> faces;
  std::vector<std::string> edges;
  std::vector<std::string> vertices;
  std::vector<NamingEntry> aliases;
  bool hasFrame = false;
  gp_Ax3 frame;
};

std::string joinSorted(std::vector<std::string> parts, const char* sep) {
  std::sort(parts.begin(), parts.end());
  parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i > 0) out += sep;
    out += parts[i];
  }
  return out;
}

// Edges: edge(<faceA>|<faceB>) from adjacent face names, sorted; vertices: the first three of
// their adjacent face names, sorted (naming.ts). Seam edges read edge(A|A), free edges edge(A).
void deriveEdgeAndVertexNames(NamedShape& ns, const Topo& topo) {
  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(ns.shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  ns.edges.assign(static_cast<size_t>(topo.edges.Extent()), std::string());
  std::vector<GeoKey> edgeKeys(ns.edges.size());
  for (int i = 1; i <= topo.edges.Extent(); ++i) {
    const TopoDS_Edge& edge = TopoDS::Edge(topo.edges(i));
    edgeKeys[static_cast<size_t>(i - 1)] = geoKey(edgeCentroid(edge));
    std::vector<int> faceIdx;
    const ShapeList* ancestors = edgeFaces.Seek(edge);
    if (ancestors != nullptr) {
      for (const TopoDS_Shape& f : *ancestors) {
        const int fi = topo.faces.FindIndex(f);
        if (fi > 0 && std::find(faceIdx.begin(), faceIdx.end(), fi) == faceIdx.end()) {
          faceIdx.push_back(fi);
        }
      }
    }
    std::vector<std::string> adjacent;
    for (int fi : faceIdx) {
      const std::string& n = ns.faces[static_cast<size_t>(fi - 1)];
      if (!n.empty()) adjacent.push_back(n);
    }
    if (adjacent.empty()) continue;
    std::string role;
    if (faceIdx.size() == 1) {
      const TopoDS_Face& face = TopoDS::Face(topo.faces(faceIdx[0]));
      role = BRep_Tool::IsClosed(edge, face) ? adjacent[0] + "|" + adjacent[0] : adjacent[0];
    } else {
      role = joinSorted(adjacent, "|");
    }
    ns.edges[static_cast<size_t>(i - 1)] = "edge(" + role + ")";
  }
  suffixDuplicates(ns.edges, edgeKeys);

  ShapeListMap vertexFaces;
  TopExp::MapShapesAndAncestors(ns.shape, TopAbs_VERTEX, TopAbs_FACE, vertexFaces);
  ns.vertices.assign(static_cast<size_t>(topo.vertices.Extent()), std::string());
  std::vector<GeoKey> vertexKeys(ns.vertices.size());
  for (int i = 1; i <= topo.vertices.Extent(); ++i) {
    const TopoDS_Vertex& vertex = TopoDS::Vertex(topo.vertices(i));
    vertexKeys[static_cast<size_t>(i - 1)] = geoKey(BRep_Tool::Pnt(vertex));
    std::vector<std::string> adjacent;
    const ShapeList* ancestors = vertexFaces.Seek(vertex);
    if (ancestors != nullptr) {
      for (const TopoDS_Shape& f : *ancestors) {
        const int fi = topo.faces.FindIndex(f);
        if (fi > 0 && !ns.faces[static_cast<size_t>(fi - 1)].empty()) {
          adjacent.push_back(ns.faces[static_cast<size_t>(fi - 1)]);
        }
      }
    }
    std::sort(adjacent.begin(), adjacent.end());
    adjacent.erase(std::unique(adjacent.begin(), adjacent.end()), adjacent.end());
    if (adjacent.empty()) continue;
    if (adjacent.size() > 3) adjacent.resize(3);
    ns.vertices[static_cast<size_t>(i - 1)] = "vertex(" + joinSorted(adjacent, "|") + ")";
  }
  suffixDuplicates(ns.vertices, vertexKeys);
}

// Completes a shape's naming from inherited/generated base face names (one per TopExp face, ""
// when unknown): unknown faces get `fallback`, splits get "#k", then edges/vertices are derived.
NamedShape finalizeNamed(const TopoDS_Shape& shape, std::vector<std::string> faceNames,
                         const std::string& fallback) {
  NamedShape ns;
  ns.shape = shape;
  const Topo topo(shape);
  faceNames.resize(static_cast<size_t>(topo.faces.Extent()));
  std::vector<GeoKey> keys(faceNames.size());
  for (int i = 1; i <= topo.faces.Extent(); ++i) {
    std::string& n = faceNames[static_cast<size_t>(i - 1)];
    if (n.empty()) n = fallback;
    keys[static_cast<size_t>(i - 1)] = geoKey(faceCentroid(TopoDS::Face(topo.faces(i))));
  }
  resolveFaceNames(faceNames, keys);
  ns.faces = std::move(faceNames);
  deriveEdgeAndVertexNames(ns, topo);
  return ns;
}

std::vector<NamingEntry> namingEntries(const NamedShape& ns) {
  std::vector<NamingEntry> out;
  auto add = [&](const std::vector<std::string>& names, const char* kind) {
    for (size_t i = 0; i < names.size(); ++i) {
      if (!names[i].empty()) out.push_back({names[i], kind, static_cast<int>(i)});
    }
  };
  add(ns.faces, "face");
  add(ns.edges, "edge");
  add(ns.vertices, "vertex");
  for (const NamingEntry& a : ns.aliases) out.push_back(a);
  return out;
}

std::string namingJson(const std::vector<NamingEntry>& naming) {
  std::string out = "[";
  for (size_t i = 0; i < naming.size(); ++i) {
    if (i > 0) out.push_back(',');
    out += "{\"name\":" + jsonString(naming[i].name) + ",\"kind\":\"" + naming[i].kind +
           "\",\"index\":" + std::to_string(naming[i].index) + "}";
  }
  out.push_back(']');
  return out;
}

ShapeHandle storeNamed(const NamedShape& ns) {
  ShapeRecord record;
  record.shape = ns.shape;
  record.faceNames = ns.faces;
  record.edgeNames = ns.edges;
  record.vertexNames = ns.vertices;
  record.aliases = ns.aliases;
  record.hasFrame = ns.hasFrame;
  record.frame = ns.frame;
  return handles().insert(std::move(record));
}

// Stores `ns` and returns the FeatureResult JSON body (without the Result envelope). If anything
// after the insert throws, the handle is released (no leaks on error paths).
struct HandleGuard {
  HandleGuard() = default;
  HandleGuard(const HandleGuard&) = delete;
  HandleGuard& operator=(const HandleGuard&) = delete;
  ShapeHandle handle = 0;
  ~HandleGuard() {
    if (handle != 0) handles().erase(handle);
  }
  ShapeHandle release() {
    const ShapeHandle h = handle;
    handle = 0;
    return h;
  }
};

std::string warningsJson(const std::vector<KernelError>& warnings) {
  std::string out = "[";
  for (size_t i = 0; i < warnings.size(); ++i) {
    if (i > 0) out.push_back(',');
    out += errorObjectJson(warnings[i]);
  }
  out.push_back(']');
  return out;
}

// Geometry validity: BRepCheck plus a sanity check that solids enclose positive volume.
bool isValidShape(const TopoDS_Shape& shape) {
  if (shape.IsNull()) return false;
  BRepCheck_Analyzer analyzer(shape);
  return analyzer.IsValid();
}

double solidVolume(const TopoDS_Shape& shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

int countSolids(const TopoDS_Shape& shape) {
  int n = 0;
  for (TopExp_Explorer ex(shape, TopAbs_SOLID); ex.More(); ex.Next()) ++n;
  return n;
}

std::string fmtMm(double v) {
  char buf[32];
  const double a = std::fabs(v);
  std::snprintf(buf, sizeof buf, a >= 10 ? "%.1f" : (a >= 1 ? "%.2f" : "%.3f"), v);
  return buf;
}

