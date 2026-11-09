// Whittle kernel façade — M3 shape operations: shell, draft, sweep, loft, plus the input helpers
// the later M3 files share (planes, lines and points from refs or frames).
// Names follow packages/contracts/src/naming.ts ("M3 additions").
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.

// ---------------------------------------------------------------------------------------------
// Input helpers: a reference is either a resolved sub-shape (inputs.refs[pointer]) or, for origin
// planes/axes/points and reference features, a frame (inputs.frames[pointer], or a role key).
// ---------------------------------------------------------------------------------------------

bool singleRef(const Json& inputs, const std::string& pointer, RefTarget& out) {
  const Json* refs = inputsObject(inputs, "refs");
  if (refs == nullptr) return false;
  const Json* ref = refs->get(pointer);
  if (ref == nullptr || ref->kind == Json::Kind::Null) return false;
  out = resolveRef(*ref, pointer);
  return true;
}

const Json* frameFor(const Json& inputs, const std::string& pointer, const char* role) {
  const Json* f = frameInput(inputs, pointer.c_str());
  if (f == nullptr && role != nullptr) f = frameInput(inputs, role);
  return f;
}

// The JSON value at an RFC 6901 pointer (no ~ escapes; feature keys never need them).
const Json* jsonAt(const Json& root, const std::string& pointer) {
  const Json* node = &root;
  size_t pos = 1;
  while (node != nullptr && pos <= pointer.size()) {
    const size_t next = pointer.find('/', pos);
    const std::string token =
        pointer.substr(pos, next == std::string::npos ? std::string::npos : next - pos);
    if (node->isObject()) {
      node = node->get(token);
    } else if (node->isArray()) {
      if (token.empty() || token.find_first_not_of("0123456789") != std::string::npos) return nullptr;
      const size_t i = static_cast<size_t>(std::strtoul(token.c_str(), nullptr, 10));
      node = i < node->array.size() ? node->array[i].get() : nullptr;
    } else {
      return nullptr;
    }
    if (next == std::string::npos) break;
    pos = next + 1;
  }
  return node;
}

// The `kind` / `name` of an EntityRef in the feature JSON at `pointer` ("" when absent), so frames
// can be read as a plane (face), an axis (edge) or a point (vertex).
std::string refKindAt(const Json& feature, const std::string& pointer) {
  const Json* node = jsonAt(feature, pointer);
  return node != nullptr && node->isObject() ? optString(*node, "kind", "") : "";
}

std::string refNameAt(const Json& feature, const std::string& pointer) {
  const Json* node = jsonAt(feature, pointer);
  return node != nullptr && node->isObject() ? optString(*node, "name", "") : "";
}

// Plane of a planar face ref: a datum plane / sketch face uses its record frame, other faces their
// centroid and outward normal.
bool planeOfRef(const RefTarget& r, gp_Ax3& frame) {
  if (r.kind != "face") return false;
  const TopoDS_Face face = TopoDS::Face(r.sub);
  gp_Pln pln;
  gp_Dir n;
  if (!planeOf(face, pln, n)) return false;
  if (r.record->hasFrame && r.record->faceNames.size() == 1) {
    frame = r.record->frame;
    return true;
  }
  frame = gp_Ax3(faceCentroid(face), n, pln.Position().XDirection());
  return true;
}

// A plane from refs[pointer] (planar face) or frames[pointer] / frames[role].
bool planeInput(const Json& inputs, const std::string& pointer, const char* role, gp_Ax3& frame,
                std::string& name) {
  RefTarget r;
  if (singleRef(inputs, pointer, r)) {
    name = r.name;
    if (!planeOfRef(r, frame)) {
      raiseError("INVALID_INPUT", "This reference must be a plane or a planar face", {}, {},
                 {r.name});
    }
    return true;
  }
  const Json* f = frameFor(inputs, pointer, role);
  if (f == nullptr) return false;
  frame = gp_Ax3(parseFrame(f));
  return true;
}

// An axis from an edge (straight: first → last vertex; circular: its axis), a face (cylinder or
// cone: its axis; plane: its normal through the centroid) or a frame (origin + z).
bool lineOfRef(const RefTarget& r, gp_Ax1& axis) {
  if (r.kind == "edge") {
    const TopoDS_Edge edge = TopoDS::Edge(r.sub);
    if (BRep_Tool::Degenerated(edge)) return false;
    BRepAdaptor_Curve c(edge);
    if (c.GetType() == GeomAbs_Line) {
      TopoDS_Vertex v1, v2;
      TopExp::Vertices(edge, v1, v2, true);
      if (!v1.IsNull() && !v2.IsNull()) {
        const gp_Pnt a = BRep_Tool::Pnt(v1);
        const gp_Pnt b = BRep_Tool::Pnt(v2);
        if (a.Distance(b) > 1e-9) {
          axis = gp_Ax1(a, gp_Dir(gp_Vec(a, b)));
          return true;
        }
      }
      axis = gp_Ax1(c.Line().Location(), c.Line().Direction());
      return true;
    }
    if (c.GetType() == GeomAbs_Circle) {
      axis = c.Circle().Axis();
      return true;
    }
    return false;
  }
  if (r.kind == "face") {
    const TopoDS_Face face = TopoDS::Face(r.sub);
    BRepAdaptor_Surface s(face, false);
    if (s.GetType() == GeomAbs_Cylinder) {
      axis = s.Cylinder().Axis();
      return true;
    }
    if (s.GetType() == GeomAbs_Cone) {
      axis = s.Cone().Axis();
      return true;
    }
    gp_Pln pln;
    gp_Dir n;
    if (planeOf(face, pln, n)) {
      axis = gp_Ax1(faceCentroid(face), n);
      return true;
    }
  }
  return false;
}

