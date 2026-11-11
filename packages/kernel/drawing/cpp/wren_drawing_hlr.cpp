// Wren drawing kernel — hidden-line removal for one view (PLAN §3: HLRBRep_PolyAlgo drafts,
// HLRBRep_Algo exact output), section cuts and detail clips.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated drawing translation unit (see wren_drawing.h).
//
// Names: every projected curve carries the index of the input edge it comes from, in
// TopExp::MapShapes order of the loaded shape, so the worker can apply `edgeNames[i]`.
//  - Exact: HLRBRep_Data's edges are the edges of the OutLiner's shape (TopExp order of that
//    shape). Edges the OutLiner kept are the input edges themselves; edges it split where an
//    outline ends on them map back through HLRTopoBRep_Data::NewSOldS; internal outlines have no
//    edge (contracts: outlines have no edge name).
//  - Draft: HLRBRep_PolyAlgo reports the input edge of every segment (or the face, for outlines).
//  - Section views: the cut's history (BRepAlgoAPI Modified) maps the cut body's edges and faces
//    back.
// Outlines instead carry the index of the input face they outline (TopExp order, so the worker
// applies `faceNames[i]`; ADR-090 amendment, second gate round):
//  - Exact: an outline is an internal edge of one HLRBRep_FaceData. That face is the OutLiner's
//    copy of an input face, and HLRTopoBRep_OutLiner::ProcessFace records both the copy and the
//    outline edge against the input face (HLRTopoBRep_Data::AddOldS). Both records must agree.
//  - Draft: HLRBRep_PolyAlgo::Hide returns the input face of an outline segment.
// A seam that lies on a silhouette names its face as well (and keeps its edge index): the
// outliner drops an outline that coincides with an edge and flags the edge instead, so without
// this one side of a revolved part would have no face in the view through its profile plane.
//  - Exact: the sharp pass draws such a seam from the face it is closed on (FaceIterator OutLine
//    and Double); that face maps back like an outline's.
//  - Draft: PolyAlgo marks the segment `outl`; the edge is a seam when its only face is closed on
//    it (BRep_Tool::IsClosed).
// A face that cannot be determined is −1 (unnamed), never a guess.
// The classification (sharp, smooth, sewn, outline) reproduces HLRBRep_HLRToShape and
// HLRBRep_PolyHLRToShape exactly; they build new 2D edges and drop the link to the input edge,
// which is why their loops are re-implemented here instead of called.

enum EdgeClass { kSharp = 0, kSmooth = 1, kOutline = 2, kSewn = 3 };

const char* edgeClassName(int c) {
  switch (c) {
    case kSmooth: return "smooth";
    case kOutline: return "outline";
    case kSewn: return "sewn";
    default: return "sharp";
  }
}

struct OutCurve {
  bool visible = true;
  int cls = kSharp;
  int index = -1;  // input edge (TopExp order), −1 = none
  int face = -1;   // outlines: input face (TopExp order), −1 = none
  Curve2D curve;
};

struct SectionSpec {
  std::vector<gp_Pnt> cut;
  gp_Dir along;
  gp_Dir look;
  bool slice = false;
};

struct ViewRequest {
  ViewFrame frame;
  bool exact = false;
  bool hidden = true;
  bool smooth = true;
  double linearDeflection = 0.1;
  double angularDeflection = 0.35;
  double sampleTolerance = 1e-3;
  bool hasSection = false;
  SectionSpec section;
  bool hasClip = false;
  ClipCircle clip;
};

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

bool optBool(const Json& obj, const char* key, bool fallback) {
  const Json* v = obj.get(key);
  if (v == nullptr) return fallback;
  if (v->kind != Json::Kind::Bool) {
    raiseError("INVALID_INPUT", std::string("project: '") + key + "' must be true or false");
  }
  return v->boolean;
}

double optPositive(const Json& obj, const char* key, double fallback) {
  const Json* v = obj.get(key);
  if (v == nullptr) return fallback;
  if (!v->isNumber() || !std::isfinite(v->number) || !(v->number > 0)) {
    raiseError("INVALID_INPUT", std::string("project: '") + key + "' must be a positive number");
  }
  return v->number;
}

gp_XY requireVec2(const Json& obj, const char* key, const char* context) {
  const Json* v = obj.get(key);
  if (v == nullptr || !v->isArray() || v->array.size() != 2) {
    raiseError("INVALID_INPUT", std::string(context) + "." + key + " must be an [x, y] array");
  }
  double xy[2];
  for (int i = 0; i < 2; ++i) {
    const Json& c = *v->array[static_cast<size_t>(i)];
    if (!c.isNumber() || !std::isfinite(c.number)) {
      raiseError("INVALID_INPUT", std::string(context) + "." + key + " must contain finite numbers");
    }
    xy[i] = c.number;
  }
  return gp_XY(xy[0], xy[1]);
}

gp_Dir requireDir(const Json& obj, const char* key, const char* context) {
  const gp_XYZ v = requireVec3(obj, key, context);
  if (v.Modulus() < 1e-12) {
    raiseError("INVALID_INPUT", std::string(context) + "." + key + " must not be a zero vector");
  }
  return gp_Dir(v);
}

