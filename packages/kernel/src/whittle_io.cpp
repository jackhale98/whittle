// Whittle kernel façade — data exchange: STEP (XCAF, names + colours), STL, BREP (PLAN §2.5).
// Files are written to / read from the Emscripten MEMFS; the worker moves the bytes.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.

struct ExportItem {
  std::shared_ptr<const ShapeRecord> record;
  std::string name;
  std::string color;  // "#rrggbb" or ""
};

std::vector<ExportItem> parseExportItems(const std::string& shapesJson) {
  const JsonPtr root = JsonParser(shapesJson).parseDocument();
  if (!root->isArray() || root->array.empty()) {
    raiseError("INVALID_INPUT", "Nothing to export", "Pass at least one body.");
  }
  std::vector<ExportItem> items;
  for (const JsonPtr& entry : root->array) {
    if (!entry->isObject()) raiseError("INVALID_INPUT", "export shapes must be objects");
    ExportItem item;
    item.record = requireShape(optHandle(*entry, "shape"));
    item.name = optString(*entry, "name", "Body " + std::to_string(items.size() + 1));
    item.color = optString(*entry, "color", "");
    items.push_back(std::move(item));
  }
  return items;
}

std::string nextMemfsPath(const char* stem, const char* ext) {
  static int counter = 0;
  ++counter;
  return std::string("/tmp/whittle-") + stem + "-" + std::to_string(counter) + "." + ext;
}

bool parseHexColor(const std::string& hex, Quantity_Color& out) {
  if (hex.size() != 7 || hex[0] != '#') return false;
  unsigned value = 0;
  for (size_t i = 1; i < 7; ++i) {
    const char c = hex[i];
    value <<= 4;
    if (c >= '0' && c <= '9') {
      value |= static_cast<unsigned>(c - '0');
    } else if (c >= 'a' && c <= 'f') {
      value |= static_cast<unsigned>(c - 'a' + 10);
    } else if (c >= 'A' && c <= 'F') {
      value |= static_cast<unsigned>(c - 'A' + 10);
    } else {
      return false;
    }
  }
  out = Quantity_Color(((value >> 16) & 0xFF) / 255.0, ((value >> 8) & 0xFF) / 255.0,
                       (value & 0xFF) / 255.0, Quantity_TOC_sRGB);
  return true;
}

std::string exportStep(const std::vector<ExportItem>& items, const Json& options) {
  const std::string schema = optString(options, "stepSchema", "AP214");
  DESTEP_Parameters params;
  if (schema == "AP214") {
    params.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP214IS;
  } else if (schema == "AP203") {
    params.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP203;
  } else if (schema == "AP242") {
    params.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP242DIS;
  } else {
    raiseError("INVALID_INPUT", "Unknown STEP schema '" + schema + "'", "Use AP203, AP214 or AP242.");
  }
  params.WriteUnit = UnitsMethods_LengthUnit_Millimeter;
  params.WriteName = true;
  params.WriteColor = true;

  occ::handle<TDocStd_Document> doc = new TDocStd_Document("MDTV-XCAF");
  XCAFDoc_DocumentTool::Set(doc->Main(), false);
  XCAFDoc_DocumentTool::SetLengthUnit(doc, 0.001);  // document unit: mm (value in metres)
  occ::handle<XCAFDoc_ShapeTool> shapes = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  occ::handle<XCAFDoc_ColorTool> colors = XCAFDoc_DocumentTool::ColorTool(doc->Main());
  for (const ExportItem& item : items) {
    const TDF_Label label = shapes->AddShape(item.record->shape, false);
    TDataStd_Name::Set(label, TCollection_ExtendedString(item.name.c_str(), true));
    Quantity_Color color;
    if (!item.color.empty() && parseHexColor(item.color, color)) {
      colors->SetColor(label, color, XCAFDoc_ColorGen);
    }
  }
  STEPCAFControl_Writer writer;
  writer.SetNameMode(true);
  writer.SetColorMode(true);
  if (!writer.Transfer(doc, params, STEPControl_AsIs)) {
    raiseError("OPERATION_FAILED", "The bodies could not be converted to STEP");
  }
  const std::string path = nextMemfsPath("export", "step");
  if (writer.Write(path.c_str()) != IFSelect_RetDone) {
    raiseError("OPERATION_FAILED", "Writing the STEP file failed");
  }
  return path;
}