bool lineInput(const Json& inputs, const std::string& pointer, const char* role, gp_Ax1& axis,
               std::string& name) {
  RefTarget r;
  if (singleRef(inputs, pointer, r)) {
    name = r.name;
    if (!lineOfRef(r, axis)) {
      raiseError("INVALID_INPUT",
                 "This reference must be a straight edge, an axis, a circular edge, a cylinder "
                 "or a plane",
                 {}, {}, {r.name});
    }
    return true;
  }
  const Json* f = frameFor(inputs, pointer, role);
  if (f == nullptr) return false;
  const gp_Ax2 ax = parseFrame(f);
  axis = gp_Ax1(ax.Location(), ax.Direction());
  return true;
}

// A point from a vertex, a circular edge (its centre) or a spherical face (its centre).
bool pointOfRef(const RefTarget& r, gp_Pnt& p) {
  if (r.kind == "vertex") {
    p = BRep_Tool::Pnt(TopoDS::Vertex(r.sub));
    return true;
  }
  if (r.kind == "edge") {
    const TopoDS_Edge edge = TopoDS::Edge(r.sub);
    if (BRep_Tool::Degenerated(edge)) return false;
    BRepAdaptor_Curve c(edge);
    if (c.GetType() == GeomAbs_Circle) {
      p = c.Circle().Location();
      return true;
    }
    if (c.GetType() == GeomAbs_Ellipse) {
      p = c.Ellipse().Location();
      return true;
    }
    return false;
  }
  if (r.kind == "face") {
    BRepAdaptor_Surface s(TopoDS::Face(r.sub), false);
    if (s.GetType() == GeomAbs_Sphere) {
      p = s.Sphere().Location();
      return true;
    }
  }
  return false;
}

bool pointInput(const Json& inputs, const std::string& pointer, const char* role, gp_Pnt& p,
                std::string& name) {
  RefTarget r;
  if (singleRef(inputs, pointer, r)) {
    name = r.name;
    if (!pointOfRef(r, p)) {
      raiseError("INVALID_INPUT",
                 "This reference must be a point, a vertex, a circular edge or a sphere", {}, {},
                 {r.name});
    }
    return true;
  }
  const Json* f = frameFor(inputs, pointer, role);
  if (f == nullptr) return false;
  p = parseFrame(f).Location();
  return true;
}

// A positive integer count (rounded; counts are `scalar` expressions).
int requireCount(const Json& values, const std::string& pointer, const std::string& label) {
  const double v = requireValue(values, pointer, label);
  const double rounded = std::floor(v + 0.5);
  if (std::fabs(v - rounded) > 1e-9 || rounded < 1) {
    raiseError("INVALID_INPUT", label + " must be a whole number of at least 1 (got " + jsonNumber(v) + ")");
  }
  if (rounded > 100000) raiseError("INVALID_INPUT", label + " is too large (at most 100000)");
  return static_cast<int>(rounded);
}

// Faces of a shape handle given as inputs.shapes[key] (e.g. "profile": a sketch's regions).
std::vector<RefTarget> facesOfShapeInput(const Json& inputs, const char* key) {
  std::vector<RefTarget> out;
  const Json* shapes = inputsObject(inputs, "shapes");
  if (shapes == nullptr) return out;
  const Json* h = shapes->get(key);
  if (h == nullptr || !h->isNumber()) return out;
  RefTarget base;
  base.handle = static_cast<int>(h->number);
  base.record = requireShape(base.handle);
  base.kind = "face";
  const Topo& topo = base.record->topo();
  for (int i = 1; i <= topo.faces.Extent(); ++i) {
    RefTarget t = base;
    t.index = i - 1;
    t.sub = topo.faces(i);
    const size_t idx = static_cast<size_t>(i - 1);
    if (idx < base.record->faceNames.size()) t.name = base.record->faceNames[idx];
    out.push_back(std::move(t));
  }
  return out;
}

std::string edgeNameIn(const ShapeRecord& record, const TopoDS_Shape& edge) {
  const int ei = record.topo().edges.FindIndex(edge);
  if (ei <= 0 || static_cast<size_t>(ei - 1) >= record.edgeNames.size()) return std::string();
  return record.edgeNames[static_cast<size_t>(ei - 1)];
}

