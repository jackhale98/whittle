// Whittle kernel façade — modeling features (PLAN §7, M1): primitives, sketch, extrude, revolve,
// fillet, chamfer, boolean, plane. Names follow packages/contracts/src/naming.ts exactly.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.

// ---------------------------------------------------------------------------------------------
// History-based naming helpers
// ---------------------------------------------------------------------------------------------

// A shape with known base names for its TopExp faces.
struct NamedInput {
  TopoDS_Shape shape;
  std::vector<std::string> faceNames;
};

NamedInput namedInputOf(const ShapeRecord& record) { return NamedInput{record.shape, record.faceNames}; }
NamedInput namedInputOf(const NamedShape& ns) { return NamedInput{ns.shape, ns.faces}; }

// Carries face names from `input` into `result` through an algorithm's history: a face that
// survives (unchanged, or Modified) keeps its name. With `onlyIfEmpty`, names already assigned
// (e.g. from the target body) win over this input's.
//
// `origin` (optional, one slot per result face, kOriginTool when unclaimed) records which input
// a face came from: the first input that reaches a slot claims it with `group`.
void carryFaceNames(BRepBuilderAPI_MakeShape& algo, const NamedInput& input, const Topo& result,
                    std::vector<std::string>& names, bool onlyIfEmpty,
                    const std::function<std::string(const std::string&)>& rename = nullptr,
                    std::vector<int>* origin = nullptr, int group = kOriginTool) {
  const Topo in(input.shape);
  auto assign = [&](int resultIndex, const std::string& name) {
    if (resultIndex <= 0) return;
    if (origin != nullptr) {
      int& o = (*origin)[static_cast<size_t>(resultIndex - 1)];
      if (o == kOriginTool) o = group;
    }
    if (name.empty()) return;
    std::string& slot = names[static_cast<size_t>(resultIndex - 1)];
    if (slot.empty() || (!onlyIfEmpty && name < slot)) slot = name;
  };
  for (int i = 1; i <= in.faces.Extent(); ++i) {
    const TopoDS_Shape& face = in.faces(i);
    const size_t idx = static_cast<size_t>(i - 1);
    const bool named = idx < input.faceNames.size() && !input.faceNames[idx].empty();
    if (!named && origin == nullptr) continue;
    const std::string name = !named ? std::string() : rename ? rename(input.faceNames[idx]) : input.faceNames[idx];
    if (algo.IsDeleted(face)) continue;
    const ShapeList& modified = algo.Modified(face);
    if (modified.IsEmpty()) {
      assign(result.faces.FindIndex(face), name);
    } else {
      for (const TopoDS_Shape& m : modified) assign(result.faces.FindIndex(m), name);
    }
  }
}

// Boolean of named inputs. Faces of `objects` keep their names; faces of `tools` keep theirs
// (mapped through `toolRename`, e.g. to F…:face(<name>)) where no object face claimed them.
//
// `manyTools` (M3 patterns and holes): tools are known-good solids (no inverted-solid check) and
// the threaded build runs the General Fuse in parallel.
//
// Same-domain faces the operation leaves side by side (a tool face flush with a body face, pieces
// of one face) are merged, and absorbed names stay as aliases (whittle_unify.cpp, ADR-076).
NamedShape booleanNamed(BOPAlgo_Operation op, const std::vector<NamedInput>& objects,
                        const std::vector<NamedInput>& tools,
                        const std::function<std::string(const std::string&)>& toolRename,
                        const std::string& fallback, bool manyTools = false) {
  ShapeList args;
  ShapeList toolList;
  for (const NamedInput& o : objects) args.Append(o.shape);
  for (const NamedInput& t : tools) toolList.Append(t.shape);
  BRepAlgoAPI_BooleanOperation bop;
  bop.SetOperation(op);
  bop.SetArguments(args);
  bop.SetTools(toolList);
#if defined(__EMSCRIPTEN_PTHREADS__)
  bop.SetRunParallel(manyTools);
#else
  bop.SetRunParallel(false);
#endif
  if (manyTools) bop.SetCheckInverted(false);
  bop.Build();
  if (bop.HasErrors() || !bop.IsDone()) {
    std::ostringstream diag;
    bop.DumpErrors(diag);
    raiseError("OPERATION_FAILED", "The boolean operation failed",
               "Check that the bodies overlap cleanly (no coincident faces at tiny offsets).",
               diag.str());
  }
  const TopoDS_Shape result = bop.Shape();
  const Topo rt(result);
  std::vector<std::string> names(static_cast<size_t>(rt.faces.Extent()));
  std::vector<int> origin(static_cast<size_t>(rt.faces.Extent()), kOriginTool);
  for (size_t i = 0; i < objects.size(); ++i) {
    carryFaceNames(bop, objects[i], rt, names, false, nullptr, &origin, static_cast<int>(i));
  }
  for (const NamedInput& t : tools) carryFaceNames(bop, t, rt, names, true, toolRename);
  return unifyBooleanResult(result, std::move(names), origin, fallback);
}

const char* opLabel(BOPAlgo_Operation op) {
  switch (op) {
    case BOPAlgo_FUSE: return "add";
    case BOPAlgo_CUT: return "cut";
    case BOPAlgo_COMMON: return "intersect";
    default: return "boolean";
  }
}

// Bodies an add/cut/intersect acts on: inputs.target, then inputs.shapes["scope…"] in key order.
std::vector<std::pair<std::string, std::shared_ptr<const ShapeRecord>>> collectBodies(
    const Json& inputs) {
  std::vector<std::pair<std::string, std::shared_ptr<const ShapeRecord>>> bodies;
  const int target = optHandle(inputs, "target");
  if (target != 0) bodies.emplace_back("target", requireShape(target));
  const Json* shapes = inputsObject(inputs, "shapes");
  if (shapes != nullptr) {
    std::vector<std::pair<std::string, int>> scoped;
    for (const auto& entry : shapes->object) {
      if (entry.first.compare(0, 5, "scope") != 0) continue;
      if (!entry.second->isNumber()) {
        raiseError("INVALID_INPUT", "inputs.shapes[\"" + entry.first + "\"] must be a shape handle");
      }
      scoped.emplace_back(entry.first, static_cast<int>(entry.second->number));
    }
    std::sort(scoped.begin(), scoped.end());
    for (const auto& s : scoped) {
      if (s.second == target) continue;
      bodies.emplace_back(s.first, requireShape(s.second));
    }
  }
  return bodies;
}

std::string featureResultJson(ShapeHandle handle, const NamedShape& ns,
                              const std::vector<KernelError>& warnings,
                              const std::string& extraFields = std::string()) {
  return okJson("{\"shape\":" + std::to_string(handle) + ",\"naming\":" +
                namingJson(namingEntries(ns)) + ",\"warnings\":" + warningsJson(warnings) +
                extraFields + "}");
}

std::string storeResult(const NamedShape& ns, const std::vector<KernelError>& warnings,
                        const std::string& extraFields = std::string()) {
  HandleGuard guard;
  guard.handle = storeNamed(ns);
  std::string json = featureResultJson(guard.handle, ns, warnings, extraFields);
  guard.release();
  return json;
}

KernelError warning(const char* code, std::string message, std::string hint = {}) {
  KernelError w;
  w.code = code;
  w.message = std::move(message);
  w.hint = std::move(hint);
  return w;
}

// Applies a feature's body op with the named tool solid it built (extrude, revolve, primitive).
std::string applyBodyOp(const NamedShape& tool, const std::string& op, const Json& inputs,
                        const std::string& tag, std::vector<KernelError> warnings,
                        const std::string& extraFields = std::string()) {
  if (op == "new" || op.empty()) return storeResult(tool, warnings, extraFields);
  BOPAlgo_Operation bopOp;
  if (op == "add") {
    bopOp = BOPAlgo_FUSE;
  } else if (op == "cut") {
    bopOp = BOPAlgo_CUT;
  } else if (op == "intersect") {
    bopOp = BOPAlgo_COMMON;
  } else {
    raiseError("INVALID_INPUT", "Unknown body operation '" + op + "'",
               "Use new, add, cut or intersect.");
  }
  const auto bodies = collectBodies(inputs);
  if (bodies.empty()) {
    raiseError("INVALID_INPUT", std::string("There is no body to ") + opLabel(bopOp),
               "Create a body first, or set the operation to New.");
  }
  const std::string fallback = "F" + tag + ":unnamed";
  const NamedInput toolInput = namedInputOf(tool);
  if (bopOp == BOPAlgo_FUSE) {
    std::vector<NamedInput> objects;
    for (const auto& b : bodies) objects.push_back(namedInputOf(*b.second));
    NamedShape result = booleanNamed(bopOp, objects, {toolInput}, nullptr, fallback);
    const int solids = countSolids(result.shape);
    if (solids > 1) {
      warnings.push_back(warning("OPERATION_FAILED",
                                 "The new material does not touch the body; the result has " +
                                     std::to_string(solids) + " separate solids",
                                 "Move the sketch onto the body, or use New."));
    }
    return storeResult(result, warnings, extraFields);
  }

  std::vector<NamedShape> results;
  for (const auto& b : bodies) {
    const double before = solidVolume(b.second->shape);
    NamedShape r = booleanNamed(bopOp, {namedInputOf(*b.second)}, {toolInput}, nullptr, fallback);
    const double after = solidVolume(r.shape);
    if (bopOp == BOPAlgo_CUT && std::fabs(after - before) <= 1e-9 * std::max(1.0, std::fabs(before))) {
      warnings.push_back(warning("OPERATION_FAILED", "The cut does not touch the body",
                                 "Move the sketch, or extend the cut depth."));
    }
    if (bopOp == BOPAlgo_COMMON && Topo(r.shape).faces.Extent() == 0) {
      raiseError("OPERATION_FAILED", "The intersection is empty",
                 "The new solid and the body do not overlap.");
    }
    if (bopOp == BOPAlgo_CUT && Topo(r.shape).faces.Extent() == 0) {
      warnings.push_back(warning("OPERATION_FAILED", "The cut removes the whole body"));
    }
    results.push_back(std::move(r));
  }
  // First body → `shape`; further scope bodies → `bodies`.
  std::vector<HandleGuard> guards(results.size());
  for (size_t i = 0; i < results.size(); ++i) guards[i].handle = storeNamed(results[i]);
  std::string extra = extraFields;
  if (results.size() > 1) {
    extra += ",\"bodies\":[";
    for (size_t i = 1; i < results.size(); ++i) {
      if (i > 1) extra.push_back(',');
      extra += "{\"key\":" + jsonString(bodies[i].first) + ",\"shape\":" +
               std::to_string(guards[i].handle) + ",\"naming\":" +
               namingJson(namingEntries(results[i])) + "}";
    }
    extra += "]";
  }
  std::string json = featureResultJson(guards[0].handle, results[0], warnings, extra);
  for (HandleGuard& g : guards) g.release();
  return json;
}

