// Whittle kernel façade — merging same-domain faces after a boolean (ADR-078).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.
//
// A boolean leaves faces that lie on one surface side by side when its tool shares a plane (or a
// cylinder, …) with the body: a plate and an upright fused flush along the back give two back
// faces with a seam between them. Such seams look wrong, add edges for downstream features to
// trip over, and make BRepOffset (shell) fail. `unifyBooleanResult` merges them with
// ShapeUpgrade_UnifySameDomain, restricted to the seams the operation created:
//   - between faces of two different inputs (the target body and a tool, two tools);
//   - between pieces of one input face that the operation split.
// Two faces that were already on one input (the target, or a tool body with earlier or imported
// splits) never merge, not even through a face of another input, so earlier features' topology
// stays as it was; two faces of different target bodies never end up in one face either; faces of
// different solids never merge. Vertices away from the merged faces are kept, so collinear edges
// elsewhere keep their split.
//
// Naming: the merged face keeps the name of the earliest-created face among the merged ones: a
// face that was on the target body beats one this operation brought in; among equals the smaller
// name wins (names start with the feature tag, a ULID, so that is the earlier feature; indices
// such as `#k` and `inst<k>` compare as numbers). Names never move: every sub-shape that survives
// keeps exactly the name it had without the merge (no `#k` renumbering), and a name is never given
// to a sub-shape it did not belong to. Every name the merge absorbed — a merged face's other
// names, and edge and vertex names that changed because of it — stays in the naming map as an
// alias of the surviving sub-shape (NamingEntry with the same kind and index, after the primary
// names). The regen engine reports a reference resolved through such an alias (kernel-client
// refs.ts, `merged`).

constexpr int kOriginUnknown = -1;  // a face no input claimed (not expected after a boolean)

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

