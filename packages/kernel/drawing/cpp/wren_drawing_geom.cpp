// Wren drawing kernel — 2D curves of a view: exact projection of 3D edge geometry onto the view
// plane, clipping to a detail circle, and contracts `Curve2` JSON.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Part of the amalgamated drawing translation unit (see wren_drawing.h); continues the anonymous
// namespace opened by whittle_core.cpp, whose JSON and error helpers it uses.
//
// Projection is parallel (orthographic), so it is affine: lines stay lines, a conic stays a conic
// (an ellipse, or a circle when it is seen face-on), and a B-spline maps pole by pole with the same
// knots and weights. Only curves without an exact form (offset curves, intersection curves) are
// sampled. A circle or ellipse seen edge-on projects onto a segment that it may cover twice, so it
// becomes lines split at its turning points, exactly.

// View plane: x right, y up, z = x × y towards the viewer. The origin is the part origin.
struct ViewFrame {
  gp_XYZ x;
  gp_XYZ y;
  gp_XYZ z;
};

gp_XY toView(const ViewFrame& f, const gp_Pnt& p) {
  return gp_XY(p.XYZ().Dot(f.x), p.XYZ().Dot(f.y));
}

gp_XY toViewVec(const ViewFrame& f, const gp_Vec& v) {
  return gp_XY(v.XYZ().Dot(f.x), v.XYZ().Dot(f.y));
}

// One 2D curve in the view plane (part mm): the C++ side of contracts `Curve2`.
struct Curve2D {
  enum class Kind { Line, Arc, Ellipse, BSpline, Polyline };
  Kind kind = Kind::Line;
  gp_XY a;       // Line
  gp_XY b;       // Line
  gp_XY center;  // Arc, Ellipse
  double radius = 0;  // Arc
  gp_XY major;        // Ellipse: the semi-major axis as a vector
  double ratio = 1;   // Ellipse: minor / major
  // Arc: angles; Ellipse: parameters (p = c + cos t·major + sin t·ratio·rot90(major)). Both run
  // counter-clockwise from start to end, end > start; a full curve is 0 → 2π.
  double start = 0;
  double end = 0;
  int degree = 0;               // BSpline
  std::vector<gp_XY> poles;     // BSpline
  std::vector<double> knots;    // BSpline: flat knot vector, poles + degree + 1 values
  std::vector<double> weights;  // BSpline: empty unless rational
  std::vector<gp_XY> points;    // Polyline
};

constexpr double kTwoPi = 2 * kPi;

double normAngle(double a) {
  a = std::fmod(a, kTwoPi);
  if (a < 0) a += kTwoPi;
  return a;
}

double angleOf(const gp_XY& v) { return std::atan2(v.Y(), v.X()); }

Curve2D makeLine(const gp_XY& a, const gp_XY& b) {
  Curve2D c;
  c.kind = Curve2D::Kind::Line;
  c.a = a;
  c.b = b;
  return c;
}

// The CCW range of an arc or elliptic arc whose own parameter `t` is ±u + const: `t1`, `t2` are its
// values at the ends of a 3D parameter range of length `span`; `ccw` = t grows with u.
void ccwRange(double t1, double t2, double span, bool ccw, double& start, double& end) {
  if (span >= kTwoPi - 1e-9) {
    start = 0;
    end = kTwoPi;
    return;
  }
  start = normAngle(ccw ? t1 : t2);
  end = start + span;
}

