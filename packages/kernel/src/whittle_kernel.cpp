// Whittle kernel façade — implementation of whittle_kernel.h (PLAN §7).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Build note: the libcascade toolchain compiles `scope: 'main'` custom bindings by concatenating
// their *contents* into one translation unit, so relative includes cannot be resolved there.
// scripts/amalgamate.mjs inlines whittle_kernel.h + this file + whittle_bindings.cpp into
// .libcascade/whittle_facade.cpp, which is what libcascade.config.ts points at.

#include "whittle_kernel.h"

#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_Failure.hxx>
#include <Standard_Version.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_List.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <map>
#include <memory>
#include <mutex>
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
  if (!e.entityRefs.empty()) {
    out += ",\"entityRefs\":[";
    for (size_t i = 0; i < e.entityRefs.size(); ++i) {
      if (i > 0) out.push_back(',');
      writeJsonString(out, e.entityRefs[i]);
    }
    out.push_back(']');
  }
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
                        std::string detail = {}) {
  KernelError e;
  e.code = code;
  e.message = std::move(message);
  e.hint = std::move(hint);
  e.detail = std::move(detail);
  throw FacadeError(std::move(e));
}

// Runs `body` and converts every exception into Result JSON. No exception escapes (header
// contract): Standard_Failure, std::exception and anything else are all caught here.
template <typename Body>
std::string guarded(const char* operation, Body&& body) {
  try {
    return body();
  } catch (const FacadeError& e) {
    return errJson(e.error());
  } catch (const JsonParseError& e) {
    KernelError err{"INVALID_INPUT", std::string(operation) + ": malformed JSON input", {}, {},
                    e.what()};
    return errJson(err);
  } catch (const Standard_Failure& e) {
    KernelError err;
    err.code = "OCCT_EXCEPTION";
    err.message = std::string(operation) + " failed inside the geometry kernel";
    const char* type = e.ExceptionType();
    const char* what = e.what();
    err.detail = std::string(type != nullptr ? type : "Standard_Failure") + ": " +
                 (what != nullptr ? what : "");
    return errJson(err);
  } catch (const std::bad_alloc&) {
    KernelError err{"INTERNAL", std::string(operation) + ": out of memory", {}, {}, "bad_alloc"};
    return errJson(err);
  } catch (const std::exception& e) {
    KernelError err{"INTERNAL", std::string(operation) + " failed", {}, {}, e.what()};
    return errJson(err);
  } catch (...) {
    KernelError err{"INTERNAL", std::string(operation) + " failed with an unknown exception", {},
                    {}, {}};
    return errJson(err);
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

struct ShapeRecord {
  TopoDS_Shape shape;
  std::vector<std::string> faceNames;  // by TopExp face index
  std::vector<std::string> edgeNames;  // by TopExp edge index
};

class HandleTable {
 public:
  ShapeHandle insert(ShapeRecord record) {
    std::lock_guard<std::mutex> lock(mutex_);
    ShapeHandle handle = next_++;
    if (next_ <= 0) next_ = 1;  // wrap-around guard; 0 is never valid
    records_.emplace(handle, std::make_shared<ShapeRecord>(std::move(record)));
    return handle;
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

double requireValue(const Json& values, const std::string& pointer, const std::string& label) {
  const Json* v = values.get(pointer);
  if (v == nullptr || !v->isNumber()) {
    raiseError("INVALID_INPUT", "Missing resolved value for " + label,
          "inputs.values must contain a number for \"" + pointer + "\"");
  }
  if (!std::isfinite(v->number)) raiseError("INVALID_INPUT", label + " is not a finite number");
  return v->number;
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
      raiseError("INVALID_INPUT", std::string(context) + "." + key + " must contain finite numbers");
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
  if (zd.IsParallel(xd, 1e-9)) raiseError("INVALID_INPUT", "frame.x must not be parallel to frame.z");
  // gp_Ax2 projects X onto the plane normal to Z, so a slightly skewed X is tolerated.
  return gp_Ax2(gp_Pnt(origin), zd, xd);
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

// ---------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------

// Box naming (contracts naming.ts, primitive roles). Roles are derived from geometry in the box's
// local frame, so they are independent of OCCT's internal face order.
struct BoxNaming {
  std::vector<NamingEntry> entries;
  std::vector<std::string> faceNames;
  std::vector<std::string> edgeNames;
};

BoxNaming nameBox(const TopoDS_Shape& shape, const gp_Ax2& frame, double dx, double dy, double dz,
                  const std::string& tag) {
  gp_Trsf toLocal;
  toLocal.SetTransformation(gp_Ax3(frame));  // world -> local
  const double extent[3] = {dx, dy, dz};
  const char* axisName[3] = {"x", "y", "z"};

  ShapeMap faces;
  ShapeMap edges;
  ShapeMap vertices;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  TopExp::MapShapes(shape, TopAbs_EDGE, edges);
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);

  BoxNaming result;
  std::vector<std::string> faceRoles(static_cast<size_t>(faces.Extent()));
  for (int i = 1; i <= faces.Extent(); ++i) {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(faces(i), props);
    const gp_Pnt c = props.CentreOfMass().Transformed(toLocal);
    const double coord[3] = {c.X(), c.Y(), c.Z()};
    // The constant coordinate of a box face is the one sitting at 0 or at its extent.
    int bestAxis = 0;
    double bestDistance = 1e300;
    bool atMax = false;
    for (int a = 0; a < 3; ++a) {
      const double toMin = std::fabs(coord[a]);
      const double toMax = std::fabs(coord[a] - extent[a]);
      const double d = std::min(toMin, toMax);
      // Face centroids sit at exactly half extent on the two free axes, so the constrained
      // axis is the unique one at distance ~0.
      if (d < bestDistance) {
        bestDistance = d;
        bestAxis = a;
        atMax = toMax < toMin;
      }
    }
    const std::string role = std::string("face.") + axisName[bestAxis] + (atMax ? "max" : "min");
    faceRoles[static_cast<size_t>(i - 1)] = role;
  }

  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  std::vector<std::string> edgeRoles(static_cast<size_t>(edges.Extent()));
  for (int i = 1; i <= edges.Extent(); ++i) {
    std::vector<std::string> adjacent;
    const ShapeList* ancestors = edgeFaces.Seek(edges(i));
    if (ancestors != nullptr) {
      for (const TopoDS_Shape& f : *ancestors) {
        const int fi = faces.FindIndex(f);
        if (fi > 0) {
          const std::string& role = faceRoles[static_cast<size_t>(fi - 1)];
          if (std::find(adjacent.begin(), adjacent.end(), role) == adjacent.end()) {
            adjacent.push_back(role);
          }
        }
      }
    }
    std::sort(adjacent.begin(), adjacent.end());
    if (adjacent.size() == 2) {
      edgeRoles[static_cast<size_t>(i - 1)] = "edge(" + adjacent[0] + "|" + adjacent[1] + ")";
    }
  }

  std::vector<std::string> vertexRoles(static_cast<size_t>(vertices.Extent()));
  for (int i = 1; i <= vertices.Extent(); ++i) {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vertices(i))).Transformed(toLocal);
    const double coord[3] = {p.X(), p.Y(), p.Z()};
    std::string role = "vertex(";
    for (int a = 0; a < 3; ++a) {
      if (a > 0) role.push_back(',');
      role += coord[a] > extent[a] * 0.5 ? "max" : "min";
    }
    role.push_back(')');
    vertexRoles[static_cast<size_t>(i - 1)] = role;
  }

  const std::string prefix = "F" + tag + ":";
  auto addAll = [&](const std::vector<std::string>& roles, const char* kind,
                    std::vector<std::string>* names) {
    for (size_t i = 0; i < roles.size(); ++i) {
      const std::string name = roles[i].empty() ? std::string() : prefix + roles[i];
      if (names != nullptr) names->push_back(name);
      if (!name.empty()) result.entries.push_back({name, kind, static_cast<int>(i)});
    }
  };
  addAll(faceRoles, "face", &result.faceNames);
  addAll(edgeRoles, "edge", &result.edgeNames);
  addAll(vertexRoles, "vertex", nullptr);
  return result;
}

std::string execBox(const Json& feature, const Json& values, const std::string& id) {
  const double dx = requireValue(values, "/dx", "box width (dx)");
  const double dy = requireValue(values, "/dy", "box depth (dy)");
  const double dz = requireValue(values, "/dz", "box height (dz)");
  const double minSize = 1e-6;  // mm; well above Precision::Confusion() (1e-7)
  const struct {
    const char* name;
    double value;
  } dims[3] = {{"dx", dx}, {"dy", dy}, {"dz", dz}};
  for (const auto& d : dims) {
    if (!(d.value > minSize)) {
      KernelError e;
      e.code = "INVALID_INPUT";
      e.message = std::string("Box ") + d.name + " must be greater than zero (got " +
                  jsonNumber(d.value) + " mm)";
      e.hint = std::string("Enter a positive value for ") + d.name + ".";
      throw FacadeError(std::move(e));
    }
  }
  const gp_Ax2 frame = parseFrame(feature.get("frame"));

  BRepPrimAPI_MakeBox maker(frame, dx, dy, dz);
  maker.Build();
  if (!maker.IsDone()) raiseError("OPERATION_FAILED", "Box construction failed");
  const TopoDS_Shape shape = maker.Shape();
  if (shape.IsNull()) raiseError("OPERATION_FAILED", "Box construction produced an empty shape");

  BoxNaming naming = nameBox(shape, frame, dx, dy, dz, id);
  ShapeRecord record;
  record.shape = shape;
  record.faceNames = std::move(naming.faceNames);
  record.edgeNames = std::move(naming.edgeNames);
  const ShapeHandle handle = handles().insert(std::move(record));
  return okJson("{\"shape\":" + std::to_string(handle) + ",\"naming\":" +
                namingJson(naming.entries) + ",\"warnings\":[]}");
}

std::string execPrimitive(const Json& feature, const Json& inputs, const std::string& id) {
  const std::string shapeKind = requireString(feature, "shape", "primitive feature");
  const Json* op = feature.get("op");
  if (op != nullptr && op->isString() && op->string != "new") {
    raiseError("UNSUPPORTED_FEATURE", "Primitive op '" + op->string + "' is not supported yet",
          "Use op \"new\"; body operations on primitives arrive in M1.");
  }
  const Json* values = inputs.get("values");
  if (values == nullptr || !values->isObject()) {
    raiseError("INVALID_INPUT", "inputs.values must be an object of resolved numbers");
  }
  if (shapeKind == "box") return execBox(feature, *values, id);
  raiseError("UNSUPPORTED_FEATURE", "Primitive shape '" + shapeKind + "' is not supported yet",
        "Only box primitives are available in this kernel build.");
}

// ---------------------------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------------------------

std::string metaJsonFor(const ShapeRecord& record, const Bnd_Box& box, int faceCount,
                        int edgeCount) {
  auto namesJson = [](const std::vector<std::string>& names, int count) {
    std::string out = "[";
    for (int i = 0; i < count; ++i) {
      if (i > 0) out.push_back(',');
      const size_t idx = static_cast<size_t>(i);
      writeJsonString(out, idx < names.size() ? names[idx] : std::string());
    }
    out.push_back(']');
    return out;
  };
  std::string bbox;
  if (box.IsVoid()) {
    bbox = "{\"min\":[0,0,0],\"max\":[0,0,0]}";
  } else {
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    bbox = "{\"min\":" + jsonVec3(gp_XYZ(x0, y0, z0)) + ",\"max\":" + jsonVec3(gp_XYZ(x1, y1, z1)) +
           "}";
  }
  return "{\"faceNames\":" + namesJson(record.faceNames, faceCount) +
         ",\"edgeNames\":" + namesJson(record.edgeNames, edgeCount) + ",\"bbox\":" + bbox + "}";
}

Bnd_Box exactBounds(const TopoDS_Shape& shape) {
  Bnd_Box box;
  // Geometry-exact bounds without the tolerance gap BRepBndLib::Add would add.
  BRepBndLib::AddOptimal(shape, box, /*useTriangulation=*/false, /*useShapeTolerance=*/false);
  return box;
}

void appendFace(const TopoDS_Face& face, MeshData& out) {
  const uint32_t firstTriangle = static_cast<uint32_t>(out.indices.size() / 3);
  TopLoc_Location location;
  const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, location);
  if (tri.IsNull() || tri->NbTriangles() == 0) {
    out.faceRanges.push_back(firstTriangle);
    out.faceRanges.push_back(0);
    return;
  }
  const gp_Trsf trsf = location.Transformation();
  const bool reversed = face.Orientation() == TopAbs_REVERSED;
  const uint32_t base = static_cast<uint32_t>(out.positions.size() / 3);

  // Normals from the surface at each node's UV where available (smooth shading on curved faces);
  // otherwise from the triangulation's own normals, finally from triangle geometry.
  std::unique_ptr<BRepAdaptor_Surface> surface;
  if (tri->HasUVNodes()) surface = std::make_unique<BRepAdaptor_Surface>(face, false);

  const int nbNodes = tri->NbNodes();
  std::vector<gp_Vec> nodeNormals(static_cast<size_t>(nbNodes), gp_Vec(0, 0, 0));
  std::vector<bool> haveNormal(static_cast<size_t>(nbNodes), false);
  for (int i = 1; i <= nbNodes; ++i) {
    const gp_Pnt p = tri->Node(i).Transformed(trsf);
    out.positions.push_back(static_cast<float>(p.X()));
    out.positions.push_back(static_cast<float>(p.Y()));
    out.positions.push_back(static_cast<float>(p.Z()));
    if (surface) {
      const gp_Pnt2d uv = tri->UVNode(i);
      BRepLProp_SLProps props(*surface, uv.X(), uv.Y(), 1, 1e-7);
      if (props.IsNormalDefined()) {
        // BRepAdaptor_Surface already includes the face location, so the normal is global.
        gp_Vec n(props.Normal());
        if (reversed) n.Reverse();
        nodeNormals[static_cast<size_t>(i - 1)] = n;
        haveNormal[static_cast<size_t>(i - 1)] = true;
      }
    } else if (tri->HasNormals()) {
      gp_Vec n(tri->Normal(i).Transformed(trsf));
      if (reversed) n.Reverse();
      nodeNormals[static_cast<size_t>(i - 1)] = n;
      haveNormal[static_cast<size_t>(i - 1)] = true;
    }
  }

  const int nbTriangles = tri->NbTriangles();
  std::vector<gp_Vec> accumulated(static_cast<size_t>(nbNodes), gp_Vec(0, 0, 0));
  for (int t = 1; t <= nbTriangles; ++t) {
    int n1 = 0;
    int n2 = 0;
    int n3 = 0;
    tri->Triangle(t).Get(n1, n2, n3);
    if (reversed) std::swap(n2, n3);  // keep CCW winding w.r.t. the outward normal
    out.indices.push_back(base + static_cast<uint32_t>(n1 - 1));
    out.indices.push_back(base + static_cast<uint32_t>(n2 - 1));
    out.indices.push_back(base + static_cast<uint32_t>(n3 - 1));
    const gp_Pnt p1 = tri->Node(n1).Transformed(trsf);
    const gp_Pnt p2 = tri->Node(n2).Transformed(trsf);
    const gp_Pnt p3 = tri->Node(n3).Transformed(trsf);
    const gp_Vec faceNormal = gp_Vec(p1, p2).Crossed(gp_Vec(p1, p3));  // area-weighted
    accumulated[static_cast<size_t>(n1 - 1)] += faceNormal;
    accumulated[static_cast<size_t>(n2 - 1)] += faceNormal;
    accumulated[static_cast<size_t>(n3 - 1)] += faceNormal;
  }

  for (int i = 0; i < nbNodes; ++i) {
    const size_t idx = static_cast<size_t>(i);
    gp_Vec n = haveNormal[idx] ? nodeNormals[idx] : accumulated[idx];
    const double len = n.Magnitude();
    if (len > 1e-300) {
      n /= len;
    } else {
      n = gp_Vec(0, 0, 1);
    }
    out.normals.push_back(static_cast<float>(n.X()));
    out.normals.push_back(static_cast<float>(n.Y()));
    out.normals.push_back(static_cast<float>(n.Z()));
  }

  out.faceRanges.push_back(firstTriangle);
  out.faceRanges.push_back(static_cast<uint32_t>(nbTriangles));
}

void appendEdge(const TopoDS_Edge& edge, const ShapeListMap& edgeFaces,
                MeshData& out) {
  const uint32_t firstPoint = static_cast<uint32_t>(out.edgePositions.size() / 3);
  uint32_t count = 0;
  auto push = [&](const gp_Pnt& p) {
    out.edgePositions.push_back(static_cast<float>(p.X()));
    out.edgePositions.push_back(static_cast<float>(p.Y()));
    out.edgePositions.push_back(static_cast<float>(p.Z()));
    ++count;
  };

  if (!BRep_Tool::Degenerated(edge)) {
    // Prefer the polygon on an adjacent face's triangulation: it shares nodes with the shaded mesh,
    // so edges and faces line up exactly.
    const ShapeList* faces = edgeFaces.Seek(edge);
    if (faces != nullptr) {
      for (const TopoDS_Shape& f : *faces) {
        TopLoc_Location location;
        const TopoDS_Face& face = TopoDS::Face(f);
        const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, location);
        if (tri.IsNull()) continue;
        const occ::handle<Poly_PolygonOnTriangulation>& poly =
            BRep_Tool::PolygonOnTriangulation(edge, tri, location);
        if (poly.IsNull()) continue;
        const gp_Trsf trsf = location.Transformation();
        for (int i = 1; i <= poly->NbNodes(); ++i) push(tri->Node(poly->Node(i)).Transformed(trsf));
        break;
      }
    }
    if (count == 0) {
      TopLoc_Location location;
      const occ::handle<Poly_Polygon3D>& polygon = BRep_Tool::Polygon3D(edge, location);
      if (!polygon.IsNull()) {
        const gp_Trsf trsf = location.Transformation();
        for (int i = 1; i <= polygon->NbNodes(); ++i) push(polygon->Nodes()(i).Transformed(trsf));
      }
    }
  }
  out.edgeRanges.push_back(firstPoint);
  out.edgeRanges.push_back(count);
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// Public façade
// ---------------------------------------------------------------------------------------------

std::string kernelInfo() {
  return guarded("kernelInfo", []() {
#if defined(__EMSCRIPTEN_PTHREADS__)
    const bool threads = true;
#else
    const bool threads = false;
#endif
    return okJson(std::string("{\"occtVersion\":") + jsonString(OCC_VERSION_COMPLETE) +
                  ",\"buildId\":" + jsonString(WHITTLE_BUILD_ID) +
                  ",\"threads\":" + (threads ? "true" : "false") + "}");
  });
}

std::string execFeature(const std::string& featureJson, const std::string& inputsJson) {
  return guarded("execFeature", [&]() {
    const JsonPtr feature = JsonParser(featureJson).parseDocument();
    const JsonPtr inputs = JsonParser(inputsJson).parseDocument();
    if (!feature->isObject()) raiseError("INVALID_INPUT", "feature must be a JSON object");
    if (!inputs->isObject()) raiseError("INVALID_INPUT", "inputs must be a JSON object");
    const std::string type = requireString(*feature, "type", "feature");
    const std::string id = requireString(*feature, "id", "feature");
    if (id.empty()) raiseError("INVALID_INPUT", "feature.id must not be empty");
    if (type == "primitive") return execPrimitive(*feature, *inputs, id);
    raiseError("UNSUPPORTED_FEATURE", "Feature type '" + type + "' is not supported by this kernel build",
          "Update Whittle, or remove the feature.");
  });
}

std::string mesh(ShapeHandle shape, const std::string& optionsJson, MeshData& out) {
  return guarded("mesh", [&]() {
    out = MeshData();
    const auto record = requireShape(shape);
    const JsonPtr options = JsonParser(optionsJson).parseDocument();
    if (!options->isObject()) raiseError("INVALID_INPUT", "mesh options must be a JSON object");
    const Json* lin = options->get("linearDeflection");
    const Json* ang = options->get("angularDeflection");
    const Json* rel = options->get("relative");
    if (lin == nullptr || !lin->isNumber() || !(lin->number > 0) || !std::isfinite(lin->number)) {
      raiseError("INVALID_INPUT", "linearDeflection must be a positive number");
    }
    if (ang == nullptr || !ang->isNumber() || !(ang->number > 0) || !std::isfinite(ang->number)) {
      raiseError("INVALID_INPUT", "angularDeflection must be a positive number (radians)");
    }
    const bool relative = rel != nullptr && rel->kind == Json::Kind::Bool && rel->boolean;
#if defined(__EMSCRIPTEN_PTHREADS__)
    const bool parallel = true;
#else
    const bool parallel = false;
#endif
    // Meshing mutates the shape's cached triangulation (shared TShape); handles are only used
    // from the kernel worker's thread, so this is safe.
    BRepMesh_IncrementalMesh mesher(record->shape, lin->number, relative, ang->number, parallel);
    if (!mesher.IsDone()) raiseError("OPERATION_FAILED", "Tessellation failed");

    ShapeMap faces;
    ShapeMap edges;
    TopExp::MapShapes(record->shape, TopAbs_FACE, faces);
    TopExp::MapShapes(record->shape, TopAbs_EDGE, edges);
    ShapeListMap edgeFaces;
    TopExp::MapShapesAndAncestors(record->shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

    out.faceRanges.reserve(static_cast<size_t>(faces.Extent()) * 2);
    for (int i = 1; i <= faces.Extent(); ++i) appendFace(TopoDS::Face(faces(i)), out);
    out.edgeRanges.reserve(static_cast<size_t>(edges.Extent()) * 2);
    for (int i = 1; i <= edges.Extent(); ++i) appendEdge(TopoDS::Edge(edges(i)), edgeFaces, out);

    out.metaJson = metaJsonFor(*record, exactBounds(record->shape), faces.Extent(), edges.Extent());
    return okJson("{}");
  });
}

std::string massProperties(ShapeHandle shape) {
  return guarded("massProperties", [&]() {
    const auto record = requireShape(shape);
    GProp_GProps volumeProps;
    BRepGProp::VolumeProperties(record->shape, volumeProps);
    GProp_GProps surfaceProps;
    BRepGProp::SurfaceProperties(record->shape, surfaceProps);
    const Bnd_Box box = exactBounds(record->shape);

    ShapeMap faces;
    ShapeMap edges;
    ShapeMap vertices;
    TopExp::MapShapes(record->shape, TopAbs_FACE, faces);
    TopExp::MapShapes(record->shape, TopAbs_EDGE, edges);
    TopExp::MapShapes(record->shape, TopAbs_VERTEX, vertices);

    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    if (!box.IsVoid()) box.Get(x0, y0, z0, x1, y1, z1);
    const gp_Pnt centroid =
        volumeProps.Mass() != 0.0 ? volumeProps.CentreOfMass() : surfaceProps.CentreOfMass();
    return okJson("{\"volume\":" + jsonNumber(volumeProps.Mass()) +
                  ",\"area\":" + jsonNumber(surfaceProps.Mass()) +
                  ",\"centroid\":" + jsonVec3(centroid.XYZ()) + ",\"bbox\":{\"min\":" +
                  jsonVec3(gp_XYZ(x0, y0, z0)) + ",\"max\":" + jsonVec3(gp_XYZ(x1, y1, z1)) +
                  "},\"faceCount\":" + std::to_string(faces.Extent()) +
                  ",\"edgeCount\":" + std::to_string(edges.Extent()) +
                  ",\"vertexCount\":" + std::to_string(vertices.Extent()) + "}");
  });
}

void release(ShapeHandle shape) {
  try {
    handles().erase(shape);
  } catch (...) {
    // Never throw across the boundary; releasing an unknown handle is a no-op.
  }
}

int32_t liveHandleCount() {
  try {
    return handles().size();
  } catch (...) {
    return -1;
  }
}

}  // namespace whittle