// ---------------------------------------------------------------------------------------------
// Primitives (box, cylinder, sphere)
// ---------------------------------------------------------------------------------------------

// Box naming (contracts naming.ts, primitive roles). Roles are derived from geometry in the box's
// local frame, so they are independent of OCCT's internal face order.
NamedShape nameBox(const TopoDS_Shape& shape, const gp_Ax2& frame, double dx, double dy, double dz,
                   const std::string& tag) {
  gp_Trsf toLocal;
  toLocal.SetTransformation(gp_Ax3(frame));  // world -> local
  const double extent[3] = {dx, dy, dz};
  const char* axisName[3] = {"x", "y", "z"};
  const Topo topo(shape);

  NamedShape ns;
  ns.shape = shape;
  std::vector<std::string> faceRoles(static_cast<size_t>(topo.faces.Extent()));
  for (int i = 1; i <= topo.faces.Extent(); ++i) {
    const gp_Pnt c = faceCentroid(TopoDS::Face(topo.faces(i))).Transformed(toLocal);
    const double coord[3] = {c.X(), c.Y(), c.Z()};
    // The constant coordinate of a box face is the one sitting at 0 or at its extent; face
    // centroids sit at exactly half extent on the two free axes.
    int bestAxis = 0;
    double bestDistance = 1e300;
    bool atMax = false;
    for (int a = 0; a < 3; ++a) {
      const double toMin = std::fabs(coord[a]);
      const double toMax = std::fabs(coord[a] - extent[a]);
      const double d = std::min(toMin, toMax);
      if (d < bestDistance) {
        bestDistance = d;
        bestAxis = a;
        atMax = toMax < toMin;
      }
    }
    faceRoles[static_cast<size_t>(i - 1)] =
        std::string("face.") + axisName[bestAxis] + (atMax ? "max" : "min");
  }

  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  std::vector<std::string> edgeRoles(static_cast<size_t>(topo.edges.Extent()));
  for (int i = 1; i <= topo.edges.Extent(); ++i) {
    std::vector<std::string> adjacent;
    const ShapeList* ancestors = edgeFaces.Seek(topo.edges(i));
    if (ancestors != nullptr) {
      for (const TopoDS_Shape& f : *ancestors) {
        const int fi = topo.faces.FindIndex(f);
        if (fi > 0) adjacent.push_back(faceRoles[static_cast<size_t>(fi - 1)]);
      }
    }
    std::sort(adjacent.begin(), adjacent.end());
    adjacent.erase(std::unique(adjacent.begin(), adjacent.end()), adjacent.end());
    if (adjacent.size() == 2) {
      edgeRoles[static_cast<size_t>(i - 1)] = "edge(" + adjacent[0] + "|" + adjacent[1] + ")";
    }
  }

  std::vector<std::string> vertexRoles(static_cast<size_t>(topo.vertices.Extent()));
  for (int i = 1; i <= topo.vertices.Extent(); ++i) {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(topo.vertices(i))).Transformed(toLocal);
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
  auto prefixed = [&](const std::vector<std::string>& roles) {
    std::vector<std::string> out;
    for (const std::string& r : roles) out.push_back(r.empty() ? std::string() : prefix + r);
    return out;
  };
  ns.faces = prefixed(faceRoles);
  ns.edges = prefixed(edgeRoles);
  ns.vertices = prefixed(vertexRoles);
  return ns;
}

// Generic primitive naming: local face roles, edges/vertices derived from them, then prefixed.
NamedShape namePrimitive(const TopoDS_Shape& shape, std::vector<std::string> faceRoles,
                         const std::string& tag) {
  NamedShape local;
  local.shape = shape;
  local.faces = std::move(faceRoles);
  const Topo topo(shape);
  deriveEdgeAndVertexNames(local, topo);
  const std::string prefix = "F" + tag + ":";
  for (auto* names : {&local.faces, &local.edges, &local.vertices}) {
    for (std::string& n : *names) {
      if (!n.empty()) n = prefix + n;
    }
  }
  return local;
}

void requirePositive(double value, const char* what, const char* field) {
  if (!(value > 1e-6)) {
    raiseError("INVALID_INPUT",
               std::string(what) + " must be greater than zero (got " + jsonNumber(value) + " mm)",
               std::string("Enter a positive value for ") + field + ".");
  }
}

NamedShape makeBox(const Json& feature, const Json& values, const std::string& tag) {
  const double dx = requireValue(values, "/dx", "box width (dx)");
  const double dy = requireValue(values, "/dy", "box depth (dy)");
  const double dz = requireValue(values, "/dz", "box height (dz)");
  requirePositive(dx, "Box dx", "dx");
  requirePositive(dy, "Box dy", "dy");
  requirePositive(dz, "Box dz", "dz");
  const gp_Ax2 frame = parseFrame(feature.get("frame"));
  BRepPrimAPI_MakeBox maker(frame, dx, dy, dz);
  maker.Build();
  if (!maker.IsDone()) raiseError("OPERATION_FAILED", "Box construction failed");
  const TopoDS_Shape shape = maker.Shape();
  if (shape.IsNull()) raiseError("OPERATION_FAILED", "Box construction produced an empty shape");
  return nameBox(shape, frame, dx, dy, dz, tag);
}

// Cylinder: axis = frame Z from the frame origin, height along +Z.
// Roles: face.side, face.zmin, face.zmax (edges/vertices derived, e.g. edge(face.side|face.zmax)).
NamedShape makeCylinder(const Json& feature, const Json& values, const std::string& tag) {
  const double r = requireValue(values, "/radius", "cylinder radius");
  const double h = requireValue(values, "/height", "cylinder height");
  requirePositive(r, "Cylinder radius", "radius");
  requirePositive(h, "Cylinder height", "height");
  const gp_Ax2 frame = parseFrame(feature.get("frame"));
  BRepPrimAPI_MakeCylinder maker(frame, r, h);
  maker.Build();
  if (!maker.IsDone()) raiseError("OPERATION_FAILED", "Cylinder construction failed");
  const TopoDS_Shape shape = maker.Shape();
  gp_Trsf toLocal;
  toLocal.SetTransformation(gp_Ax3(frame));
  const Topo topo(shape);
  std::vector<std::string> roles(static_cast<size_t>(topo.faces.Extent()));
  for (int i = 1; i <= topo.faces.Extent(); ++i) {
    const TopoDS_Face& f = TopoDS::Face(topo.faces(i));
    BRepAdaptor_Surface s(f, false);
    if (s.GetType() == GeomAbs_Plane) {
      const gp_Pnt c = faceCentroid(f).Transformed(toLocal);
      roles[static_cast<size_t>(i - 1)] = c.Z() > h / 2 ? "face.zmax" : "face.zmin";
    } else {
      roles[static_cast<size_t>(i - 1)] = "face.side";
    }
  }
  return namePrimitive(shape, roles, tag);
}

// Sphere centred on the frame origin. Roles: face.sphere; the seam reads
// edge(face.sphere|face.sphere), the two degenerate pole edges edge(face.sphere)#0/#1 and the
// pole vertices vertex(face.sphere)#0/#1 (#0 = −Z pole in world order, see split rule).
NamedShape makeSphere(const Json& feature, const Json& values, const std::string& tag) {
  const double r = requireValue(values, "/radius", "sphere radius");
  requirePositive(r, "Sphere radius", "radius");
  const gp_Ax2 frame = parseFrame(feature.get("frame"));
  BRepPrimAPI_MakeSphere maker(frame, r);
  maker.Build();
  if (!maker.IsDone()) raiseError("OPERATION_FAILED", "Sphere construction failed");
  const TopoDS_Shape shape = maker.Shape();
  const Topo topo(shape);
  std::vector<std::string> roles(static_cast<size_t>(topo.faces.Extent()), "face.sphere");
  return namePrimitive(shape, roles, tag);
}

std::string execPrimitive(const Json& feature, const Json& inputs, const std::string& tag) {
  const std::string shapeKind = requireString(feature, "shape", "primitive feature");
  const std::string op = optString(feature, "op", "new");
  const Json* values = inputs.get("values");
  if (values == nullptr || !values->isObject()) {
    raiseError("INVALID_INPUT", "inputs.values must be an object of resolved numbers");
  }
  NamedShape tool;
  if (shapeKind == "box") {
    tool = makeBox(feature, *values, tag);
  } else if (shapeKind == "cylinder") {
    tool = makeCylinder(feature, *values, tag);
  } else if (shapeKind == "sphere") {
    tool = makeSphere(feature, *values, tag);
  } else {
    raiseError("UNSUPPORTED_FEATURE", "Primitive shape '" + shapeKind + "' is not supported",
               "Use box, cylinder or sphere.");
  }
  return applyBodyOp(tool, op, inputs, tag, {});
}

// ---------------------------------------------------------------------------------------------
// Sketch: solved entities → edges, points and regions (planar faces)
//
// Regions are the bounded faces of the planar arrangement of all non-construction curves
// ("minimal regions", as in Onshape/Fusion): curves are intersected and split with the General
// Fuse algorithm (BRepAlgoAPI_BuilderAlgo, fuzzy 1e-6 mm, which also merges coincident end
// points of different entities), then every split edge is passed in both orientations to
// BOPAlgo_BuilderFace on the sketch plane (the recipe of BOPAlgo_Tools::WiresToFaces). Each
// bounded area becomes a face; loops nested inside it become its holes, and the nested loop is a
// region of its own. Dangling and open curves bound nothing and are dropped
// (SetAvoidInternalShapes).
// ---------------------------------------------------------------------------------------------

struct SketchPointDef {
  double u = 0;
  double v = 0;
  bool construction = false;
};

// OCCT's knot form: distinct, strictly increasing knots and their multiplicities.
struct KnotVector {
  std::vector<double> knots;
  std::vector<int> mults;
};

// Contract default for a clamped (non-periodic) spline of `nPoles` poles (ADR-pending, sketch
// curves): multiplicity degree + 1 at both ends, interior knots uniform in [0, 1] with
// multiplicity 1, i.e. knots i / (nPoles - degree), i = 0 … nPoles - degree.
KnotVector uniformClampedKnots(int nPoles, int degree) {
  const int spans = nPoles - degree;
  KnotVector kv;
  for (int i = 0; i <= spans; ++i) {
    kv.knots.push_back(static_cast<double>(i) / spans);
    kv.mults.push_back(i == 0 || i == spans ? degree + 1 : 1);
  }
  return kv;
}

// Contract default for a periodic spline: nPoles + 1 knots i / nPoles (period 1), multiplicity 1.
KnotVector uniformPeriodicKnots(int nPoles) {
  KnotVector kv;
  for (int i = 0; i <= nPoles; ++i) {
    kv.knots.push_back(static_cast<double>(i) / nPoles);
    kv.mults.push_back(1);
  }
  return kv;
}