// Points (in order) to curves: a polyline, or lines when the points are collinear (a conic or a
// flat spline seen edge-on), split where the points turn back along the line.
void emitPoints(const std::vector<gp_XY>& raw, double tiny, std::vector<Curve2D>& out) {
  std::vector<gp_XY> pts;
  pts.reserve(raw.size());
  for (const gp_XY& q : raw) {
    if (pts.empty() || (q - pts.back()).Modulus() > tiny) pts.push_back(q);
  }
  if (pts.size() < 2) return;
  size_t far = 0;
  double farDist = 0;
  for (size_t i = 1; i < pts.size(); ++i) {
    const double d = (pts[i] - pts[0]).Modulus();
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  if (farDist <= tiny) return;
  const gp_XY u = (pts[far] - pts[0]) / farDist;
  bool collinear = true;
  for (const gp_XY& q : pts) {
    const gp_XY v = q - pts[0];
    if (std::fabs(v.X() * u.Y() - v.Y() * u.X()) > 1e-9 * std::max(1.0, farDist)) {
      collinear = false;
      break;
    }
  }
  if (!collinear) {
    if (pts.size() == 2) {
      out.push_back(makeLine(pts[0], pts[1]));
      return;
    }
    Curve2D c;
    c.kind = Curve2D::Kind::Polyline;
    c.points = std::move(pts);
    out.push_back(std::move(c));
    return;
  }
  // Monotone runs along u.
  size_t runStart = 0;
  int sense = 0;
  for (size_t i = 1; i < pts.size(); ++i) {
    const double step = (pts[i] - pts[i - 1]).Dot(u);
    const int s = step > 0 ? 1 : -1;
    if (sense != 0 && s != sense) {
      out.push_back(makeLine(pts[runStart], pts[i - 1]));
      runStart = i - 1;
    }
    sense = s;
  }
  out.push_back(makeLine(pts[runStart], pts.back()));
}

// Samples [u1, u2] within `tol` (chord) and 0.1 rad, projected.
void projectSampled(const Adaptor3d_Curve& c, double u1, double u2, const ViewFrame& f, double tol,
                    std::vector<Curve2D>& out) {
  GCPnts_TangentialDeflection sampler(c, u1, u2, 0.1, tol, 2);
  std::vector<gp_XY> pts;
  pts.reserve(static_cast<size_t>(std::max(2, sampler.NbPoints())));
  for (int i = 1; i <= sampler.NbPoints(); ++i) pts.push_back(toView(f, sampler.Value(i)));
  emitPoints(pts, 1e-9, out);
}

// Circle or ellipse c + X cos u + Y sin u (X, Y: the conic's axes scaled by its radii).
void projectConic(const gp_Ax2& pos, double ra, double rb, double u1, double u2, const ViewFrame& f,
                  std::vector<Curve2D>& out) {
  const gp_XY ctr = toView(f, gp_Pnt(pos.Location()));
  const gp_XY X = toViewVec(f, gp_Vec(pos.XDirection()) * ra);
  const gp_XY Y = toViewVec(f, gp_Vec(pos.YDirection()) * rb);
  const double det = X.X() * Y.Y() - X.Y() * Y.X();
  const double span = u2 - u1;
  auto at = [&](double u) { return ctr + X * std::cos(u) + Y * std::sin(u); };
  if (std::fabs(det) <= 1e-9 * ra * rb) {
    // Edge-on: s(u) = (X·d) cos u + (Y·d) sin u along d turns at u0 + kπ.
    const gp_XY big = X.Modulus() >= Y.Modulus() ? X : Y;
    if (big.Modulus() <= 0) return;
    const gp_XY d = big / big.Modulus();
    const double u0 = std::atan2(Y.Dot(d), X.Dot(d));
    std::vector<double> cuts{u1};
    const double kFirst = std::ceil((u1 - u0) / kPi);
    for (double k = kFirst;; k += 1) {
      const double t = u0 + k * kPi;
      if (t >= u2 - 1e-12) break;
      if (t > u1 + 1e-12) cuts.push_back(t);
    }
    cuts.push_back(u2);
    for (size_t i = 1; i < cuts.size(); ++i) {
      const gp_XY a = at(cuts[i - 1]);
      const gp_XY b = at(cuts[i]);
      if ((b - a).Modulus() > 1e-9) out.push_back(makeLine(a, b));
    }
    return;
  }
  // Principal axes of M = [X Y]: A = M Mᵀ = [[p, q], [q, r]].
  const double p = X.X() * X.X() + Y.X() * Y.X();
  const double q = X.X() * X.Y() + Y.X() * Y.Y();
  const double r = X.Y() * X.Y() + Y.Y() * Y.Y();
  const double mean = 0.5 * (p + r);
  const double dev = std::hypot(0.5 * (p - r), q);
  const double majorR = std::sqrt(mean + dev);
  const double minorR = std::sqrt(std::max(0.0, mean - dev));
  const bool ccw = det > 0;
  Curve2D c;
  c.center = ctr;
  if (majorR - minorR <= 1e-9 * majorR) {
    c.kind = Curve2D::Kind::Arc;
    c.radius = 0.5 * (majorR + minorR);
    ccwRange(angleOf(at(u1) - ctr), angleOf(at(u2) - ctr), span, ccw, c.start, c.end);
  } else {
    const double rot = 0.5 * std::atan2(2 * q, p - r);
    const gp_XY U(std::cos(rot), std::sin(rot));
    const gp_XY V(-U.Y(), U.X());
    auto param = [&](double u) {
      const gp_XY w = at(u) - ctr;
      return std::atan2(w.Dot(V) / minorR, w.Dot(U) / majorR);
    };
    c.kind = Curve2D::Kind::Ellipse;
    c.major = U * majorR;
    c.ratio = minorR / majorR;
    ccwRange(param(u1), param(u2), span, ccw, c.start, c.end);
  }
  out.push_back(std::move(c));
}

// B-spline or Bezier: poles projected, same weights and knots, trimmed to [u1, u2] and clamped.
// Returns false when the projection is flat (poles on one line) or OCCT refuses the trim; the
// caller then samples.
bool projectBSpline(const BRepAdaptor_Curve& c, double u1, double u2, const ViewFrame& f,
                    std::vector<Curve2D>& out) {
  occ::handle<Geom_BSplineCurve> bs;
  try {
    if (c.GetType() == GeomAbs_BSplineCurve) {
      bs = occ::down_cast<Geom_BSplineCurve>(c.BSpline()->Copy());
    } else {
      // A Bezier curve is the B-spline with one span on [0, 1] (its parameter range).
      const occ::handle<Geom_BezierCurve> bz = c.Bezier();
      const int np = bz->NbPoles();
      NCollection_Array1<gp_Pnt> P(1, np);
      NCollection_Array1<double> W(1, np);
      for (int i = 1; i <= np; ++i) {
        P(i) = bz->Pole(i);
        W(i) = bz->Weight(i);
      }
      NCollection_Array1<double> K(1, 2);
      NCollection_Array1<int> M(1, 2);
      K(1) = 0;
      K(2) = 1;
      M(1) = M(2) = bz->Degree() + 1;
      bs = new Geom_BSplineCurve(P, W, K, M, bz->Degree(), false);
    }
    if (bs.IsNull()) return false;
    const double first = bs->FirstParameter();
    const double last = bs->LastParameter();
    const double period = bs->IsPeriodic() ? last - first : 0;
    if (bs->IsPeriodic() && u2 - u1 >= period - Precision::PConfusion()) {
      bs->SetNotPeriodic();
    } else if (bs->IsPeriodic() || u1 > first + Precision::PConfusion() ||
               u2 < last - Precision::PConfusion() || bs->Multiplicity(1) != bs->Degree() + 1 ||
               bs->Multiplicity(bs->NbKnots()) != bs->Degree() + 1) {
      const double a = bs->IsPeriodic() ? u1 : std::max(u1, first);
      const double b = bs->IsPeriodic() ? u2 : std::min(u2, last);
      if (!(b > a)) return false;
      bs->Segment(a, b);
    }
    if (bs->IsPeriodic()) bs->SetNotPeriodic();
  } catch (const Standard_Failure&) {
    return false;
  }
  Curve2D out2;
  out2.kind = Curve2D::Kind::BSpline;
  out2.degree = bs->Degree();
  const int np = bs->NbPoles();
  out2.poles.reserve(static_cast<size_t>(np));
  for (int i = 1; i <= np; ++i) out2.poles.push_back(toView(f, bs->Pole(i)));
  // Poles on one line: the curve lies on a segment (seen edge-on); sampled into exact lines.
  {
    double far = 0;
    size_t farI = 0;
    for (size_t i = 1; i < out2.poles.size(); ++i) {
      const double d = (out2.poles[i] - out2.poles[0]).Modulus();
      if (d > far) {
        far = d;
        farI = i;
      }
    }
    if (far < 1e-9) return false;
    const gp_XY dir = (out2.poles[farI] - out2.poles[0]) / far;
    bool flat = true;
    for (const gp_XY& q : out2.poles) {
      const gp_XY v = q - out2.poles[0];
      if (std::fabs(v.X() * dir.Y() - v.Y() * dir.X()) > 1e-9 * std::max(1.0, far)) {
        flat = false;
        break;
      }
    }
    if (flat) return false;
  }
  if (bs->IsRational()) {
    out2.weights.reserve(static_cast<size_t>(np));
    for (int i = 1; i <= np; ++i) out2.weights.push_back(bs->Weight(i));
  }
  const NCollection_Array1<double>& K = bs->KnotSequence();  // flat: poles + degree + 1 values
  out2.knots.reserve(static_cast<size_t>(K.Length()));
  for (int i = K.Lower(); i <= K.Upper(); ++i) out2.knots.push_back(K(i));
  out.push_back(std::move(out2));
  return true;
}

// The part of a 3D curve on [u1, u2], projected onto the view plane.
void projectSegment(const BRepAdaptor_Curve& c, double u1, double u2, const ViewFrame& f,
                    double tol, std::vector<Curve2D>& out) {
  if (!(u2 > u1)) return;
  switch (c.GetType()) {
    case GeomAbs_Line: {
      const gp_XY a = toView(f, c.Value(u1));
      const gp_XY b = toView(f, c.Value(u2));
      if ((b - a).Modulus() > 1e-9) out.push_back(makeLine(a, b));
      return;
    }
    case GeomAbs_Circle: {
      const gp_Circ circ = c.Circle();
      projectConic(circ.Position(), circ.Radius(), circ.Radius(), u1, u2, f, out);
      return;
    }
    case GeomAbs_Ellipse: {
      const gp_Elips el = c.Ellipse();
      projectConic(el.Position(), el.MajorRadius(), el.MinorRadius(), u1, u2, f, out);
      return;
    }
    case GeomAbs_BSplineCurve:
    case GeomAbs_BezierCurve:
      if (projectBSpline(c, u1, u2, f, out)) return;
      break;
    default:
      break;
  }
  projectSampled(c, u1, u2, f, tol, out);
}

// Reverses a curve's direction where the type has one (lines, polylines, B-splines). Arcs and
// ellipses stay counter-clockwise by definition.
void reverseCurve(Curve2D& c) {
  switch (c.kind) {
    case Curve2D::Kind::Line:
      std::swap(c.a, c.b);
      break;
    case Curve2D::Kind::Polyline:
      std::reverse(c.points.begin(), c.points.end());
      break;
    case Curve2D::Kind::BSpline: {
      std::reverse(c.poles.begin(), c.poles.end());
      std::reverse(c.weights.begin(), c.weights.end());
      if (!c.knots.empty()) {
        const double s = c.knots.front() + c.knots.back();
        std::vector<double> k(c.knots.rbegin(), c.knots.rend());
        for (double& v : k) v = s - v;
        c.knots = std::move(k);
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// Detail views: clip to a circle in the view plane
// ---------------------------------------------------------------------------------------------

struct ClipCircle {
  gp_XY c;
  double r = 0;
  double f(const gp_XY& p) const { return (p - c).SquareModulus() - r * r; }
  bool inside(const gp_XY& p) const { return f(p) < 0; }
};

// Sub-ranges of [t0, t1] where `eval` is inside the circle, from the given crossing parameters.
template <typename Eval>
std::vector<std::pair<double, double>> insideRanges(Eval&& eval, const ClipCircle& k, double t0,
                                                     double t1, std::vector<double> cuts) {
  std::sort(cuts.begin(), cuts.end());
  std::vector<double> ts{t0};
  for (double t : cuts) {
    if (t > ts.back() + 1e-12 && t < t1 - 1e-12) ts.push_back(t);
  }
  ts.push_back(t1);
  std::vector<std::pair<double, double>> ranges;
  for (size_t i = 1; i < ts.size(); ++i) {
    if (!k.inside(eval(0.5 * (ts[i - 1] + ts[i])))) continue;
    if (!ranges.empty() && std::fabs(ranges.back().second - ts[i - 1]) <= 1e-12) {
      ranges.back().second = ts[i];  // a tangential touch: keep one range
    } else {
      ranges.emplace_back(ts[i - 1], ts[i]);
    }
  }
  return ranges;
}

// Crossings of a smooth curve with the circle, by sampling `n` intervals and bisection.
template <typename Eval>
std::vector<double> numericCrossings(Eval&& eval, const ClipCircle& k, double t0, double t1,
                                     int n) {
  std::vector<double> out;
  double ta = t0;
  double fa = k.f(eval(ta));
  for (int i = 1; i <= n; ++i) {
    const double tb = t0 + (t1 - t0) * i / n;
    const double fb = k.f(eval(tb));
    if ((fa < 0) != (fb < 0)) {
      double lo = ta;
      double hi = tb;
      double flo = fa;
      for (int it = 0; it < 80 && hi - lo > 1e-15 * std::max(1.0, std::fabs(hi)); ++it) {
        const double mid = 0.5 * (lo + hi);
        const double fm = k.f(eval(mid));
        if ((fm < 0) == (flo < 0)) {
          lo = mid;
          flo = fm;
        } else {
          hi = mid;
        }
      }
      out.push_back(0.5 * (lo + hi));
    }
    ta = tb;
    fa = fb;
  }
  return out;
}

// Parameters t ∈ [0, 1] where a + t(b − a) crosses the circle.
std::vector<double> lineCrossings(const gp_XY& a, const gp_XY& b, const ClipCircle& k) {
  const gp_XY d = b - a;
  const gp_XY w = a - k.c;
  const double A = d.SquareModulus();
  const double B = 2 * d.Dot(w);
  const double C = w.SquareModulus() - k.r * k.r;
  std::vector<double> out;
  if (A <= 0) return out;
  const double disc = B * B - 4 * A * C;
  if (disc <= 0) return out;
  const double s = std::sqrt(disc);
  out.push_back((-B - s) / (2 * A));
  out.push_back((-B + s) / (2 * A));
  return out;
}

occ::handle<Geom2d_BSplineCurve> toGeom2d(const Curve2D& c) {
  // Flat knots → distinct knots and multiplicities.
  std::vector<double> k;
  std::vector<int> m;
  for (double v : c.knots) {
    if (!k.empty() && std::fabs(v - k.back()) <= 1e-12 * std::max(1.0, std::fabs(v))) {
      ++m.back();
    } else {
      k.push_back(v);
      m.push_back(1);
    }
  }
  const int np = static_cast<int>(c.poles.size());
  NCollection_Array1<gp_Pnt2d> P(1, np);
  for (int i = 1; i <= np; ++i) {
    const gp_XY& q = c.poles[static_cast<size_t>(i - 1)];
    P(i) = gp_Pnt2d(q.X(), q.Y());
  }
  const int nk = static_cast<int>(k.size());
  NCollection_Array1<double> K(1, nk);
  NCollection_Array1<int> M(1, nk);
  for (int i = 1; i <= nk; ++i) {
    K(i) = k[static_cast<size_t>(i - 1)];
    M(i) = m[static_cast<size_t>(i - 1)];
  }
  if (c.weights.empty()) return new Geom2d_BSplineCurve(P, K, M, c.degree, false);
  NCollection_Array1<double> W(1, np);
  for (int i = 1; i <= np; ++i) W(i) = c.weights[static_cast<size_t>(i - 1)];
  return new Geom2d_BSplineCurve(P, W, K, M, c.degree, false);
}

Curve2D fromGeom2d(const occ::handle<Geom2d_BSplineCurve>& g) {
  Curve2D c;
  c.kind = Curve2D::Kind::BSpline;
  c.degree = g->Degree();
  const int np = g->NbPoles();
  for (int i = 1; i <= np; ++i) c.poles.emplace_back(g->Pole(i).X(), g->Pole(i).Y());
  if (g->IsRational()) {
    for (int i = 1; i <= np; ++i) c.weights.push_back(g->Weight(i));
  }
  const NCollection_Array1<double>& K = g->KnotSequence();
  for (int i = K.Lower(); i <= K.Upper(); ++i) c.knots.push_back(K(i));
  return c;
}

// Arc or ellipse pieces for the kept parameter ranges of `c`. On a full curve the first and last
// ranges meet across its start: they become one piece running through it (end may pass 2π).
void conicPieces(const Curve2D& c, std::vector<std::pair<double, double>> ranges,
                 std::vector<Curve2D>& out) {
  const bool full = c.end - c.start >= kTwoPi - 1e-9;
  if (full && ranges.size() >= 2 && ranges.front().first <= c.start + 1e-12 &&
      ranges.back().second >= c.end - 1e-12) {
    ranges.back().second = ranges.front().second + kTwoPi;
    ranges.erase(ranges.begin());
  }
  for (const auto& r : ranges) {
    Curve2D piece = c;
    piece.start = r.first;
    piece.end = r.second;
    if (piece.end - piece.start < kTwoPi - 1e-9) {
      const double s = normAngle(piece.start);
      piece.end = s + (piece.end - piece.start);
      piece.start = s;
    }
    out.push_back(std::move(piece));
  }
}

// Appends the parts of `c` inside the circle.
void clipCurve(const Curve2D& c, const ClipCircle& k, std::vector<Curve2D>& out) {
  switch (c.kind) {
    case Curve2D::Kind::Line: {
      auto eval = [&](double t) { return c.a + (c.b - c.a) * t; };
      for (const auto& r : insideRanges(eval, k, 0, 1, lineCrossings(c.a, c.b, k))) {
        out.push_back(makeLine(eval(r.first), eval(r.second)));
      }
      return;
    }
    case Curve2D::Kind::Arc: {
      auto eval = [&](double t) {
        return c.center + gp_XY(std::cos(t), std::sin(t)) * c.radius;
      };
      std::vector<double> cuts;
      const gp_XY w = k.c - c.center;
      const double D = w.Modulus();
      if (D > 1e-12 && D < c.radius + k.r && D > std::fabs(c.radius - k.r)) {
        const double phi = angleOf(w);
        const double cosA = (c.radius * c.radius + D * D - k.r * k.r) / (2 * c.radius * D);
        const double alpha = std::acos(std::max(-1.0, std::min(1.0, cosA)));
        for (double t : {phi - alpha, phi + alpha}) {
          double tt = c.start + normAngle(t - c.start);
          for (; tt < c.end; tt += kTwoPi) cuts.push_back(tt);
        }
      }
      conicPieces(c, insideRanges(eval, k, c.start, c.end, cuts), out);
      return;
    }
    case Curve2D::Kind::Ellipse: {
      const gp_XY minor = gp_XY(-c.major.Y(), c.major.X()) * c.ratio;
      auto eval = [&](double t) { return c.center + c.major * std::cos(t) + minor * std::sin(t); };
      const auto cuts = numericCrossings(eval, k, c.start, c.end, 256);
      conicPieces(c, insideRanges(eval, k, c.start, c.end, cuts), out);
      return;
    }
    case Curve2D::Kind::BSpline: {
      const occ::handle<Geom2d_BSplineCurve> g = toGeom2d(c);
      const double t0 = g->FirstParameter();
      const double t1 = g->LastParameter();
      auto eval = [&](double t) { return g->Value(t).XY(); };
      const int n = std::max(256, 16 * static_cast<int>(c.poles.size()));
      const auto ranges = insideRanges(eval, k, t0, t1, numericCrossings(eval, k, t0, t1, n));
      for (const auto& r : ranges) {
        if (r.first <= t0 + 1e-12 && r.second >= t1 - 1e-12) {
          out.push_back(c);
          continue;
        }
        occ::handle<Geom2d_BSplineCurve> piece = occ::down_cast<Geom2d_BSplineCurve>(g->Copy());
        piece->Segment(r.first, r.second);
        out.push_back(fromGeom2d(piece));
      }
      return;
    }
    case Curve2D::Kind::Polyline: {
      std::vector<std::vector<gp_XY>> runs;
      std::vector<gp_XY> run;
      auto flush = [&]() {
        if (run.size() >= 2) runs.push_back(run);
        run.clear();
      };
      for (size_t i = 1; i < c.points.size(); ++i) {
        const gp_XY a = c.points[i - 1];
        const gp_XY b = c.points[i];
        auto eval = [&](double t) { return a + (b - a) * t; };
        const auto ranges = insideRanges(eval, k, 0, 1, lineCrossings(a, b, k));
        for (const auto& r : ranges) {
          const gp_XY p0 = eval(r.first);
          const gp_XY p1 = eval(r.second);
          if (run.empty() || r.first > 1e-12) {
            flush();
            run.push_back(p0);
          }
          run.push_back(p1);
          if (r.second < 1 - 1e-12) flush();
        }
        if (ranges.empty()) flush();
      }
      flush();
      // A closed polyline whose first and last runs meet at its start point: one run.
      const bool closed = c.points.size() > 2 && c.points.front().X() == c.points.back().X() &&
                          c.points.front().Y() == c.points.back().Y();
      if (closed && runs.size() >= 2 && (runs.front().front() - c.points.front()).Modulus() == 0 &&
          (runs.back().back() - c.points.back()).Modulus() == 0) {
        runs.back().insert(runs.back().end(), runs.front().begin() + 1, runs.front().end());
        runs.erase(runs.begin());
      }
      for (std::vector<gp_XY>& r : runs) {
        if (r.size() == 2) {
          out.push_back(makeLine(r[0], r[1]));
        } else {
          Curve2D p;
          p.kind = Curve2D::Kind::Polyline;
          p.points = std::move(r);
          out.push_back(std::move(p));
        }
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// JSON (contracts drawing.ts `Curve2`)
// ---------------------------------------------------------------------------------------------

// Polyline points need far fewer digits than exact parameters: 10 significant digits are below
// 1e-6 mm on parts up to 10 m.
void writeCompactNumber(std::string& out, double value) {
  if (!std::isfinite(value)) {
    out += "null";
    return;
  }
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.10g", value);
  out += buf;
}

void writeXY(std::string& out, const gp_XY& p, bool compact = false) {
  out.push_back('[');
  if (compact) {
    writeCompactNumber(out, p.X());
    out.push_back(',');
    writeCompactNumber(out, p.Y());
  } else {
    writeJsonNumber(out, p.X());
    out.push_back(',');
    writeJsonNumber(out, p.Y());
  }
  out.push_back(']');
}

void writeCurve(std::string& out, const Curve2D& c) {
  switch (c.kind) {
    case Curve2D::Kind::Line:
      out += "{\"kind\":\"line\",\"a\":";
      writeXY(out, c.a);
      out += ",\"b\":";
      writeXY(out, c.b);
      out.push_back('}');
      return;
    case Curve2D::Kind::Arc:
      out += "{\"kind\":\"arc\",\"center\":";
      writeXY(out, c.center);
      out += ",\"radius\":";
      writeJsonNumber(out, c.radius);
      out += ",\"start\":";
      writeJsonNumber(out, c.start);
      out += ",\"end\":";
      writeJsonNumber(out, c.end);
      out.push_back('}');
      return;
    case Curve2D::Kind::Ellipse:
      out += "{\"kind\":\"ellipse\",\"center\":";
      writeXY(out, c.center);
      out += ",\"major\":";
      writeXY(out, c.major);
      out += ",\"ratio\":";
      writeJsonNumber(out, c.ratio);
      out += ",\"start\":";
      writeJsonNumber(out, c.start);
      out += ",\"end\":";
      writeJsonNumber(out, c.end);
      out.push_back('}');
      return;
    case Curve2D::Kind::BSpline: {
      out += "{\"kind\":\"bspline\",\"degree\":" + std::to_string(c.degree) + ",\"poles\":[";
      for (size_t i = 0; i < c.poles.size(); ++i) {
        if (i > 0) out.push_back(',');
        writeXY(out, c.poles[i]);
      }
      out += "],\"knots\":[";
      for (size_t i = 0; i < c.knots.size(); ++i) {
        if (i > 0) out.push_back(',');
        writeJsonNumber(out, c.knots[i]);
      }
      out.push_back(']');
      if (!c.weights.empty()) {
        out += ",\"weights\":[";
        for (size_t i = 0; i < c.weights.size(); ++i) {
          if (i > 0) out.push_back(',');
          writeJsonNumber(out, c.weights[i]);
        }
        out.push_back(']');
      }
      out.push_back('}');
      return;
    }
    case Curve2D::Kind::Polyline:
      out += "{\"kind\":\"polyline\",\"points\":[";
      for (size_t i = 0; i < c.points.size(); ++i) {
        if (i > 0) out.push_back(',');
        writeXY(out, c.points[i], true);
      }
      out += "]}";
      return;
  }
}
