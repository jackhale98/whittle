// Whittle kernel façade — merging same-domain faces after a boolean (ADR-076).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.
//
// A boolean leaves faces that lie on one surface side by side when its tool shares a plane (or a
// cylinder, …) with the body: a plate and an upright fused flush along the back give two back
// faces with a seam between them. Such seams look wrong, add edges for downstream features to
// trip over, and make BRepOffset (shell) fail. `unifyBooleanResult` merges them with
// ShapeUpgrade_UnifySameDomain, restricted to the seams the operation created:
//   - a tool face (created by this operation) next to anything on the same surface;
//   - pieces of one body face that the operation split.
// Two faces that were already on the body never merge, so earlier features' topology stays as it
// was, and faces of different solids never merge. Vertices away from the merged faces are kept,
// so collinear edges elsewhere keep their split.
//
// Naming: the merged face keeps the name of the earliest-created face among the merged ones: a
// face that was on the body beats one this operation created; among equals the smaller name wins
// (names start with the feature tag, a ULID, so that is the earlier feature). Every other name the
// merge absorbed — and every edge and vertex name that changed because of it — stays in the naming
// map as an alias of the surviving sub-shape (NamingEntry with the same kind and index, after the
// primary names), so references to either original face keep resolving. The regen engine reports
// a reference resolved through such an alias (kernel-client refs.ts, `merged`).

constexpr int kOriginTool = -1;  // a face created by this operation (or of unknown provenance)

// Do two faces lie on the same surface? Same Geom_Surface and location, or the same analytic
// surface within 1e-6 mm / 1e-9 rad (UnifySameDomain then decides with its own tolerances; this is
// only a cheap filter so that most booleans never run it).
bool sameDomainFaces(const TopoDS_Face& a, const TopoDS_Face& b) {
  TopLoc_Location la;
  TopLoc_Location lb;
  const occ::handle<Geom_Surface> sa = BRep_Tool::Surface(a, la);
  const occ::handle<Geom_Surface> sb = BRep_Tool::Surface(b, lb);
  if (sa.IsNull() || sb.IsNull()) return false;
  if (sa == sb && la.IsEqual(lb)) return true;
  const BRepAdaptor_Surface A(a, false);
  const BRepAdaptor_Surface B(b, false);
  if (A.GetType() != B.GetType()) return false;
  constexpr double lin = 1e-6;
  constexpr double ang = 1e-9;
  switch (A.GetType()) {
    case GeomAbs_Plane: {
      const gp_Pln pa = A.Plane();
      const gp_Pln pb = B.Plane();
      return pa.Axis().IsParallel(pb.Axis(), ang) && pb.Distance(pa.Location()) < lin;
    }
    case GeomAbs_Cylinder: {
      const gp_Cylinder ca = A.Cylinder();
      const gp_Cylinder cb = B.Cylinder();
      return std::fabs(ca.Radius() - cb.Radius()) < lin && ca.Axis().IsParallel(cb.Axis(), ang) &&
             gp_Lin(cb.Axis()).Distance(ca.Location()) < lin;
    }
    case GeomAbs_Cone: {
      const gp_Cone ca = A.Cone();
      const gp_Cone cb = B.Cone();
      return std::fabs(ca.SemiAngle() - cb.SemiAngle()) < ang && ca.Axis().IsParallel(cb.Axis(), ang) &&
             ca.Apex().Distance(cb.Apex()) < lin;
    }
    case GeomAbs_Sphere: {
      const gp_Sphere sa2 = A.Sphere();
      const gp_Sphere sb2 = B.Sphere();
      return std::fabs(sa2.Radius() - sb2.Radius()) < lin && sa2.Location().Distance(sb2.Location()) < lin;
    }
    default:
      return false;
  }
}