// The B-spline of a sketch `bspline` entity (SketchBSpline). Validates everything OCCT would
// reject (and the contract's "clamped unless periodic") first, so bad input is INVALID_INPUT
// naming the entity rather than an OCCT exception.
occ::handle<Geom_BSplineCurve> sketchBSplineCurve(const Json& e, const std::string& id,
                                                  const std::vector<gp_Pnt>& poles,
                                                  const std::string& ref) {
  auto bad = [&](const std::string& message, const std::string& hint = {}) {
    raiseError("INVALID_INPUT", "Spline " + id + " " + message, hint, {}, {ref});
  };
  const int maxDegree = Geom_BSplineCurve::MaxDegree();
  const Json* degJ = e.get("degree");
  if (degJ == nullptr || !degJ->isNumber() || degJ->number != std::floor(degJ->number) ||
      degJ->number < 1 || degJ->number > maxDegree) {
    bad("needs an integer degree from 1 to " + std::to_string(maxDegree), "Splines are usually degree 3.");
  }
  const int degree = static_cast<int>(degJ->number);
  const Json* perJ = e.get("periodic");
  if (perJ != nullptr && perJ->kind != Json::Kind::Bool) bad("periodic must be true or false");
  const bool periodic = perJ != nullptr && perJ->boolean;
  const int n = static_cast<int>(poles.size());
  if (n < degree + 1) {
    bad("needs at least degree + 1 = " + std::to_string(degree + 1) + " control points (has " +
            std::to_string(n) + ")",
        "Add control points or lower the degree.");
  }
  double extent = 0;
  for (const gp_Pnt& p : poles) extent = std::max(extent, p.Distance(poles.front()));
  if (!(extent > 1e-6)) bad("has zero length", "Drag its control points apart.");

  std::vector<double> weights;
  const Json* wJ = e.get("weights");
  if (wJ != nullptr && wJ->kind != Json::Kind::Null) {
    if (!wJ->isArray() || static_cast<int>(wJ->array.size()) != n) {
      bad("needs one weight per control point (" + std::to_string(n) + ")");
    }
    for (const JsonPtr& w : wJ->array) {
      if (!w->isNumber() || !std::isfinite(w->number) || !(w->number > 0)) {
        bad("has a weight that is not a positive number", "Weights must be greater than zero.");
      }
      weights.push_back(w->number);
    }
  }

  KnotVector kv;
  const Json* kJ = e.get("knots");
  const Json* mJ = e.get("multiplicities");
  const bool hasK = kJ != nullptr && kJ->kind != Json::Kind::Null;
  const bool hasM = mJ != nullptr && mJ->kind != Json::Kind::Null;
  // ADR-048: an open spline's `knots` without `multiplicities` is a flat (expanded) knot vector
  // when it has n + degree + 1 entries; equal neighbours collapse into one knot (exact equality,
  // as the regen engine reads it). Anything else without the pair is refused.
  const bool flatKnots = hasK && !hasM && !periodic && kJ->isArray() &&
                         static_cast<int>(kJ->array.size()) == n + degree + 1;
  if (hasK != hasM && !flatKnots) {
    bad("needs knots and multiplicities together (or neither, for uniform knots)",
        "An open spline may also give a flat knot vector of control points + degree + 1 values.");
  }
  if (!hasK) {
    kv = periodic ? uniformPeriodicKnots(n) : uniformClampedKnots(n, degree);
  } else if (flatKnots) {
    for (const JsonPtr& k : kJ->array) {
      if (!k->isNumber() || !std::isfinite(k->number)) bad("has a knot that is not a finite number");
      if (!kv.knots.empty() && k->number == kv.knots.back()) {
        ++kv.mults.back();
        continue;
      }
      if (!kv.knots.empty() && !(k->number - kv.knots.back() > 1e-12 * std::max(1.0, std::fabs(k->number)))) {
        bad("needs non-decreasing knots");
      }
      kv.knots.push_back(k->number);
      kv.mults.push_back(1);
    }
    if (kv.knots.size() < 2) bad("needs at least two distinct knots");
    for (size_t i = 1; i + 1 < kv.mults.size(); ++i) {
      if (kv.mults[i] > degree) bad("has an interior knot with multiplicity above the degree");
    }
    if (kv.mults.front() != degree + 1 || kv.mults.back() != degree + 1) {
      bad("is not clamped: its first and last knots need multiplicity degree + 1 = " +
          std::to_string(degree + 1));
    }
  } else {
    if (!kJ->isArray() || !mJ->isArray() || kJ->array.size() != mJ->array.size() || kJ->array.size() < 2) {
      bad("needs knots and multiplicities of the same length (at least 2)");
    }
    for (size_t i = 0; i < kJ->array.size(); ++i) {
      const Json& k = *kJ->array[i];
      const Json& m = *mJ->array[i];
      if (!k.isNumber() || !std::isfinite(k.number)) bad("has a knot that is not a finite number");
      if (!m.isNumber() || m.number != std::floor(m.number) || m.number < 1 || m.number > degree + 1) {
        bad("has a multiplicity that is not an integer from 1 to degree + 1");
      }
      if (i > 0 && !(k.number - kv.knots.back() > 1e-12 * std::max(1.0, std::fabs(k.number)))) {
        bad("needs strictly increasing knots", "Repeat a knot with its multiplicity instead.");
      }
      kv.knots.push_back(k.number);
      kv.mults.push_back(static_cast<int>(m.number));
    }
    const size_t last = kv.mults.size() - 1;
    for (size_t i = 1; i < last; ++i) {
      if (kv.mults[i] > degree) bad("has an interior knot with multiplicity above the degree");
    }
    int sum = 0;
    for (int m : kv.mults) sum += m;
    if (periodic) {
      if (kv.mults[0] != kv.mults[last] || kv.mults[0] > degree) {
        bad("is periodic: its first and last knots need the same multiplicity, at most the degree");
      }
      if (sum - kv.mults[last] != n) {
        bad("has a knot vector of the wrong length: a periodic spline with " + std::to_string(n) +
            " control points needs multiplicities summing to " + std::to_string(n) +
            " without the last knot (has " + std::to_string(sum - kv.mults[last]) + ")");
      }
    } else {
      if (kv.mults[0] != degree + 1 || kv.mults[last] != degree + 1) {
        bad("is not clamped: its first and last knots need multiplicity degree + 1 = " +
            std::to_string(degree + 1));
      }
      if (sum != n + degree + 1) {
        bad("has a knot vector of the wrong length: " + std::to_string(n) + " control points of degree " +
            std::to_string(degree) + " need " + std::to_string(n + degree + 1) +
            " knots counting multiplicity (has " + std::to_string(sum) + ")");
      }
    }
  }

  NCollection_Array1<gp_Pnt> P(1, n);
  for (int i = 0; i < n; ++i) P(i + 1) = poles[static_cast<size_t>(i)];
  const int nk = static_cast<int>(kv.knots.size());
  NCollection_Array1<double> K(1, nk);
  NCollection_Array1<int> M(1, nk);
  for (int i = 0; i < nk; ++i) {
    K(i + 1) = kv.knots[static_cast<size_t>(i)];
    M(i + 1) = kv.mults[static_cast<size_t>(i)];
  }
  try {
    if (weights.empty()) return new Geom_BSplineCurve(P, K, M, degree, periodic);
    NCollection_Array1<double> W(1, n);
    for (int i = 0; i < n; ++i) W(i + 1) = weights[static_cast<size_t>(i)];
    return new Geom_BSplineCurve(P, W, K, M, degree, periodic);
  } catch (const Standard_Failure& f) {
    const char* what = f.what();
    bad(std::string("is not a valid B-spline: ") + (what != nullptr ? what : "OCCT refused it"));
  }
  return {};
}

// Lets a sketch vertex sit on its curve end: the solver keeps points on their curves to its own
// tolerance (≤ 1e-6 mm, checked by the caller), BRepLib_MakeEdge wants them within the vertex
// tolerance (1e-7 mm by default).
void fitVertexToCurve(const TopoDS_Vertex& v, const gp_Pnt& onCurve) {
  const double d = BRep_Tool::Pnt(v).Distance(onCurve);
  if (d > BRep_Tool::Tolerance(v)) BRep_Builder().UpdateVertex(v, 1.01 * d);
}

