// Whittle kernel façade — push/pull direct editing (PLAN §9.2, §12 M2; ADR-009, ADR-010).
// Names follow packages/contracts/src/naming.ts, "M2 additions".
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.
//
// Algorithm (ADR-010):
//   1. Each selected planar face is copied and swept along its outward normal by the signed
//      distance d (BRepPrimAPI_MakePrism): outward for d > 0, into the body for d < 0.
//   2. One boolean with all prisms as tools: fuse when d > 0, cut when d < 0.
//   3. Coplanar (same-domain) faces that the operation leaves side by side are merged with
//      ShapeUpgrade_UnifySameDomain, restricted to seams the operation created: a new wall next to
//      an old face in the same plane (pulling a box top up makes the box taller, with no seam
//      line), a moved face flush with an old face (a pocket floor pulled up flush closes the
//      pocket), and pieces of one face that the boolean split. Old faces never merge with each
//      other, nor two different moved faces.
//   4. BRepCheck_Analyzer; ShapeFix_Shape only when the result is invalid; never return an
//      invalid shape.
// Names flow through every step's history (BOP Modified/IsDeleted, then BRepTools_History of the
// unify and fix steps). When faces merge, an old face's name beats a moved face's, which beats a
// wall's: a face that was already there keeps its identity, a moved face swallowed by a flush
// face disappears, and a wall merged into an old face takes that face's name.

enum PushPullRole : int { kRoleOld = 0, kRoleMoved = 1, kRoleWall = 2, kRoleNone = 3 };

struct RoledName {
  std::string name;
  int role = kRoleNone;
};

void assignRoled(std::vector<RoledName>& slots, int index1, const std::string& name, int role) {
  if (index1 <= 0 || name.empty()) return;
  RoledName& slot = slots[static_cast<size_t>(index1 - 1)];
  if (role < slot.role || (role == slot.role && name < slot.name)) {
    slot.name = name;
    slot.role = role;
  }
}

// Carries roled face names from `inputFaces` (an input of `algo`) to `result` through the
// history of a BRepBuilderAPI_MakeShape algorithm (a face that survives or is Modified keeps its
// name and role).
void carryRoled(BRepBuilderAPI_MakeShape& algo, const ShapeMap& inputFaces,
                const std::vector<RoledName>& inputNames, const Topo& result,
                std::vector<RoledName>& out) {
  for (int i = 1; i <= inputFaces.Extent(); ++i) {
    const RoledName& n = inputNames[static_cast<size_t>(i - 1)];
    if (n.name.empty()) continue;
    const TopoDS_Shape& face = inputFaces(i);
    if (algo.IsDeleted(face)) continue;
    const ShapeList& modified = algo.Modified(face);
    if (modified.IsEmpty()) {
      assignRoled(out, result.faces.FindIndex(face), n.name, n.role);
    } else {
      for (const TopoDS_Shape& m : modified) {
        assignRoled(out, result.faces.FindIndex(m), n.name, n.role);
      }
    }
  }
}

// Same through a BRepTools_History (unify, shape fix). A null history means "unchanged".
std::vector<RoledName> carryRoledHistory(const occ::handle<BRepTools_History>& history,
                                         const Topo& before, const std::vector<RoledName>& names,
                                         const Topo& after) {
  std::vector<RoledName> out(static_cast<size_t>(after.faces.Extent()));
  for (int i = 1; i <= before.faces.Extent(); ++i) {
    const RoledName& n = names[static_cast<size_t>(i - 1)];
    if (n.name.empty()) continue;
    const TopoDS_Shape& face = before.faces(i);
    if (history.IsNull()) {
      assignRoled(out, after.faces.FindIndex(face), n.name, n.role);
      continue;
    }
    if (history->IsRemoved(face)) continue;
    const ShapeList& modified = history->Modified(face);
    if (modified.IsEmpty()) {
      assignRoled(out, after.faces.FindIndex(face), n.name, n.role);
    } else {
      for (const TopoDS_Shape& m : modified) {
        if (m.ShapeType() == TopAbs_FACE) assignRoled(out, after.faces.FindIndex(m), n.name, n.role);
      }
    }
  }
  return out;
}