std::string exportBrep(const std::vector<ExportItem>& items) {
  TopoDS_Shape shape;
  if (items.size() == 1) {
    shape = items[0].record->shape;
  } else {
    BRep_Builder b;
    TopoDS_Compound c;
    b.MakeCompound(c);
    for (const ExportItem& item : items) b.Add(c, item.record->shape);
    shape = c;
  }
  const std::string path = nextMemfsPath("export", "brep");
  if (!BRepTools::Write(shape, path.c_str(), false, false, TopTools_FormatVersion_CURRENT)) {
    raiseError("OPERATION_FAILED", "Writing the BREP file failed");
  }
  return path;
}

// Triangles of a shape tessellated at the export deflection. Meshes a copy so the viewport's
// cached triangulation (shared TShapes) is not replaced by export-quality meshes.
void collectTriangles(const ShapeRecord& record, double linear, double angular,
                      std::vector<float>& out) {
  TopoDS_Shape shape = record.shape;
  if (!record.meshOnly) {
    BRepBuilderAPI_Copy copy(record.shape, true, false);
    shape = copy.Shape();
    BRepMesh_IncrementalMesh mesher(shape, linear, false, angular, false);
    if (!mesher.IsDone()) raiseError("OPERATION_FAILED", "Tessellation for STL export failed");
  }
  for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face& face = TopoDS::Face(ex.Current());
    TopLoc_Location loc;
    const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull()) continue;
    const gp_Trsf trsf = loc.Transformation();
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    for (int t = 1; t <= tri->NbTriangles(); ++t) {
      int n1 = 0;
      int n2 = 0;
      int n3 = 0;
      tri->Triangle(t).Get(n1, n2, n3);
      if (reversed) std::swap(n2, n3);
      const gp_Pnt p[3] = {tri->Node(n1).Transformed(trsf), tri->Node(n2).Transformed(trsf),
                           tri->Node(n3).Transformed(trsf)};
      gp_Vec normal = gp_Vec(p[0], p[1]).Crossed(gp_Vec(p[0], p[2]));
      if (normal.Magnitude() > 1e-300) normal.Normalize();
      out.push_back(static_cast<float>(normal.X()));
      out.push_back(static_cast<float>(normal.Y()));
      out.push_back(static_cast<float>(normal.Z()));
      for (const gp_Pnt& q : p) {
        out.push_back(static_cast<float>(q.X()));
        out.push_back(static_cast<float>(q.Y()));
        out.push_back(static_cast<float>(q.Z()));
      }
    }
  }
}

struct FileCloser {
  std::FILE* f;
  ~FileCloser() {
    if (f != nullptr) std::fclose(f);
  }
};

std::string sanitizeSolidName(const std::string& name) {
  std::string out;
  for (const char c : name) out.push_back(c == '\n' || c == '\r' ? ' ' : c);
  return out.empty() ? std::string("whittle") : out;
}