std::string execSketch(const Json& feature, const Json& inputs, const std::string& id) {
  const Json* planeFrame = frameInput(inputs, "plane");
  const gp_Ax3 frame(parseFrame(planeFrame));
  const gp_Pnt origin = frame.Location();
  const gp_Dir xDir = frame.XDirection();
  const gp_Dir yDir = frame.YDirection();
  const gp_Dir zDir = frame.Direction();
  auto to3d = [&](double u, double v) {
    return gp_Pnt(origin.XYZ() + u * xDir.XYZ() + v * yDir.XYZ());
  };
  const std::string tag = "S" + id;

  const Json* entities = feature.get("entities");
  if (entities == nullptr || !entities->isArray()) {
    raiseError("INVALID_INPUT", "sketch.entities must be an array");
  }

  std::map<std::string, SketchPointDef> points;
  std::vector<std::string> pointOrder;
  for (const JsonPtr& e : entities->array) {
    if (!e->isObject()) raiseError("INVALID_INPUT", "sketch entities must be objects");
    if (optString(*e, "kind", "") != "point") continue;
    const std::string pid = requireString(*e, "id", "sketch point");
    const Json* x = e->get("x");
    const Json* y = e->get("y");
    if (x == nullptr || y == nullptr || !x->isNumber() || !y->isNumber() ||
        !std::isfinite(x->number) || !std::isfinite(y->number)) {
      raiseError("INVALID_INPUT", "Sketch point " + pid + " needs finite x and y (mm)");
    }
    const Json* c = e->get("construction");
    points[pid] = SketchPointDef{x->number, y->number, c != nullptr && c->boolean};
    pointOrder.push_back(pid);
  }
  auto pointById = [&](const Json& e, const std::string& ref) -> const SketchPointDef& {
    auto it = points.find(ref);
    if (it == points.end()) {
      raiseError("INVALID_INPUT", "Sketch entity " + optString(e, "id", "?") + " refers to unknown point " + ref);
    }
    return it->second;
  };
  auto pointOf = [&](const Json& e, const char* key) -> const SketchPointDef& {
    return pointById(e, requireString(e, key, "sketch entity"));
  };
  std::map<std::string, TopoDS_Vertex> vertexOf;
  auto vertexById = [&](const Json& e, const std::string& ref) {
    auto found = vertexOf.find(ref);
    if (found != vertexOf.end()) return found->second;
    const SketchPointDef& p = pointById(e, ref);
    TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(to3d(p.u, p.v)).Vertex();
    vertexOf[ref] = v;
    return v;
  };
  auto vertexFor = [&](const Json& e, const char* key) {
    return vertexById(e, requireString(e, key, "sketch entity"));
  };

  struct Curve {
    std::string id;
    bool construction = false;
    TopoDS_Edge edge;
  };
  std::vector<Curve> curves;
  for (const JsonPtr& ep : entities->array) {
    const Json& e = *ep;
    const std::string kind = optString(e, "kind", "");
    if (kind == "point") continue;
    Curve c;
    c.id = requireString(e, "id", "sketch entity");
    const Json* cons = e.get("construction");
    c.construction = cons != nullptr && cons->boolean;
    if (kind == "line") {
      const SketchPointDef& a = pointOf(e, "start");
      const SketchPointDef& b = pointOf(e, "end");
      if (std::hypot(b.u - a.u, b.v - a.v) < 1e-6) {
        raiseError("INVALID_INPUT", "Line " + c.id + " has zero length",
                   "Delete it or drag its end points apart.", {}, {tag + ":e(" + c.id + ")"});
      }
      BRepBuilderAPI_MakeEdge mk(vertexFor(e, "start"), vertexFor(e, "end"));
      if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build line " + c.id);
      c.edge = mk.Edge();
    } else if (kind == "circle") {
      const SketchPointDef& ctr = pointOf(e, "center");
      const Json* r = e.get("radius");
      if (r == nullptr || !r->isNumber() || !(r->number > 1e-6) || !std::isfinite(r->number)) {
        raiseError("INVALID_INPUT", "Circle " + c.id + " needs a positive radius",
                   "Enter a radius greater than zero.", {}, {tag + ":e(" + c.id + ")"});
      }
      gp_Circ circ(gp_Ax2(to3d(ctr.u, ctr.v), zDir, xDir), r->number);
      BRepBuilderAPI_MakeEdge mk(circ);
      if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build circle " + c.id);
      c.edge = mk.Edge();
    } else if (kind == "arc") {
      const SketchPointDef& ctr = pointOf(e, "center");
      const SketchPointDef& s = pointOf(e, "start");
      const SketchPointDef& t = pointOf(e, "end");
      const double r = std::hypot(s.u - ctr.u, s.v - ctr.v);
      const double r2 = std::hypot(t.u - ctr.u, t.v - ctr.v);
      if (!(r > 1e-6)) {
        raiseError("INVALID_INPUT", "Arc " + c.id + " has zero radius", {}, {},
                   {tag + ":e(" + c.id + ")"});
      }
      if (std::fabs(r - r2) > 1e-6 * std::max(1.0, r)) {
        raiseError("INVALID_INPUT", "Arc " + c.id + " end point is not on its circle",
                   "Solve the sketch before building it.", {}, {tag + ":e(" + c.id + ")"});
      }
      double a1 = std::atan2(s.v - ctr.v, s.u - ctr.u);
      double a2 = std::atan2(t.v - ctr.v, t.u - ctr.u);
      while (a2 <= a1 + 1e-12) a2 += 2 * kPi;
      if (a2 - a1 < 1e-9 || std::hypot(t.u - s.u, t.v - s.v) < 1e-9) {
        raiseError("INVALID_INPUT", "Arc " + c.id + " has no sweep", "Use a circle instead.", {},
                   {tag + ":e(" + c.id + ")"});
      }
      occ::handle<Geom_Circle> circle =
          new Geom_Circle(gp_Ax2(to3d(ctr.u, ctr.v), zDir, xDir), r);
      const TopoDS_Vertex vs = vertexFor(e, "start");
      const TopoDS_Vertex ve = vertexFor(e, "end");
      fitVertexToCurve(ve, circle->Value(a2));
      BRepBuilderAPI_MakeEdge mk(circle, vs, ve, a1, a2);
      if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build arc " + c.id);
      c.edge = mk.Edge();
    } else if (kind == "ellipse") {
      const SketchPointDef& ctr = pointOf(e, "center");
      const Json* maj = e.get("majorRadius");
      const Json* min = e.get("minorRadius");
      const Json* rot = e.get("rotation");
      if (maj == nullptr || min == nullptr || !maj->isNumber() || !min->isNumber() ||
          !(maj->number > 1e-6) || !(min->number > 1e-6)) {
        raiseError("INVALID_INPUT", "Ellipse " + c.id + " needs positive radii", {}, {},
                   {tag + ":e(" + c.id + ")"});
      }
      double major = maj->number;
      double minor = min->number;
      double angle = rot != nullptr && rot->isNumber() ? rot->number : 0.0;
      if (minor > major) {
        std::swap(major, minor);
        angle += kPi / 2;
      }
      const gp_Dir axisX(std::cos(angle) * xDir.XYZ() + std::sin(angle) * yDir.XYZ());
      gp_Elips el(gp_Ax2(to3d(ctr.u, ctr.v), zDir, axisX), major, minor);
      BRepBuilderAPI_MakeEdge mk(el);
      if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build ellipse " + c.id);
      c.edge = mk.Edge();
    } else if (kind == "ellipticArc") {
      // M3.5: counter-clockwise from start to end; major axis at `rotation` (as the ellipse).
      const std::string ref = tag + ":e(" + c.id + ")";
      const SketchPointDef& ctr = pointOf(e, "center");
      const SketchPointDef& s = pointOf(e, "start");
      const SketchPointDef& t = pointOf(e, "end");
      const Json* maj = e.get("majorRadius");
      const Json* min = e.get("minorRadius");
      const Json* rot = e.get("rotation");
      if (maj == nullptr || min == nullptr || !maj->isNumber() || !min->isNumber() ||
          !std::isfinite(maj->number) || !std::isfinite(min->number) || !(maj->number > 1e-6) ||
          !(min->number > 1e-6)) {
        raiseError("INVALID_INPUT", "Elliptic arc " + c.id + " needs positive radii", {}, {}, {ref});
      }
      if (rot != nullptr && (!rot->isNumber() || !std::isfinite(rot->number))) {
        raiseError("INVALID_INPUT", "Elliptic arc " + c.id + " needs a finite rotation (rad)", {}, {}, {ref});
      }
      double major = maj->number;
      double minor = min->number;
      double angle = rot != nullptr ? rot->number : 0.0;
      if (minor > major) {
        std::swap(major, minor);
        angle += kPi / 2;
      }
      const gp_Dir axisX(std::cos(angle) * xDir.XYZ() + std::sin(angle) * yDir.XYZ());
      const gp_Elips el(gp_Ax2(to3d(ctr.u, ctr.v), zDir, axisX), major, minor);
      const gp_Pnt ps = to3d(s.u, s.v);
      const gp_Pnt pt = to3d(t.u, t.v);
      const double onTol = 1e-6 * std::max(1.0, major);
      for (const gp_Pnt& q : {ps, pt}) {
        if (ElCLib::Value(ElCLib::Parameter(el, q), el).Distance(q) > onTol) {
          raiseError("INVALID_INPUT", "Elliptic arc " + c.id + " end point is not on its ellipse",
                     "Solve the sketch before building it.", {}, {ref});
        }
      }
      if (ps.Distance(pt) < 1e-9) {
        raiseError("INVALID_INPUT", "Elliptic arc " + c.id + " has no sweep", "Use an ellipse instead.", {},
                   {ref});
      }
      GC_MakeArcOfEllipse arc(el, ps, pt, true);
      if (!arc.IsDone()) raiseError("OPERATION_FAILED", "Could not build elliptic arc " + c.id, {}, {}, {ref});
      const occ::handle<Geom_TrimmedCurve>& trimmed = arc.Value();
      const double p1 = trimmed->FirstParameter();
      const double p2 = trimmed->LastParameter();
      const TopoDS_Vertex vs = vertexFor(e, "start");
      const TopoDS_Vertex ve = vertexFor(e, "end");
      fitVertexToCurve(vs, trimmed->Value(p1));
      fitVertexToCurve(ve, trimmed->Value(p2));
      BRepBuilderAPI_MakeEdge mk(trimmed->BasisCurve(), vs, ve, p1, p2);
      if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build elliptic arc " + c.id, {}, {}, {ref});
      c.edge = mk.Edge();
    } else if (kind == "bspline") {
      // M3.5: exact B-spline from the pole points; clamped ends share the end poles' vertices.
      const std::string ref = tag + ":e(" + c.id + ")";
      const Json* polesJ = e.get("poles");
      if (polesJ == nullptr || !polesJ->isArray()) {
        raiseError("INVALID_INPUT", "Spline " + c.id + " needs a poles array of point ids", {}, {}, {ref});
      }
      std::vector<std::string> poleIds;
      std::vector<gp_Pnt> poles;
      for (const JsonPtr& pj : polesJ->array) {
        if (!pj->isString()) {
          raiseError("INVALID_INPUT", "Spline " + c.id + " poles must be point ids", {}, {}, {ref});
        }
        const SketchPointDef& p = pointById(e, pj->string);
        poleIds.push_back(pj->string);
        poles.push_back(to3d(p.u, p.v));
      }
      const occ::handle<Geom_BSplineCurve> curve = sketchBSplineCurve(e, c.id, poles, ref);
      if (curve->IsPeriodic()) {
        BRepBuilderAPI_MakeEdge mk(curve);
        if (!mk.IsDone()) raiseError("OPERATION_FAILED", "Could not build spline " + c.id, {}, {}, {ref});
        c.edge = mk.Edge();
      } else {
        const double u0 = curve->FirstParameter();
        const double u1 = curve->LastParameter();
        const TopoDS_Vertex v0 = vertexById(e, poleIds.front());
        // A spline closed on itself (same end pole, or coincident end poles) has one vertex.
        const bool closed = poleIds.back() == poleIds.front() ||
                            poles.back().Distance(poles.front()) <= Precision::Confusion();
        const TopoDS_Vertex v1 = closed ? v0 : vertexById(e, poleIds.back());
        fitVertexToCurve(v0, curve->Value(u0));
        fitVertexToCurve(v1, curve->Value(u1));
        BRepBuilderAPI_MakeEdge mk(curve, v0, v1, u0, u1);
        if (!mk.IsDone()) {
          raiseError("OPERATION_FAILED", "Could not build spline " + c.id,
                     "Check that its control points are not all on top of each other.", {}, {ref});
        }
        c.edge = mk.Edge();
      }
    } else {
      raiseError("UNSUPPORTED_FEATURE", "Sketch entity kind '" + kind + "' is not supported");
    }
    curves.push_back(std::move(c));
  }

  // Split the profile curves at their intersections (General Fuse) and keep the history.
  ShapeList profileEdges;
  for (const Curve& c : curves) {
    if (!c.construction) profileEdges.Append(c.edge);
  }
  std::vector<std::vector<TopoDS_Shape>> pieces(curves.size());
  std::vector<KernelError> warnings;
  if (profileEdges.Extent() == 1) {
    // General Fuse needs two arguments; a single line/circle/arc/ellipse never self-intersects.
    for (size_t i = 0; i < curves.size(); ++i) {
      if (!curves[i].construction) pieces[i].push_back(curves[i].edge);
    }
  } else if (!profileEdges.IsEmpty()) {
    BRepAlgoAPI_BuilderAlgo gf;
    gf.SetArguments(profileEdges);
    gf.SetFuzzyValue(1e-6);
    gf.SetRunParallel(false);
    gf.Build();
    if (gf.HasErrors() || !gf.IsDone()) {
      std::ostringstream diag;
      gf.DumpErrors(diag);
      raiseError("OPERATION_FAILED", "Could not intersect the sketch curves", {}, diag.str());
    }
    for (size_t i = 0; i < curves.size(); ++i) {
      if (curves[i].construction) continue;
      const ShapeList& mod = gf.Modified(curves[i].edge);
      if (mod.IsEmpty()) {
        if (!gf.IsDeleted(curves[i].edge)) pieces[i].push_back(curves[i].edge);
      } else {
        for (const TopoDS_Shape& p : mod) pieces[i].push_back(p);
      }
    }
  }

  // Piece names: S…:e(<id>), or S…:e(<id>)#k when the curve was split.
  ShapeMap pieceMap;
  std::vector<std::string> pieceName;
  std::vector<std::string> pieceEntity;
  for (size_t i = 0; i < curves.size(); ++i) {
    const std::string base = tag + ":e(" + curves[i].id + ")";
    if (curves[i].construction) {
      pieceMap.Add(curves[i].edge);
      pieceName.push_back(base);
      pieceEntity.push_back(curves[i].id);
      continue;
    }
    std::vector<std::string> names(pieces[i].size(), base);
    std::vector<GeoKey> keys;
    for (const TopoDS_Shape& p : pieces[i]) keys.push_back(geoKey(edgeCentroid(TopoDS::Edge(p))));
    suffixDuplicates(names, keys);
    for (size_t k = 0; k < pieces[i].size(); ++k) {
      if (pieceMap.Add(pieces[i][k]) > static_cast<int>(pieceName.size())) {
        pieceName.push_back(names[k]);
        pieceEntity.push_back(curves[i].id);
      }
    }
  }

  // Regions.
  std::vector<TopoDS_Face> regionFaces;
  if (!profileEdges.IsEmpty()) {
    ShapeList twoSided;
    for (size_t i = 0; i < curves.size(); ++i) {
      for (const TopoDS_Shape& p : pieces[i]) {
        twoSided.Append(p.Oriented(TopAbs_FORWARD));
        twoSided.Append(p.Oriented(TopAbs_REVERSED));
      }
    }
    const double big = 1e7;
    TopoDS_Face planeFace = BRepBuilderAPI_MakeFace(gp_Pln(frame), -big, big, -big, big).Face();
    planeFace.Orientation(TopAbs_FORWARD);
    BRepLib::BuildPCurveForEdgesOnPlane(twoSided, planeFace);
    BOPAlgo_BuilderFace bf;
    bf.SetShapes(twoSided);
    bf.SetFace(planeFace);
    bf.SetAvoidInternalShapes(true);
    bf.Perform();
    if (bf.HasErrors()) {
      warnings.push_back(warning("OPERATION_FAILED", "Some sketch regions could not be built",
                                 "Check for tiny gaps or overlapping curves."));
    } else {
      for (const TopoDS_Shape& area : bf.Areas()) {
        Bnd_Box box;
        BRepBndLib::Add(area, box);
        if (box.IsVoid()) continue;
        double x0, y0, z0, x1, y1, z1;
        box.Get(x0, y0, z0, x1, y1, z1);
        if (x1 - x0 > big || y1 - y0 > big || z1 - z0 > big) continue;  // unbounded outside
        regionFaces.push_back(TopoDS::Face(area));
      }
    }
  }

  // Region names: S…:region(<outer ids sorted>|<inner loop ids sorted>…), inner loops sorted.
  auto loopIds = [&](const TopoDS_Shape& wire) {
    std::vector<std::string> ids;
    for (TopoDS_Iterator it(wire); it.More(); it.Next()) {
      const TopoDS_Shape& e = it.Value();
      if (e.Orientation() == TopAbs_INTERNAL || e.Orientation() == TopAbs_EXTERNAL) continue;
      const int pi = pieceMap.FindIndex(e);
      if (pi > 0) ids.push_back(pieceEntity[static_cast<size_t>(pi - 1)]);
    }
    return joinSorted(ids, ",");
  };
  std::vector<std::string> regionNames;
  std::vector<GeoKey> regionKeys;
  for (const TopoDS_Face& f : regionFaces) {
    const TopoDS_Wire outer = BRepTools::OuterWire(f);
    std::vector<std::string> inner;
    for (TopoDS_Iterator it(f); it.More(); it.Next()) {
      if (it.Value().ShapeType() != TopAbs_WIRE || it.Value().IsSame(outer)) continue;
      inner.push_back(loopIds(it.Value()));
    }
    std::sort(inner.begin(), inner.end());
    std::string name = tag + ":region(" + loopIds(outer);
    for (const std::string& in : inner) name += "|" + in;
    name += ")";
    regionNames.push_back(name);
    regionKeys.push_back(geoKey(faceCentroid(f)));
  }
  suffixDuplicates(regionNames, regionKeys);
  std::vector<size_t> regionOrder(regionFaces.size());
  for (size_t i = 0; i < regionOrder.size(); ++i) regionOrder[i] = i;
  std::sort(regionOrder.begin(), regionOrder.end(),
            [&](size_t a, size_t b) { return regionNames[a] < regionNames[b]; });

  // Assemble the sketch compound: curves (split pieces, construction curves whole), free points,
  // regions. TopExp order follows insertion order, so it is deterministic.
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  for (int i = 1; i <= pieceMap.Extent(); ++i) builder.Add(compound, pieceMap(i));
  {
    const Topo sofar(compound);
    for (const std::string& pid : pointOrder) {
      const SketchPointDef& p = points[pid];
      const gp_Pnt pos = to3d(p.u, p.v);
      bool onCurve = false;
      for (int v = 1; v <= sofar.vertices.Extent() && !onCurve; ++v) {
        onCurve = BRep_Tool::Pnt(TopoDS::Vertex(sofar.vertices(v))).Distance(pos) < 1e-6;
      }
      if (!onCurve) {
        auto found = vertexOf.find(pid);
        builder.Add(compound, found != vertexOf.end()
                                  ? TopoDS_Shape(found->second)
                                  : TopoDS_Shape(BRepBuilderAPI_MakeVertex(pos).Vertex()));
      }
    }
  }
  for (size_t i : regionOrder) builder.Add(compound, regionFaces[i]);

  NamedShape ns;
  ns.shape = compound;
  ns.hasFrame = true;
  ns.frame = frame;
  const Topo topo(compound);
  ns.faces.assign(static_cast<size_t>(topo.faces.Extent()), std::string());
  for (size_t i : regionOrder) {
    const int fi = topo.faces.FindIndex(regionFaces[i]);
    if (fi > 0) ns.faces[static_cast<size_t>(fi - 1)] = regionNames[i];
  }
  ns.edges.assign(static_cast<size_t>(topo.edges.Extent()), std::string());
  for (int i = 1; i <= topo.edges.Extent(); ++i) {
    const int pi = pieceMap.FindIndex(topo.edges(i));
    if (pi > 0) ns.edges[static_cast<size_t>(i - 1)] = pieceName[static_cast<size_t>(pi - 1)];
  }
  ns.vertices.assign(static_cast<size_t>(topo.vertices.Extent()), std::string());
  for (int i = 1; i <= topo.vertices.Extent(); ++i) {
    const gp_Pnt pos = BRep_Tool::Pnt(TopoDS::Vertex(topo.vertices(i)));
    std::vector<std::string> ids;
    for (const std::string& pid : pointOrder) {
      const SketchPointDef& p = points[pid];
      if (to3d(p.u, p.v).Distance(pos) < 1e-6) ids.push_back(pid);
    }
    std::sort(ids.begin(), ids.end());
    for (size_t k = 0; k < ids.size(); ++k) {
      const std::string name = tag + ":p(" + ids[k] + ")";
      if (k == 0) {
        ns.vertices[static_cast<size_t>(i - 1)] = name;
      } else {
        ns.aliases.push_back({name, "vertex", i - 1});
      }
    }
  }

  std::vector<std::string> sortedRegionNames;
  for (size_t i : regionOrder) sortedRegionNames.push_back(regionNames[i]);
  return storeResult(ns, warnings,
                     ",\"frame\":" + jsonFrame(frame) + ",\"regions\":" +
                         jsonStringArray(sortedRegionNames));
}

