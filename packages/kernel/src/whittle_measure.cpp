// Whittle kernel façade — exact B-rep measurement (PLAN §9.1 phone measure, ADR-009 §4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated façade translation unit (see whittle_core.cpp); not compiled alone.
//
// One target: intrinsic values (vertex/point position, edge length + circle radius, face area +
// cylinder/sphere radius, body area). Two targets: minimum distance with its closest points
// (BRepExtrema_DistShapeShape) and, when both are planar faces and/or straight edges, the angle:
//   face–face  angle between the outward normals, [0, π] (adjacent box faces: π/2)
//   edge–edge  edges sharing a vertex: angle between the directions pointing away from it, [0, π]
//              (the corner angle); otherwise the angle between the two lines, [0, π/2]
//   face–edge  angle between the line and the plane, [0, π/2]

struct MeasureSubject {
  std::string kind;  // face | edge | vertex | body | point
  TopoDS_Shape shape;
  gp_Pnt point;  // kind == point
};

MeasureSubject parseMeasureTarget(const Json& t, const char* label) {
  if (!t.isObject()) {
    raiseError("INVALID_INPUT", std::string("Measure target '") + label + "' must be an object");
  }
  MeasureSubject s;
  if (t.get("point") != nullptr) {
    s.kind = "point";
    s.point = gp_Pnt(requireVec3(t, "point", label));
    s.shape = BRepBuilderAPI_MakeVertex(s.point).Vertex();
    return s;
  }
  const RefTarget r = resolveRef(t, std::string("/") + label);
  if (r.record->meshOnly) {
    raiseError("INVALID_INPUT", "Mesh reference bodies cannot be measured exactly",
               "Measure a solid body, or import a STEP file instead of a mesh.");
  }
  s.kind = r.kind;
  s.shape = r.sub;
  return s;
}

bool lineOf(const TopoDS_Shape& s, gp_Dir& dir) {
  if (s.ShapeType() != TopAbs_EDGE) return false;
  const TopoDS_Edge& e = TopoDS::Edge(s);
  if (BRep_Tool::Degenerated(e) || !BRep_Tool::IsGeometric(e)) return false;
  BRepAdaptor_Curve c(e);
  if (c.GetType() != GeomAbs_Line) return false;
  dir = c.Line().Direction();
  if (e.Orientation() == TopAbs_REVERSED) dir.Reverse();
  return true;
}

bool flatFace(const TopoDS_Shape& s, gp_Dir& normal) {
  if (s.ShapeType() != TopAbs_FACE || !BRep_Tool::IsGeometric(TopoDS::Face(s))) return false;
  gp_Pln pln;
  return planeOf(TopoDS::Face(s), pln, normal);
}

double clampedAngle(double cosine) { return std::acos(std::max(-1.0, std::min(1.0, cosine))); }

// Direction of straight edge `e` pointing away from vertex `v` (one of its ends).
gp_Vec awayFrom(const TopoDS_Edge& e, const TopoDS_Vertex& v) {
  TopoDS_Vertex v1, v2;
  TopExp::Vertices(e, v1, v2);
  const gp_Pnt p = BRep_Tool::Pnt(v);
  const gp_Pnt other = v1.IsSame(v) ? BRep_Tool::Pnt(v2) : BRep_Tool::Pnt(v1);
  return gp_Vec(p, other);
}

bool measureAngle(const MeasureSubject& a, const MeasureSubject& b, double& angle) {
  gp_Dir na, nb;
  if (flatFace(a.shape, na) && flatFace(b.shape, nb)) {
    angle = clampedAngle(na.Dot(nb));
    return true;
  }
  gp_Dir la, lb;
  if (lineOf(a.shape, la) && lineOf(b.shape, lb)) {
    const TopoDS_Edge& ea = TopoDS::Edge(a.shape);
    const TopoDS_Edge& eb = TopoDS::Edge(b.shape);
    TopoDS_Vertex common;
    if (!ea.IsSame(eb) && TopExp::CommonVertex(ea, eb, common)) {
      const gp_Vec va = awayFrom(ea, common);
      const gp_Vec vb = awayFrom(eb, common);
      if (va.Magnitude() > 1e-12 && vb.Magnitude() > 1e-12) {
        angle = va.Angle(vb);
        return true;
      }
    }
    angle = clampedAngle(std::fabs(la.Dot(lb)));
    return true;
  }
  if ((flatFace(a.shape, na) && lineOf(b.shape, lb)) || (flatFace(b.shape, na) && lineOf(a.shape, lb))) {
    angle = std::asin(std::max(0.0, std::min(1.0, std::fabs(na.Dot(lb)))));
    return true;
  }
  return false;
}