void writeStl(const std::string& path, const std::vector<float>& facets, bool binary,
              const std::string& name) {
  FileCloser file{std::fopen(path.c_str(), "wb")};
  if (file.f == nullptr) raiseError("INTERNAL", "Could not create " + path);
  const size_t count = facets.size() / 12;
  if (binary) {
    char header[80];
    std::memset(header, 0, sizeof header);
    std::snprintf(header, sizeof header, "Whittle STL (mm) %s", sanitizeSolidName(name).c_str());
    std::fwrite(header, 1, sizeof header, file.f);
    const uint32_t n = static_cast<uint32_t>(count);
    unsigned char le[4] = {static_cast<unsigned char>(n & 0xFF),
                           static_cast<unsigned char>((n >> 8) & 0xFF),
                           static_cast<unsigned char>((n >> 16) & 0xFF),
                           static_cast<unsigned char>((n >> 24) & 0xFF)};
    std::fwrite(le, 1, 4, file.f);
    const uint16_t attr = 0;
    for (size_t i = 0; i < count; ++i) {
      // Wasm is little-endian, matching STL.
      std::fwrite(&facets[i * 12], sizeof(float), 12, file.f);
      std::fwrite(&attr, sizeof attr, 1, file.f);
    }
  } else {
    const std::string solid = sanitizeSolidName(name);
    std::fprintf(file.f, "solid %s\n", solid.c_str());
    for (size_t i = 0; i < count; ++i) {
      const float* f = &facets[i * 12];
      std::fprintf(file.f, "  facet normal %.7e %.7e %.7e\n    outer loop\n", f[0], f[1], f[2]);
      for (int v = 0; v < 3; ++v) {
        std::fprintf(file.f, "      vertex %.9e %.9e %.9e\n", f[3 + v * 3], f[4 + v * 3],
                     f[5 + v * 3]);
      }
      std::fprintf(file.f, "    endloop\n  endfacet\n");
    }
    std::fprintf(file.f, "endsolid %s\n", solid.c_str());
  }
  if (std::ferror(file.f) != 0) raiseError("INTERNAL", "Writing the STL file failed");
}

double positiveOption(const Json& options, const char* key, double fallback) {
  const Json* v = options.get(key);
  if (v == nullptr || v->kind == Json::Kind::Null) return fallback;
  if (!v->isNumber() || !(v->number > 0) || !std::isfinite(v->number)) {
    raiseError("INVALID_INPUT", std::string(key) + " must be a positive number");
  }
  return v->number;
}

bool boolOption(const Json& options, const char* key, bool fallback) {
  const Json* v = options.get(key);
  if (v == nullptr || v->kind != Json::Kind::Bool) return fallback;
  return v->boolean;
}