std::string faceNameIn(const ShapeRecord& record, const TopoDS_Shape& face) {
  const int fi = record.topo().faces.FindIndex(face);
  if (fi <= 0 || static_cast<size_t>(fi - 1) >= record.faceNames.size()) return std::string();
  return record.faceNames[static_cast<size_t>(fi - 1)];
}

std::string occtDetail(const Standard_Failure& e) {
  const char* type = e.ExceptionType();
  const char* what = e.what();
  return std::string(type != nullptr ? type : "Standard_Failure") + ": " + (what != nullptr ? what : "");
}

// The single solid of a body (shell, draft). Compounds of one solid are unwrapped.
TopoDS_Shape singleSolid(const ShapeRecord& record, const char* verb) {
  TopoDS_Shape solid;
  int n = 0;
  for (TopExp_Explorer ex(record.shape, TopAbs_SOLID); ex.More(); ex.Next()) {
    if (n++ == 0) solid = ex.Current();
  }
  if (n != 1) {
    raiseError("INVALID_INPUT", std::string("Only a single solid body can be ") + verb,
               n == 0 ? "This body has no solid." : "Split the body first, or pick one solid.");
  }
  return solid;
}

// Self-intersection check (BOPAlgo_CheckerSI, as BOPAlgo_ArgumentAnalyzer does it).
bool selfIntersects(const TopoDS_Shape& shape) {
  BOPAlgo_CheckerSI checker;
  ShapeList args;
  args.Append(shape);
  checker.SetArguments(args);
  checker.SetNonDestructive(true);
  checker.SetRunParallel(false);
  checker.Perform();
  if (checker.HasErrors()) return true;
  const BOPDS_DS& ds = *(checker.PDS());
  for (NCollection_Map<BOPDS_Pair>::Iterator it(ds.Interferences()); it.More(); it.Next()) {
    int n1 = 0;
    int n2 = 0;
    it.Value().Indices(n1, n2);
    if (!ds.IsNewShape(n1) && !ds.IsNewShape(n2)) return true;
  }
  return false;
}

// Names faces of a swept/revolved solid after the profile edge each came from: the algorithm's
// Generated list first; then, for faces it missed (full revolutions), the single profile edge
// lying on the face's surface.
void nameFromProfileEdges(BRepBuilderAPI_MakeShape& algo, const Topo& topo,
                          const std::vector<std::pair<TopoDS_Edge, std::string>>& edges,
                          std::vector<std::string>& names) {
  auto assign = [&](const TopoDS_Shape& f, const std::string& name) {
    const int i = topo.faces.FindIndex(f);
    if (i > 0 && names[static_cast<size_t>(i - 1)].empty()) names[static_cast<size_t>(i - 1)] = name;
  };
  for (const auto& e : edges) {
    if (e.second.empty()) continue;
    for (const TopoDS_Shape& g : algo.Generated(e.first)) {
      if (g.ShapeType() == TopAbs_FACE) assign(g, e.second);
    }
  }
  for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
    if (!names[static_cast<size_t>(fi - 1)].empty()) continue;
    const TopoDS_Face& f = TopoDS::Face(topo.faces(fi));
    TopLoc_Location loc;
    const occ::handle<Geom_Surface> surface = BRep_Tool::Surface(f, loc);
    if (surface.IsNull()) continue;
    std::string match;
    int matches = 0;
    for (const auto& e : edges) {
      if (e.second.empty() || BRep_Tool::Degenerated(e.first)) continue;
      BRepAdaptor_Curve c(e.first);
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
      if (e.second != match) {
        match = e.second;
        ++matches;
      }
    }
    if (matches == 1) names[static_cast<size_t>(fi - 1)] = match;
  }
}

// ---------------------------------------------------------------------------------------------
// Shell (BRepOffset_MakeOffset: thick solid with open faces, or a closed hollow solid)
//
// Naming (naming.ts M3): kept faces keep their names; each offset face is F…:shell(<face>); the
// rim OCCT builds from each open face (Modified of the closing face: one annular face per open
// face, lying in its plane) is F…:rim(<open face>).
// ---------------------------------------------------------------------------------------------

