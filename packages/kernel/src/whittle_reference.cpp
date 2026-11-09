// Whittle kernel façade — M3 reference geometry (plane, axis and point definitions) and the
// "convert entities" projection of model edges / face outlines onto a sketch plane.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.
//
// Inputs (normative, see README): every reference of a definition at JSON pointer P is either a
// resolved sub-shape at inputs.refs[P] or a frame at inputs.frames[P] (origin planes/axes/points
// and reference features). A frame reads as a plane (origin + z normal), an axis (origin + z) or a
// point (origin) according to the definition, or for `intersection` according to the EntityRef
// kind in the feature (face / edge / vertex).

gp_Ax3 requirePlane(const Json& inputs, const std::string& pointer, const char* role, const char* what,
                    std::string* name = nullptr) {
  gp_Ax3 frame;
  std::string n;
  if (!planeInput(inputs, pointer, role, frame, n)) {
    raiseError("UNRESOLVED_REFERENCE", std::string("Select ") + what, "Pick a plane or a planar face.");
  }
  if (name != nullptr) *name = n;
  return frame;
}

gp_Ax1 requireLine(const Json& inputs, const std::string& pointer, const char* what, std::string* name = nullptr) {
  gp_Ax1 axis;
  std::string n;
  if (!lineInput(inputs, pointer, nullptr, axis, n)) {
    raiseError("UNRESOLVED_REFERENCE", std::string("Select ") + what, "Pick an axis or a straight edge.");
  }
  if (name != nullptr) *name = n;
  return axis;
}

gp_Pnt requirePoint(const Json& inputs, const std::string& pointer, const char* what) {
  gp_Pnt p;
  std::string n;
  if (!pointInput(inputs, pointer, nullptr, p, n)) {
    raiseError("UNRESOLVED_REFERENCE", std::string("Select ") + what, "Pick a point or a vertex.");
  }
  return p;
}

RefTarget requireEdgeRef(const Json& inputs, const std::string& pointer, const char* what) {
  RefTarget r;
  if (!singleRef(inputs, pointer, r)) raiseError("UNRESOLVED_REFERENCE", std::string("Select ") + what);
  if (r.kind != "edge") raiseError("INVALID_INPUT", std::string(what) + " must be an edge", {}, {}, {r.name});
  if (BRep_Tool::Degenerated(TopoDS::Edge(r.sub))) {
    raiseError("INVALID_INPUT", std::string(what) + " has no length", {}, {}, {r.name});
  }
  return r;
}

// Curve parameter at fraction `t` (0–1) of the edge's arc length, in the curve's own direction.
double parameterAtFraction(const BRepAdaptor_Curve& c, double t) {
  if (t < -1e-9 || t > 1 + 1e-9) raiseError("INVALID_INPUT", "The position along the edge must be between 0 and 1");
  t = std::max(0.0, std::min(1.0, t));
  const double length = GCPnts_AbscissaPoint::Length(c);
  if (t <= 0) return c.FirstParameter();
  if (t >= 1) return c.LastParameter();
  GCPnts_AbscissaPoint ap(c, t * length, c.FirstParameter());
  if (!ap.IsDone()) raiseError("OPERATION_FAILED", "Could not find the point along the edge");
  return ap.Parameter();
}

// A frame whose x is a deterministic perpendicular of z (world X, else world Y, projected).
gp_Ax3 frameWithZ(const gp_Pnt& origin, const gp_Dir& z) {
  gp_Vec x(1, 0, 0);
  if (std::fabs(gp_Vec(z).Dot(x)) > 0.9) x = gp_Vec(0, 1, 0);
  x -= gp_Vec(z) * x.Dot(gp_Vec(z));
  return gp_Ax3(origin, z, gp_Dir(x));
}