// "edge(A#0|B)#1" -> "edge(A|B)": every split suffix removed (resolve.ts `baseName`).
std::string withoutSplits(const std::string& name) {
  std::string out;
  out.reserve(name.size());
  for (size_t i = 0; i < name.size(); ++i) {
    if (name[i] == '#' && i + 1 < name.size() && name[i + 1] >= '0' && name[i + 1] <= '9') {
      ++i;
      while (i + 1 < name.size() && name[i + 1] >= '0' && name[i + 1] <= '9') ++i;
      continue;
    }
    out.push_back(name[i]);
  }
  return out;
}

// Images of `s` (a sub-shape of the input) in `after` through a BRepTools_History: none when
// removed, its Modified shapes of the same type, else itself when it is still there.
std::vector<int> imagesIn(const occ::handle<BRepTools_History>& history, const TopoDS_Shape& s,
                          const ShapeMap& after) {
  std::vector<int> out;
  if (!history.IsNull()) {
    if (history->IsRemoved(s)) return out;
    const ShapeList& modified = history->Modified(s);
    if (!modified.IsEmpty()) {
      for (const TopoDS_Shape& m : modified) {
        if (m.ShapeType() != s.ShapeType()) continue;
        const int i = after.FindIndex(m);
        if (i > 0 && std::find(out.begin(), out.end(), i) == out.end()) out.push_back(i);
      }
      return out;
    }
  }
  const int i = after.FindIndex(s);
  if (i > 0) out.push_back(i);
  return out;
}

// Aliases for names of `before` (one kind) that changed in `after`: a name whose sub-shape went
// to exactly one sub-shape of `after` under another name. Names that only lost or changed a split
// suffix are left to the resolver's name-family rule, and a name that is a primary name in `after`
// is never an alias.
void aliasesFor(const ShapeMap& beforeMap, const std::vector<std::string>& beforeNames,
                const ShapeMap& afterMap, const std::vector<std::string>& afterNames,
                const occ::handle<BRepTools_History>& history, const char* kind,
                std::vector<NamingEntry>& out) {
  std::set<std::string> primary(afterNames.begin(), afterNames.end());
  std::map<std::string, std::set<int>> targets;
  for (int i = 1; i <= beforeMap.Extent(); ++i) {
    const size_t bi = static_cast<size_t>(i - 1);
    if (bi >= beforeNames.size() || beforeNames[bi].empty()) continue;
    const std::string& old = beforeNames[bi];
    if (primary.count(old) != 0) continue;
    for (int j : imagesIn(history, beforeMap(i), afterMap)) {
      const size_t aj = static_cast<size_t>(j - 1);
      if (aj >= afterNames.size() || afterNames[aj] == old) continue;
      if (withoutSplits(afterNames[aj]) == withoutSplits(old)) continue;
      targets[old].insert(j);
    }
  }
  for (const auto& t : targets) {
    if (t.second.size() == 1) out.push_back({t.first, kind, *t.second.begin() - 1});
  }
}

// Union-find over face indices (1-based).
struct FaceSets {
  std::vector<int> parent;
  explicit FaceSets(int n) : parent(static_cast<size_t>(n + 1)) {
    for (int i = 0; i <= n; ++i) parent[static_cast<size_t>(i)] = i;
  }
  int find(int i) {
    while (parent[static_cast<size_t>(i)] != i) {
      parent[static_cast<size_t>(i)] = parent[static_cast<size_t>(parent[static_cast<size_t>(i)])];
      i = parent[static_cast<size_t>(i)];
    }
    return i;
  }
  void join(int a, int b) { parent[static_cast<size_t>(find(a))] = find(b); }
};

// Is face a ranked before face b for keeping its name (earliest-created first)?
bool earlierFace(int originA, const std::string& nameA, int originB, const std::string& nameB) {
  const bool oldA = originA != kOriginTool;
  const bool oldB = originB != kOriginTool;
  if (oldA != oldB) return oldA;
  if (nameA.empty() != nameB.empty()) return !nameA.empty();
  return nameA < nameB;
}