ViewRequest parseViewRequest(const Json& j) {
  ViewRequest r;
  const Json* frame = j.get("frame");
  if (frame == nullptr || !frame->isObject()) {
    raiseError("INVALID_INPUT", "project: 'frame' must be an object with x and y");
  }
  const gp_XYZ x0 = requireVec3(*frame, "x", "frame");
  const gp_XYZ y0 = requireVec3(*frame, "y", "frame");
  if (x0.Modulus() < 1e-12) raiseError("INVALID_INPUT", "frame.x must not be a zero vector");
  const gp_XYZ x = x0 / x0.Modulus();
  gp_XYZ y = y0 - x * y0.Dot(x);
  if (y.Modulus() < 1e-9 * std::max(1.0, y0.Modulus())) {
    raiseError("INVALID_INPUT", "frame.x and frame.y must not be parallel");
  }
  y /= y.Modulus();
  r.frame.x = x;
  r.frame.y = y;
  r.frame.z = x.Crossed(y);
  const std::string quality = requireString(j, "quality", "project");
  if (quality != "draft" && quality != "exact") {
    raiseError("INVALID_INPUT", "project: quality must be 'draft' or 'exact'");
  }
  r.exact = quality == "exact";
  r.hidden = optBool(j, "hidden", true);
  r.smooth = optBool(j, "smooth", true);
  r.linearDeflection = optPositive(j, "linearDeflection", r.linearDeflection);
  r.angularDeflection = optPositive(j, "angularDeflection", r.angularDeflection);
  r.sampleTolerance = optPositive(j, "sampleTolerance", r.sampleTolerance);
  if (const Json* s = j.get("section")) {
    if (!s->isObject()) raiseError("INVALID_INPUT", "project: 'section' must be an object");
    const Json* cut = s->get("cut");
    if (cut == nullptr || !cut->isArray() || cut->array.size() < 2) {
      raiseError("INVALID_INPUT", "section.cut needs at least two points");
    }
    for (const JsonPtr& p : cut->array) {
      const Json& v = *p;
      bool good = v.isArray() && v.array.size() == 3;
      for (size_t i = 0; good && i < 3; ++i) {
        good = v.array[i]->isNumber() && std::isfinite(v.array[i]->number);
      }
      if (!good) raiseError("INVALID_INPUT", "section.cut points must be finite [x, y, z] arrays");
      r.section.cut.emplace_back(v.array[0]->number, v.array[1]->number, v.array[2]->number);
    }
    r.section.along = requireDir(*s, "along", "section");
    r.section.look = requireDir(*s, "look", "section");
    const std::string depth = optString(*s, "depth", "full");
    if (depth != "full" && depth != "slice") {
      raiseError("INVALID_INPUT", "section.depth must be 'full' or 'slice'");
    }
    r.section.slice = depth == "slice";
    r.hasSection = true;
  }
  if (const Json* c = j.get("clip")) {
    if (!c->isObject()) raiseError("INVALID_INPUT", "project: 'clip' must be an object");
    r.clip.c = requireVec2(*c, "center", "clip");
    const Json* radius = c->get("radius");
    if (radius == nullptr || !radius->isNumber() || !std::isfinite(radius->number) ||
        !(radius->number > 0)) {
      raiseError("INVALID_INPUT", "clip.radius must be a positive number");
    }
    r.clip.r = radius->number;
    r.hasClip = true;
  }
  return r;
}

HLRAlgo_Projector projectorFor(const ViewFrame& f) {
  return HLRAlgo_Projector(gp_Ax2(gp::Origin(), gp_Dir(f.z), gp_Dir(f.x)));
}

double elapsedMs(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - since)
      .count();
}

// Input edge index (0-based TopExp order of the loaded shape) of an edge of the shape HLR runs
// on, or −1.
using EdgeOrigin = std::function<int(const TopoDS_Shape&)>;
// Input face index (0-based TopExp order of the loaded shape) of a face of the shape HLR runs on,
// or −1.
using FaceOrigin = std::function<int(const TopoDS_Shape&)>;

// ---------------------------------------------------------------------------------------------
// Exact: HLRBRep_Algo
// ---------------------------------------------------------------------------------------------

struct HlrPiece {
  int edge;  // HLRBRep_Data edge index (1-based)
  int cls;
  bool visible;
  double u1;
  double u2;
  int iface = 0;   // outlines (seams on the silhouette): their HLRBRep_Data face, 1-based; 0 = none
  int index = -1;  // input edge (TopExp order), −1 = none (set before merging)
  int face = -1;   // outlines: input face (TopExp order), −1 = none (set before merging)
  // Merge keys (mergePieces): the input edge or −edge, and the 3D curve with its location.
  int group = 0;
  const Geom_Curve* curve = nullptr;
  TopLoc_Location loc;
};

// HLRBRep_HLRToShape::InternalCompound / DrawFace / DrawEdge (OCCT 8.0.1) without building edges.
// typ: 5 sharp, 3 smooth (Rg1Line), 4 sewn (RgNLine), 2 outline; In3d = false.
class ExactCollector {
 public:
  ExactCollector(const occ::handle<HLRBRep_Data>& ds, std::vector<HlrPiece>& out)
      : ds_(ds), out_(out) {}

  void collect(int typ, bool visible) {
    const int ne = ds_->NbEdges();
    const int nf = ds_->NbFaces();
    for (int ie = 1; ie <= ne; ++ie) {
      HLRBRep_EdgeData& ed = ds_->EDataArray().ChangeValue(ie);
      if (ed.Selected() && !ed.Vertical()) {
        ed.Used(false);
        ed.HideCount(0);
      } else {
        ed.Used(true);
      }
    }
    for (int iface = 1; iface <= nf; ++iface) face(visible, typ, iface);
    if (typ >= 3) {
      for (int ie = 1; ie <= ne; ++ie) {
        HLRBRep_EdgeData& ed = ds_->EDataArray().ChangeValue(ie);
        if (!ed.Used()) {
          edge(visible, false, typ, ie, 0);
          ed.Used(true);
        }
      }
    }
  }

 private:
  static int classOf(int typ) {
    switch (typ) {
      case 3: return kSmooth;
      case 4: return kSewn;
      case 2: return kOutline;
      default: return kSharp;
    }
  }