std::string execPlane(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json* def = feature.get("definition");
  if (def == nullptr || !def->isObject()) raiseError("INVALID_INPUT", "plane.definition is required");
  const Json& values = valuesOf(inputs);
  const std::string kind = optString(*def, "kind", "");
  gp_Ax3 frame;
  double size = 100;
  if (kind == "frame") {
    const Json* f = def->get("frame");
    if (f == nullptr) f = frameInput(inputs, "plane");
    frame = gp_Ax3(parseFrame(f));
  } else if (kind == "offset") {
    const double distance = requireValue(values, "/definition/distance", "plane offset");
    RefTarget r;
    if (singleRef(inputs, "/definition/from", r)) {
      if (!planeOfRef(r, frame)) {
        raiseError("INVALID_INPUT", "An offset plane needs a planar face or a plane", {}, {}, {r.name});
      }
      Bnd_Box box;
      BRepBndLib::Add(r.sub, box);
      if (!box.IsVoid()) size = std::max(10.0, std::sqrt(box.SquareExtent()) * 1.2);
    } else {
      frame = requirePlane(inputs, "/definition/from", "from", "the face or plane to offset from");
    }
    frame.Translate(gp_Vec(frame.Direction()) * distance);
  } else if (kind == "threePoints") {
    const gp_Pnt a = requirePoint(inputs, "/definition/points/0", "the first point");
    const gp_Pnt b = requirePoint(inputs, "/definition/points/1", "the second point");
    const gp_Pnt c = requirePoint(inputs, "/definition/points/2", "the third point");
    const gp_Vec ab(a, b);
    const gp_Vec n = ab.Crossed(gp_Vec(a, c));
    if (ab.Magnitude() < 1e-9 || n.Magnitude() < 1e-9 * std::max(1.0, ab.Magnitude())) {
      raiseError("INVALID_INPUT", "The three points lie on one line", "Pick three points that form a triangle.");
    }
    frame = gp_Ax3(a, gp_Dir(n), gp_Dir(ab));
    size = std::max(10.0, 1.2 * std::max({a.Distance(b), a.Distance(c), b.Distance(c)}));
  } else if (kind == "angle") {
    const gp_Ax3 from = requirePlane(inputs, "/definition/from", nullptr, "the plane to rotate from");
    const gp_Ax1 axis = requireLine(inputs, "/definition/axis", "the axis to rotate about");
    const double angle = requireValue(values, "/definition/angle", "plane angle");
    const gp_Vec d(axis.Direction());
    gp_Vec n(from.Direction());
    n -= d * n.Dot(d);
    if (n.Magnitude() < 1e-9) {
      raiseError("INVALID_INPUT", "The axis is perpendicular to the plane", "Pick an axis that lies in, or parallel to, the plane.");
    }
    n.Normalize();
    n.Rotate(gp_Ax1(gp_Pnt(0, 0, 0), axis.Direction()), angle);
    frame = gp_Ax3(axis.Location(), gp_Dir(n), axis.Direction());
  } else if (kind == "normalToCurve") {
    const RefTarget r = requireEdgeRef(inputs, "/definition/curve", "the curve");
    BRepAdaptor_Curve c(TopoDS::Edge(r.sub));
    double u = c.FirstParameter();
    const Json* at = def->get("at");
    if (at != nullptr && at->isObject() && at->get("t") != nullptr) {
      u = parameterAtFraction(c, requireValue(values, "/definition/at/t", "position along the curve"));
    } else {
      const gp_Pnt p = requirePoint(inputs, "/definition/at", "the point on the curve");
      double first = 0;
      double last = 0;
      const occ::handle<Geom_Curve> curve = BRep_Tool::Curve(TopoDS::Edge(r.sub), first, last);
      if (curve.IsNull()) raiseError("INVALID_INPUT", "The curve has no 3D geometry", {}, {}, {r.name});
      GeomAPI_ProjectPointOnCurve proj(p, curve, first, last);
      if (proj.NbPoints() == 0 || proj.LowerDistance() > 1e-4) {
        raiseError("INVALID_INPUT", "The point is not on the curve", "Pick a vertex of the curve.", {}, {r.name});
      }
      u = proj.LowerDistanceParameter();
    }
    gp_Pnt p;
    gp_Vec tangent;
    c.D1(u, p, tangent);
    if (tangent.Magnitude() < 1e-12) raiseError("INVALID_INPUT", "The curve has no direction at this point", {}, {}, {r.name});
    frame = frameWithZ(p, gp_Dir(tangent));
  } else if (kind == "midplane") {
    const gp_Ax3 a = requirePlane(inputs, "/definition/a", nullptr, "the first plane");
    const gp_Ax3 b = requirePlane(inputs, "/definition/b", nullptr, "the second plane");
    if (!a.Direction().IsParallel(b.Direction(), 1e-6)) {
      raiseError("INVALID_INPUT", "A mid-plane needs two parallel planes", "Pick two parallel faces.");
    }
    const gp_Vec nb(b.Direction());
    const gp_Pnt pa = a.Location();
    const gp_Pnt pb = pa.Translated(-nb * gp_Vec(b.Location(), pa).Dot(nb));
    frame = gp_Ax3(gp_Pnt((pa.XYZ() + pb.XYZ()) / 2), a.Direction(), a.XDirection());
  } else if (kind == "throughPoint") {
    const gp_Ax3 from = requirePlane(inputs, "/definition/from", nullptr, "the plane to copy");
    const gp_Pnt p = requirePoint(inputs, "/definition/point", "the point");
    frame = gp_Ax3(p, from.Direction(), from.XDirection());
  } else {
    raiseError("INVALID_INPUT",
               "plane.definition.kind must be offset, frame, threePoints, angle, normalToCurve, "
               "midplane or throughPoint");
  }
  const Json* flip = feature.get("flip");
  if (flip != nullptr && flip->kind == Json::Kind::Bool && flip->boolean) {
    frame = gp_Ax3(frame.Location(), frame.Direction().Reversed(), frame.XDirection());
  }
  const double h = size / 2;
  const TopoDS_Face face = BRepBuilderAPI_MakeFace(gp_Pln(frame), -h, h, -h, h).Face();
  NamedShape ns = finalizeNamed(face, {"F" + tag + ":plane"}, "F" + tag + ":plane");
  ns.hasFrame = true;
  ns.frame = frame;
  return storeResult(ns, {}, ",\"frame\":" + jsonFrame(frame));
}