// Completes the naming of a boolean result `shape` whose faces carry the base names `names` and
// provenance `origin` (per TopExp face: the index of the body it was on, or kOriginTool), merging
// the same-domain faces the operation left side by side (see the top of this file). Returns the
// named shape, with aliases for the absorbed names; when nothing merges this is exactly
// finalizeNamed(shape, names, fallback).
NamedShape unifyBooleanResult(const TopoDS_Shape& shape, std::vector<std::string> names,
                              const std::vector<int>& origin, const std::string& fallback) {
  const Topo t1(shape);
  const int nFaces = t1.faces.Extent();
  names.resize(static_cast<size_t>(nFaces));
  auto originOf = [&](int fi) {
    const size_t i = static_cast<size_t>(fi - 1);
    return i < origin.size() ? origin[i] : kOriginTool;
  };
  auto nameOf = [&](int fi) -> const std::string& { return names[static_cast<size_t>(fi - 1)]; };

  // 1. Seams the rules allow, on one surface.
  ShapeListMap edgeFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  ShapeListMap edgeSolids;
  const bool multiSolid = countSolids(shape) > 1;
  if (multiSolid) TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_SOLID, edgeSolids);
  struct Seam {
    int edge;  // index in edgeFaces
    int a;
    int b;
  };
  std::vector<Seam> seams;
  std::vector<char> joining(static_cast<size_t>(edgeFaces.Extent() + 1), 0);
  for (int e = 1; e <= edgeFaces.Extent(); ++e) {
    std::vector<int> faces;
    for (const TopoDS_Shape& f : edgeFaces(e)) {
      const int fi = t1.faces.FindIndex(f);
      if (fi > 0 && std::find(faces.begin(), faces.end(), fi) == faces.end()) faces.push_back(fi);
    }
    if (faces.size() < 2) continue;  // seams of periodic faces and free edges join nothing
    joining[static_cast<size_t>(e)] = 1;
    if (faces.size() != 2) continue;
    const int a = faces[0];
    const int b = faces[1];
    const int oa = originOf(a);
    const int ob = originOf(b);
    const bool allowed = oa == kOriginTool || ob == kOriginTool ||
                         (oa == ob && !nameOf(a).empty() && nameOf(a) == nameOf(b));
    if (!allowed) continue;
    if (multiSolid) {
      const ShapeList* solids = edgeSolids.Seek(edgeFaces.FindKey(e));
      int n = 0;
      if (solids != nullptr) {
        NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> distinct;
        for (const TopoDS_Shape& s : *solids) distinct.Add(s);
        n = distinct.Extent();
      }
      if (n > 1) continue;
    }
    if (!sameDomainFaces(TopoDS::Face(t1.faces(a)), TopoDS::Face(t1.faces(b)))) continue;
    seams.push_back(Seam{e, a, b});
  }
  if (seams.empty()) return finalizeNamed(shape, std::move(names), fallback);

  // 2. Merge groups; the earliest face of each group keeps its name. A group never absorbs a
  //    second face that was already on the body (the seams to it stay).
  FaceSets sets(nFaces);
  for (const Seam& s : seams) sets.join(s.a, s.b);
  std::vector<int> winner(static_cast<size_t>(nFaces + 1), 0);
  for (int fi = 1; fi <= nFaces; ++fi) {
    const int root = sets.find(fi);
    int& w = winner[static_cast<size_t>(root)];
    if (w == 0 || earlierFace(originOf(fi), nameOf(fi), originOf(w), nameOf(w))) w = fi;
  }
  auto conflicts = [&](int fi) {
    const int w = winner[static_cast<size_t>(sets.find(fi))];
    const int ow = originOf(w);
    const int of = originOf(fi);
    return ow != kOriginTool && of != kOriginTool && (of != ow || nameOf(fi) != nameOf(w));
  };
  std::vector<char> removable(static_cast<size_t>(edgeFaces.Extent() + 1), 0);
  std::vector<char> merging(static_cast<size_t>(nFaces + 1), 0);
  for (const Seam& s : seams) {
    if (conflicts(s.a) || conflicts(s.b)) continue;
    removable[static_cast<size_t>(s.edge)] = 1;
    merging[static_cast<size_t>(s.a)] = 1;
    merging[static_cast<size_t>(s.b)] = 1;
  }

  // 3. Keep every other joining edge, and every vertex that touches no merging face.
  NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> keep;
  bool any = false;
  for (int e = 1; e <= edgeFaces.Extent(); ++e) {
    if (removable[static_cast<size_t>(e)] != 0) {
      any = true;
    } else if (joining[static_cast<size_t>(e)] != 0) {
      keep.Add(edgeFaces.FindKey(e));
    }
  }
  if (!any) return finalizeNamed(shape, std::move(names), fallback);
  ShapeListMap vertexFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertexFaces);
  for (int v = 1; v <= vertexFaces.Extent(); ++v) {
    bool near = false;
    for (const TopoDS_Shape& f : vertexFaces(v)) {
      const int fi = t1.faces.FindIndex(f);
      if (fi > 0 && merging[static_cast<size_t>(fi)] != 0) near = true;
    }
    if (!near) keep.Add(vertexFaces.FindKey(v));
  }

  // 4. Unify; a merge that changes the solid count, breaks validity or changes the volume is
  //    dropped (the seams stay, as before ADR-076).
  TopoDS_Shape unified;
  occ::handle<BRepTools_History> history;
  try {
    ShapeUpgrade_UnifySameDomain unify(shape, /*UnifyEdges=*/true, /*UnifyFaces=*/true,
                                       /*ConcatBSplines=*/false);
    unify.SetSafeInputMode(true);
    unify.KeepShapes(keep);
    unify.Build();
    unified = unify.Shape();
    history = unify.History();
  } catch (const Standard_Failure&) {
    unified.Nullify();
  }
  if (unified.IsNull() || unified.IsSame(shape) || countSolids(unified) != countSolids(shape)) {
    return finalizeNamed(shape, std::move(names), fallback);
  }
  const Topo t2(unified);
  if (t2.faces.Extent() >= nFaces && t2.edges.Extent() >= t1.edges.Extent()) {
    return finalizeNamed(shape, std::move(names), fallback);
  }
  if (!isValidShape(unified) && isValidShape(shape)) return finalizeNamed(shape, std::move(names), fallback);
  if (countSolids(shape) > 0) {
    const double v1 = solidVolume(shape);
    const double v2 = solidVolume(unified);
    if (!(std::fabs(v2 - v1) <= 1e-9 * std::max(1.0, std::fabs(v1)))) {
      return finalizeNamed(shape, std::move(names), fallback);
    }
  }

  // 5. Names: each unified face takes its earliest contributor's base name; aliases from the
  //    names the operation would have given without the merge.
  std::vector<std::string> names2(static_cast<size_t>(t2.faces.Extent()));
  std::vector<int> best(static_cast<size_t>(t2.faces.Extent() + 1), 0);
  for (int fi = 1; fi <= nFaces; ++fi) {
    for (int j : imagesIn(history, t1.faces(fi), t2.faces)) {
      int& b = best[static_cast<size_t>(j)];
      if (b == 0 || earlierFace(originOf(fi), nameOf(fi), originOf(b), nameOf(b))) b = fi;
    }
  }
  for (int j = 1; j <= t2.faces.Extent(); ++j) {
    const int b = best[static_cast<size_t>(j)];
    if (b > 0) names2[static_cast<size_t>(j - 1)] = nameOf(b);
  }
  const NamedShape pre = finalizeNamed(shape, std::move(names), fallback);
  NamedShape post = finalizeNamed(unified, std::move(names2), fallback);
  aliasesFor(t1.faces, pre.faces, t2.faces, post.faces, history, "face", post.aliases);
  aliasesFor(t1.edges, pre.edges, t2.edges, post.edges, history, "edge", post.aliases);
  aliasesFor(t1.vertices, pre.vertices, t2.vertices, post.vertices, history, "vertex", post.aliases);
  return post;
}
