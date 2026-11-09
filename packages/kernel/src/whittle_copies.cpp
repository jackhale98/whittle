// Whittle kernel façade — M3 copies and placed tools: mirror, linear and circular patterns, the hole
// wizard, the kernel `import` feature and cosmetic threads. Names follow naming.ts ("M3 additions").
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.

// ---------------------------------------------------------------------------------------------
// Transformed copies of named shapes
// ---------------------------------------------------------------------------------------------

// A copy of `input` placed by `trsf`, every face name N renamed by `rename`. Rigid motions only
// move the shape (shared geometry, same TopExp order, so names stay by index); mirrors rebuild
// the geometry (OCCT forbids negative locations) and carry names through the modification.
NamedInput transformedNamed(const NamedInput& input, const gp_Trsf& trsf,
                            const std::function<std::string(const std::string&)>& rename) {
  NamedInput out;
  if (!trsf.IsNegative()) {
    out.shape = input.shape.Moved(TopLoc_Location(trsf));
    out.faceNames.reserve(input.faceNames.size());
    for (const std::string& n : input.faceNames) out.faceNames.push_back(n.empty() ? n : rename(n));
    return out;
  }
  BRepBuilderAPI_Transform mk(input.shape, trsf, true);
  if (!mk.IsDone()) raiseError("OPERATION_FAILED", "The mirror copy could not be built");
  out.shape = mk.Shape();
  const Topo in(input.shape);
  const Topo rt(out.shape);
  out.faceNames.assign(static_cast<size_t>(rt.faces.Extent()), std::string());
  for (int i = 1; i <= in.faces.Extent(); ++i) {
    const size_t idx = static_cast<size_t>(i - 1);
    if (idx >= input.faceNames.size() || input.faceNames[idx].empty()) continue;
    const int ri = rt.faces.FindIndex(mk.ModifiedShape(in.faces(i)));
    if (ri > 0) out.faceNames[static_cast<size_t>(ri - 1)] = rename(input.faceNames[idx]);
  }
  return out;
}

struct Instance {
  int k = 0;  // instance index (0 = the original, never produced)
  gp_Trsf trsf;
};

struct CopyPlan {
  std::vector<Instance> instances;
  std::string role;  // "mirror" or "inst"
  std::string refName;
};

std::set<int> skipSet(const Json& feature) {
  std::set<int> skip;
  const Json* s = feature.get("skip");
  if (s != nullptr && s->isArray()) {
    for (const JsonPtr& v : s->array) {
      if (v->isNumber() && v->number == std::floor(v->number)) skip.insert(static_cast<int>(v->number));
    }
  }
  return skip;
}