// String order with digit runs compared as numbers ("inst2(" < "inst10(", "#9" < "#10").
bool naturalLess(const std::string& a, const std::string& b) {
  size_t i = 0;
  size_t j = 0;
  auto digit = [](char c) { return c >= '0' && c <= '9'; };
  while (i < a.size() && j < b.size()) {
    if (digit(a[i]) && digit(b[j])) {
      size_t ie = i;
      size_t je = j;
      while (ie < a.size() && digit(a[ie])) ++ie;
      while (je < b.size() && digit(b[je])) ++je;
      size_t is = i;
      size_t js = j;
      while (is + 1 < ie && a[is] == '0') ++is;  // leading zeros (ULIDs) don't change the value
      while (js + 1 < je && b[js] == '0') ++js;
      if (ie - is != je - js) return ie - is < je - js;
      const int c = a.compare(is, ie - is, b, js, je - js);
      if (c != 0) return c < 0;
      if (ie - i != je - j) return ie - i < je - j;
      i = ie;
      j = je;
      continue;
    }
    if (a[i] != b[j]) return a[i] < b[j];
    ++i;
    ++j;
  }
  return a.size() - i < b.size() - j;
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

// Trailing split index of a name ("X#3" → 3), -1 without one.
long splitIndex(const std::string& name) {
  const size_t hash = name.rfind('#');
  if (hash == std::string::npos || hash + 1 >= name.size()) return -1;
  if (name.find_first_not_of("0123456789", hash + 1) != std::string::npos) return -1;
  return std::strtol(name.c_str() + hash + 1, nullptr, 10);
}

// Names never move (see the top of this file), for one kind. `afterNames` are the names derived
// for the merged shape; `beforeNames` those the same operation gives without the merge.
//  - `restore`: a surviving sub-shape whose derived name differs from all its own old names only
//    by the split index gets its old name back (the smallest, if several merged into it), so
//    renumbering never shifts `#k` onto another piece.
//  - Then any name that belonged to a different sub-shape before is replaced by a fresh index of
//    its family (one past every index in use), so an old reference can only reach its own
//    sub-shape: through its name, its alias, or the resolver's evidence rules — never silently.
void keepNamesInPlace(const ShapeMap& beforeMap, const std::vector<std::string>& beforeNames,
                      const ShapeMap& afterMap, std::vector<std::string>& afterNames,
                      const occ::handle<BRepTools_History>& history, bool restore) {
  const int nAfter = afterMap.Extent();
  afterNames.resize(static_cast<size_t>(nAfter));
  std::vector<std::vector<int>> pre(static_cast<size_t>(nAfter + 1));
  std::map<std::string, int> owner;  // old name → old index
  for (int i = 1; i <= beforeMap.Extent(); ++i) {
    const size_t bi = static_cast<size_t>(i - 1);
    if (bi >= beforeNames.size() || beforeNames[bi].empty()) continue;
    owner[beforeNames[bi]] = i;
    for (int j : imagesIn(history, beforeMap(i), afterMap)) pre[static_cast<size_t>(j)].push_back(i);
  }
  auto oldName = [&](int i) -> const std::string& { return beforeNames[static_cast<size_t>(i - 1)]; };
  auto ownsOld = [&](int j, const std::string& name) {
    for (int i : pre[static_cast<size_t>(j)]) {
      if (oldName(i) == name) return true;
    }
    return false;
  };
  if (restore) {
    for (int j = 1; j <= nAfter; ++j) {
      std::string& name = afterNames[static_cast<size_t>(j - 1)];
      if (name.empty() || ownsOld(j, name)) continue;
      const std::string base = stripSplitSuffix(name);
      const std::string* pick = nullptr;
      for (int i : pre[static_cast<size_t>(j)]) {
        const std::string& o = oldName(i);
        if (stripSplitSuffix(o) == base && (pick == nullptr || naturalLess(o, *pick))) pick = &o;
      }
      if (pick != nullptr) name = *pick;
    }
  }
  std::set<std::string> used(afterNames.begin(), afterNames.end());
  for (const std::string& n : beforeNames) used.insert(n);
  for (int j = 1; j <= nAfter; ++j) {
    std::string& name = afterNames[static_cast<size_t>(j - 1)];
    if (name.empty()) continue;
    const auto it = owner.find(name);
    if (it == owner.end() || ownsOld(j, name)) continue;
    const std::string base = stripSplitSuffix(name);
    long next = 0;
    for (const std::string& n : used) {
      if (stripSplitSuffix(n) == base) next = std::max(next, splitIndex(n) + 1);
    }
    std::string fresh = base + "#" + std::to_string(next);
    while (used.count(fresh) != 0) fresh = base + "#" + std::to_string(++next);
    used.insert(fresh);
    name = fresh;
  }
}

// Aliases for names of `before` (one kind) that are not names in `after`: a name whose sub-shape
// went to exactly one sub-shape of `after`, which now has another name. (A name that is a primary
// name in `after` sits on its own sub-shape, see keepNamesInPlace.)
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
      if (aj < afterNames.size() && afterNames[aj] != old) targets[old].insert(j);
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

// Completes the naming of a boolean result `shape` whose faces carry the base names `names` and
// provenance `origin` (per TopExp face: the index of the input it came from — objects (target
// bodies) 0 … nObjects − 1, then the tools — or kOriginUnknown), merging the same-domain faces the
// operation left side by side (see the top of this file). Returns the named shape, with aliases
// for the absorbed names; when nothing merges this is exactly finalizeNamed(shape, names,
// fallback). See unifyBooleanResult below.
NamedShape unifyBooleanResultImpl(const TopoDS_Shape& shape, std::vector<std::string> names,
                                  const std::vector<int>& origin, int nObjects,
                                  const std::string& fallback) {
  const Topo t1(shape);
  const int nFaces = t1.faces.Extent();
  names.resize(static_cast<size_t>(nFaces));
  auto originOf = [&](int fi) {
    const size_t i = static_cast<size_t>(fi - 1);
    return i < origin.size() ? origin[i] : kOriginUnknown;
  };
  auto nameOf = [&](int fi) -> const std::string& { return names[static_cast<size_t>(fi - 1)]; };
  auto onTarget = [&](int fi) { return originOf(fi) >= 0 && originOf(fi) < nObjects; };
  // Earliest-created first: a face of the target body beats a tool's; then the smaller name.
  auto earlier = [&](int a, int b) {
    if (onTarget(a) != onTarget(b)) return onTarget(a);
    if (nameOf(a).empty() != nameOf(b).empty()) return !nameOf(a).empty();
    return naturalLess(nameOf(a), nameOf(b));
  };

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
    // Created by this operation: faces of two inputs meet, or one input face was split.
    const bool allowed = oa == kOriginUnknown || ob == kOriginUnknown || oa != ob ||
                         (!nameOf(a).empty() && nameOf(a) == nameOf(b));
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

  // 2. Merge groups. Per group and input, only the earliest face of that input may merge (with
  //    the pieces of it); and only one target body's face. Seams to the other faces stay, so two
  //    faces that were already on one input never become one face.
  FaceSets sets(nFaces);
  for (const Seam& s : seams) sets.join(s.a, s.b);
  std::map<std::pair<int, int>, int> keeper;  // (group root, input) → earliest face
  std::vector<int> targetKeeper(static_cast<size_t>(nFaces + 1), 0);
  for (int fi = 1; fi <= nFaces; ++fi) {
    const int o = originOf(fi);
    if (o == kOriginUnknown) continue;
    const int root = sets.find(fi);
    int& k = keeper[{root, o}];
    if (k == 0 || earlier(fi, k)) k = fi;
    if (onTarget(fi)) {
      int& t = targetKeeper[static_cast<size_t>(root)];
      if (t == 0 || earlier(fi, t)) t = fi;
    }
  }
  auto conflicts = [&](int fi) {
    const int o = originOf(fi);
    if (o == kOriginUnknown) return false;
    const int root = sets.find(fi);
    if (nameOf(fi) != nameOf(keeper[{root, o}])) return true;
    const int t = targetKeeper[static_cast<size_t>(root)];
    return onTarget(fi) && (originOf(t) != o || nameOf(t) != nameOf(fi));
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
  //    dropped (the seams stay, as before ADR-078).
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

  // 5. Names. `pre` is what the operation names without the merge (what stored references know).
  //    Each unified face takes its earliest contributor's final name from `pre`, unchanged — no
  //    renumbering of the faces that did not merge. Edges and vertices are derived from those face
  //    names, then pinned to their old names where only an index moved.
  std::vector<int> best(static_cast<size_t>(t2.faces.Extent() + 1), 0);
  for (int fi = 1; fi <= nFaces; ++fi) {
    for (int j : imagesIn(history, t1.faces(fi), t2.faces)) {
      int& b = best[static_cast<size_t>(j)];
      if (b == 0 || earlier(fi, b)) b = fi;
    }
  }
  const NamedShape pre = finalizeNamed(shape, std::move(names), fallback);
  NamedShape post;
  post.shape = unified;
  post.faces.assign(static_cast<size_t>(t2.faces.Extent()), std::string());
  for (int j = 1; j <= t2.faces.Extent(); ++j) {
    const int b = best[static_cast<size_t>(j)];
    post.faces[static_cast<size_t>(j - 1)] = b > 0 ? pre.faces[static_cast<size_t>(b - 1)] : fallback;
  }
  resolveFaceNames(post.faces, [&t2](size_t i) {
    return geoKey(faceCentroid(TopoDS::Face(t2.faces(static_cast<int>(i) + 1))));
  });
  keepNamesInPlace(t1.faces, pre.faces, t2.faces, post.faces, history, /*restore=*/false);
  deriveEdgeAndVertexNames(post, t2);
  keepNamesInPlace(t1.edges, pre.edges, t2.edges, post.edges, history, /*restore=*/true);
  keepNamesInPlace(t1.vertices, pre.vertices, t2.vertices, post.vertices, history, /*restore=*/true);
  aliasesFor(t1.faces, pre.faces, t2.faces, post.faces, history, "face", post.aliases);
  aliasesFor(t1.edges, pre.edges, t2.edges, post.edges, history, "edge", post.aliases);
  aliasesFor(t1.vertices, pre.vertices, t2.vertices, post.vertices, history, "vertex", post.aliases);
  return post;
}

// The merge is an improvement, never a reason to fail: if OCCT throws anywhere in it, the boolean
// result is named as it is, with its seams (as before ADR-078).
NamedShape unifyBooleanResult(const TopoDS_Shape& shape, std::vector<std::string> names,
                              const std::vector<int>& origin, int nObjects, const std::string& fallback) {
  try {
    return unifyBooleanResultImpl(shape, names, origin, nObjects, fallback);
  } catch (const Standard_Failure&) {
    return finalizeNamed(shape, std::move(names), fallback);
  }
}