// Extent of `shape` along `axis` (parameters of the projected bbox corners).
void extentAlong(const TopoDS_Shape& shape, const gp_Ax1& axis, double& lo, double& hi) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, false, false);
  lo = 0;
  hi = 0;
  if (box.IsVoid()) return;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  bool first = true;
  for (double x : {x0, x1}) {
    for (double y : {y0, y1}) {
      for (double z : {z0, z1}) {
        const double t = gp_Vec(axis.Location(), gp_Pnt(x, y, z)).Dot(gp_Vec(axis.Direction()));
        lo = first ? t : std::min(lo, t);
        hi = first ? t : std::max(hi, t);
        first = false;
      }
    }
  }
}

// The axis result: a segment a→b named F…:axis; the frame origin is `origin` (default a).
std::string storeAxis(const gp_Pnt& a, const gp_Pnt& b, const gp_Dir& dir, const std::string& tag,
                      const gp_Pnt* origin = nullptr) {
  BRepBuilderAPI_MakeEdge me(a, b);
  if (!me.IsDone()) raiseError("OPERATION_FAILED", "The axis could not be built");
  NamedShape ns;
  ns.shape = me.Edge();
  ns.edges = {"F" + tag + ":axis"};
  ns.vertices.assign(2, std::string());
  ns.hasFrame = true;
  ns.frame = frameWithZ(origin != nullptr ? *origin : a, dir);
  return storeResult(ns, {}, ",\"frame\":" + jsonFrame(ns.frame));
}