// ---------------------------------------------------------------------------------------------
// Profiles (extrude / revolve)
// ---------------------------------------------------------------------------------------------

struct Profile {
  std::vector<TopoDS_Face> faces;
  // Persistent name of every profile edge (by TShape), from the record the face came from.
  ShapeMap edgeMap;
  std::vector<std::string> edgeNames;
  gp_Dir normal;
  gp_Pnt origin;
};

// Outward normal of a planar face (accounts for the face orientation).
bool planeOf(const TopoDS_Face& face, gp_Pln& plane, gp_Dir& normal) {
  BRepAdaptor_Surface s(face, false);
  if (s.GetType() != GeomAbs_Plane) return false;
  plane = s.Plane();
  normal = plane.Axis().Direction();
  if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
  return true;
}

Profile collectProfile(const Json& inputs, const char* verb) {
  const std::vector<RefTarget> refs = refsAt(inputs, "/profile");
  if (refs.empty()) {
    raiseError("UNRESOLVED_REFERENCE", std::string("Select at least one sketch region to ") + verb,
               "Pick a closed region of a sketch.");
  }
  Profile p;
  bool haveNormal = false;
  for (const RefTarget& r : refs) {
    if (r.kind != "face") {
      raiseError("INVALID_INPUT", std::string("Only sketch regions or planar faces can be ") + verb +
                                      "d (got a " + r.kind + ")",
                 {}, {}, {r.name});
    }
    const TopoDS_Face face = TopoDS::Face(r.sub);
    gp_Pln plane;
    gp_Dir n;
    if (!planeOf(face, plane, n)) {
      raiseError("INVALID_INPUT", std::string("Only planar regions can be ") + verb + "d", {}, {},
                 {r.name});
    }
    if (r.record->hasFrame) n = r.record->frame.Direction();
    if (!haveNormal) {
      p.normal = n;
      p.origin = r.record->hasFrame ? r.record->frame.Location() : plane.Location();
      haveNormal = true;
    } else if (!p.normal.IsParallel(n, 1e-9)) {
      raiseError("INVALID_INPUT", "All profile regions must lie in parallel planes", {}, {},
                 {r.name});
    }
    p.faces.push_back(face);
    const Topo& topo = r.record->topo();
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
      const int ei = topo.edges.FindIndex(ex.Current());
      const std::string name =
          ei > 0 && static_cast<size_t>(ei - 1) < r.record->edgeNames.size()
              ? r.record->edgeNames[static_cast<size_t>(ei - 1)]
              : std::string();
      if (p.edgeMap.Add(ex.Current()) > static_cast<int>(p.edgeNames.size())) {
        p.edgeNames.push_back(name);
      }
    }
  }
  return p;
}