  void face(bool visible, int typ, int iface) {
    HLRBRep_FaceIterator itf;
    for (itf.InitEdge(ds_->FDataArray().ChangeValue(iface)); itf.MoreEdge(); itf.NextEdge()) {
      const int ie = itf.Edge();
      HLRBRep_EdgeData& edf = ds_->EDataArray().ChangeValue(ie);
      if (edf.Used()) continue;
      bool todraw;
      if (typ == 2) {
        todraw = itf.Internal();
      } else if (typ == 3) {
        todraw = edf.Rg1Line() && !edf.RgNLine() && !itf.OutLine();
      } else if (typ == 4) {
        todraw = edf.RgNLine() && !itf.OutLine();
      } else {
        todraw = !itf.IsoLine() && !itf.Internal() && (!edf.Rg1Line() || itf.OutLine());
      }
      if (todraw) {
        // A seam (an edge closed on this face, Double) that an outline coincides with (OutLine):
        // the outliner drops that outline and the sharp pass draws the seam, which then outlines
        // this face too.
        const bool seamOutline = typ == 5 && itf.OutLine() && itf.Double();
        edge(visible, true, typ, ie, typ == 2 || seamOutline ? iface : 0);
        edf.Used(true);
      } else if ((typ > 4 || typ == 2) && (edf.Rg1Line() && !itf.OutLine())) {
        const int hc = edf.HideCount();
        if (hc > 0) {
          edf.Used(true);
        } else {
          edf.HideCount(hc + 1);  // try with another face
        }
      } else {
        edf.Used(true);
      }
    }
  }

  // iface: for outlines (typ 2), the face whose internal edge `ie` is; for a seam on the
  // silhouette, the face it is closed on; 0 otherwise.
  void edge(bool visible, bool inFace, int typ, int ie, int iface) {
    HLRBRep_EdgeData& ed = ds_->EDataArray().ChangeValue(ie);
    bool todraw;
    if (inFace) {
      todraw = true;
    } else if (typ == 3) {
      todraw = ed.Rg1Line() && !ed.RgNLine();
    } else if (typ == 4) {
      todraw = ed.RgNLine();
    } else {
      todraw = !ed.Rg1Line();
    }
    if (!todraw) return;
    double sta = 0;
    double end = 0;
    float tolSta = 0;
    float tolEnd = 0;
    HLRAlgo_EdgeIterator it;
    if (visible) {
      for (it.InitVisible(ed.Status()); it.MoreVisible(); it.NextVisible()) {
        it.Visible(sta, tolSta, end, tolEnd);
        out_.push_back(HlrPiece{ie, classOf(typ), true, sta, end, iface});
      }
    } else {
      for (it.InitHidden(ed.Status()); it.MoreHidden(); it.NextHidden()) {
        it.Hidden(sta, tolSta, end, tolEnd);
        out_.push_back(HlrPiece{ie, classOf(typ), false, sta, end, iface});
      }
    }
  }

  occ::handle<HLRBRep_Data> ds_;
  std::vector<HlrPiece>& out_;
};

// HLR splits an edge's visible (or hidden) part at every outline vertex, and the OutLiner splits
// the edge itself where an outline ends on it, so a rim seen whole comes back in several pieces on
// several HLR edges. Joins pieces of one input edge, class and role that lie on the same 3D curve
// (split edges share their Geom_Curve and its parameters) and meet; on a circle or ellipse also
// across its seam, so a rim seen whole is one curve. Outlines (no input edge) join per HLR edge.
void mergePieces(const occ::handle<HLRBRep_Data>& ds, std::vector<HlrPiece>& pieces) {
  for (HlrPiece& p : pieces) {
    TopLoc_Location loc;
    double f = 0;
    double l = 0;
    const TopoDS_Edge& e = TopoDS::Edge(ds->EdgeMap().FindKey(p.edge));
    const occ::handle<Geom_Curve> c = BRep_Tool::Curve(e, loc, f, l);
    p.curve = c.get();
    p.loc = loc;
    p.group = p.index >= 0 ? p.index : -p.edge;
  }
  std::sort(pieces.begin(), pieces.end(), [](const HlrPiece& a, const HlrPiece& b) {
    if (a.group != b.group) return a.group < b.group;
    if (a.cls != b.cls) return a.cls < b.cls;
    if (a.visible != b.visible) return a.visible > b.visible;
    if (a.face != b.face) return a.face < b.face;
    if (a.curve != b.curve) return std::less<const Geom_Curve*>()(a.curve, b.curve);
    return a.u1 < b.u1;
  });
  auto same = [](const HlrPiece& a, const HlrPiece& b) {
    return a.group == b.group && a.cls == b.cls && a.visible == b.visible && a.face == b.face &&
           a.curve != nullptr && a.curve == b.curve && a.loc.IsEqual(b.loc);
  };
  auto touches = [](double u, double v) {
    return std::fabs(u - v) <= 1e-9 * std::max(1.0, std::fabs(u));
  };
  std::vector<HlrPiece> merged;
  merged.reserve(pieces.size());
  for (const HlrPiece& p : pieces) {
    if (!merged.empty() && same(merged.back(), p) && touches(merged.back().u2, p.u1)) {
      merged.back().u2 = std::max(merged.back().u2, p.u2);
    } else {
      merged.push_back(p);
    }
  }
  // Across the seam of a circle or ellipse: [s, a] … [b, s + 2π] → [b, a + 2π].
  std::vector<HlrPiece> out;
  out.reserve(merged.size());
  for (size_t i = 0; i < merged.size();) {
    size_t j = i;
    while (j + 1 < merged.size() && same(merged[j + 1], merged[i])) ++j;
    const GeomAbs_CurveType type =
        ds->EDataArray().Value(merged[i].edge).Geometry().GetCurve().GetType();
    const bool conic = type == GeomAbs_Circle || type == GeomAbs_Ellipse;
    if (j > i && conic && touches(merged[i].u1 + 2 * kPi, merged[j].u2)) {
      HlrPiece wrapped = merged[j];
      wrapped.u2 = merged[i].u2 + 2 * kPi;
      for (size_t k = i + 1; k < j; ++k) out.push_back(merged[k]);
      out.push_back(wrapped);
    } else {
      for (size_t k = i; k <= j; ++k) out.push_back(merged[k]);
    }
    i = j + 1;
  }
  pieces = std::move(out);
}

