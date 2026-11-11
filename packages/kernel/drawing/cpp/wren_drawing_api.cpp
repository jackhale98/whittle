// Wren drawing kernel — public entry points (wren_drawing.h). Every one runs inside `guarded`, so
// no OCCT or C++ exception crosses the boundary.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated drawing translation unit; closes the anonymous namespace that
// whittle_core.cpp opened.

}  // namespace

std::string drawingInfo() {
  return guarded("drawingInfo", []() {
#if defined(__EMSCRIPTEN_PTHREADS__)
    const bool threads = true;
#else
    const bool threads = false;
#endif
    return okJson(std::string("{\"occtVersion\":") + jsonString(OCC_VERSION_COMPLETE) +
                  ",\"buildId\":" + jsonString(WHITTLE_BUILD_ID) +
                  ",\"threads\":" + (threads ? "true" : "false") + ",\"kind\":\"drawing\"}");
  });
}

std::string loadShape(const std::string& path) {
  return guarded("loadShape", [&]() {
    TopoDS_Shape shape;
    BRep_Builder builder;
    if (!BRepTools::Read(shape, path.c_str(), builder) || shape.IsNull()) {
      raiseError("INVALID_INPUT", "The drawing worker could not read this part",
                 "Rebuild the part; its BREP data may be truncated.");
    }
    // Continuity of edges between faces that meet tangentially (fillets, blends) or of seams, when
    // the writer did not store it: HLR classifies by it (smooth = G1, sewn = G2 and up). Topology
    // and TopExp order are unchanged.
    BRepLib::EncodeRegularity(shape, 1e-6);
    ShapeRecord record;
    record.shape = shape;
    record.topoCache = std::make_shared<Topo>(shape);
    const int edges = record.topoCache->edges.Extent();
    const int faces = record.topoCache->faces.Extent();
    const int solids = countSolids(shape);
    const ShapeHandle handle = handles().insert(std::move(record));
    return okJson("{\"handle\":" + std::to_string(handle) + ",\"edges\":" + std::to_string(edges) +
                  ",\"faces\":" + std::to_string(faces) + ",\"solids\":" + std::to_string(solids) +
                  "}");
  });
}

std::string project(ShapeHandle shape, const std::string& requestJson) {
  return guarded("project", [&]() {
    const std::shared_ptr<const ShapeRecord> record = requireShape(shape);
    const JsonPtr request = JsonParser(requestJson).parseDocument();
    if (!request->isObject()) raiseError("INVALID_INPUT", "project: the request must be an object");
    const ViewRequest req = parseViewRequest(*request);
    return okJson(projectViewJson(*record, req));
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