std::string execShell(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const double t = requireValue(values, "/thickness", "shell thickness");
  if (!(t > 1e-6)) {
    raiseError("INVALID_INPUT", "Shell thickness must be greater than zero", "Enter a positive thickness.");
  }
  const std::string direction = optString(feature, "direction", "inward");
  if (direction != "inward" && direction != "outward") {
    raiseError("INVALID_INPUT", "Shell direction must be inward or outward");
  }
  const std::vector<RefTarget> open = refsAt(inputs, "/openFaces");
  std::shared_ptr<const ShapeRecord> target;
  const int th = optHandle(inputs, "target");
  if (th != 0) {
    target = requireShape(th);
  } else if (!open.empty()) {
    target = open[0].record;
  } else {
    const std::vector<RefTarget> body = refsAt(inputs, "/body");
    if (!body.empty()) target = body[0].record;
  }
  if (!target) raiseError("UNRESOLVED_REFERENCE", "Select the body to shell", "Pick a face to remove, or a body.");
  const TopoDS_Shape solid = singleSolid(*target, "shelled");
  const Topo& topo = target->topo();
  std::vector<int> openIdx;  // 1-based face indices of the target
  std::vector<std::string> openNames;
  for (const RefTarget& r : open) {
    if (r.kind != "face") raiseError("INVALID_INPUT", "Only faces can be removed by a shell", {}, {}, {r.name});
    const int fi = topo.faces.FindIndex(r.sub);
    if (fi <= 0) raiseError("INVALID_INPUT", "The face is not on the body", "Re-pick the face.", {}, {r.name});
    if (std::find(openIdx.begin(), openIdx.end(), fi) != openIdx.end()) continue;
    openIdx.push_back(fi);
    openNames.push_back(faceNameIn(*target, topo.faces(fi)));
  }
  if (static_cast<int>(openIdx.size()) >= topo.faces.Extent()) {
    raiseError("INVALID_INPUT", "A shell cannot remove every face of the body", {}, {}, openNames);
  }
  auto isOpen = [&](int fi) { return std::find(openIdx.begin(), openIdx.end(), fi) != openIdx.end(); };

  const double offset = direction == "inward" ? -t : t;
  const double before = solidVolume(solid);
  // Sharp (intersection) joins, like other CAD shells; when OCCT cannot intersect the offset
  // faces (some curved bodies), rounded (arc) joins, with a warning.
  std::string detail;
  auto attempt = [&](GeomAbs_JoinType join, std::unique_ptr<BRepOffset_MakeOffset>& mo) -> TopoDS_Shape {
    mo = std::make_unique<BRepOffset_MakeOffset>();
    TopoDS_Shape result;
    try {
      mo->Initialize(solid, offset, 1e-6, BRepOffset_Skin, /*Intersection=*/false, /*SelfInter=*/false,
                     join, /*Thickening=*/false, /*RemoveIntEdges=*/false);
      for (int fi : openIdx) mo->AddFace(TopoDS::Face(topo.faces(fi)));
      if (openIdx.empty()) {
        mo->MakeOffsetShape();
      } else {
        mo->MakeThickSolid();
      }
      if (!mo->IsDone()) {
        detail = "BRepOffset_Error " + std::to_string(static_cast<int>(mo->Error()));
        return TopoDS_Shape();
      }
      result = mo->Shape();
    } catch (const Standard_Failure& e) {
      detail = occtDetail(e);
      return TopoDS_Shape();
    }
    if (openIdx.empty()) {
      // Closed hollow solid: the original and the offset shell, one of them reversed as the void.
      const double offsetVolume = solidVolume(result);
      if (!(offsetVolume > 1e-9) || (offset < 0 && offsetVolume >= before) || selfIntersects(result)) {
        detail = "offset solid volume " + jsonNumber(offsetVolume);
        return TopoDS_Shape();
      }
      BRep_Builder builder;
      TopoDS_Solid hollow;
      builder.MakeSolid(hollow);
      const TopoDS_Shape& outer = offset < 0 ? solid : result;
      const TopoDS_Shape& inner = offset < 0 ? result : solid;
      for (TopExp_Explorer ex(outer, TopAbs_SHELL); ex.More(); ex.Next()) builder.Add(hollow, ex.Current());
      for (TopExp_Explorer ex(inner, TopAbs_SHELL); ex.More(); ex.Next()) {
        builder.Add(hollow, ex.Current().Reversed());
      }
      result = hollow;
    }
    const double after = solidVolume(result);
    if (!isValidShape(result) || !(after > 1e-9) || (offset < 0 && after >= before) ||
        (!openIdx.empty() && selfIntersects(result))) {
      detail = "result volume " + jsonNumber(after) + " (body " + jsonNumber(before) + ")";
      return TopoDS_Shape();
    }
    return result;
  };
  std::vector<KernelError> warnings;
  std::unique_ptr<BRepOffset_MakeOffset> moPtr;
  TopoDS_Shape result = attempt(GeomAbs_Intersection, moPtr);
  if (result.IsNull()) {
    const std::string sharpDetail = detail;
    result = attempt(GeomAbs_Arc, moPtr);
    if (result.IsNull()) {
      raiseError("OPERATION_FAILED", "The shell is too thick for this body",
                 "Try a thinner wall (thinner than half the body's smallest width).",
                 sharpDetail + "; arc joins: " + detail, openNames);
    }
    warnings.push_back(warning("OPERATION_FAILED", "The shell has rounded outside corners",
                               "OCCT could not build sharp corners for this body; the offset uses "
                               "rounded joins."));
  }
  BRepOffset_MakeOffset& mo = *moPtr;

  const Topo rt(result);
  std::vector<std::string> names(static_cast<size_t>(rt.faces.Extent()));
  auto assign = [&](const TopoDS_Shape& f, const std::string& name) {
    const int i = rt.faces.FindIndex(f);
    if (i > 0 && !name.empty() && names[static_cast<size_t>(i - 1)].empty()) names[static_cast<size_t>(i - 1)] = name;
  };
  const std::string prefix = "F" + tag + ":";
  // Kept faces (same TShape in the result).
  for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
    if (isOpen(fi)) continue;
    assign(topo.faces(fi), faceNameIn(*target, topo.faces(fi)));
  }
  // Offset faces.
  for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
    if (isOpen(fi)) continue;
    const std::string n = faceNameIn(*target, topo.faces(fi));
    if (n.empty()) continue;
    for (const TopoDS_Shape& g : mo.Generated(topo.faces(fi))) {
      if (g.ShapeType() == TopAbs_FACE) assign(g, prefix + "shell(" + n + ")");
    }
  }
  // Rims.
  for (size_t k = 0; k < openIdx.size(); ++k) {
    if (openNames[k].empty()) continue;
    for (const TopoDS_Shape& m : mo.Modified(topo.faces(openIdx[k]))) {
      if (m.ShapeType() == TopAbs_FACE) assign(m, prefix + "rim(" + openNames[k] + ")");
    }
  }
  // Kept faces OCCT rebuilt (new TShape on the original surface).
  for (int ri = 1; ri <= rt.faces.Extent(); ++ri) {
    if (!names[static_cast<size_t>(ri - 1)].empty()) continue;
    TopLoc_Location rl;
    const occ::handle<Geom_Surface> rs = BRep_Tool::Surface(TopoDS::Face(rt.faces(ri)), rl);
    for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
      if (isOpen(fi)) continue;
      TopLoc_Location ol;
      const occ::handle<Geom_Surface> os = BRep_Tool::Surface(TopoDS::Face(topo.faces(fi)), ol);
      if (!rs.IsNull() && rs == os && rl.IsEqual(ol)) {
        names[static_cast<size_t>(ri - 1)] = faceNameIn(*target, topo.faces(fi));
        break;
      }
    }
  }
  return storeResult(finalizeNamed(result, std::move(names), prefix + "unnamed"), warnings);
}