std::string profileEdgeName(const Profile& p, const TopoDS_Shape& edge) {
  const int i = p.edgeMap.FindIndex(edge);
  if (i <= 0) return std::string();
  return p.edgeNames[static_cast<size_t>(i - 1)];
}

// Sweeps every profile face with `sweep` (prism or revol), names caps/sides per naming.ts and
// fuses the per-face solids. `wantCaps` = false for full revolutions.
template <typename Sweep>
NamedShape sweepProfile(const Profile& profile, const std::string& tag, bool wantCaps,
                        const std::function<std::unique_ptr<Sweep>(const TopoDS_Face&)>& make) {
  const std::string prefix = "F" + tag + ":";
  const std::string fallback = prefix + "unnamed";
  std::vector<NamedShape> solids;
  for (const TopoDS_Face& face : profile.faces) {
    std::unique_ptr<Sweep> sweep = make(face);
    sweep->Build();
    if (!sweep->IsDone()) raiseError("OPERATION_FAILED", "The sweep of the profile failed");
    const TopoDS_Shape shape = sweep->Shape();
    const Topo topo(shape);
    std::vector<std::string> names(static_cast<size_t>(topo.faces.Extent()));
    auto assign = [&](const TopoDS_Shape& f, const std::string& name) {
      const int i = topo.faces.FindIndex(f);
      if (i > 0 && names[static_cast<size_t>(i - 1)].empty()) names[static_cast<size_t>(i - 1)] = name;
    };
    if (wantCaps) {
      assign(sweep->FirstShape(), prefix + "start");
      assign(sweep->LastShape(), prefix + "end");
    }
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
      const std::string edgeName = profileEdgeName(profile, ex.Current());
      for (const TopoDS_Shape& g : sweep->Generated(ex.Current())) {
        if (g.ShapeType() == TopAbs_FACE) {
          assign(g, prefix + "side(" + (edgeName.empty() ? std::string("?") : edgeName) + ")");
        }
      }
    }
    // BRepPrimAPI_MakeRevol::Generated misses some faces of full revolutions (its degenerated-edge
    // substitution history). The swept face still contains its profile edge at angle 0, so name
    // a leftover face after the one profile edge lying on its surface (ends + middle).
    for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
      if (!names[static_cast<size_t>(fi - 1)].empty()) continue;
      const TopoDS_Face& f = TopoDS::Face(topo.faces(fi));
      TopLoc_Location loc;
      const occ::handle<Geom_Surface> surface = BRep_Tool::Surface(f, loc);
      if (surface.IsNull()) continue;
      std::string match;
      int matches = 0;
      for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
        BRepAdaptor_Curve c(TopoDS::Edge(ex.Current()));
        bool on = true;
        for (double t : {0.0, 0.5, 1.0}) {
          const gp_Pnt p = c.Value(c.FirstParameter() + t * (c.LastParameter() - c.FirstParameter()));
          GeomAPI_ProjectPointOnSurf proj(p.Transformed(loc.Transformation().Inverted()), surface);
          if (proj.NbPoints() == 0 || proj.LowerDistance() > 1e-6) {
            on = false;
            break;
          }
        }
        if (!on) continue;
        const std::string edgeName = profileEdgeName(profile, ex.Current());
        const std::string name = prefix + "side(" + (edgeName.empty() ? std::string("?") : edgeName) + ")";
        if (name != match) {
          match = name;
          ++matches;
        }
      }
      if (matches == 1) names[static_cast<size_t>(fi - 1)] = match;
    }
    NamedShape ns;
    ns.shape = shape;
    ns.faces = std::move(names);
    solids.push_back(std::move(ns));
  }
  if (solids.size() == 1) return finalizeNamed(solids[0].shape, solids[0].faces, fallback);
  std::vector<NamedInput> objects{namedInputOf(solids[0])};
  std::vector<NamedInput> tools;
  for (size_t i = 1; i < solids.size(); ++i) tools.push_back(namedInputOf(solids[i]));
  return booleanNamed(BOPAlgo_FUSE, objects, tools, nullptr, fallback);
}

NamedShape movedNamed(NamedShape ns, const gp_Trsf& trsf) {
  ns.shape = ns.shape.Moved(TopLoc_Location(trsf));  // same TopExp order; names stay by index
  return ns;
}

double bodiesExtent(const std::vector<std::pair<std::string, std::shared_ptr<const ShapeRecord>>>& bodies,
                    const Profile& profile) {
  Bnd_Box box;
  for (const auto& b : bodies) BRepBndLib::Add(b.second->shape, box);
  for (const TopoDS_Face& f : profile.faces) BRepBndLib::Add(f, box);
  if (box.IsVoid()) return 1.0;
  return std::sqrt(box.SquareExtent());
}

// A planar target for "up to": a face ref at /end/target or a frame (origin planes).
bool upToPlane(const Json& inputs, gp_Pln& plane, std::string& refName) {
  const std::vector<RefTarget> refs = refsAt(inputs, "/end/target");
  if (!refs.empty()) {
    const RefTarget& r = refs[0];
    refName = r.name;
    if (r.kind != "face") {
      raiseError("INVALID_INPUT", "Extrude up to needs a face or plane", {}, {}, {r.name});
    }
    gp_Dir n;
    if (!planeOf(TopoDS::Face(r.sub), plane, n)) return false;
    return true;
  }
  const Json* f = frameInput(inputs, "/end/target");
  if (f == nullptr) f = frameInput(inputs, "upTo");
  if (f == nullptr) {
    raiseError("UNRESOLVED_REFERENCE", "Select the face or plane to extrude up to");
  }
  plane = gp_Pln(gp_Ax3(parseFrame(f)));
  return true;
}

std::string execExtrude(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const Profile profile = collectProfile(inputs, "extrude");
  if (hasValue(values, "/draft") && std::fabs(requireValue(values, "/draft", "draft angle")) > 1e-12) {
    raiseError("UNSUPPORTED_FEATURE", "Draft on extrude is not available yet",
               "Set the draft angle to 0.");
  }
  const std::string direction = optString(feature, "direction", "normal");
  if (direction != "normal" && direction != "reverse" && direction != "symmetric") {
    raiseError("INVALID_INPUT", "Extrude direction must be normal, reverse or symmetric");
  }
  const std::string op = optString(feature, "op", "new");
  const Json* end = feature.get("end");
  const std::string endKind = end != nullptr && end->isObject() ? optString(*end, "kind", "") : "";
  const gp_Vec n(profile.normal);
  const double sign = direction == "reverse" ? -1.0 : 1.0;

  double length = 0;    // prism length
  double shift = 0;     // translation along n after sweeping (symmetric)
  bool halfSpace = false;
  gp_Pln stopPlane;
  if (endKind == "blind") {
    length = requireValue(values, "/end/depth", "extrude depth");
    if (!(length > 1e-6)) {
      raiseError("INVALID_INPUT", "Extrude depth must be greater than zero",
                 "Enter a positive depth, or flip the direction.");
    }
  } else if (endKind == "throughAll") {
    const auto bodies = collectBodies(inputs);
    if (bodies.empty() || op == "new") {
      raiseError("INVALID_INPUT", "Through all needs a body to go through",
                 "Use a blind depth, or set the operation to Cut or Intersect.");
    }
    length = 2 * bodiesExtent(bodies, profile) + 1;
  } else if (endKind == "upTo") {
    if (direction == "symmetric") {
      raiseError("INVALID_INPUT", "Symmetric extrude cannot go up to a face",
                 "Use Normal or Reverse.");
    }
    std::string refName;
    if (!upToPlane(inputs, stopPlane, refName)) {
      raiseError("UNSUPPORTED_FEATURE", "Extrude up to a curved face is not available yet",
                 "Pick a planar face or a plane.", {}, {refName});
    }
    const gp_Dir pn = stopPlane.Axis().Direction();
    const gp_Vec dir = n * sign;
    if (std::fabs(gp_Vec(pn).Dot(dir)) > 1 - 1e-12) {
      // Parallel: exact blind extrude to the plane.
      length = gp_Vec(profile.origin, stopPlane.Location()).Dot(dir);
      if (!(length > 1e-6)) {
        raiseError("INVALID_INPUT", "The up-to face is behind the sketch",
                   "Flip the extrude direction.", {}, {refName});
      }
    } else {
      halfSpace = true;
      Bnd_Box box;
      for (const TopoDS_Face& f : profile.faces) BRepBndLib::Add(f, box);
      const double diag = box.IsVoid() ? 1.0 : std::sqrt(box.SquareExtent());
      const double reach =
          std::fabs(stopPlane.Distance(profile.origin)) / std::max(1e-3, std::fabs(gp_Vec(pn).Dot(dir)));
      length = 4 * (diag + reach) + 1;
    }
  } else {
    raiseError("INVALID_INPUT", "Extrude end must be blind, throughAll or upTo");
  }
  if (direction == "symmetric") {
    shift = -length / 2;
  }
  const gp_Vec sweepVec = n * (sign * length);

  NamedShape tool = sweepProfile<BRepPrimAPI_MakePrism>(
      profile, tag, true, [&](const TopoDS_Face& f) {
        return std::make_unique<BRepPrimAPI_MakePrism>(f, sweepVec, false, true);
      });
  if (shift != 0) {
    gp_Trsf t;
    t.SetTranslation(n * shift);
    tool = movedNamed(std::move(tool), t);
  }
  if (halfSpace) {
    // Keep the part of the long prism on the profile's side of the stop plane; the plane's face
    // becomes the end cap.
    const double big = 1e6;
    const TopoDS_Face planeFace = BRepBuilderAPI_MakeFace(stopPlane, -big, big, -big, big).Face();
    BRepPrimAPI_MakeHalfSpace hs(planeFace, profile.origin);
    const TopoDS_Shape solid = hs.Solid();
    const Topo hsTopo(solid);
    NamedInput hsInput{solid, std::vector<std::string>(static_cast<size_t>(hsTopo.faces.Extent()),
                                                       "F" + tag + ":end")};
    // Drop the far cap's name so it cannot compete with the real end.
    for (std::string& name : tool.faces) {
      if (name == "F" + tag + ":end") name.clear();
    }
    tool = booleanNamed(BOPAlgo_COMMON, {namedInputOf(tool)}, {hsInput}, nullptr,
                        "F" + tag + ":unnamed");
    if (Topo(tool.shape).faces.Extent() == 0) {
      raiseError("OPERATION_FAILED", "The extrude does not reach the up-to face",
                 "Flip the direction or pick another face.");
    }
  }
  return applyBodyOp(tool, op, inputs, tag, {});
}