void runExact(const TopoDS_Shape& shape, const ViewRequest& req, const EdgeOrigin& originOf,
              const FaceOrigin& faceOriginOf, std::vector<OutCurve>& out) {
  occ::handle<HLRBRep_Algo> algo = new HLRBRep_Algo();
  algo->Add(shape);
  algo->Projector(projectorFor(req.frame));
  algo->Update();
  algo->Hide();
  const occ::handle<HLRBRep_Data> ds = algo->DataStructure();
  if (ds.IsNull() || algo->NbShapes() < 1) {
    raiseError("OPERATION_FAILED", "Hidden-line removal failed for this view");
  }
  // HLRBRep_InternalAlgo::Update swallows an exception while outlining a shape and loads it empty;
  // an empty result for a shape with edges is a failure, never an empty view.
  if (ds->NbEdges() == 0) {
    TopExp_Explorer any(shape, TopAbs_EDGE);
    if (any.More()) {
      raiseError("OPERATION_FAILED", "Hidden-line removal failed for this view",
                 "Try the draft quality, or a slightly different view direction.");
    }
    return;
  }
  const occ::handle<HLRTopoBRep_OutLiner>& outliner = algo->ShapeBounds(1).Shape();
  HLRTopoBRep_Data& topoData = outliner->DataStructure();

  std::vector<HlrPiece> pieces;
  ExactCollector collector(ds, pieces);
  const int types[] = {5, 2, 3, 4};
  for (const int typ : types) {
    if (!req.smooth && (typ == 3 || typ == 4)) continue;
    collector.collect(typ, true);
    if (req.hidden) collector.collect(typ, false);
  }

  std::vector<int> originOfDs(static_cast<size_t>(ds->NbEdges()) + 1, -2);
  auto inputIndex = [&](int ie) {
    int& cached = originOfDs[static_cast<size_t>(ie)];
    if (cached != -2) return cached;
    const TopoDS_Shape& e = ds->EdgeMap().FindKey(ie);
    int idx = originOf(e);
    if (idx < 0) {
      const TopoDS_Shape old = topoData.NewSOldS(e);
      if (!old.IsNull() && old.ShapeType() == TopAbs_EDGE && !old.IsSame(e)) idx = originOf(old);
    }
    cached = idx;
    return idx;
  };
  // The input face of an HLRBRep_Data face: the OutLiner's copy maps back to it
  // (HLRTopoBRep_OutLiner::ProcessFace, AddOldS). −1 when unknown.
  const int nbFaces = ds->NbFaces();
  auto inputFaceOf = [&](int iface) {
    if (iface < 1 || iface > nbFaces || iface > ds->FaceMap().Extent()) return -1;
    const TopoDS_Shape old = topoData.NewSOldS(ds->FaceMap().FindKey(iface));
    return !old.IsNull() && old.ShapeType() == TopAbs_FACE ? faceOriginOf(old) : -1;
  };
  // An outline's input face, from the face it is internal to and from the outline edge itself
  // (ProcessFace records both against the input face). Either alone is enough; if both are known
  // they must agree. −1 when neither is known.
  auto outlineFace = [&](const HlrPiece& p) {
    const int byFace = inputFaceOf(p.iface);
    int byEdge = -1;
    const TopoDS_Shape old = topoData.NewSOldS(ds->EdgeMap().FindKey(p.edge));
    if (!old.IsNull() && old.ShapeType() == TopAbs_FACE) byEdge = faceOriginOf(old);
    if (byFace >= 0 && byEdge >= 0) return byFace == byEdge ? byFace : -1;
    return byFace >= 0 ? byFace : byEdge;
  };
  for (HlrPiece& p : pieces) {
    if (p.cls == kOutline) {
      p.index = -1;
      p.face = outlineFace(p);
    } else {
      p.index = inputIndex(p.edge);
      // A seam on the silhouette: the face it is closed on (it has no other).
      p.face = inputFaceOf(p.iface);
    }
  }
  mergePieces(ds, pieces);

  std::vector<Curve2D> curves;
  for (const HlrPiece& p : pieces) {
    curves.clear();
    const HLRBRep_EdgeData& ed = ds->EDataArray().Value(p.edge);
    projectSegment(ed.Geometry().GetCurve(), p.u1, p.u2, req.frame, req.sampleTolerance, curves);
    for (Curve2D& c : curves) {
      OutCurve oc;
      oc.visible = p.visible;
      oc.cls = p.cls;
      oc.index = p.index;
      oc.face = p.face;
      oc.curve = std::move(c);
      out.push_back(std::move(oc));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Draft: HLRBRep_PolyAlgo
// ---------------------------------------------------------------------------------------------

// Joins segments that share end points (bit-identical: PolyAlgo's neighbouring segments share
// their nodes) into chains.
std::vector<std::vector<gp_XY>> chainSegments(const std::vector<std::pair<gp_XY, gp_XY>>& segs) {
  std::map<std::pair<double, double>, int> ids;
  std::vector<gp_XY> nodes;
  std::vector<std::vector<int>> adjacent;
  std::vector<std::pair<int, int>> edges;
  auto node = [&](const gp_XY& p) {
    const auto key = std::make_pair(p.X(), p.Y());
    auto it = ids.find(key);
    if (it != ids.end()) return it->second;
    const int id = static_cast<int>(nodes.size());
    ids.emplace(key, id);
    nodes.push_back(p);
    adjacent.emplace_back();
    return id;
  };
  for (const auto& s : segs) {
    const int a = node(s.first);
    const int b = node(s.second);
    if (a == b) continue;
    const int e = static_cast<int>(edges.size());
    edges.emplace_back(a, b);
    adjacent[static_cast<size_t>(a)].push_back(e);
    adjacent[static_cast<size_t>(b)].push_back(e);
  }
  std::vector<char> used(edges.size(), 0);
  std::vector<std::vector<gp_XY>> chains;
  auto walk = [&](int start, int firstEdge) {
    std::vector<gp_XY> chain{nodes[static_cast<size_t>(start)]};
    int at = start;
    int e = firstEdge;
    while (e >= 0) {
      used[static_cast<size_t>(e)] = 1;
      const auto& ab = edges[static_cast<size_t>(e)];
      at = ab.first == at ? ab.second : ab.first;
      chain.push_back(nodes[static_cast<size_t>(at)]);
      e = -1;
      const auto& adj = adjacent[static_cast<size_t>(at)];
      if (adj.size() != 2) break;  // an end or a branch point
      for (int next : adj) {
        if (!used[static_cast<size_t>(next)]) e = next;
      }
    }
    chains.push_back(std::move(chain));
  };
  for (size_t n = 0; n < nodes.size(); ++n) {
    if (adjacent[n].size() == 2) continue;
    for (int e : adjacent[n]) {
      if (!used[static_cast<size_t>(e)]) walk(static_cast<int>(n), e);
    }
  }
  for (size_t e = 0; e < edges.size(); ++e) {
    if (!used[e]) walk(edges[e].first, static_cast<int>(e));  // closed loops
  }
  return chains;
}

void runDraft(const TopoDS_Shape& shape, const ViewRequest& req, const EdgeOrigin& originOf,
              const FaceOrigin& faceOriginOf, std::vector<OutCurve>& out) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  const bool parallel = true;
#else
  const bool parallel = false;
#endif
  // Keeps a finer triangulation from an earlier view; the shape belongs to the drawing worker.
  BRepMesh_IncrementalMesh mesher(shape, req.linearDeflection, false, req.angularDeflection,
                                  parallel);
  if (!mesher.IsDone()) raiseError("OPERATION_FAILED", "Tessellating the part for the draft failed");

  occ::handle<HLRBRep_PolyAlgo> algo = new HLRBRep_PolyAlgo();
  algo->Projector(projectorFor(req.frame));
  algo->Load(shape);
  algo->Update();
  const gp_Trsf& T = algo->Projector().Transformation();

  // Group key: visible, class, input edge, outlined face (outlines of different faces stay apart,
  // and a seam's segments on the silhouette apart from its others).
  using Key = std::tuple<bool, int, int, int>;
  std::map<Key, std::vector<std::pair<gp_XY, gp_XY>>> groups;
  ShapeMap outlineFaces;
  // By outlineFaces index (1-based; 0 = outlines no face): the input face, or −1.
  std::vector<int> outlineFaceOrigin{-1};
  auto faceKey = [&](const TopoDS_Shape& f) {
    const int key = outlineFaces.Add(f);
    if (key == static_cast<int>(outlineFaceOrigin.size())) {
      outlineFaceOrigin.push_back(!f.IsNull() && f.ShapeType() == TopAbs_FACE ? faceOriginOf(f)
                                                                              : -1);
    }
    return key;
  };
  // Seams on the silhouette: PolyAlgo marks a segment `outl` when the triangles on its two sides
  // face opposite ways. On a seam (an edge closed on its only face) that segment outlines the face.
  ShapeListMap edgeFaces;
  auto seamFaceOf = [&](const TopoDS_Shape& e) {
    TopoDS_Shape none;
    if (e.IsNull() || e.ShapeType() != TopAbs_EDGE) return none;
    if (edgeFaces.IsEmpty()) {
      TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    }
    const int i = edgeFaces.FindIndex(e);
    if (i < 1) return none;
    TopoDS_Shape face;
    for (const TopoDS_Shape& f : edgeFaces(i)) {
      if (face.IsNull()) {
        face = f;
      } else if (!face.IsSame(f)) {
        return none;  // between two faces: not a seam
      }
    }
    if (face.IsNull() || !BRep_Tool::IsClosed(TopoDS::Edge(e), TopoDS::Face(face))) return none;
    return face;
  };
  HLRAlgo_EdgeStatus status;
  TopoDS_Shape S;
  bool reg1 = false;
  bool regn = false;
  bool outl = false;
  bool intl = false;
  double sta = 0;
  double end = 0;
  float tolSta = 0;
  float tolEnd = 0;
  for (algo->InitHide(); algo->MoreHide(); algo->NextHide()) {
    HLRAlgo_BiPoint::PointsT& pts = algo->Hide(status, S, reg1, regn, outl, intl);
    // HLRBRep_PolyHLRToShape::InternalCompound classification.
    int cls;
    if (intl) {
      cls = kOutline;
    } else if (reg1 && !regn && !outl) {
      cls = kSmooth;
    } else if (regn && !outl) {
      cls = kSewn;
    } else {
      cls = kSharp;  // !intl && (!reg1 || outl)
    }
    if (!req.smooth && (cls == kSmooth || cls == kSewn)) continue;
    gp_XYZ p1 = pts.Pnt1;
    gp_XYZ p2 = pts.Pnt2;
    T.Transforms(p1);
    T.Transforms(p2);
    const gp_XY a(p1.X(), p1.Y());
    const gp_XY b(p2.X(), p2.Y());
    const gp_XY d = b - a;
    if (d.Modulus() <= 1e-10) continue;
    auto at = [&](double t) { return t <= 0 ? a : (t >= 1 ? b : a + d * t); };
    int index = -1;
    int face = 0;
    if (intl) {
      // S is the face of the loaded shape the outline segment lies on (PolyAlgo's face map).
      face = faceKey(S);
    } else {
      index = originOf(S);
      if (outl) {
        const TopoDS_Shape seamFace = seamFaceOf(S);
        if (!seamFace.IsNull()) face = faceKey(seamFace);
      }
    }
    HLRAlgo_EdgeIterator it;
    for (it.InitVisible(status); it.MoreVisible(); it.NextVisible()) {
      it.Visible(sta, tolSta, end, tolEnd);
      groups[Key(true, cls, index, face)].emplace_back(at(sta), at(end));
    }
    if (req.hidden) {
      for (it.InitHidden(status); it.MoreHidden(); it.NextHidden()) {
        it.Hidden(sta, tolSta, end, tolEnd);
        groups[Key(false, cls, index, face)].emplace_back(at(sta), at(end));
      }
    }
  }
  for (const auto& g : groups) {
    for (std::vector<gp_XY>& chain : chainSegments(g.second)) {
      OutCurve oc;
      oc.visible = std::get<0>(g.first);
      oc.cls = std::get<1>(g.first);
      oc.index = std::get<2>(g.first);
      oc.face = outlineFaceOrigin[static_cast<size_t>(std::get<3>(g.first))];
      if (chain.size() == 2) {
        oc.curve = makeLine(chain[0], chain[1]);
      } else {
        oc.curve.kind = Curve2D::Kind::Polyline;
        oc.curve.points = std::move(chain);
      }
      out.push_back(std::move(oc));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Section views
// ---------------------------------------------------------------------------------------------

struct SectionCut {
  TopoDS_Shape result;
  std::vector<int> edgeOrigin;  // by result edge (0-based TopExp order): input edge or −1
  std::vector<int> faceOrigin;  // by result face (0-based TopExp order): input face or −1
  std::vector<std::pair<int, TopoDS_Face>> faces;  // (cut segment, face on the cutting surface)
};

// Cuts away the material on the viewer's side of the cutting surface: the cut line swept along
// `along`. Each segment P_i P_{i+1} not parallel to the viewing direction gets one prism tool, the
// quad (P_i, P_{i+1}, P_{i+1} − L·w, P_i − L·w) swept through the part, where w is the viewing
// direction in the cut-line plane; the first and last segments are extended past the part. The
// union of the quads is everything on the viewer's side of the line, so full, offset (stepped)
// and half (L-shaped) sections need no special cases, and a step parallel to the viewing
// direction cuts nothing of its own. The cut faces are the images of the tools' segment faces.
SectionCut cutForSection(const TopoDS_Shape& shape, const ShapeMap& inputEdges,
                         const ShapeMap& inputFaces, const SectionSpec& spec) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) raiseError("INVALID_INPUT", "The part is empty; there is nothing to section");
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  const double diag = gp_Pnt(x0, y0, z0).Distance(gp_Pnt(x1, y1, z1));
  const double big = 2 * diag + 10;
  const gp_XYZ a = spec.along.XYZ();
  gp_XYZ w = spec.look.XYZ() - a * spec.look.XYZ().Dot(a);
  if (w.Modulus() < 1e-9) {
    raiseError("INVALID_INPUT", "The section's viewing direction runs along the cutting surface",
               "Look at the cut from one of its sides.");
  }
  w /= w.Modulus();
  double sMin = RealLast();
  double sMax = RealFirst();
  for (int i = 0; i < 8; ++i) {
    const gp_XYZ corner((i & 1) ? x1 : x0, (i & 2) ? y1 : y0, (i & 4) ? z1 : z0);
    sMin = std::min(sMin, corner.Dot(a));
    sMax = std::max(sMax, corner.Dot(a));
  }
  const double s0 = sMin - big;
  const gp_Vec sweep(a * (sMax - sMin + 2 * big));
  std::vector<gp_XYZ> pts;
  for (const gp_Pnt& p : spec.cut) pts.push_back(p.XYZ() + a * (s0 - p.XYZ().Dot(a)));

  ShapeList tools;
  std::vector<std::pair<int, TopoDS_Shape>> segmentFaces;
  const size_t n = pts.size();
  for (size_t i = 0; i + 1 < n; ++i) {
    const gp_XYZ d = pts[i + 1] - pts[i];
    const double len = d.Modulus();
    if (len < 1e-9) continue;
    const gp_XYZ dir = d / len;
    if ((dir - w * dir.Dot(w)).Modulus() < 1e-6) continue;  // a step along the viewing direction
    const gp_XYZ A = i == 0 ? pts[i] - dir * big : pts[i];
    const gp_XYZ B = i + 2 == n ? pts[i + 1] + dir * big : pts[i + 1];
    const gp_Pnt pA(A);
    const gp_Pnt pB(B);
    BRepBuilderAPI_MakePolygon poly(pA, pB, gp_Pnt(B - w * big), gp_Pnt(A - w * big), true);
    if (!poly.IsDone()) raiseError("INVALID_INPUT", "The section's cut line is degenerate");
    const TopoDS_Wire wire = poly.Wire();
    TopoDS_Edge segmentEdge;
    for (TopExp_Explorer ex(wire, TopAbs_EDGE); ex.More(); ex.Next()) {
      TopoDS_Vertex v1, v2;
      TopExp::Vertices(TopoDS::Edge(ex.Current()), v1, v2);
      const gp_Pnt q1 = BRep_Tool::Pnt(v1);
      const gp_Pnt q2 = BRep_Tool::Pnt(v2);
      if ((q1.Distance(pA) < 1e-7 && q2.Distance(pB) < 1e-7) ||
          (q1.Distance(pB) < 1e-7 && q2.Distance(pA) < 1e-7)) {
        segmentEdge = TopoDS::Edge(ex.Current());
      }
    }
    BRepBuilderAPI_MakeFace face(wire, true);
    if (!face.IsDone() || segmentEdge.IsNull()) {
      raiseError("INVALID_INPUT", "The section's cut line is degenerate");
    }
    BRepPrimAPI_MakePrism prism(face.Face(), sweep, false, true);
    if (!prism.IsDone()) raiseError("OPERATION_FAILED", "Could not build the section's cutting tool");
    TopoDS_Shape tool = prism.Shape();
    if (solidVolume(tool) < 0) tool.Reverse();
    for (const TopoDS_Shape& g : prism.Generated(segmentEdge)) {
      if (g.ShapeType() == TopAbs_FACE) segmentFaces.emplace_back(static_cast<int>(i), g);
    }
    tools.Append(tool);
  }
  if (tools.IsEmpty()) {
    raiseError("INVALID_INPUT", "The section's cut line runs along the viewing direction",
               "Draw the cut line across the part.");
  }

  ShapeList args;
  args.Append(shape);
  BRepAlgoAPI_BooleanOperation bop;
  bop.SetOperation(BOPAlgo_CUT);
  bop.SetArguments(args);
  bop.SetTools(tools);
  bop.SetNonDestructive(true);  // the loaded shape stays cached for other views
#if defined(__EMSCRIPTEN_PTHREADS__)
  bop.SetRunParallel(true);
#else
  bop.SetRunParallel(false);
#endif
  bop.Build();
  if (bop.HasErrors() || !bop.IsDone()) {
    std::ostringstream diag;
    bop.DumpErrors(diag);
    raiseError("OPERATION_FAILED", "The section cut failed",
               "Move the cut line slightly; it may run exactly along a face or an edge.",
               diag.str());
  }
  SectionCut cut;
  cut.result = bop.Shape();
  const Topo rt(cut.result);
  if (rt.faces.Extent() == 0) {
    raiseError("INVALID_INPUT", "The section removes the whole part",
               "Look at the cut from the other side.");
  }
  cut.edgeOrigin.assign(static_cast<size_t>(rt.edges.Extent()), -1);
  for (int i = 1; i <= inputEdges.Extent(); ++i) {
    const TopoDS_Shape& e = inputEdges(i);
    const int kept = rt.edges.FindIndex(e);
    if (kept > 0) cut.edgeOrigin[static_cast<size_t>(kept - 1)] = i - 1;
    for (const TopoDS_Shape& m : bop.Modified(e)) {
      const int idx = rt.edges.FindIndex(m);
      if (idx > 0) cut.edgeOrigin[static_cast<size_t>(idx - 1)] = i - 1;
    }
  }
  // Faces likewise, so the far half of a cut cylinder keeps its outline's face name.
  cut.faceOrigin.assign(static_cast<size_t>(rt.faces.Extent()), -1);
  for (int i = 1; i <= inputFaces.Extent(); ++i) {
    const TopoDS_Shape& f = inputFaces(i);
    const int kept = rt.faces.FindIndex(f);
    if (kept > 0) cut.faceOrigin[static_cast<size_t>(kept - 1)] = i - 1;
    for (const TopoDS_Shape& m : bop.Modified(f)) {
      const int idx = rt.faces.FindIndex(m);
      if (idx > 0) cut.faceOrigin[static_cast<size_t>(idx - 1)] = i - 1;
    }
  }
  for (const auto& sf : segmentFaces) {
    const ShapeList& images = bop.Modified(sf.second);
    if (images.IsEmpty()) {
      if (rt.faces.Contains(sf.second)) cut.faces.emplace_back(sf.first, TopoDS::Face(sf.second));
      continue;
    }
    for (const TopoDS_Shape& m : images) {
      if (m.ShapeType() == TopAbs_FACE && rt.faces.Contains(m)) {
        cut.faces.emplace_back(sf.first, TopoDS::Face(m));
      }
    }
  }
  return cut;
}

// A face's loops in the view plane: the outer wire first, then the holes; curves in wire order and
// direction (arcs and ellipses keep their counter-clockwise form).
std::vector<std::vector<Curve2D>> faceLoops(const TopoDS_Face& face, const ViewFrame& f,
                                            double tol) {
  std::vector<std::vector<Curve2D>> loops;
  const TopoDS_Wire outer = BRepTools::OuterWire(face);
  std::vector<TopoDS_Wire> wires;
  if (!outer.IsNull()) wires.push_back(outer);
  for (TopExp_Explorer ex(face, TopAbs_WIRE); ex.More(); ex.Next()) {
    if (!outer.IsNull() && ex.Current().IsSame(outer)) continue;
    wires.push_back(TopoDS::Wire(ex.Current()));
  }
  for (const TopoDS_Wire& wire : wires) {
    std::vector<Curve2D> loop;
    for (BRepTools_WireExplorer wex(wire, face); wex.More(); wex.Next()) {
      const TopoDS_Edge& e = wex.Current();
      if (BRep_Tool::Degenerated(e)) continue;
      BRepAdaptor_Curve c(e);
      std::vector<Curve2D> pieces;
      projectSegment(c, c.FirstParameter(), c.LastParameter(), f, tol, pieces);
      if (wex.Orientation() == TopAbs_REVERSED) {
        std::reverse(pieces.begin(), pieces.end());
        for (Curve2D& p : pieces) reverseCurve(p);
      }
      for (Curve2D& p : pieces) loop.push_back(std::move(p));
    }
    if (!loop.empty()) loops.push_back(std::move(loop));
  }
  return loops;
}

// ---------------------------------------------------------------------------------------------
// One view
// ---------------------------------------------------------------------------------------------

std::string projectViewJson(const ShapeRecord& record, const ViewRequest& req) {
  const ShapeMap& inputEdges = record.topo().edges;
  const ShapeMap& inputFaces = record.topo().faces;
  std::vector<OutCurve> curves;
  std::vector<std::pair<int, std::vector<std::vector<Curve2D>>>> sectionFaces;
  double cutMs = 0;
  double hlrMs = 0;
  int edges = inputEdges.Extent();
  int faces = record.topo().faces.Extent();

  TopoDS_Shape target = record.shape;
  EdgeOrigin originOf = [&](const TopoDS_Shape& e) { return inputEdges.FindIndex(e) - 1; };
  FaceOrigin faceOriginOf = [&](const TopoDS_Shape& f) { return inputFaces.FindIndex(f) - 1; };
  SectionCut cut;
  if (req.hasSection) {
    const auto t0 = std::chrono::steady_clock::now();
    cut = cutForSection(record.shape, inputEdges, inputFaces, req.section);
    cutMs = elapsedMs(t0);
    target = cut.result;
    auto resultTopo = std::make_shared<Topo>(cut.result);
    edges = resultTopo->edges.Extent();
    faces = resultTopo->faces.Extent();
    originOf = [resultTopo, &cut](const TopoDS_Shape& e) {
      const int idx = resultTopo->edges.FindIndex(e);
      return idx > 0 ? cut.edgeOrigin[static_cast<size_t>(idx - 1)] : -1;
    };
    faceOriginOf = [resultTopo, &cut](const TopoDS_Shape& f) {
      const int idx = resultTopo->faces.FindIndex(f);
      return idx > 0 ? cut.faceOrigin[static_cast<size_t>(idx - 1)] : -1;
    };
    // Cut faces, ordered per segment by the centre of their box in the view (x, then y).
    std::vector<std::tuple<int, double, double, size_t>> order;
    for (size_t i = 0; i < cut.faces.size(); ++i) {
      Bnd_Box fb;
      BRepBndLib::Add(cut.faces[i].second, fb);
      double fx0, fy0, fz0, fx1, fy1, fz1;
      fb.Get(fx0, fy0, fz0, fx1, fy1, fz1);
      const gp_XY c = toView(req.frame, gp_Pnt(0.5 * (fx0 + fx1), 0.5 * (fy0 + fy1),
                                               0.5 * (fz0 + fz1)));
      order.emplace_back(cut.faces[i].first, std::round(c.X() * 1e6) / 1e6,
                         std::round(c.Y() * 1e6) / 1e6, i);
    }
    std::sort(order.begin(), order.end());
    for (const auto& o : order) {
      const TopoDS_Face& face = cut.faces[std::get<3>(o)].second;
      sectionFaces.emplace_back(std::get<0>(o), faceLoops(face, req.frame, req.sampleTolerance));
    }
  }

  const auto t1 = std::chrono::steady_clock::now();
  if (req.hasSection && req.section.slice) {
    // The cut faces only: their boundaries, all visible (they face the viewer).
    ShapeMap seen;
    for (const auto& sf : cut.faces) {
      for (TopExp_Explorer ex(sf.second, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        if (BRep_Tool::Degenerated(e) || seen.Contains(e)) continue;
        seen.Add(e);
        BRepAdaptor_Curve c(e);
        std::vector<Curve2D> pieces;
        projectSegment(c, c.FirstParameter(), c.LastParameter(), req.frame, req.sampleTolerance,
                       pieces);
        for (Curve2D& p : pieces) {
          OutCurve oc;
          oc.curve = std::move(p);
          curves.push_back(std::move(oc));
        }
      }
    }
  } else if (req.exact) {
    runExact(target, req, originOf, faceOriginOf, curves);
  } else {
    runDraft(target, req, originOf, faceOriginOf, curves);
  }
  hlrMs = elapsedMs(t1);

  if (req.hasClip) {
    std::vector<OutCurve> clipped;
    std::vector<Curve2D> pieces;
    for (const OutCurve& oc : curves) {
      pieces.clear();
      clipCurve(oc.curve, req.clip, pieces);
      for (Curve2D& p : pieces) {
        OutCurve c2;
        c2.visible = oc.visible;
        c2.cls = oc.cls;
        c2.index = oc.index;
        c2.face = oc.face;
        c2.curve = std::move(p);
        clipped.push_back(std::move(c2));
      }
    }
    curves = std::move(clipped);
  }

  std::string out = "{\"curves\":[";
  for (size_t i = 0; i < curves.size(); ++i) {
    const OutCurve& oc = curves[i];
    if (i > 0) out.push_back(',');
    out += "{\"role\":";
    out += oc.visible ? "\"visible\"" : "\"hidden\"";
    out += ",\"edge\":\"";
    out += edgeClassName(oc.cls);
    out += "\",\"index\":" + std::to_string(oc.index) + ",\"face\":" + std::to_string(oc.face) +
           ",\"curve\":";
    writeCurve(out, oc.curve);
    out.push_back('}');
  }
  out += "],\"sectionFaces\":[";
  for (size_t i = 0; i < sectionFaces.size(); ++i) {
    if (i > 0) out.push_back(',');
    out += "{\"segment\":" + std::to_string(sectionFaces[i].first) + ",\"loops\":[";
    const auto& loops = sectionFaces[i].second;
    for (size_t l = 0; l < loops.size(); ++l) {
      if (l > 0) out.push_back(',');
      out.push_back('[');
      for (size_t k = 0; k < loops[l].size(); ++k) {
        if (k > 0) out.push_back(',');
        writeCurve(out, loops[l][k]);
      }
      out.push_back(']');
    }
    out += "]}";
  }
  out += "],\"stats\":{\"hlrMs\":" + jsonNumber(hlrMs) + ",\"cutMs\":" + jsonNumber(cutMs) +
         ",\"edges\":" + std::to_string(edges) + ",\"faces\":" + std::to_string(faces) + "}}";
  return out;
}