CopyPlan planCopies(const std::string& type, const Json& feature, const Json& inputs) {
  const Json& values = valuesOf(inputs);
  CopyPlan plan;
  if (type == "mirror") {
    gp_Ax3 plane;
    if (!planeInput(inputs, "/plane", "plane", plane, plan.refName)) {
      raiseError("UNRESOLVED_REFERENCE", "Select the mirror plane", "Pick a plane or a planar face.");
    }
    Instance m;
    m.k = 1;
    m.trsf.SetMirror(gp_Ax2(plane.Location(), plane.Direction(), plane.XDirection()));
    plan.instances.push_back(m);
    plan.role = "mirror";
    return plan;
  }
  plan.role = "inst";
  const std::set<int> skip = skipSet(feature);
  if (type == "linearPattern") {
    gp_Ax1 a1;
    // The first direction: refs or frames at "/direction", else frames.direction or frames.axis.
    if (!lineInput(inputs, "/direction", "direction", a1, plan.refName) &&
        !lineInput(inputs, "/direction", "axis", a1, plan.refName)) {
      raiseError("UNRESOLVED_REFERENCE", "Select the pattern direction", "Pick an edge, an axis or a plane.");
    }
    gp_Vec d1(a1.Direction());
    const Json* rev = feature.get("reverse");
    if (rev != nullptr && rev->kind == Json::Kind::Bool && rev->boolean) d1.Reverse();
    const int n1 = requireCount(values, "/count", "Pattern count");
    const double s1 = requireValue(values, "/spacing", "pattern spacing");
    int n2 = 1;
    double s2 = 0;
    gp_Vec d2;
    const Json* second = feature.get("second");
    if (second != nullptr && second->isObject()) {
      gp_Ax1 a2;
      std::string name2;
      if (!lineInput(inputs, "/second/direction", "second", a2, name2)) {
        raiseError("UNRESOLVED_REFERENCE", "Select the second pattern direction");
      }
      d2 = gp_Vec(a2.Direction());
      const Json* rev2 = second->get("reverse");
      if (rev2 != nullptr && rev2->kind == Json::Kind::Bool && rev2->boolean) d2.Reverse();
      n2 = requireCount(values, "/second/count", "Second pattern count");
      s2 = requireValue(values, "/second/spacing", "second pattern spacing");
      if (d1.Crossed(d2).Magnitude() < 1e-9) {
        raiseError("INVALID_INPUT", "The two pattern directions are parallel", "Pick two different directions.");
      }
    }
    if (static_cast<long long>(n1) * n2 > 100000) raiseError("INVALID_INPUT", "The pattern has too many instances");
    for (int j = 0; j < n2; ++j) {
      for (int i = 0; i < n1; ++i) {
        const int k = j * n1 + i;  // row-major: the first direction runs along a row
        if (k == 0 || skip.count(k) != 0) continue;
        Instance inst;
        inst.k = k;
        inst.trsf.SetTranslation(d1 * (s1 * i) + (n2 > 1 ? d2 * (s2 * j) : gp_Vec(0, 0, 0)));
        plan.instances.push_back(inst);
      }
    }
    return plan;
  }
  if (type == "circularPattern") {
    gp_Ax1 axis;
    if (!lineInput(inputs, "/axis", "axis", axis, plan.refName)) {
      raiseError("UNRESOLVED_REFERENCE", "Select the pattern axis", "Pick an axis, a straight edge or a cylinder.");
    }
    const int n = requireCount(values, "/count", "Pattern count");
    const double angle = requireValue(values, "/angle", "pattern angle");
    const Json* eq = feature.get("equalSpacing");
    const bool equal = eq != nullptr && eq->kind == Json::Kind::Bool && eq->boolean;
    double step = angle;
    if (equal) {
      const bool full = std::fabs(std::fabs(angle) - 2 * kPi) < 1e-9;
      step = full ? angle / n : (n > 1 ? angle / (n - 1) : 0.0);
    }
    for (int k = 1; k < n; ++k) {
      if (skip.count(k) != 0) continue;
      Instance inst;
      inst.k = k;
      inst.trsf.SetRotation(axis, step * k);
      plan.instances.push_back(inst);
    }
    return plan;
  }
  raiseError("INTERNAL", "Unknown copy feature " + type);
}

std::function<std::string(const std::string&)> copyRename(const std::string& tag, const CopyPlan& plan,
                                                          int k) {
  const std::string prefix =
      "F" + tag + ":" + (plan.role == "mirror" ? std::string("mirror") : "inst" + std::to_string(k)) + "(";
  return [prefix](const std::string& n) { return prefix + n + ")"; };
}

// Boolean of one object with many tools in one BRepAlgoAPI call (multi-tool argument): one General
// Fuse intersects everything at once, which stays fast for hundreds of instances.
NamedShape multiToolBoolean(BOPAlgo_Operation op, const NamedInput& object,
                            const std::vector<NamedInput>& tools, const std::string& fallback) {
  return booleanNamed(op, {object}, tools, nullptr, fallback, /*manyTools=*/true);
}