// ---------------------------------------------------------------------------------------------
// Revolve
// ---------------------------------------------------------------------------------------------

gp_Ax1 revolveAxis(const Json& inputs) {
  const std::vector<RefTarget> refs = refsAt(inputs, "/axis");
  if (!refs.empty()) {
    const RefTarget& r = refs[0];
    if (r.kind != "edge") {
      raiseError("INVALID_INPUT", "The revolve axis must be a straight edge or an axis", {}, {},
                 {r.name});
    }
    const TopoDS_Edge edge = TopoDS::Edge(r.sub);
    BRepAdaptor_Curve curve(edge);
    if (curve.GetType() != GeomAbs_Line) {
      raiseError("INVALID_INPUT", "The revolve axis must be a straight edge", {}, {}, {r.name});
    }
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(edge, v1, v2, true);
    if (v1.IsNull() || v2.IsNull()) {
      gp_Lin line = curve.Line();
      return gp_Ax1(line.Location(), line.Direction());
    }
    const gp_Pnt a = BRep_Tool::Pnt(v1);
    const gp_Pnt b = BRep_Tool::Pnt(v2);
    if (a.Distance(b) < 1e-9) raiseError("INVALID_INPUT", "The revolve axis has zero length");
    return gp_Ax1(a, gp_Dir(gp_Vec(a, b)));
  }
  const Json* f = frameInput(inputs, "axis");
  if (f == nullptr) f = frameInput(inputs, "/axis");
  if (f == nullptr) raiseError("UNRESOLVED_REFERENCE", "Select an axis to revolve around");
  const gp_Ax2 ax = parseFrame(f);
  return gp_Ax1(ax.Location(), ax.Direction());
}

std::string execRevolve(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const Profile profile = collectProfile(inputs, "revolve");
  gp_Ax1 axis = revolveAxis(inputs);
  const double angle = requireValue(values, "/angle", "revolve angle");
  if (!(angle > 1e-9) || angle > 2 * kPi + 1e-9) {
    raiseError("INVALID_INPUT", "Revolve angle must be between 0 and 360°",
               "Enter an angle such as 90deg or 360deg.");
  }
  const bool full = angle >= 2 * kPi - 1e-9;
  const std::string direction = optString(feature, "direction", "normal");
  if (direction == "reverse") axis.Reverse();
  const std::string op = optString(feature, "op", "new");

  // The profile must stay on one side of the axis (in the profile plane).
  {
    const gp_Vec side = gp_Vec(axis.Direction()).Crossed(gp_Vec(profile.normal));
    if (side.Magnitude() < 1e-9) {
      raiseError("INVALID_INPUT", "The revolve axis is perpendicular to the sketch plane",
                 "Pick an axis that lies in the sketch plane.");
    }
    double lo = 0;
    double hi = 0;
    for (const TopoDS_Face& f : profile.faces) {
      for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
        BRepAdaptor_Curve c(TopoDS::Edge(ex.Current()));
        const int samples = 16;
        for (int s = 0; s <= samples; ++s) {
          const double t = c.FirstParameter() + (c.LastParameter() - c.FirstParameter()) * s / samples;
          const double d = gp_Vec(axis.Location(), c.Value(t)).Dot(side.Normalized());
          lo = std::min(lo, d);
          hi = std::max(hi, d);
        }
      }
    }
    if (lo < -1e-6 && hi > 1e-6) {
      raiseError("OPERATION_FAILED", "The profile crosses the revolve axis",
                 "Move the profile so it lies on one side of the axis.");
    }
    if (std::max(-lo, hi) < 1e-6) {
      raiseError("INVALID_INPUT", "The profile lies on the revolve axis");
    }
  }

  NamedShape tool = sweepProfile<BRepPrimAPI_MakeRevol>(
      profile, tag, !full, [&](const TopoDS_Face& f) {
        return full ? std::make_unique<BRepPrimAPI_MakeRevol>(f, axis, 2 * kPi, false)
                    : std::make_unique<BRepPrimAPI_MakeRevol>(f, axis, angle, false);
      });
  if (direction == "symmetric" && !full) {
    gp_Trsf r;
    r.SetRotation(axis, -angle / 2);
    tool = movedNamed(std::move(tool), r);
  }
  if (!isValidShape(tool.shape) || !(solidVolume(tool.shape) > 0)) {
    raiseError("OPERATION_FAILED", "The revolve produced an invalid solid",
               "Check that the profile does not touch the axis at a single point.");
  }
  return applyBodyOp(tool, op, inputs, tag, {});
}

// ---------------------------------------------------------------------------------------------
// Fillet / chamfer
// ---------------------------------------------------------------------------------------------

struct EdgeSelection {
  std::shared_ptr<const ShapeRecord> target;
  std::vector<TopoDS_Edge> edges;
  std::vector<std::string> names;
};