std::string execAxis(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json* def = feature.get("definition");
  if (def == nullptr || !def->isObject()) raiseError("INVALID_INPUT", "axis.definition is required");
  const std::string kind = optString(*def, "kind", "");
  const double half = 50;
  if (kind == "twoPoints") {
    const gp_Pnt a = requirePoint(inputs, "/definition/a", "the first point");
    const gp_Pnt b = requirePoint(inputs, "/definition/b", "the second point");
    if (a.Distance(b) < 1e-9) raiseError("INVALID_INPUT", "The two points coincide", "Pick two different points.");
    return storeAxis(a, b, gp_Dir(gp_Vec(a, b)), tag);
  }
  if (kind == "edge") {
    RefTarget r;
    if (singleRef(inputs, "/definition/edge", r)) {
      if (r.kind != "edge" || BRep_Tool::Degenerated(TopoDS::Edge(r.sub)) ||
          BRepAdaptor_Curve(TopoDS::Edge(r.sub)).GetType() != GeomAbs_Line) {
        raiseError("INVALID_INPUT", "An axis along an edge needs a straight edge", {}, {}, {r.name});
      }
      gp_Ax1 axis;
      lineOfRef(r, axis);
      double lo = 0;
      double hi = 0;
      extentAlong(r.sub, axis, lo, hi);
      return storeAxis(axis.Location().Translated(gp_Vec(axis.Direction()) * lo),
                       axis.Location().Translated(gp_Vec(axis.Direction()) * hi), axis.Direction(), tag);
    }
    const gp_Ax1 axis = requireLine(inputs, "/definition/edge", "the edge");
    return storeAxis(axis.Location(), axis.Location().Translated(gp_Vec(axis.Direction()) * (2 * half)),
                     axis.Direction(), tag);
  }
  if (kind == "cylinder") {
    RefTarget r;
    if (!singleRef(inputs, "/definition/face", r)) raiseError("UNRESOLVED_REFERENCE", "Select a cylindrical face or a circular edge");
    gp_Ax1 axis;
    bool ok = false;
    if (r.kind == "face") {
      BRepAdaptor_Surface s(TopoDS::Face(r.sub), false);
      ok = (s.GetType() == GeomAbs_Cylinder || s.GetType() == GeomAbs_Cone) && lineOfRef(r, axis);
    } else if (r.kind == "edge" && !BRep_Tool::Degenerated(TopoDS::Edge(r.sub))) {
      ok = BRepAdaptor_Curve(TopoDS::Edge(r.sub)).GetType() == GeomAbs_Circle && lineOfRef(r, axis);
    }
    if (!ok) {
      raiseError("INVALID_INPUT", "This axis needs a cylindrical or conical face, or a circular edge", {}, {}, {r.name});
    }
    double lo = 0;
    double hi = 0;
    extentAlong(r.sub, axis, lo, hi);
    if (hi - lo < 1e-6) {
      lo -= half;
      hi += half;
    }
    return storeAxis(axis.Location().Translated(gp_Vec(axis.Direction()) * lo),
                     axis.Location().Translated(gp_Vec(axis.Direction()) * hi), axis.Direction(), tag);
  }
  if (kind == "twoPlanes") {
    const gp_Ax3 a = requirePlane(inputs, "/definition/a", nullptr, "the first plane");
    const gp_Ax3 b = requirePlane(inputs, "/definition/b", nullptr, "the second plane");
    const gp_Vec n1(a.Direction());
    const gp_Vec n2(b.Direction());
    const gp_Vec d = n1.Crossed(n2);
    if (d.Magnitude() < 1e-9) raiseError("INVALID_INPUT", "The planes are parallel and do not intersect");
    const double h1 = n1.Dot(gp_Vec(a.Location().XYZ()));
    const double h2 = n2.Dot(gp_Vec(b.Location().XYZ()));
    const double n12 = n1.Dot(n2);
    const double det = 1 - n12 * n12;
    const gp_XYZ p0 = (n1.XYZ() * (h1 - h2 * n12) + n2.XYZ() * (h2 - h1 * n12)) / det;
    const gp_Dir dir(d);
    // The point of the line nearest the planes' own origins (centroids for faces).
    const gp_XYZ mid = (a.Location().XYZ() + b.Location().XYZ()) / 2;
    const gp_Pnt p(p0 + dir.XYZ() * (mid - p0).Dot(dir.XYZ()));
    return storeAxis(p.Translated(gp_Vec(dir) * -half), p.Translated(gp_Vec(dir) * half), dir, tag, &p);
  }
  if (kind == "pointNormal") {
    const gp_Pnt p = requirePoint(inputs, "/definition/point", "the point");
    const gp_Ax3 pl = requirePlane(inputs, "/definition/plane", nullptr, "the plane");
    return storeAxis(p, p.Translated(gp_Vec(pl.Direction()) * (2 * half)), pl.Direction(), tag);
  }
  raiseError("INVALID_INPUT", "axis.definition.kind must be twoPoints, edge, cylinder, twoPlanes or pointNormal");
}