// ---------------------------------------------------------------------------------------------
// Draft (BRepOffsetAPI_DraftAngle): faces taper about a neutral plane along its normal.
// ---------------------------------------------------------------------------------------------

std::string execDraft(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const double angle = requireValue(values, "/angle", "draft angle");
  if (!(std::fabs(angle) > 1e-9) || std::fabs(angle) >= kPi / 2 - 1e-6) {
    raiseError("INVALID_INPUT", "Draft angle must be between 0° and 90°", "Enter an angle such as 3deg.");
  }
  const std::vector<RefTarget> faces = refsAt(inputs, "/faces");
  if (faces.empty()) raiseError("INVALID_INPUT", "Select at least one face to draft");
  const int th = optHandle(inputs, "target");
  const std::shared_ptr<const ShapeRecord> target = th != 0 ? requireShape(th) : faces[0].record;
  gp_Ax3 neutral;
  std::string neutralName;
  if (!planeInput(inputs, "/neutral", "neutral", neutral, neutralName)) {
    raiseError("UNRESOLVED_REFERENCE", "Select the neutral plane of the draft",
               "Pick a planar face or a plane.");
  }
  const Json* rev = feature.get("reverse");
  gp_Dir pull = neutral.Direction();
  if (rev != nullptr && rev->kind == Json::Kind::Bool && rev->boolean) pull.Reverse();
  const gp_Pln neutralPlane(neutral);
  const Topo& topo = target->topo();
  std::vector<std::string> faceNames;
  std::vector<TopoDS_Face> drafted;
  for (const RefTarget& r : faces) {
    if (r.kind != "face") raiseError("INVALID_INPUT", "Only faces can be drafted", {}, {}, {r.name});
    const int fi = topo.faces.FindIndex(r.sub);
    if (fi <= 0) raiseError("INVALID_INPUT", "The face is not on the body", "Re-pick the face.", {}, {r.name});
    drafted.push_back(TopoDS::Face(topo.faces(fi)));
    faceNames.push_back(faceNameIn(*target, topo.faces(fi)));
  }
  BRepOffsetAPI_DraftAngle draft(target->shape);
  TopoDS_Shape result;
  std::string detail;
  for (size_t i = 0; i < drafted.size(); ++i) {
    try {
      draft.Add(drafted[i], pull, angle, neutralPlane, true);
    } catch (const Standard_Failure& e) {
      detail = occtDetail(e);
    }
    if (!detail.empty() || !draft.AddDone()) {
      std::vector<std::string> refs{faceNames[i]};
      raiseError("OPERATION_FAILED", "This face cannot be drafted about the neutral plane",
                 "Faces parallel to the neutral plane cannot be drafted; pick side faces, or "
                 "another neutral plane.",
                 detail.empty() ? "Draft_ErrorStatus " + std::to_string(static_cast<int>(draft.Status())) : detail,
                 refs);
    }
  }
  try {
    draft.Build();
    if (draft.IsDone()) result = draft.Shape();
  } catch (const Standard_Failure& e) {
    detail = occtDetail(e);
  }
  if (result.IsNull() || !isValidShape(result) || !(solidVolume(result) > 1e-9)) {
    raiseError("OPERATION_FAILED", "The draft could not be built",
               "Try a smaller angle, or draft fewer faces at once.",
               detail.empty() ? "Draft_ErrorStatus " + std::to_string(static_cast<int>(draft.Status())) : detail,
               faceNames);
  }
  // BRepOffsetAPI_DraftAngle::Modified() returns nothing for the drafted faces themselves; the
  // modification's ModifiedShape() maps every face (drafted or rebuilt) to its result.
  const Topo rt(result);
  std::vector<std::string> names(static_cast<size_t>(rt.faces.Extent()));
  for (int fi = 1; fi <= topo.faces.Extent(); ++fi) {
    const std::string n = faceNameIn(*target, topo.faces(fi));
    if (n.empty()) continue;
    TopoDS_Shape image;
    try {
      image = draft.ModifiedShape(topo.faces(fi));
    } catch (const Standard_Failure&) {
      continue;
    }
    const int ri = image.IsNull() ? 0 : rt.faces.FindIndex(image);
    if (ri > 0 && names[static_cast<size_t>(ri - 1)].empty()) names[static_cast<size_t>(ri - 1)] = n;
  }
  carryFaceNames(draft, namedInputOf(*target), rt, names, true);
  return storeResult(finalizeNamed(result, std::move(names), "F" + tag + ":unnamed"), {});
}