EdgeSelection selectEdges(const Json& inputs, const char* verb) {
  const std::vector<RefTarget> refs = refsAt(inputs, "/edges");
  if (refs.empty()) {
    raiseError("INVALID_INPUT", std::string("Select at least one edge to ") + verb);
  }
  EdgeSelection sel;
  const int target = optHandle(inputs, "target");
  sel.target = target != 0 ? requireShape(target) : refs[0].record;
  const Topo& topo = sel.target->topo();
  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(sel.target->shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  for (const RefTarget& r : refs) {
    if (r.kind != "edge") {
      raiseError("INVALID_INPUT", std::string("Only edges can be ") + verb + "ed", {}, {},
                 {r.name});
    }
    const int ei = topo.edges.FindIndex(r.sub);
    if (ei <= 0) {
      raiseError("INVALID_INPUT", "The edge is not on the body", "Re-pick the edge.", {}, {r.name});
    }
    const TopoDS_Edge edge = TopoDS::Edge(topo.edges(ei));
    if (BRep_Tool::Degenerated(edge)) {
      raiseError("INVALID_INPUT", std::string("This edge cannot be ") + verb + "ed", {}, {},
                 {r.name});
    }
    std::set<int> faces;
    if (const ShapeList* anc = edgeFaces.Seek(edge)) {
      for (const TopoDS_Shape& f : *anc) faces.insert(topo.faces.FindIndex(f));
    }
    if (faces.size() != 2) {
      raiseError("INVALID_INPUT",
                 std::string("Only edges between two faces can be ") + verb + "ed", {}, {},
                 {r.name});
    }
    const size_t idx = static_cast<size_t>(ei - 1);
    sel.edges.push_back(edge);
    sel.names.push_back(idx < sel.target->edgeNames.size() ? sel.target->edgeNames[idx] : r.name);
  }
  return sel;
}

// Names the result of a local operation (fillet/chamfer): surviving faces via Modified, new faces
// from edges/vertices via Generated as F…:<role>(<edge or vertex name>).
NamedShape nameLocalOperation(BRepBuilderAPI_MakeShape& algo, const ShapeRecord& target,
                              const TopoDS_Shape& result, const std::string& tag, const char* role) {
  const Topo rt(result);
  std::vector<std::string> names(static_cast<size_t>(rt.faces.Extent()));
  carryFaceNames(algo, namedInputOf(target), rt, names, false);
  const Topo& in = target.topo();
  const std::string prefix = "F" + tag + ":" + role + "(";
  auto generated = [&](const ShapeMap& map, const std::vector<std::string>& sourceNames) {
    for (int i = 1; i <= map.Extent(); ++i) {
      const size_t idx = static_cast<size_t>(i - 1);
      if (idx >= sourceNames.size() || sourceNames[idx].empty()) continue;
      const std::string name = prefix + sourceNames[idx] + ")";
      for (const TopoDS_Shape& g : algo.Generated(map(i))) {
        if (g.ShapeType() != TopAbs_FACE) continue;
        const int fi = rt.faces.FindIndex(g);
        if (fi <= 0) continue;
        std::string& slot = names[static_cast<size_t>(fi - 1)];
        if (slot.empty() || name < slot) slot = name;
      }
    }
  };
  generated(in.edges, target.edgeNames);
  generated(in.vertices, target.vertexNames);
  return finalizeNamed(result, std::move(names), "F" + tag + ":unnamed");
}

bool filletWorks(const TopoDS_Shape& shape, const std::vector<TopoDS_Edge>& edges, double r) {
  try {
    BRepFilletAPI_MakeFillet mk(shape);
    for (const TopoDS_Edge& e : edges) mk.Add(r, e);
    mk.Build();
    return mk.IsDone() && isValidShape(mk.Shape());
  } catch (...) {
    return false;
  }
}

// Largest radius (≤ r) that still builds, by bisection; 0 when none found or too costly.
double maxWorkingRadius(const TopoDS_Shape& shape, const std::vector<TopoDS_Edge>& edges,
                        double r) {
  if (Topo(shape).faces.Extent() > 400 || edges.size() > 32) return 0;
  double lo = 0;
  double hi = r;
  for (int i = 0; i < 9; ++i) {
    const double mid = (lo + hi) / 2;
    if (filletWorks(shape, edges, mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// `propagate: false` (M3). OCCT has no switch for it: every BRepFilletAPI_MakeFillet /
// BRepFilletAPI_MakeChamfer Add() calls ChFi3d_Builder::PerformElement (ChFi3d_Builder_1.cxx),
// which always extends the contour along tangent-continuous edges. So when the contour OCCT
// built is longer than the selection, refuse with the extra edges instead of silently blending
// more than was asked (never fake it).
bool propagateOption(const Json& feature) {
  const Json* p = feature.get("propagate");
  return !(p != nullptr && p->kind == Json::Kind::Bool && !p->boolean);
}

void refuseTangentPropagation(const BRepFilletAPI_LocalOperation& mk, const EdgeSelection& sel,
                              const char* what) {
  std::vector<std::string> extra;
  for (int ic = 1; ic <= mk.NbContours(); ++ic) {
    for (int j = 1; j <= mk.NbEdges(ic); ++j) {
      const TopoDS_Edge& e = mk.Edge(ic, j);
      bool selected = false;
      for (const TopoDS_Edge& s : sel.edges) selected = selected || s.IsSame(e);
      if (selected) continue;
      const int ei = sel.target->topo().edges.FindIndex(e);
      const size_t idx = static_cast<size_t>(ei - 1);
      extra.push_back(ei > 0 && idx < sel.target->edgeNames.size() ? sel.target->edgeNames[idx]
                                                                    : std::string("edge #") + std::to_string(ei - 1));
    }
  }
  if (extra.empty()) return;
  std::vector<std::string> refs = sel.names;
  refs.insert(refs.end(), extra.begin(), extra.end());
  raiseError("UNSUPPORTED_FEATURE",
             std::string("The ") + what + " cannot stop at tangent edges: " + std::to_string(extra.size()) +
                 (extra.size() == 1 ? " tangent edge continues" : " tangent edges continue") + " the selection",
             "Turn on \"Propagate along tangent edges\", or select the whole tangent chain.",
             "OCCT ChFi3d_Builder::PerformElement always propagates along tangent edges", refs);
}

std::string roundDownHint(double v) {
  double step = v >= 10 ? 1.0 : (v >= 1 ? 0.1 : (v >= 0.1 ? 0.01 : 0.001));
  double rounded = std::floor(v / step) * step;
  if (rounded <= 0) rounded = v;
  return fmtMm(rounded);
}

std::string execFillet(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const EdgeSelection sel = selectEdges(inputs, "fillet");
  const double r = requireValue(values, "/radius", "fillet radius");
  if (!(r > 1e-6)) {
    raiseError("INVALID_INPUT", "Fillet radius must be greater than zero",
               "Enter a positive radius.", {}, sel.names);
  }
  const bool plural = sel.edges.size() > 1;
  auto tooLarge = [&](const std::string& detail) {
    const double maxR = maxWorkingRadius(sel.target->shape, sel.edges, r);
    raiseError("OPERATION_FAILED",
               std::string("Fillet radius is too large for ") + (plural ? "these edges" : "this edge"),
               maxR > 0 ? "Try ≤ " + roundDownHint(maxR) + " mm"
                        : "Try a smaller radius, or fillet fewer edges at once.",
               detail, sel.names);
  };
  std::unique_ptr<BRepFilletAPI_MakeFillet> mk;
  TopoDS_Shape result;
  try {
    mk = std::make_unique<BRepFilletAPI_MakeFillet>(sel.target->shape);
    for (const TopoDS_Edge& e : sel.edges) mk->Add(r, e);
    if (!propagateOption(feature)) refuseTangentPropagation(*mk, sel, "fillet");
    mk->Build();
    if (mk->IsDone()) result = mk->Shape();
  } catch (const Standard_Failure& e) {
    tooLarge(std::string(e.ExceptionType()) + ": " + (e.what() != nullptr ? e.what() : ""));
  }
  if (result.IsNull() || !isValidShape(result)) tooLarge("BRepFilletAPI_MakeFillet not done / invalid");
  return storeResult(nameLocalOperation(*mk, *sel.target, result, tag, "fillet"), {});
}

std::string execChamfer(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const EdgeSelection sel = selectEdges(inputs, "chamfer");
  const Json* mode = feature.get("mode");
  const std::string kind = mode != nullptr && mode->isObject() ? optString(*mode, "kind", "") : "";
  const double d = requireValue(values, "/mode/distance", "chamfer distance");
  if (!(d > 1e-6)) {
    raiseError("INVALID_INPUT", "Chamfer distance must be greater than zero",
               "Enter a positive distance.", {}, sel.names);
  }
  double angle = 0;
  if (kind == "distanceAngle") {
    angle = requireValue(values, "/mode/angle", "chamfer angle");
    if (!(angle > 1e-6) || !(angle < kPi / 2 - 1e-6)) {
      raiseError("INVALID_INPUT", "Chamfer angle must be between 0° and 90°", {}, {}, sel.names);
    }
  } else if (kind != "distance") {
    raiseError("INVALID_INPUT", "Chamfer mode must be distance or distanceAngle");
  }
  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(sel.target->shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  const Topo& topo = sel.target->topo();
  std::unique_ptr<BRepFilletAPI_MakeChamfer> mk;
  TopoDS_Shape result;
  std::string detail;
  try {
    mk = std::make_unique<BRepFilletAPI_MakeChamfer>(sel.target->shape);
    for (const TopoDS_Edge& e : sel.edges) {
      if (kind == "distance") {
        mk->Add(d, e);
        continue;
      }
      // Distance is measured on the adjacent face whose persistent name sorts first
      // (deterministic; the contract has no reference-face field yet).
      TopoDS_Face ref;
      std::string refName;
      for (const TopoDS_Shape& f : edgeFaces.FindFromKey(e)) {
        const int fi = topo.faces.FindIndex(f);
        const std::string n = fi > 0 && static_cast<size_t>(fi - 1) < sel.target->faceNames.size()
                                  ? sel.target->faceNames[static_cast<size_t>(fi - 1)]
                                  : std::string();
        if (ref.IsNull() || n < refName) {
          ref = TopoDS::Face(f);
          refName = n;
        }
      }
      mk->AddDA(d, angle, e, ref);
    }
    if (!propagateOption(feature)) refuseTangentPropagation(*mk, sel, "chamfer");
    mk->Build();
    if (mk->IsDone()) result = mk->Shape();
  } catch (const Standard_Failure& e) {
    detail = std::string(e.ExceptionType()) + ": " + (e.what() != nullptr ? e.what() : "");
  }
  if (result.IsNull() || !isValidShape(result)) {
    raiseError("OPERATION_FAILED",
               std::string("Chamfer is too large for ") + (sel.edges.size() > 1 ? "these edges" : "this edge"),
               "Try a smaller distance.", detail, sel.names);
  }
  return storeResult(nameLocalOperation(*mk, *sel.target, result, tag, "chamfer"), {});
}

// ---------------------------------------------------------------------------------------------
// Boolean feature
// ---------------------------------------------------------------------------------------------

std::string execBoolean(const Json& feature, const Json& inputs, const std::string& tag) {
  const std::string op = requireString(feature, "op", "boolean feature");
  BOPAlgo_Operation bopOp;
  if (op == "add") {
    bopOp = BOPAlgo_FUSE;
  } else if (op == "cut") {
    bopOp = BOPAlgo_CUT;
  } else if (op == "intersect") {
    bopOp = BOPAlgo_COMMON;
  } else {
    raiseError("INVALID_INPUT", "Boolean op must be add, cut or intersect");
  }
  std::shared_ptr<const ShapeRecord> target;
  const int targetHandle = optHandle(inputs, "target");
  if (targetHandle != 0) {
    target = requireShape(targetHandle);
  } else {
    const std::vector<RefTarget> t = refsAt(inputs, "/target");
    if (t.empty()) raiseError("UNRESOLVED_REFERENCE", "Select the body to " + op);
    target = t[0].record;
  }
  std::vector<std::shared_ptr<const ShapeRecord>> tools;
  for (const RefTarget& r : refsAt(inputs, "/tools")) tools.push_back(r.record);
  if (const Json* shapes = inputsObject(inputs, "shapes")) {
    std::vector<std::pair<std::string, int>> keyed;
    for (const auto& entry : shapes->object) {
      if (entry.first.compare(0, 5, "tools") == 0 && entry.second->isNumber()) {
        keyed.emplace_back(entry.first, static_cast<int>(entry.second->number));
      }
    }
    std::sort(keyed.begin(), keyed.end());
    for (const auto& k : keyed) tools.push_back(requireShape(k.second));
  }
  if (tools.empty()) raiseError("UNRESOLVED_REFERENCE", "Select at least one tool body");
  std::vector<NamedInput> toolInputs;
  for (const auto& t : tools) {
    if (t.get() == target.get()) {
      raiseError("INVALID_INPUT", "A body cannot be combined with itself");
    }
    toolInputs.push_back(namedInputOf(*t));
  }
  const std::string prefix = "F" + tag + ":face(";
  NamedShape result = booleanNamed(
      bopOp, {namedInputOf(*target)}, toolInputs,
      [&](const std::string& n) { return prefix + n + ")"; }, "F" + tag + ":unnamed");
  std::vector<KernelError> warnings;
  if (Topo(result.shape).faces.Extent() == 0) {
    if (bopOp == BOPAlgo_COMMON) {
      raiseError("OPERATION_FAILED", "The intersection is empty", "The bodies do not overlap.");
    }
    warnings.push_back(warning("OPERATION_FAILED", "The result is empty"));
  }
  return storeResult(result, warnings);
}

// Defined later in the amalgamated translation unit (whittle_pushpull.cpp, whittle_shape_ops.cpp,
// whittle_copies.cpp, whittle_reference.cpp).
std::string execPushPull(const Json& feature, const Json& inputs, const std::string& tag);
std::string execShell(const Json& feature, const Json& inputs, const std::string& tag);
std::string execDraft(const Json& feature, const Json& inputs, const std::string& tag);
std::string execSweep(const Json& feature, const Json& inputs, const std::string& tag);
std::string execLoft(const Json& feature, const Json& inputs, const std::string& tag);
std::string execCopies(const std::string& type, const Json& feature, const Json& inputs,
                       const std::string& tag);
std::string execHole(const Json& feature, const Json& inputs, const std::string& tag);
std::string execImport(const Json& feature, const Json& inputs, const std::string& tag);
std::string execThread(const Json& feature, const Json& inputs, const std::string& tag);
std::string execPlane(const Json& feature, const Json& inputs, const std::string& tag);
std::string execAxis(const Json& feature, const Json& inputs, const std::string& tag);
std::string execPoint(const Json& feature, const Json& inputs, const std::string& tag);

std::string dispatchFeature(const Json& feature, const Json& inputs) {
  const std::string type = requireString(feature, "type", "feature");
  const std::string id = requireString(feature, "id", "feature");
  if (id.empty()) raiseError("INVALID_INPUT", "feature.id must not be empty");
  if (type == "primitive") return execPrimitive(feature, inputs, id);
  if (type == "sketch") return execSketch(feature, inputs, id);
  if (type == "extrude") return execExtrude(feature, inputs, id);
  if (type == "revolve") return execRevolve(feature, inputs, id);
  if (type == "fillet") return execFillet(feature, inputs, id);
  if (type == "chamfer") return execChamfer(feature, inputs, id);
  if (type == "boolean") return execBoolean(feature, inputs, id);
  if (type == "plane") return execPlane(feature, inputs, id);
  if (type == "pushPull") return execPushPull(feature, inputs, id);
  if (type == "shell") return execShell(feature, inputs, id);
  if (type == "draft") return execDraft(feature, inputs, id);
  if (type == "sweep") return execSweep(feature, inputs, id);
  if (type == "loft") return execLoft(feature, inputs, id);
  if (type == "mirror" || type == "linearPattern" || type == "circularPattern") {
    return execCopies(type, feature, inputs, id);
  }
  if (type == "hole") return execHole(feature, inputs, id);
  if (type == "import") return execImport(feature, inputs, id);
  if (type == "thread") return execThread(feature, inputs, id);
  if (type == "axis") return execAxis(feature, inputs, id);
  if (type == "point") return execPoint(feature, inputs, id);
  raiseError("UNSUPPORTED_FEATURE",
             "Feature type '" + type + "' is not supported by this kernel build",
             "Update Whittle, or remove the feature.");
}