std::string execCopies(const std::string& type, const Json& feature, const Json& inputs,
                       const std::string& tag) {
  const Json* source = feature.get("source");
  if (source == nullptr || !source->isObject()) raiseError("INVALID_INPUT", type + ".source is required");
  const std::string kind = optString(*source, "kind", "");
  const CopyPlan plan = planCopies(type, feature, inputs);
  const std::string fallback = "F" + tag + ":unnamed";
  std::vector<KernelError> warnings;

  if (kind == "features") {
    const int th = optHandle(inputs, "target");
    if (th == 0) {
      raiseError("UNRESOLVED_REFERENCE", "There is no body to copy the features onto",
                 "The copied features must act on an existing body.");
    }
    const std::shared_ptr<const ShapeRecord> target = requireShape(th);
    const Json* ids = source->get("features");
    if (ids == nullptr || !ids->isArray() || ids->array.empty()) {
      raiseError("INVALID_INPUT", "Select at least one feature to copy");
    }
    const Json& values = valuesOf(inputs);
    const Json* shapes = inputsObject(inputs, "shapes");
    NamedShape current;
    current.shape = target->shape;
    current.faces = target->faceNames;
    current.edges = target->edgeNames;
    current.vertices = target->vertexNames;
    bool changed = false;
    for (const JsonPtr& idJ : ids->array) {
      if (!idJ->isString()) raiseError("INVALID_INPUT", "source.features must be feature ids");
      const std::string id = idJ->string;
      const Json* h = shapes != nullptr ? shapes->get("tool:" + id) : nullptr;
      if (h == nullptr || !h->isNumber()) {
        raiseError("UNRESOLVED_REFERENCE", "The tool shape of a copied feature is missing",
                   "Re-run the feature, or remove it from the copy.", "inputs.shapes[\"tool:" + id + "\"]");
      }
      const std::shared_ptr<const ShapeRecord> tool = requireShape(static_cast<int>(h->number));
      const double opValue = requireValue(values, "/ops/" + id, "operation of feature " + id);
      if (opValue == 2) {
        raiseError("UNSUPPORTED_FEATURE",
                   std::string(type == "mirror" ? "Mirroring" : "Patterning") + " an intersect feature is not supported",
                   "Copy the bodies instead, or change the feature to Add or Cut.");
      }
      if (opValue != 0 && opValue != 1) raiseError("INVALID_INPUT", "values[\"/ops/" + id + "\"] must be 0 (add), 1 (cut) or 2 (intersect)");
      std::vector<NamedInput> copies;
      copies.reserve(plan.instances.size());
      for (const Instance& inst : plan.instances) {
        copies.push_back(transformedNamed(namedInputOf(*tool), inst.trsf, copyRename(tag, plan, inst.k)));
      }
      if (copies.empty()) continue;
      current = multiToolBoolean(opValue == 0 ? BOPAlgo_FUSE : BOPAlgo_CUT, namedInputOf(current), copies, fallback);
      changed = true;
      // A copy that touches the body leaves at least one of its (renamed) faces in the result.
      const std::string copyPrefix = "F" + tag + ":" + (plan.role == "mirror" ? "mirror(" : "inst");
      bool touched = false;
      for (const std::string& n : current.faces) touched = touched || n.compare(0, copyPrefix.size(), copyPrefix) == 0;
      if (!touched) {
        warnings.push_back(warning("OPERATION_FAILED", "The copies of feature " + id + " do not touch the body"));
      }
    }
    if (!changed) current = finalizeNamed(current.shape, current.faces, fallback);
    if (Topo(current.shape).faces.Extent() == 0) {
      raiseError("OPERATION_FAILED", "The copies remove the whole body");
    }
    return storeResult(current, warnings);
  }

  if (kind != "bodies") raiseError("INVALID_INPUT", "source.kind must be features or bodies");
  const std::vector<RefTarget> bodies = refsAt(inputs, "/source/bodies");
  if (bodies.empty()) raiseError("UNRESOLVED_REFERENCE", "Select at least one body to copy");
  const Json* mergeJ = source->get("merge");
  const bool merge = mergeJ != nullptr && mergeJ->kind == Json::Kind::Bool && mergeJ->boolean;
  if (plan.instances.empty()) raiseError("INVALID_INPUT", "The pattern has no instances besides the original");
  struct Copy {
    std::string key;
    NamedInput input;
  };
  std::vector<Copy> copies;
  for (size_t b = 0; b < bodies.size(); ++b) {
    for (const Instance& inst : plan.instances) {
      Copy c;
      c.key = (plan.role == "mirror" ? std::string("mirror") : "inst" + std::to_string(inst.k)) + ":" + std::to_string(b);
      c.input = transformedNamed(namedInputOf(*bodies[b].record), inst.trsf, copyRename(tag, plan, inst.k));
      copies.push_back(std::move(c));
    }
  }
  if (merge) {
    std::vector<NamedInput> tools;
    for (size_t b = 1; b < bodies.size(); ++b) tools.push_back(namedInputOf(*bodies[b].record));
    for (const Copy& c : copies) tools.push_back(c.input);
    NamedShape fused =
        booleanNamed(BOPAlgo_FUSE, {namedInputOf(*bodies[0].record)}, tools, nullptr, fallback, /*manyTools=*/true);
    const int solids = countSolids(fused.shape);
    if (solids > 1) {
      warnings.push_back(warning("OPERATION_FAILED",
                                 "The copies do not touch; the merged body has " + std::to_string(solids) + " separate solids",
                                 "Reduce the spacing, or turn off Merge."));
    }
    return storeResult(fused, warnings);
  }
  std::vector<NamedShape> results;
  for (const Copy& c : copies) results.push_back(finalizeNamed(c.input.shape, c.input.faceNames, fallback));
  std::vector<HandleGuard> guards(results.size());
  for (size_t i = 0; i < results.size(); ++i) guards[i].handle = storeNamed(results[i]);
  std::string extra;
  if (results.size() > 1) {
    extra = ",\"bodies\":[";
    for (size_t i = 1; i < results.size(); ++i) {
      if (i > 1) extra.push_back(',');
      extra += "{\"key\":" + jsonString(copies[i].key) + ",\"shape\":" + std::to_string(guards[i].handle) +
               ",\"naming\":" + namingJson(namingEntries(results[i])) + "}";
    }
    extra += "]";
  }
  std::string json = featureResultJson(guards[0].handle, results[0], warnings, extra);
  for (HandleGuard& g : guards) g.release();
  return json;
}

