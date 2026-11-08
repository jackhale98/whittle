// Whittle kernel façade — public entry points of whittle_kernel.h (PLAN §7): meshing, mass
// properties, fingerprints, export/import, threads, handle lifetime.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.

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

Bnd_Box exactBounds(const ShapeRecord& record) {
  Bnd_Box box;
  // Geometry-exact bounds without the tolerance gap BRepBndLib::Add would add. Mesh-only shapes
  // (STL import) have no geometry, so their triangulation is used.
  BRepBndLib::AddOptimal(record.shape, box, /*useTriangulation=*/record.meshOnly,
                         /*useShapeTolerance=*/false);
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

// BRepMesh_IncrementalMesh keeps an existing triangulation that is at least as fine as asked
// for, and triangulations live in the (shared) TShapes. To honour a coarser request after a
// finer one, drop the cached triangulation when it was built for a much smaller deflection. The
// recorded per-edge polygon deflection is the requested (target) value, unlike the face
// triangulation's, which BRepLib::UpdateDeflection overwrites with the measured deviation.
bool cachedMeshTooFine(const TopoDS_Shape& shape, double linear) {
  for (TopExp_Explorer fx(shape, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face& face = TopoDS::Face(fx.Current());
    TopLoc_Location loc;
    const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull()) continue;
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
      const occ::handle<Poly_PolygonOnTriangulation>& poly =
          BRep_Tool::PolygonOnTriangulation(TopoDS::Edge(ex.Current()), tri, loc);
      if (!poly.IsNull() && poly->Deflection() > 0 && poly->Deflection() < 0.5 * linear) {
        return true;
      }
    }
  }
  for (TopExp_Explorer ex(shape, TopAbs_EDGE, TopAbs_FACE); ex.More(); ex.Next()) {
    TopLoc_Location loc;
    const occ::handle<Poly_Polygon3D>& poly = BRep_Tool::Polygon3D(TopoDS::Edge(ex.Current()), loc);
    if (!poly.IsNull() && poly->Deflection() > 0 && poly->Deflection() < 0.5 * linear) return true;
  }
  return false;
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
    return dispatchFeature(*feature, *inputs);
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
    const Bnd_Box bounds = exactBounds(*record);
    double linear = lin->number;
    if (relative && !bounds.IsVoid()) {
      // Contract: relative to the shape's bbox size (largest extent).
      double x0, y0, z0, x1, y1, z1;
      bounds.Get(x0, y0, z0, x1, y1, z1);
      const double size = std::max(x1 - x0, std::max(y1 - y0, z1 - z0));
      if (size > 0) linear *= size;
    }
#if defined(__EMSCRIPTEN_PTHREADS__)
    const bool parallel = true;
#else
    const bool parallel = false;
#endif
    if (!record->meshOnly) {
      // Meshing mutates the shape's cached triangulation (shared TShapes); handles are only used
      // from the kernel worker's thread, so this is safe.
      if (cachedMeshTooFine(record->shape, linear)) BRepTools::Clean(record->shape);
      BRepMesh_IncrementalMesh mesher(record->shape, linear, false, ang->number, parallel);
      if (!mesher.IsDone()) raiseError("OPERATION_FAILED", "Tessellation failed");
    }

    const Topo& topo = record->topo();
    ShapeListMap edgeFaces;
    TopExp::MapShapesAndAncestors(record->shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

    out.faceRanges.reserve(static_cast<size_t>(topo.faces.Extent()) * 2);
    for (int i = 1; i <= topo.faces.Extent(); ++i) appendFace(TopoDS::Face(topo.faces(i)), out);
    out.edgeRanges.reserve(static_cast<size_t>(topo.edges.Extent()) * 2);
    for (int i = 1; i <= topo.edges.Extent(); ++i) {
      appendEdge(TopoDS::Edge(topo.edges(i)), edgeFaces, out);
    }

    out.metaJson = metaJsonFor(*record, bounds, topo.faces.Extent(), topo.edges.Extent());
    return okJson("{}");
  });
}