// ---------------------------------------------------------------------------------------------
// Sweep (BRepOffsetAPI_MakePipeShell per profile wire; holes cut out)
// ---------------------------------------------------------------------------------------------

TopoDS_Wire chainedPath(const Json& inputs, std::vector<std::string>& names) {
  const std::vector<RefTarget> refs = refsAt(inputs, "/path");
  if (refs.empty()) {
    raiseError("UNRESOLVED_REFERENCE", "Select the path to sweep along", "Pick sketch curves or model edges.");
  }
  BRepBuilderAPI_MakeWire mw;
  for (const RefTarget& r : refs) {
    names.push_back(r.name);
    if (r.kind != "edge") raiseError("INVALID_INPUT", "The sweep path must be made of edges", {}, {}, {r.name});
    mw.Add(TopoDS::Edge(r.sub));
    if (mw.Error() != BRepBuilderAPI_WireDone) {
      raiseError("INVALID_INPUT", "The path edges do not form one connected chain",
                 "Pick edges that join end to end, in order.", {}, {r.name});
    }
  }
  if (!mw.IsDone()) raiseError("INVALID_INPUT", "The sweep path is not a connected chain");
  return mw.Wire();
}

NamedShape pipeOfWire(const TopoDS_Wire& wire, const TopoDS_Wire& path, bool fixed,
                      const gp_Ax3& profileFrame, const Profile& profile, const std::string& tag,
                      bool caps) {
  const std::string prefix = "F" + tag + ":";
  BRepOffsetAPI_MakePipeShell pipe(path);
  if (fixed) {
    pipe.SetMode(gp_Ax2(profileFrame.Location(), profileFrame.Direction(), profileFrame.XDirection()));
  } else {
    pipe.SetMode(false);  // corrected Frenet: no twist on planar or nearly planar paths
  }
  pipe.Add(wire, /*WithContact=*/false, /*WithCorrection=*/false);
  std::string detail;
  bool solid = false;
  try {
    pipe.Build();
    if (pipe.IsDone()) solid = pipe.MakeSolid();
  } catch (const Standard_Failure& e) {
    detail = occtDetail(e);
  }
  if (!solid) {
    raiseError("OPERATION_FAILED", "The profile cannot be swept along this path",
               "Check that the path starts at the profile and has no sharp corners.",
               detail.empty() ? "BRepBuilderAPI_PipeError " + std::to_string(static_cast<int>(pipe.GetStatus())) : detail);
  }
  const TopoDS_Shape shape = pipe.Shape();
  const Topo topo(shape);
  std::vector<std::string> names(static_cast<size_t>(topo.faces.Extent()));
  auto assign = [&](const TopoDS_Shape& f, const std::string& name) {
    if (f.IsNull()) return;
    const int i = topo.faces.FindIndex(f);
    if (i > 0 && names[static_cast<size_t>(i - 1)].empty()) names[static_cast<size_t>(i - 1)] = name;
  };
  if (caps) {
    assign(pipe.FirstShape(), prefix + "start");
    assign(pipe.LastShape(), prefix + "end");
  }
  std::vector<std::pair<TopoDS_Edge, std::string>> edges;
  for (TopExp_Explorer ex(wire, TopAbs_EDGE); ex.More(); ex.Next()) {
    const std::string n = profileEdgeName(profile, ex.Current());
    edges.emplace_back(TopoDS::Edge(ex.Current()), prefix + "side(" + (n.empty() ? std::string("?") : n) + ")");
  }
  nameFromProfileEdges(pipe, topo, edges, names);
  NamedShape ns;
  ns.shape = shape;
  ns.faces = std::move(names);
  return ns;
}