// ---------------------------------------------------------------------------------------------
// Hole wizard
//
// Each hole is a revolved profile in its frame (origin on the face, z into the material) with a
// small extension above the face, so the cut never leaves a coincident skin. Named roles:
// F…:hole(<P>):wall, :bottom (flat blind end), :tip (drill point), :cbore.wall, :cbore.floor,
// :csink. All holes are cut in one boolean (multi-tool argument).
// ---------------------------------------------------------------------------------------------

struct HoleSpec {
  std::string kind;  // simple | counterbore | countersink | tapped
  double radius = 0;
  double tipAngle = 0;  // 0 = flat
  double cboreRadius = 0;
  double cboreDepth = 0;
  double csinkRadius = 0;
  double csinkAngle = 0;
};

NamedShape holeTool(const HoleSpec& spec, const gp_Ax2& frame, double depth, bool through,
                    const std::string& base) {
  const double r = spec.radius;
  const double above = std::max(1.0, 2 * std::max({r, spec.cboreRadius, spec.csinkRadius}));
  // (radius, depth) polyline, closed along the axis.
  struct P2 {
    double r;
    double z;
  };
  std::vector<P2> pts;
  std::vector<std::string> roles;  // role of the edge from pts[i] to pts[i+1]
  pts.push_back({0, -above});
  double topR = r;
  if (spec.kind == "counterbore") topR = spec.cboreRadius;
  if (spec.kind == "countersink") topR = spec.csinkRadius;
  pts.push_back({topR, -above});
  roles.push_back("");  // top cap (outside the material)
  if (spec.kind == "counterbore") {
    pts.push_back({topR, spec.cboreDepth});
    roles.push_back("cbore.wall");
    pts.push_back({r, spec.cboreDepth});
    roles.push_back("cbore.floor");
  } else if (spec.kind == "countersink") {
    pts.push_back({topR, 0});
    roles.push_back("");  // above the face
    const double zc = (topR - r) / std::tan(spec.csinkAngle / 2);
    pts.push_back({r, zc});
    roles.push_back("csink");
  }
  pts.push_back({r, depth});
  roles.push_back("wall");
  if (!through && spec.tipAngle > 0) {
    pts.push_back({0, depth + r / std::tan(spec.tipAngle / 2)});
    roles.push_back("tip");
  } else {
    pts.push_back({0, depth});
    roles.push_back("bottom");
  }
  roles.push_back("");  // along the axis back to the start
  const gp_Pnt o = frame.Location();
  const gp_XYZ x = frame.XDirection().XYZ();
  const gp_XYZ z = frame.Direction().XYZ();
  auto to3d = [&](const P2& p) { return gp_Pnt(o.XYZ() + p.r * x + p.z * z); };
  BRepBuilderAPI_MakeWire mw;
  std::vector<std::pair<TopoDS_Edge, std::string>> edges;
  std::vector<TopoDS_Vertex> verts;
  for (const P2& p : pts) verts.push_back(BRepBuilderAPI_MakeVertex(to3d(p)).Vertex());
  for (size_t i = 0; i < pts.size(); ++i) {
    const size_t j = (i + 1) % pts.size();
    BRepBuilderAPI_MakeEdge me(verts[i], verts[j]);
    if (!me.IsDone()) raiseError("OPERATION_FAILED", "The hole profile could not be built");
    mw.Add(me.Edge());
    edges.emplace_back(me.Edge(), roles[i].empty() ? std::string() : base + ":" + roles[i]);
  }
  BRepBuilderAPI_MakeFace mf(gp_Pln(gp_Ax3(o, frame.YDirection(), frame.XDirection())), mw.Wire(), true);
  if (!mf.IsDone()) raiseError("OPERATION_FAILED", "The hole profile could not be built");
  BRepPrimAPI_MakeRevol revol(mf.Face(), gp_Ax1(o, frame.Direction()), 2 * kPi, false);
  revol.Build();
  if (!revol.IsDone()) raiseError("OPERATION_FAILED", "The hole tool could not be built");
  TopoDS_Shape shape = revol.Shape();
  if (solidVolume(shape) < 0) shape.Reverse();
  const Topo topo(shape);
  std::vector<std::string> names(static_cast<size_t>(topo.faces.Extent()));
  nameFromProfileEdges(revol, topo, edges, names);
  NamedShape ns;
  ns.shape = shape;
  ns.faces = std::move(names);
  return ns;
}