std::string massProperties(ShapeHandle shape, double densityKgPerMm3) {
  return guarded("massProperties", [&]() {
    const auto record = requireShape(shape);
    if (!std::isfinite(densityKgPerMm3) || densityKgPerMm3 < 0) {
      raiseError("INVALID_INPUT", "Density must be a positive number (kg/mm³)",
                 "Check the material's density.");
    }
    GProp_GProps volumeProps;
    BRepGProp::VolumeProperties(record->shape, volumeProps);
    GProp_GProps surfaceProps;
    BRepGProp::SurfaceProperties(record->shape, surfaceProps);
    const Bnd_Box box = exactBounds(*record);
    const Topo& topo = record->topo();

    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    if (!box.IsVoid()) box.Get(x0, y0, z0, x1, y1, z1);
    const bool hasVolume = std::fabs(volumeProps.Mass()) > 0.0;
    const gp_Pnt centroid = hasVolume ? volumeProps.CentreOfMass() : surfaceProps.CentreOfMass();
    std::string json = "{\"volume\":" + jsonNumber(volumeProps.Mass()) +
                       ",\"area\":" + jsonNumber(surfaceProps.Mass()) +
                       ",\"centroid\":" + jsonVec3(centroid.XYZ());
    if (densityKgPerMm3 > 0) {
      const double mass = volumeProps.Mass() * densityKgPerMm3;
      json += ",\"mass\":" + jsonNumber(mass) + ",\"inertia\":[";
      // GProp: about the centre of mass, axes parallel to world; the volume integrals scale
      // with the (homogeneous) density.
      const gp_Mat m = hasVolume ? volumeProps.MatrixOfInertia() : gp_Mat(0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (int r = 1; r <= 3; ++r) {
        for (int c = 1; c <= 3; ++c) {
          if (r != 1 || c != 1) json.push_back(',');
          json += jsonNumber(m(r, c) * densityKgPerMm3);
        }
      }
      json += "]";
    }
    json += ",\"bbox\":{\"min\":" + jsonVec3(gp_XYZ(x0, y0, z0)) +
            ",\"max\":" + jsonVec3(gp_XYZ(x1, y1, z1)) +
            "},\"faceCount\":" + std::to_string(topo.faces.Extent()) +
            ",\"edgeCount\":" + std::to_string(topo.edges.Extent()) +
            ",\"vertexCount\":" + std::to_string(topo.vertices.Extent()) + "}";
    return okJson(json);
  });
}

std::string fingerprints(ShapeHandle shape) {
  return guarded("fingerprints", [&]() {
    const auto record = requireShape(shape);
    const Topo& topo = record->topo();
    std::string json = "{\"faces\":[";
    for (int i = 1; i <= topo.faces.Extent(); ++i) {
      const TopoDS_Face& face = TopoDS::Face(topo.faces(i));
      if (i > 1) json.push_back(',');
      GProp_GProps props;
      BRepGProp::SurfaceProperties(face, props);
      const bool geometric = BRep_Tool::IsGeometric(face);
      const char* type = "mesh";
      std::string normal;
      if (geometric) {
        BRepAdaptor_Surface s(face, false);
        type = surfaceTypeName(s.GetType());
        gp_Pln pln;
        gp_Dir n;
        if (planeOf(face, pln, n)) normal = ",\"normal\":" + jsonVec3(n.XYZ());
      }
      json += "{\"centroid\":" + jsonPoint(faceCentroid(face)) + normal +
              ",\"area\":" + jsonNumber(props.Mass()) + ",\"surface\":\"" + type + "\"}";
    }
    json += "],\"edges\":[";
    for (int i = 1; i <= topo.edges.Extent(); ++i) {
      const TopoDS_Edge& edge = TopoDS::Edge(topo.edges(i));
      if (i > 1) json.push_back(',');
      const char* type = "degenerate";
      if (!BRep_Tool::Degenerated(edge)) {
        if (BRep_Tool::IsGeometric(edge)) {
          BRepAdaptor_Curve c(edge);
          type = curveTypeName(c.GetType());
        } else {
          type = "mesh";
        }
      }
      json += "{\"centroid\":" + jsonPoint(edgeCentroid(edge)) +
              ",\"length\":" + jsonNumber(edgeLength(edge)) + ",\"curve\":\"" + type + "\"}";
    }
    json += "],\"vertices\":[";
    for (int i = 1; i <= topo.vertices.Extent(); ++i) {
      if (i > 1) json.push_back(',');
      json += "{\"point\":" + jsonPoint(BRep_Tool::Pnt(TopoDS::Vertex(topo.vertices(i)))) + "}";
    }
    json += "]}";
    return okJson(json);
  });
}

std::string exportShapes(const std::string& shapesJson, const std::string& format,
                         const std::string& optionsJson) {
  return guarded("exportShapes", [&]() {
    const std::vector<ExportItem> items = parseExportItems(shapesJson);
    const JsonPtr options = JsonParser(optionsJson.empty() ? std::string("{}") : optionsJson)
                                .parseDocument();
    if (!options->isObject()) raiseError("INVALID_INPUT", "export options must be a JSON object");
    std::vector<std::pair<std::string, std::string>> files;
    if (format == "step") {
      files.emplace_back(exportStep(items, *options), items.size() == 1 ? items[0].name : "");
    } else if (format == "brep") {
      files.emplace_back(exportBrep(items), items.size() == 1 ? items[0].name : "");
    } else if (format == "stl") {
      files = exportStl(items, *options);
    } else {
      raiseError("INVALID_INPUT", "Unknown export format '" + format + "'",
                 "Use step, stl or brep.");
    }
    std::string json = "{\"path\":" + jsonString(files[0].first) + ",\"files\":[";
    for (size_t i = 0; i < files.size(); ++i) {
      if (i > 0) json.push_back(',');
      json += "{\"path\":" + jsonString(files[i].first) + ",\"name\":" + jsonString(files[i].second) + "}";
    }
    json += "]}";
    return okJson(json);
  });
}

std::string importFile(const std::string& path, const std::string& format) {
  return guarded("importFile", [&]() {
    if (format == "step") return importStep(path);
    if (format == "brep") return importBrep(path);
    if (format == "stl") return importStl(path);
    raiseError("INVALID_INPUT", "Unknown import format '" + format + "'", "Use step, stl or brep.");
  });
}

std::string measure(const std::string& queryJson) {
  return guarded("measure", [&]() {
    const JsonPtr query = JsonParser(queryJson).parseDocument();
    return okJson(measureQuery(*query));
  });
}

std::string configureThreads(int32_t count) {
  return guarded("configureThreads", [&]() {
    if (count < 1) raiseError("INVALID_INPUT", "Thread count must be at least 1");
#if defined(__EMSCRIPTEN_PTHREADS__)
    const int max = std::max(1, OSD_Parallel::NbLogicalProcessors());
    const int n = std::min(static_cast<int>(count), max);
    const occ::handle<OSD_ThreadPool>& pool = OSD_ThreadPool::DefaultPool();
    if (pool->IsInUse()) raiseError("INTERNAL", "The thread pool is busy; try again");
    // Pool threads start lazily on first use; keeping n within the pre-spawned pthread pool
    // (PTHREAD_POOL_SIZE / threadCount) avoids a blocking pthread_create in the worker.
    pool->Init(n);
    return okJson("{\"threads\":" + std::to_string(pool->NbThreads()) +
                  ",\"max\":" + std::to_string(max) + "}");
#else
    return okJson("{\"threads\":1,\"max\":1}");
#endif
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