// An operand of a point intersection: the ref's sub-shape, or a frame read as the EntityRef kind.
TopoDS_Shape intersectionOperand(const Json& feature, const Json& inputs, const std::string& pointer) {
  RefTarget r;
  if (singleRef(inputs, pointer, r)) {
    if (r.kind == "body") raiseError("INVALID_INPUT", "Intersect edges, faces or planes, not whole bodies");
    return r.sub;
  }
  const Json* f = frameFor(inputs, pointer, nullptr);
  if (f == nullptr) raiseError("UNRESOLVED_REFERENCE", "Select two entities to intersect");
  const gp_Ax2 ax = parseFrame(f);
  const std::string kind = refKindAt(feature, pointer);
  const double big = 1e5;
  if (kind == "edge") return BRepBuilderAPI_MakeEdge(gp_Lin(ax.Location(), ax.Direction()), -big, big).Edge();
  if (kind == "vertex") return BRepBuilderAPI_MakeVertex(ax.Location()).Vertex();
  return BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(ax)), -big, big, -big, big).Face();
}

std::string execPoint(const Json& feature, const Json& inputs, const std::string& tag) {
  const Json* def = feature.get("definition");
  if (def == nullptr || !def->isObject()) raiseError("INVALID_INPUT", "point.definition is required");
  const Json& values = valuesOf(inputs);
  const std::string kind = optString(*def, "kind", "");
  gp_Pnt p;
  if (kind == "coordinates") {
    p = gp_Pnt(requireValue(values, "/definition/x", "point x"), requireValue(values, "/definition/y", "point y"),
               requireValue(values, "/definition/z", "point z"));
  } else if (kind == "vertex") {
    p = requirePoint(inputs, "/definition/vertex", "the vertex");
  } else if (kind == "center") {
    p = requirePoint(inputs, "/definition/of", "a circular edge or a sphere");
  } else if (kind == "alongEdge") {
    const RefTarget r = requireEdgeRef(inputs, "/definition/edge", "the edge");
    BRepAdaptor_Curve c(TopoDS::Edge(r.sub));
    p = c.Value(parameterAtFraction(c, requireValue(values, "/definition/t", "position along the edge")));
  } else if (kind == "intersection") {
    const TopoDS_Shape a = intersectionOperand(feature, inputs, "/definition/a");
    const TopoDS_Shape b = intersectionOperand(feature, inputs, "/definition/b");
    if (a.ShapeType() == TopAbs_FACE && b.ShapeType() == TopAbs_FACE) {
      raiseError("INVALID_INPUT", "Two planes meet in a line, not a point", "Use an axis from two planes, or intersect an edge with a plane.");
    }
    BRepExtrema_DistShapeShape dist(a, b);
    if (!dist.IsDone() || dist.NbSolution() == 0) raiseError("OPERATION_FAILED", "Could not intersect the two entities");
    if (dist.Value() > 1e-6) {
      raiseError("INVALID_INPUT", "The two entities do not intersect",
                 "They are " + fmtMm(dist.Value()) + " mm apart at the closest point.");
    }
    p = dist.PointOnShape1(1);
  } else {
    raiseError("INVALID_INPUT", "point.definition.kind must be coordinates, vertex, center, alongEdge or intersection");
  }
  NamedShape ns;
  ns.shape = BRepBuilderAPI_MakeVertex(p).Vertex();
  ns.vertices = {"F" + tag + ":point"};
  ns.hasFrame = true;
  ns.frame = gp_Ax3(p, gp_Dir(0, 0, 1), gp_Dir(1, 0, 0));
  return storeResult(ns, {}, ",\"frame\":" + jsonFrame(ns.frame));
}

// ---------------------------------------------------------------------------------------------
// Projection onto a sketch plane ("convert entities")
//
// Coordinates are the plane frame's local x/y. Lines stay lines; circles and arcs whose axis is
// parallel to the plane normal stay circles / counter-clockwise arcs; everything else (circles
// seen obliquely, ellipses, splines) is a polyline within ~1 µm. Curves that project to a point
// (edges along the normal) are dropped (no curves).
// ---------------------------------------------------------------------------------------------