std::string intrinsicJson(const MeasureSubject& s) {
  std::string json = "{";
  auto field = [&](const char* key, const std::string& value) {
    if (json.size() > 1) json.push_back(',');
    json += std::string("\"") + key + "\":" + value;
  };
  if (s.kind == "point") {
    field("position", jsonPoint(s.point));
  } else if (s.kind == "vertex") {
    field("position", jsonPoint(BRep_Tool::Pnt(TopoDS::Vertex(s.shape))));
  } else if (s.kind == "edge") {
    const TopoDS_Edge& e = TopoDS::Edge(s.shape);
    field("length", jsonNumber(edgeLength(e)));
    if (!BRep_Tool::Degenerated(e) && BRep_Tool::IsGeometric(e)) {
      BRepAdaptor_Curve c(e);
      if (c.GetType() == GeomAbs_Circle) field("radius", jsonNumber(c.Circle().Radius()));
    }
  } else if (s.kind == "face") {
    const TopoDS_Face& f = TopoDS::Face(s.shape);
    GProp_GProps props;
    reportedSurfaceProperties(f, props);
    field("area", jsonNumber(props.Mass()));
    if (BRep_Tool::IsGeometric(f)) {
      BRepAdaptor_Surface surface(f, false);
      if (surface.GetType() == GeomAbs_Cylinder) {
        field("radius", jsonNumber(surface.Cylinder().Radius()));
      } else if (surface.GetType() == GeomAbs_Sphere) {
        field("radius", jsonNumber(surface.Sphere().Radius()));
      }
    }
  } else {  // body
    GProp_GProps props;
    reportedSurfaceProperties(s.shape, props);
    field("area", jsonNumber(props.Mass()));
  }
  json.push_back('}');
  return json;
}

std::string pairJson(const MeasureSubject& a, const MeasureSubject& b) {
  BRepExtrema_DistShapeShape dss;
  dss.LoadS1(a.shape);
  dss.LoadS2(b.shape);
  dss.Perform();
  if (!dss.IsDone() || dss.NbSolution() == 0) {
    raiseError("OPERATION_FAILED", "Could not measure the distance between these entities");
  }
  // Several solutions (e.g. parallel faces): take the one whose point on `a` is nearest to a's
  // centre, so the dimension line sits in the middle rather than at an arbitrary corner.
  const gp_Pnt centre = a.kind == "point" ? a.point : boxCenter(a.shape);
  int best = 1;
  double bestDistance = 1e300;
  for (int i = 1; i <= dss.NbSolution(); ++i) {
    const double dist = dss.PointOnShape1(i).Distance(centre);
    if (dist < bestDistance - 1e-9) {
      bestDistance = dist;
      best = i;
    }
  }
  std::string json = "{\"distance\":{\"value\":" + jsonNumber(dss.Value()) +
                     ",\"a\":" + jsonPoint(dss.PointOnShape1(best)) +
                     ",\"b\":" + jsonPoint(dss.PointOnShape2(best)) + "}";
  double angle = 0;
  if (measureAngle(a, b, angle)) json += ",\"angle\":" + jsonNumber(angle);
  json += "}";
  return json;
}

std::string measureQuery(const Json& query) {
  if (!query.isObject()) raiseError("INVALID_INPUT", "The measure query must be a JSON object");
  const Json* a = query.get("a");
  if (a == nullptr || a->kind == Json::Kind::Null) {
    raiseError("INVALID_INPUT", "Pick something to measure");
  }
  const MeasureSubject sa = parseMeasureTarget(*a, "a");
  const Json* b = query.get("b");
  if (b == nullptr || b->kind == Json::Kind::Null) return intrinsicJson(sa);
  const MeasureSubject sb = parseMeasureTarget(*b, "b");
  return pairJson(sa, sb);
}