std::string execHole(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const int th = optHandle(inputs, "target");
  std::shared_ptr<const ShapeRecord> target;
  if (th != 0) target = requireShape(th);
  // Without a target (or with op "new") the result is the drill solids themselves: the tool shape
  // mirror/pattern copies apply.
  const std::string op = optString(feature, "op", target ? "cut" : "new");
  if (op != "cut" && op != "new") raiseError("INVALID_INPUT", "hole.op must be cut (default) or new (the tool solid)");
  if (!target && op == "cut") {
    raiseError("UNRESOLVED_REFERENCE", "There is no body to drill", "Place the hole on a face of a body.");
  }
  // Hole frames, ordered by index.
  std::vector<std::pair<long, gp_Ax2>> frames;
  if (const Json* fr = inputsObject(inputs, "frames")) {
    for (const auto& entry : fr->object) {
      if (entry.first.compare(0, 5, "hole:") != 0) continue;
      const std::string rest = entry.first.substr(5);
      if (rest.empty() || rest.find_first_not_of("0123456789") != std::string::npos) continue;
      frames.emplace_back(std::strtol(rest.c_str(), nullptr, 10), parseFrame(entry.second.get()));
    }
  }
  std::sort(frames.begin(), frames.end(), [](const std::pair<long, gp_Ax2>& a, const std::pair<long, gp_Ax2>& b) {
    return a.first < b.first;
  });
  if (frames.empty()) raiseError("UNRESOLVED_REFERENCE", "Place at least one hole point", "Add a sketch point on the face.");

  HoleSpec spec;
  spec.kind = optString(feature, "kind", "simple");
  if (spec.kind != "simple" && spec.kind != "counterbore" && spec.kind != "countersink" && spec.kind != "tapped") {
    raiseError("INVALID_INPUT", "Hole kind must be simple, counterbore, countersink or tapped");
  }
  const double diameter = requireValue(values, "/diameter", spec.kind == "tapped" ? "tap drill diameter" : "hole diameter");
  if (!(diameter > 1e-6)) raiseError("INVALID_INPUT", "Hole diameter must be greater than zero");
  spec.radius = diameter / 2;
  const Json* end = feature.get("end");
  const std::string endKind = end != nullptr && end->isObject() ? optString(*end, "kind", "") : "";
  if (endKind != "blind" && endKind != "throughAll" && endKind != "upTo") {
    raiseError("INVALID_INPUT", "Hole end must be blind, throughAll or upTo");
  }
  const bool through = endKind == "throughAll";
  if (endKind == "blind" && hasValue(values, "/tipAngle")) {
    spec.tipAngle = requireValue(values, "/tipAngle", "drill point angle");
    if (!(spec.tipAngle > 1e-6) || !(spec.tipAngle < kPi - 1e-6)) {
      raiseError("INVALID_INPUT", "The drill point angle must be between 0° and 180°", "118° is the usual drill point.");
    }
  }
  if (spec.kind == "counterbore") {
    spec.cboreRadius = requireValue(values, "/counterbore/diameter", "counterbore diameter") / 2;
    spec.cboreDepth = requireValue(values, "/counterbore/depth", "counterbore depth");
    if (!(spec.cboreRadius > spec.radius + 1e-6)) {
      raiseError("INVALID_INPUT", "The counterbore must be wider than the hole");
    }
    if (!(spec.cboreDepth > 1e-6)) raiseError("INVALID_INPUT", "Counterbore depth must be greater than zero");
  }
  if (spec.kind == "countersink") {
    spec.csinkRadius = requireValue(values, "/countersink/diameter", "countersink diameter") / 2;
    spec.csinkAngle = requireValue(values, "/countersink/angle", "countersink angle");
    if (!(spec.csinkRadius > spec.radius + 1e-6)) {
      raiseError("INVALID_INPUT", "The countersink must be wider than the hole");
    }
    if (!(spec.csinkAngle > 1e-6) || !(spec.csinkAngle < kPi - 1e-6)) {
      raiseError("INVALID_INPUT", "The countersink angle must be between 0° and 180°");
    }
  }
  double blindDepth = 0;
  if (endKind == "blind") {
    blindDepth = requireValue(values, "/end/depth", "hole depth");
    if (!(blindDepth > 1e-6)) raiseError("INVALID_INPUT", "Hole depth must be greater than zero");
  }
  double throughDepth = 0;
  if (through) {
    // Sized by the body when there is one; a bare tool is 10 m deep (longer than any part).
    throughDepth = 1e4;
    if (target) {
      Bnd_Box box;
      BRepBndLib::Add(target->shape, box);
      if (!box.IsVoid()) throughDepth = 2 * std::sqrt(box.SquareExtent()) + 1;
    }
  }
  gp_Pln upToPlane;
  bool haveUpTo = false;
  if (endKind == "upTo") {
    gp_Ax3 pl;
    std::string name;
    haveUpTo = planeInput(inputs, "/end/target", "upTo", pl, name);
    if (!haveUpTo) raiseError("UNRESOLVED_REFERENCE", "Select the face the hole goes up to");
    upToPlane = gp_Pln(pl);
  }
  const Json* points = feature.get("points");
  const std::string prefix = "F" + tag + ":hole(";
  std::vector<NamedInput> tools;
  std::vector<NamedShape> toolShapes;
  for (size_t i = 0; i < frames.size(); ++i) {
    const gp_Ax2& frame = frames[i].second;
    std::string point;
    const size_t pi = static_cast<size_t>(frames[i].first);
    if (points != nullptr && points->isArray() && pi < points->array.size() && points->array[pi]->isObject()) {
      point = optString(*points->array[pi], "name", "");
    }
    if (point.empty()) point = "#" + std::to_string(frames[i].first);
    double depth = blindDepth;
    if (through) depth = throughDepth;
    if (haveUpTo) {
      const gp_Dir n = upToPlane.Axis().Direction();
      const double cosA = gp_Vec(n).Dot(gp_Vec(frame.Direction()));
      if (std::fabs(cosA) < 1e-9) raiseError("INVALID_INPUT", "The up-to face is parallel to the hole axis");
      depth = gp_Vec(frame.Location(), upToPlane.Location()).Dot(gp_Vec(n)) / cosA;
      if (!(depth > 1e-6)) raiseError("INVALID_INPUT", "The up-to face is behind the hole", "Pick a face below the hole's face.");
    }
    if (spec.kind == "counterbore" && !through && spec.cboreDepth >= depth - 1e-6) {
      raiseError("INVALID_INPUT", "The counterbore is deeper than the hole");
    }
    if (spec.kind == "countersink" && !through &&
        (spec.csinkRadius - spec.radius) / std::tan(spec.csinkAngle / 2) >= depth - 1e-6) {
      raiseError("INVALID_INPUT", "The countersink is deeper than the hole");
    }
    toolShapes.push_back(holeTool(spec, frame, depth, through, prefix + point + ")"));
  }
  for (const NamedShape& t : toolShapes) tools.push_back(namedInputOf(t));
  const std::string fallback = "F" + tag + ":unnamed";
  if (op == "new") {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    std::vector<std::string> names;
    for (const NamedInput& t : tools) {
      builder.Add(compound, t.shape);
      names.insert(names.end(), t.faceNames.begin(), t.faceNames.end());
    }
    const TopoDS_Shape shape = tools.size() == 1 ? tools[0].shape : TopoDS_Shape(compound);
    return storeResult(finalizeNamed(shape, std::move(names), fallback), {});
  }
  NamedShape result = multiToolBoolean(BOPAlgo_CUT, namedInputOf(*target), tools, fallback);
  std::vector<KernelError> warnings;
  bool touched = false;
  for (const std::string& n : result.faces) touched = touched || n.compare(0, prefix.size(), prefix) == 0;
  if (!touched) {
    warnings.push_back(warning("OPERATION_FAILED", "The hole does not cut the body",
                               "Place the hole points on a face of the body."));
  }
  if (Topo(result.shape).faces.Extent() == 0) raiseError("OPERATION_FAILED", "The holes remove the whole body");
  return storeResult(result, warnings);
}