gp_XY toPlaneXY(const gp_Ax3& f, const gp_Pnt& p) {
  const gp_Vec v(f.Location(), p);
  return gp_XY(v.Dot(gp_Vec(f.XDirection())), v.Dot(gp_Vec(f.YDirection())));
}

std::string vec2Json(const gp_XY& v) { return "[" + jsonNumber(v.X()) + "," + jsonNumber(v.Y()) + "]"; }

std::vector<std::string> projectEdgeCurves(const TopoDS_Edge& edge, const gp_Ax3& plane) {
  std::vector<std::string> out;
  if (BRep_Tool::Degenerated(edge) || !BRep_Tool::IsGeometric(edge)) return out;
  BRepAdaptor_Curve c(edge);
  const double u0 = c.FirstParameter();
  const double u1 = c.LastParameter();
  const gp_Dir n = plane.Direction();
  if (c.GetType() == GeomAbs_Line) {
    const gp_XY a = toPlaneXY(plane, c.Value(u0));
    const gp_XY b = toPlaneXY(plane, c.Value(u1));
    if ((b - a).Modulus() < 1e-9) return out;
    out.push_back("{\"kind\":\"line\",\"a\":" + vec2Json(a) + ",\"b\":" + vec2Json(b) + "}");
    return out;
  }
  if (c.GetType() == GeomAbs_Circle) {
    const gp_Circ circ = c.Circle();
    const double cosv = gp_Vec(circ.Axis().Direction()).Dot(gp_Vec(n));
    if (std::fabs(cosv) > 1 - 1e-12) {
      const gp_XY ctr = toPlaneXY(plane, circ.Location());
      const double r = circ.Radius();
      if (u1 - u0 >= 2 * kPi - 1e-9) {
        out.push_back("{\"kind\":\"circle\",\"c\":" + vec2Json(ctr) + ",\"r\":" + jsonNumber(r) + "}");
        return out;
      }
      gp_XY s = toPlaneXY(plane, c.Value(u0));
      gp_XY e = toPlaneXY(plane, c.Value(u1));
      if (cosv < 0) std::swap(s, e);  // keep counter-clockwise in plane coordinates
      out.push_back("{\"kind\":\"arc\",\"c\":" + vec2Json(ctr) + ",\"r\":" + jsonNumber(r) + ",\"start\":" +
                    vec2Json(s) + ",\"end\":" + vec2Json(e) + "}");
      return out;
    }
  }
  // Sampled: tangential deflection (0.05 rad, 1 µm), projected, de-duplicated.
  GCPnts_TangentialDeflection sampler(c, 0.05, 1e-3, 8);
  std::vector<gp_XY> pts;
  for (int i = 1; i <= sampler.NbPoints(); ++i) {
    const gp_XY q = toPlaneXY(plane, sampler.Value(i));
    if (pts.empty() || (q - pts.back()).Modulus() > 1e-9) pts.push_back(q);
  }
  if (pts.size() < 2) return out;
  // Collinear (e.g. a circle seen edge-on): one line between the extreme points.
  size_t far = 0;
  double farDist = 0;
  for (size_t i = 1; i < pts.size(); ++i) {
    const double d = (pts[i] - pts[0]).Modulus();
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  if (farDist < 1e-9) return out;
  const gp_XY u = (pts[far] - pts[0]) / farDist;
  double lo = 0;
  double hi = 0;
  bool collinear = true;
  for (const gp_XY& q : pts) {
    const gp_XY v = q - pts[0];
    if (std::fabs(v.X() * u.Y() - v.Y() * u.X()) > 1e-7 * std::max(1.0, farDist)) {
      collinear = false;
      break;
    }
    const double t = v.X() * u.X() + v.Y() * u.Y();
    lo = std::min(lo, t);
    hi = std::max(hi, t);
  }
  if (collinear) {
    out.push_back("{\"kind\":\"line\",\"a\":" + vec2Json(pts[0] + u * lo) + ",\"b\":" + vec2Json(pts[0] + u * hi) + "}");
    return out;
  }
  std::string poly = "{\"kind\":\"polyline\",\"points\":[";
  for (size_t i = 0; i < pts.size(); ++i) {
    if (i > 0) poly.push_back(',');
    poly += vec2Json(pts[i]);
  }
  poly += "]}";
  out.push_back(poly);
  return out;
}

std::string projectedEdgeJson(int ordinal, const TopoDS_Edge& edge, const gp_Ax3& plane) {
  std::string json = "{\"edge\":" + std::to_string(ordinal) + ",\"curves\":[";
  const std::vector<std::string> curves = projectEdgeCurves(edge, plane);
  for (size_t i = 0; i < curves.size(); ++i) {
    if (i > 0) json.push_back(',');
    json += curves[i];
  }
  return json + "]}";
}

gp_Ax3 queryPlane(const Json& query) {
  const Json* plane = query.get("plane");
  if (plane == nullptr || !plane->isObject()) raiseError("INVALID_INPUT", "plane (a Frame) is required");
  return gp_Ax3(parseFrame(plane));
}

int queryOrdinal(const Json& v, int count, const char* what) {
  if (!v.isNumber() || v.number != std::floor(v.number) || v.number < 0) {
    raiseError("INVALID_INPUT", std::string(what) + " ordinals must be non-negative integers");
  }
  if (v.number >= count) {
    raiseError("UNRESOLVED_REFERENCE", std::string(what) + " " + jsonNumber(v.number) + " does not exist on the shape",
               "Re-pick the entity.");
  }
  return static_cast<int>(v.number);
}

std::string projectEdgesQuery(const Json& query) {
  if (!query.isObject()) raiseError("INVALID_INPUT", "projectEdges query must be an object");
  const auto record = requireShape(optHandle(query, "shape"));
  const gp_Ax3 plane = queryPlane(query);
  const Json* edges = query.get("edges");
  if (edges == nullptr || !edges->isArray()) raiseError("INVALID_INPUT", "edges must be an array of edge ordinals");
  const Topo& topo = record->topo();
  std::string json = "[";
  for (size_t i = 0; i < edges->array.size(); ++i) {
    const int e = queryOrdinal(*edges->array[i], topo.edges.Extent(), "Edge");
    if (i > 0) json.push_back(',');
    json += projectedEdgeJson(e, TopoDS::Edge(topo.edges(e + 1)), plane);
  }
  return json + "]";
}

std::string projectFaceOutlineQuery(const Json& query) {
  if (!query.isObject()) raiseError("INVALID_INPUT", "projectFaceOutline query must be an object");
  const auto record = requireShape(optHandle(query, "shape"));
  const gp_Ax3 plane = queryPlane(query);
  const Json* faceJ = query.get("face");
  if (faceJ == nullptr) raiseError("INVALID_INPUT", "face (a face ordinal) is required");
  const Topo& topo = record->topo();
  const int fi = queryOrdinal(*faceJ, topo.faces.Extent(), "Face");
  const TopoDS_Face face = TopoDS::Face(topo.faces(fi + 1));
  const TopoDS_Wire outer = BRepTools::OuterWire(face);
  auto loopJson = [&](const TopoDS_Wire& wire) {
    std::string json = "[";
    bool first = true;
    for (BRepTools_WireExplorer ex(wire, face); ex.More(); ex.Next()) {
      const int ei = topo.edges.FindIndex(ex.Current());
      if (ei <= 0) continue;
      if (!first) json.push_back(',');
      first = false;
      json += projectedEdgeJson(ei - 1, TopoDS::Edge(topo.edges(ei)), plane);
    }
    return json + "]";
  };
  std::string json = "{\"outer\":" + (outer.IsNull() ? std::string("[]") : loopJson(outer)) + ",\"inner\":[";
  bool first = true;
  for (TopoDS_Iterator it(face); it.More(); it.Next()) {
    if (it.Value().ShapeType() != TopAbs_WIRE || it.Value().IsSame(outer)) continue;
    if (!first) json.push_back(',');
    first = false;
    json += loopJson(TopoDS::Wire(it.Value()));
  }
  return json + "]}";
}