// Profile faces from refs "/profile/<n>" or every region of inputs.shapes.profile.
Profile sweepProfileInput(const Json& inputs) {
  if (!refsAt(inputs, "/profile").empty()) return collectProfile(inputs, "sweep");
  const std::vector<RefTarget> faces = facesOfShapeInput(inputs, "profile");
  if (faces.empty()) {
    raiseError("UNRESOLVED_REFERENCE", "Select at least one sketch region to sweep", "Pick a closed region of a sketch.");
  }
  Profile p;
  bool haveNormal = false;
  for (const RefTarget& r : faces) {
    const TopoDS_Face face = TopoDS::Face(r.sub);
    gp_Pln plane;
    gp_Dir n;
    if (!planeOf(face, plane, n)) raiseError("INVALID_INPUT", "Only planar regions can be swept", {}, {}, {r.name});
    if (r.record->hasFrame) n = r.record->frame.Direction();
    if (!haveNormal) {
      p.normal = n;
      p.origin = r.record->hasFrame ? r.record->frame.Location() : plane.Location();
      haveNormal = true;
    }
    p.faces.push_back(face);
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
      if (p.edgeMap.Add(ex.Current()) > static_cast<int>(p.edgeNames.size())) {
        p.edgeNames.push_back(edgeNameIn(*r.record, ex.Current()));
      }
    }
  }
  return p;
}

std::string execSweep(const Json& feature, const Json& inputs, const std::string& tag) {
  const Profile profile = sweepProfileInput(inputs);
  std::vector<std::string> pathNames;
  const TopoDS_Wire path = chainedPath(inputs, pathNames);
  const std::string orientation = optString(feature, "orientation", "followPath");
  if (orientation != "followPath" && orientation != "fixed") {
    raiseError("INVALID_INPUT", "Sweep orientation must be followPath or fixed");
  }
  const bool fixed = orientation == "fixed";
  const std::string op = optString(feature, "op", "new");
  const std::string fallback = "F" + tag + ":unnamed";
  const bool closedPath = BRep_Tool::IsClosed(path);
  std::vector<NamedShape> solids;
  for (const TopoDS_Face& face : profile.faces) {
    gp_Pln pln;
    gp_Dir n;
    planeOf(face, pln, n);
    const gp_Ax3 frame(pln.Location(), n, pln.Position().XDirection());
    const TopoDS_Wire outer = BRepTools::OuterWire(face);
    NamedShape solid = pipeOfWire(outer, path, fixed, frame, profile, tag, !closedPath);
    std::vector<NamedInput> holes;
    std::vector<NamedShape> holeSolids;
    for (TopoDS_Iterator it(face); it.More(); it.Next()) {
      if (it.Value().ShapeType() != TopAbs_WIRE || it.Value().IsSame(outer)) continue;
      holeSolids.push_back(pipeOfWire(TopoDS::Wire(it.Value()), path, fixed, frame, profile, tag, false));
    }
    for (const NamedShape& h : holeSolids) holes.push_back(namedInputOf(h));
    if (!holes.empty()) {
      solid = booleanNamed(BOPAlgo_CUT, {namedInputOf(solid)}, holes, nullptr, fallback);
    } else {
      solid = finalizeNamed(solid.shape, solid.faces, fallback);
    }
    solids.push_back(std::move(solid));
  }
  NamedShape tool = solids[0];
  if (solids.size() > 1) {
    std::vector<NamedInput> others;
    for (size_t i = 1; i < solids.size(); ++i) others.push_back(namedInputOf(solids[i]));
    tool = booleanNamed(BOPAlgo_FUSE, {namedInputOf(solids[0])}, others, nullptr, fallback);
  }
  if (!isValidShape(tool.shape) || !(solidVolume(tool.shape) > 1e-9) || selfIntersects(tool.shape)) {
    raiseError("OPERATION_FAILED", "The sweep intersects itself",
               "Use a smaller profile or a path with gentler bends.", {}, pathNames);
  }
  return applyBodyOp(tool, op, inputs, tag, {});
}

// ---------------------------------------------------------------------------------------------
// Loft (BRepOffsetAPI_ThruSections)
// ---------------------------------------------------------------------------------------------