// May the seam between two faces be removed when they lie on the same surface?
bool pushPullMergeAllowed(const RoledName& a, const RoledName& b) {
  if (a.role == kRoleNone || b.role == kRoleNone) return false;
  if (a.name == b.name) return true;  // pieces of one face split by the boolean
  const int lo = std::min(a.role, b.role);
  const int hi = std::max(a.role, b.role);
  if (lo == kRoleOld) return hi == kRoleWall || hi == kRoleMoved;
  return lo == kRoleWall && hi == kRoleWall;
}

struct PushedFace {
  TopoDS_Face face;  // as oriented in the body (outward)
  int index = 0;     // 1-based TopExp index in the body
  std::string name;
  gp_Dir normal;
};

std::string execPushPull(const Json& /*feature*/, const Json& inputs, const std::string& tag) {
  const Json& values = valuesOf(inputs);
  const double d = requireValue(values, "/distance", "push/pull distance");
  const std::vector<RefTarget> refs = refsAt(inputs, "/faces");
  if (refs.empty()) {
    raiseError("UNRESOLVED_REFERENCE", "Select at least one face to push or pull",
               "Pick a flat face of a body.");
  }
  const int targetHandle = optHandle(inputs, "target");
  const std::shared_ptr<const ShapeRecord> target =
      targetHandle != 0 ? requireShape(targetHandle) : refs[0].record;
  if (target->meshOnly) {
    raiseError("INVALID_INPUT", "A mesh reference body cannot be pushed or pulled",
               "Meshes are for reference only; import a STEP file to model on it.");
  }
  if (countSolids(target->shape) == 0) {
    raiseError("INVALID_INPUT", "Push/pull needs a solid body",
               "Pick a face of a solid, not of a sketch or a plane.");
  }

  // Selected faces: planar, on the target body, each once.
  const Topo& topo = target->topo();
  std::vector<PushedFace> pushed;
  std::vector<std::string> pushedNames;
  for (size_t i = 0; i < refs.size(); ++i) {
    const RefTarget& r = refs[i];
    const std::string ordinal = std::to_string(i + 1);
    if (r.kind != "face") {
      raiseError("INVALID_INPUT",
                 "Only faces can be pushed or pulled (selection " + ordinal + " is a " + r.kind + ")",
                 "Pick flat faces.", "/faces/" + std::to_string(i), {r.name});
    }
    const int fi = topo.faces.FindIndex(r.sub);
    if (fi <= 0) {
      raiseError("INVALID_INPUT", "Selected face " + ordinal + " is not on the body being edited",
                 "Push/pull moves faces of one body at a time.", "/faces/" + std::to_string(i),
                 {r.name});
    }
    if (std::any_of(pushed.begin(), pushed.end(), [&](const PushedFace& p) { return p.index == fi; })) {
      continue;
    }
    PushedFace pf;
    pf.face = TopoDS::Face(topo.faces(fi));
    pf.index = fi;
    const size_t idx = static_cast<size_t>(fi - 1);
    pf.name = idx < target->faceNames.size() ? target->faceNames[idx] : std::string();
    gp_Pln plane;
    if (!planeOf(pf.face, plane, pf.normal)) {
      BRepAdaptor_Surface s(pf.face, false);
      raiseError("UNSUPPORTED_FEATURE",
                 "Selected face " + ordinal + " is curved (" + surfaceTypeName(s.GetType()) +
                     "); push/pull can only move flat faces for now",
                 "Pick a planar face. Curved faces are not supported yet.",
                 "/faces/" + std::to_string(i) + " = body face index " + std::to_string(fi - 1),
                 {pf.name.empty() ? r.name : pf.name});
    }
    pushedNames.push_back(pf.name);
    pushed.push_back(std::move(pf));
  }
  if (!(std::fabs(d) > 1e-6)) {
    raiseError("INVALID_INPUT", "Push/pull distance must not be zero",
               "Drag the arrow, or enter a distance (negative pushes into the body).", {},
               pushedNames);
  }

  // 1. One prism per face, along its outward normal by d. Each prism sweeps a copy of the face so
  //    tool and body share no topology (the coincident faces are then found geometrically).
  const std::string prefix = "F" + tag + ":";
  std::vector<TopoDS_Shape> prisms;
  std::vector<std::vector<RoledName>> prismNames;
  for (const PushedFace& pf : pushed) {
    BRepBuilderAPI_Copy copier(pf.face, /*copyGeom=*/true, /*copyMesh=*/false);
    const TopoDS_Face base = TopoDS::Face(copier.Shape());
    BRepPrimAPI_MakePrism prism(base, gp_Vec(pf.normal) * d, /*Copy=*/false, /*Canonize=*/true);
    prism.Build();
    if (!prism.IsDone()) {
      raiseError("OPERATION_FAILED", "Could not sweep the face", {}, {}, {pf.name});
    }
    TopoDS_Shape solid = prism.Shape();
    if (solidVolume(solid) < 0) solid.Reverse();
    const Topo pt(solid);
    std::vector<RoledName> names(static_cast<size_t>(pt.faces.Extent()));
    assignRoled(names, pt.faces.FindIndex(prism.LastShape()), pf.name, kRoleMoved);
    for (TopExp_Explorer ex(pf.face, TopAbs_EDGE); ex.More(); ex.Next()) {
      const int ei = topo.edges.FindIndex(ex.Current());
      const size_t eidx = static_cast<size_t>(ei - 1);
      const std::string edgeName =
          ei > 0 && eidx < target->edgeNames.size() && !target->edgeNames[eidx].empty()
              ? target->edgeNames[eidx]
              : std::string("?");
      for (const TopoDS_Shape& copied : copier.Modified(ex.Current())) {
        for (const TopoDS_Shape& g : prism.Generated(copied)) {
          if (g.ShapeType() != TopAbs_FACE) continue;
          assignRoled(names, pt.faces.FindIndex(g), prefix + "side(" + edgeName + ")", kRoleWall);
        }
      }
    }
    prisms.push_back(solid);
    prismNames.push_back(std::move(names));
  }

  // 2. Boolean: fuse (pull out) or cut (push in), all faces at once.
  const bool add = d > 0;
  ShapeList args;
  args.Append(target->shape);
  ShapeList toolList;
  for (const TopoDS_Shape& p : prisms) toolList.Append(p);
  BRepAlgoAPI_BooleanOperation bop;
  bop.SetOperation(add ? BOPAlgo_FUSE : BOPAlgo_CUT);
  bop.SetArguments(args);
  bop.SetTools(toolList);
  bop.SetRunParallel(false);
  bop.SetNonDestructive(true);  // the body is a cached regen result shared with other features
  bop.Build();
  if (bop.HasErrors() || !bop.IsDone()) {
    std::ostringstream diag;
    bop.DumpErrors(diag);
    raiseError("OPERATION_FAILED", "The push/pull could not be computed",
               "Try a slightly different distance.", diag.str(), pushedNames);
  }
  const TopoDS_Shape r1 = bop.Shape();
  const std::string amount = fmtMm(std::fabs(d)) + " mm";
  const char* what = pushed.size() > 1 ? "these faces" : "this face";
  if (countSolids(r1) == 0 || !(solidVolume(r1) > 1e-9)) {
    raiseError("OPERATION_FAILED",
               std::string("Pushing ") + what + " in by " + amount + " removes the whole body",
               "Use a smaller distance, or delete the body instead.", {}, pushedNames);
  }

  // Roled names on the boolean result: body faces first (old, or moved when selected — those
  // normally vanish), then each prism's (moved cap, walls).
  const Topo t1(r1);
  std::vector<RoledName> names1(static_cast<size_t>(t1.faces.Extent()));
  {
    std::vector<RoledName> bodyNames(static_cast<size_t>(topo.faces.Extent()));
    for (int i = 1; i <= topo.faces.Extent(); ++i) {
      const size_t idx = static_cast<size_t>(i - 1);
      if (idx >= target->faceNames.size()) continue;
      const bool selected = std::any_of(pushed.begin(), pushed.end(),
                                        [&](const PushedFace& p) { return p.index == i; });
      bodyNames[idx] = RoledName{target->faceNames[idx], selected ? kRoleMoved : kRoleOld};
    }
    carryRoled(bop, topo.faces, bodyNames, t1, names1);
    for (size_t p = 0; p < prisms.size(); ++p) {
      const Topo pt(prisms[p]);
      carryRoled(bop, pt.faces, prismNames[p], t1, names1);
    }
  }

  // 3. Merge the seams the operation created between faces on one surface.
  TopoDS_Shape r2 = r1;
  std::vector<RoledName> names2 = names1;
  {
    NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> keep;
    ShapeListMap edgeFaces;
    TopExp::MapShapesAndAncestors(r1, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    bool anyMergeable = false;
    for (int e = 1; e <= edgeFaces.Extent(); ++e) {
      std::vector<int> faces;
      for (const TopoDS_Shape& f : edgeFaces(e)) {
        const int fi = t1.faces.FindIndex(f);
        if (fi > 0 && std::find(faces.begin(), faces.end(), fi) == faces.end()) faces.push_back(fi);
      }
      // Seams and free edges (one face) never join two faces, so they are not kept: a kept seam
      // makes UnifySameDomain drop its (periodic) face from every merge.
      if (faces.size() < 2) continue;
      const bool removable =
          faces.size() == 2 && pushPullMergeAllowed(names1[static_cast<size_t>(faces[0] - 1)],
                                                    names1[static_cast<size_t>(faces[1] - 1)]);
      if (removable) {
        anyMergeable = true;
      } else {
        keep.Add(edgeFaces.FindKey(e));
      }
    }
    // Only edges around the operation may be joined: every vertex that touches no moved face or
    // wall stays (so collinear edges elsewhere on the body keep their split).
    ShapeListMap vertexFaces;
    TopExp::MapShapesAndAncestors(r1, TopAbs_VERTEX, TopAbs_FACE, vertexFaces);
    for (int v = 1; v <= vertexFaces.Extent(); ++v) {
      bool near = false;
      for (const TopoDS_Shape& f : vertexFaces(v)) {
        const int fi = t1.faces.FindIndex(f);
        const int role = fi > 0 ? names1[static_cast<size_t>(fi - 1)].role : kRoleNone;
        if (role == kRoleMoved || role == kRoleWall) near = true;
      }
      if (!near) keep.Add(vertexFaces.FindKey(v));
    }
    if (anyMergeable) {
      ShapeUpgrade_UnifySameDomain unify(r1, /*UnifyEdges=*/true, /*UnifyFaces=*/true,
                                         /*ConcatBSplines=*/false);
      unify.SetSafeInputMode(true);
      unify.KeepShapes(keep);
      unify.Build();
      const TopoDS_Shape unified = unify.Shape();
      if (!unified.IsNull() && countSolids(unified) == countSolids(r1)) {
        r2 = unified;
        names2 = carryRoledHistory(unify.History(), t1, names1, Topo(r2));
      }
    }
  }

  // 4. Validity: heal only if needed; never hand back an invalid solid. A merge that broke a
  //    valid boolean result is dropped (the seams stay) before anything is healed.
  if (!r2.IsSame(r1) && !isValidShape(r2) && isValidShape(r1)) {
    r2 = r1;
    names2 = names1;
  }
  TopoDS_Shape r3 = r2;
  std::vector<RoledName> names3 = names2;
  if (!isValidShape(r2)) {
    ShapeFix_Shape fix(r2);
    fix.Perform();
    const TopoDS_Shape fixed = fix.Shape();
    if (fixed.IsNull() || !isValidShape(fixed)) {
      raiseError("OPERATION_FAILED", "The push/pull produced an invalid solid",
                 "Try a slightly different distance.", "BRepCheck_Analyzer: invalid after ShapeFix",
                 pushedNames);
    }
    const occ::handle<ShapeBuild_ReShape> context = fix.Context();
    names3 = carryRoledHistory(context.IsNull() ? occ::handle<BRepTools_History>()
                                                : context->History(),
                               Topo(r2), names2, Topo(fixed));
    r3 = fixed;
  }
  if (!(solidVolume(r3) > 1e-9)) {
    raiseError("OPERATION_FAILED",
               std::string("Pushing ") + what + " in by " + amount + " removes the whole body",
               "Use a smaller distance, or delete the body instead.", {}, pushedNames);
  }

  std::vector<KernelError> warnings;
  const int before = countSolids(target->shape);
  const int after = countSolids(r3);
  if (after > before) {
    warnings.push_back(warning("OPERATION_FAILED",
                               "The push/pull split the body into " + std::to_string(after) +
                                   " separate solids",
                               "Use a smaller distance to keep the body in one piece."));
  }

  std::vector<std::string> faceNames;
  faceNames.reserve(names3.size());
  for (const RoledName& n : names3) faceNames.push_back(n.name);
  return storeResult(finalizeNamed(r3, std::move(faceNames), prefix + "unnamed"), warnings);
}