// ---------------------------------------------------------------------------------------------
// Import feature: imported raw shapes (inputs.shapes["source…"], from importFile) placed by the
// feature's frame and named F<id>:face#k per body (geometric key); bodies ordered by the
// geometric key of their volume centroid. add/cut/intersect name tool faces
// F<id>:face(F<id>:face#k). A mesh reference body has one face F<id>:face and no edge names.
// ---------------------------------------------------------------------------------------------

std::string execImport(const Json& feature, const Json& inputs, const std::string& tag) {
  std::vector<std::pair<std::string, std::shared_ptr<const ShapeRecord>>> sources;
  if (const Json* shapes = inputsObject(inputs, "shapes")) {
    for (const auto& entry : shapes->object) {
      if (entry.first.compare(0, 6, "source") != 0) continue;
      if (!entry.second->isNumber()) raiseError("INVALID_INPUT", "inputs.shapes[\"" + entry.first + "\"] must be a shape handle");
      sources.emplace_back(entry.first, requireShape(static_cast<int>(entry.second->number)));
    }
  }
  std::sort(sources.begin(), sources.end(),
            [](const std::pair<std::string, std::shared_ptr<const ShapeRecord>>& a,
               const std::pair<std::string, std::shared_ptr<const ShapeRecord>>& b) { return a.first < b.first; });
  if (sources.empty()) {
    raiseError("UNRESOLVED_REFERENCE", "The imported file has no shapes",
               "Pass the imported bodies as inputs.shapes[\"source…\"].");
  }
  const std::string op = optString(feature, "op", "new");
  const gp_Ax2 placement = parseFrame(feature.get("frame"));
  gp_Trsf trsf;
  trsf.SetDisplacement(gp_Ax3(), gp_Ax3(placement));
  const bool identity = trsf.Form() == gp_Identity;
  const std::string base = "F" + tag + ":face";
  bool meshOnly = false;
  for (const auto& s : sources) meshOnly = meshOnly || s.second->meshOnly;
  if (meshOnly) {
    if (op != "new") {
      raiseError("INVALID_INPUT", "A mesh file can only be imported as a new reference body",
                 "Set the operation to New, or import a STEP file to combine it with bodies.");
    }
    std::vector<HandleGuard> guards(sources.size());
    std::vector<ShapeHandle> handlesOut;
    for (size_t i = 0; i < sources.size(); ++i) {
      ShapeRecord record;
      record.shape = identity ? sources[i].second->shape : sources[i].second->shape.Moved(TopLoc_Location(trsf));
      record.meshOnly = true;
      const Topo topo(record.shape);
      record.faceNames.assign(static_cast<size_t>(topo.faces.Extent()), base);
      guards[i].handle = handles().insert(std::move(record));
    }
    std::string extra;
    if (sources.size() > 1) {
      extra = ",\"bodies\":[";
      for (size_t i = 1; i < sources.size(); ++i) {
        if (i > 1) extra.push_back(',');
        extra += "{\"key\":" + jsonString(sources[i].first) + ",\"shape\":" + std::to_string(guards[i].handle) +
                 ",\"naming\":[{\"name\":" + jsonString(base) + ",\"kind\":\"face\",\"index\":0}]}";
      }
      extra += "]";
    }
    std::string json = okJson("{\"shape\":" + std::to_string(guards[0].handle) + ",\"naming\":[{\"name\":" +
                              jsonString(base) + ",\"kind\":\"face\",\"index\":0}],\"warnings\":[]" + extra + "}");
    for (HandleGuard& g : guards) g.release();
    return json;
  }
  struct Body {
    std::string key;
    NamedShape named;
    GeoKey order;
  };
  std::vector<Body> placed;
  for (const auto& s : sources) {
    for (TopExp_Explorer ex(s.second->shape, TopAbs_SOLID); ex.More(); ex.Next()) {
      Body b;
      b.key = s.first;
      const TopoDS_Shape shape = identity ? ex.Current() : ex.Current().Moved(TopLoc_Location(trsf));
      b.named = finalizeNamed(shape, std::vector<std::string>(static_cast<size_t>(Topo(shape).faces.Extent()), base), base);
      GProp_GProps props;
      BRepGProp::VolumeProperties(shape, props);
      b.order = geoKey(props.CentreOfMass());
      placed.push_back(std::move(b));
    }
    if (TopExp_Explorer(s.second->shape, TopAbs_SOLID).More()) continue;
    // Shells or faces (e.g. IGES surfaces): one body.
    Body b;
    b.key = s.first;
    const TopoDS_Shape shape = identity ? s.second->shape : s.second->shape.Moved(TopLoc_Location(trsf));
    b.named = finalizeNamed(shape, std::vector<std::string>(static_cast<size_t>(Topo(shape).faces.Extent()), base), base);
    b.order = geoKey(boxCenter(shape));
    placed.push_back(std::move(b));
  }
  if (placed.empty()) raiseError("INVALID_INPUT", "The imported file contains no shapes");
  std::stable_sort(placed.begin(), placed.end(), [](const Body& a, const Body& b) { return a.order < b.order; });
  if (op == "new") {
    std::vector<HandleGuard> guards(placed.size());
    for (size_t i = 0; i < placed.size(); ++i) guards[i].handle = storeNamed(placed[i].named);
    std::string extra;
    if (placed.size() > 1) {
      extra = ",\"bodies\":[";
      for (size_t i = 1; i < placed.size(); ++i) {
        if (i > 1) extra.push_back(',');
        extra += "{\"key\":" + jsonString("body#" + std::to_string(i)) + ",\"shape\":" +
                 std::to_string(guards[i].handle) + ",\"naming\":" + namingJson(namingEntries(placed[i].named)) + "}";
      }
      extra += "]";
    }
    std::string json = featureResultJson(guards[0].handle, placed[0].named, {}, extra);
    for (HandleGuard& g : guards) g.release();
    return json;
  }
  // Body op: one tool of all solids, tool faces F<id>:face(<own name>).
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  NamedShape tool;
  for (const Body& b : placed) {
    builder.Add(compound, b.named.shape);
    for (const std::string& n : b.named.faces) tool.faces.push_back(base + "(" + n + ")");
  }
  tool.shape = placed.size() == 1 ? placed[0].named.shape : TopoDS_Shape(compound);
  return applyBodyOp(tool, op, inputs, tag, {});
}