std::string execLoft(const Json& feature, const Json& inputs, const std::string& tag) {
  const std::vector<RefTarget> sections = refsAt(inputs, "/sections");
  if (sections.size() < 2) {
    raiseError("INVALID_INPUT", "A loft needs at least two sections", "Pick two or more sketch regions.");
  }
  const Json* ruledJ = feature.get("ruled");
  const Json* closedJ = feature.get("closed");
  const bool ruled = ruledJ != nullptr && ruledJ->kind == Json::Kind::Bool && ruledJ->boolean;
  const bool closed = closedJ != nullptr && closedJ->kind == Json::Kind::Bool && closedJ->boolean;
  const std::string op = optString(feature, "op", "new");
  const std::string prefix = "F" + tag + ":";
  std::vector<KernelError> warnings;
  const Json* guides = feature.get("guides");
  if (guides != nullptr && guides->isArray() && !guides->array.empty()) {
    warnings.push_back(warning("UNSUPPORTED_FEATURE", "Loft guide curves are ignored",
                               "OCCT's loft (ThruSections) has no guide-curve support; add more "
                               "sections to shape the loft."));
  }
  BRepOffsetAPI_ThruSections loft(true, ruled, 1e-6);
  std::vector<std::pair<TopoDS_Edge, std::string>> sideEdges;  // first wire section
  TopoDS_Wire firstWire;
  bool haveFirstWire = false;
  for (size_t i = 0; i < sections.size(); ++i) {
    const RefTarget& r = sections[i];
    const bool end = i == 0 || i + 1 == sections.size();
    TopoDS_Wire wire;
    if (r.kind == "vertex") {
      if (!end || closed) {
        raiseError("INVALID_INPUT", "Only the first or last section of an open loft can be a point", {}, {}, {r.name});
      }
      loft.AddVertex(TopoDS::Vertex(r.sub));
      continue;
    }
    if (r.kind == "face") {
      const TopoDS_Face face = TopoDS::Face(r.sub);
      int wires = 0;
      for (TopoDS_Iterator it(face); it.More(); it.Next()) {
        if (it.Value().ShapeType() == TopAbs_WIRE) ++wires;
      }
      if (wires > 1) {
        raiseError("UNSUPPORTED_FEATURE", "Loft sections with holes are not supported yet",
                   "Loft the outer region, then cut the hole with a second loft.", {}, {r.name});
      }
      wire = BRepTools::OuterWire(face);
    } else if (r.kind == "edge") {
      BRepBuilderAPI_MakeWire mw(TopoDS::Edge(r.sub));
      if (!mw.IsDone() || !BRep_Tool::IsClosed(mw.Wire())) {
        raiseError("INVALID_INPUT", "A loft section must be a closed region or curve", {}, {}, {r.name});
      }
      wire = mw.Wire();
    } else {
      raiseError("INVALID_INPUT", "Loft sections must be regions, closed curves or points", {}, {}, {r.name});
    }
    loft.AddWire(wire);
    if (!haveFirstWire) {
      haveFirstWire = true;
      firstWire = wire;
      for (TopExp_Explorer ex(wire, TopAbs_EDGE); ex.More(); ex.Next()) {
        std::string n = r.kind == "edge" ? r.name : edgeNameIn(*r.record, ex.Current());
        sideEdges.emplace_back(TopoDS::Edge(ex.Current()), prefix + "side(" + (n.empty() ? std::string("?") : n) + ")");
      }
    }
  }
  if (!haveFirstWire) raiseError("INVALID_INPUT", "A loft needs at least one region section");
  if (closed) loft.AddWire(firstWire);
  loft.CheckCompatibility(true);
  TopoDS_Shape shape;
  std::string detail;
  try {
    loft.Build();
    if (loft.IsDone()) shape = loft.Shape();
  } catch (const Standard_Failure& e) {
    detail = occtDetail(e);
  }
  if (shape.IsNull()) {
    raiseError("OPERATION_FAILED", "The loft could not be built",
               "Check that the sections do not cross each other.", detail);
  }
  if (solidVolume(shape) < 0) shape.Reverse();
  const Topo topo(shape);
  std::vector<std::string> names(static_cast<size_t>(topo.faces.Extent()));
  auto assign = [&](const TopoDS_Shape& f, const std::string& name) {
    if (f.IsNull() || f.ShapeType() != TopAbs_FACE) return;
    const int i = topo.faces.FindIndex(f);
    if (i > 0 && names[static_cast<size_t>(i - 1)].empty()) names[static_cast<size_t>(i - 1)] = name;
  };
  if (!closed) {
    assign(loft.FirstShape(), prefix + "start");
    assign(loft.LastShape(), prefix + "end");
  }
  for (const auto& e : sideEdges) {
    for (const TopoDS_Shape& g : loft.Generated(e.first)) assign(g, e.second);
  }
  NamedShape tool = finalizeNamed(shape, std::move(names), prefix + "unnamed");
  if (!isValidShape(tool.shape) || !(solidVolume(tool.shape) > 1e-9)) {
    raiseError("OPERATION_FAILED", "The loft produced an invalid solid",
               "Check that the sections do not cross each other and face the same way.");
  }
  return applyBodyOp(tool, op, inputs, tag, std::move(warnings));
}