// Returns the list of (path, name) files written.
std::vector<std::pair<std::string, std::string>> exportStl(const std::vector<ExportItem>& items,
                                                           const Json& options) {
  const double linear = positiveOption(options, "linearDeflection", 0.02);
  const double angular = positiveOption(options, "angularDeflection", 0.25);
  const bool binary = boolOption(options, "stlBinary", true);
  const bool perBody = boolOption(options, "stlPerBody", false);
  std::vector<std::pair<std::string, std::string>> files;
  if (perBody) {
    for (const ExportItem& item : items) {
      std::vector<float> facets;
      collectTriangles(*item.record, linear, angular, facets);
      const std::string path = nextMemfsPath("export", "stl");
      writeStl(path, facets, binary, item.name);
      files.emplace_back(path, item.name);
    }
  } else {
    std::vector<float> facets;
    for (const ExportItem& item : items) collectTriangles(*item.record, linear, angular, facets);
    const std::string path = nextMemfsPath("export", "stl");
    const std::string name = items.size() == 1 ? items[0].name : std::string("whittle");
    writeStl(path, facets, binary, name);
    files.emplace_back(path, name);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

std::string labelName(const TDF_Label& label) {
  occ::handle<TDataStd_Name> name;
  if (label.FindAttribute(TDataStd_Name::GetID(), name) && !name.IsNull()) {
    return TCollection_AsciiString(name->Get()).ToCString();
  }
  return std::string();
}

void addBodies(const TopoDS_Shape& shape, const std::string& name,
               std::vector<std::pair<TopoDS_Shape, std::string>>& out) {
  std::vector<TopoDS_Shape> solids;
  for (TopExp_Explorer ex(shape, TopAbs_SOLID); ex.More(); ex.Next()) solids.push_back(ex.Current());
  if (solids.empty()) {
    out.emplace_back(shape, name);
    return;
  }
  for (size_t i = 0; i < solids.size(); ++i) {
    out.emplace_back(solids[i], solids.size() == 1 || name.empty()
                                    ? name
                                    : name + " " + std::to_string(i + 1));
  }
}

void walkStepLabel(const TDF_Label& label, const TopLoc_Location& location, const std::string& name,
                   std::vector<std::pair<TopoDS_Shape, std::string>>& out, int depth) {
  if (depth > 64) return;
  if (XCAFDoc_ShapeTool::IsAssembly(label)) {
    NCollection_Sequence<TDF_Label> components;
    XCAFDoc_ShapeTool::GetComponents(label, components, false);
    for (int i = 1; i <= components.Length(); ++i) {
      const TDF_Label& comp = components(i);
      TDF_Label referred;
      if (!XCAFDoc_ShapeTool::GetReferredShape(comp, referred)) continue;
      std::string compName = labelName(comp);
      if (compName.empty()) compName = labelName(referred);
      walkStepLabel(referred, location * XCAFDoc_ShapeTool::GetLocation(comp), compName, out,
                    depth + 1);
    }
    return;
  }
  TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(label);
  if (shape.IsNull()) return;
  if (!location.IsIdentity()) shape = shape.Moved(location);
  addBodies(shape, name.empty() ? labelName(label) : name, out);
}

std::string importBodiesJson(const std::vector<std::pair<TopoDS_Shape, std::string>>& bodies,
                             bool meshOnly) {
  if (bodies.empty()) raiseError("INVALID_INPUT", "The file contains no shapes");
  std::vector<HandleGuard> guards(bodies.size());
  std::string json = "{\"bodies\":[";
  for (size_t i = 0; i < bodies.size(); ++i) {
    ShapeRecord record;
    record.shape = bodies[i].first;
    record.meshOnly = meshOnly;
    guards[i].handle = handles().insert(std::move(record));
    if (i > 0) json.push_back(',');
    json += "{\"shape\":" + std::to_string(guards[i].handle);
    if (!bodies[i].second.empty()) json += ",\"name\":" + jsonString(bodies[i].second);
    json += "}";
  }
  json += "]}";
  std::string result = okJson(json);
  for (HandleGuard& g : guards) g.release();
  return result;
}

std::string importStep(const std::string& path) {
  STEPCAFControl_Reader reader;
  reader.SetNameMode(true);
  reader.SetColorMode(true);
  if (reader.ReadFile(path.c_str()) != IFSelect_RetDone) {
    raiseError("INVALID_INPUT", "This file is not a readable STEP file");
  }
  occ::handle<TDocStd_Document> doc = new TDocStd_Document("MDTV-XCAF");
  XCAFDoc_DocumentTool::Set(doc->Main(), false);
  XCAFDoc_DocumentTool::SetLengthUnit(doc, 0.001);
  if (!reader.Transfer(doc)) raiseError("OPERATION_FAILED", "The STEP file could not be converted");
  occ::handle<XCAFDoc_ShapeTool> shapes = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  NCollection_Sequence<TDF_Label> roots;
  shapes->GetFreeShapes(roots);
  std::vector<std::pair<TopoDS_Shape, std::string>> bodies;
  for (int i = 1; i <= roots.Length(); ++i) walkStepLabel(roots(i), TopLoc_Location(), "", bodies, 0);
  return importBodiesJson(bodies, false);
}

std::string importBrep(const std::string& path) {
  TopoDS_Shape shape;
  BRep_Builder builder;
  if (!BRepTools::Read(shape, path.c_str(), builder) || shape.IsNull()) {
    raiseError("INVALID_INPUT", "This file is not a readable BREP file");
  }
  std::vector<std::pair<TopoDS_Shape, std::string>> bodies;
  addBodies(shape, std::string(), bodies);
  return importBodiesJson(bodies, false);
}

std::string importStl(const std::string& path) {
  const occ::handle<Poly_Triangulation> tri = RWStl::ReadFile(path.c_str());
  if (tri.IsNull() || tri->NbTriangles() == 0) {
    raiseError("INVALID_INPUT", "This file is not a readable STL file");
  }
  TopoDS_Face face;
  BRep_Builder builder;
  builder.MakeFace(face, tri);
  return importBodiesJson({{face, std::string()}}, true);
}