// ---------------------------------------------------------------------------------------------
// Cosmetic thread: no geometry change; validates the face and reports its axis as `frame`.
// ---------------------------------------------------------------------------------------------

std::string execThread(const Json& /*feature*/, const Json& inputs, const std::string& /*tag*/) {
  RefTarget face;
  if (!singleRef(inputs, "/face", face)) raiseError("UNRESOLVED_REFERENCE", "Select the cylindrical face to thread");
  if (face.kind != "face") raiseError("INVALID_INPUT", "A thread goes on a cylindrical face", {}, {}, {face.name});
  BRepAdaptor_Surface s(TopoDS::Face(face.sub), false);
  if (s.GetType() != GeomAbs_Cylinder) {
    raiseError("INVALID_INPUT", "A thread goes on a cylindrical face", "Pick the hole's or the shaft's wall.", {},
               {face.name});
  }
  const int th = optHandle(inputs, "target");
  const std::shared_ptr<const ShapeRecord> target = th != 0 ? requireShape(th) : face.record;
  const gp_Ax1 axis = s.Cylinder().Axis();
  ShapeRecord copy = *target;
  copy.topoCache.reset();
  NamedShape ns;
  ns.shape = copy.shape;
  ns.faces = copy.faceNames;
  ns.edges = copy.edgeNames;
  ns.vertices = copy.vertexNames;
  ns.aliases = copy.aliases;
  const gp_Ax3 frame(axis.Location(), axis.Direction());
  return storeResult(ns, {}, ",\"frame\":" + jsonFrame(frame) + ",\"radius\":" + jsonNumber(s.Cylinder().Radius()));
}
