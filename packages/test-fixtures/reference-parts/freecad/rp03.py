"""RP03 Ball knob: a sphere and a chamfered cylinder fused, the top cut away by a box."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, box, main  # noqa: E402

PART_ID = "rp03-ball-knob"


def build(d):
    R, a, L, h, c = d["ball_d"] / 2, d["stem_d"] / 2, d["stem_l"], d["flat_h"], d["chamfer_c"]
    ball = Part.makeSphere(R, V(0, 0, 0), V(0, 0, 1), -90, 90, 360)
    stem = Part.makeCylinder(a, L, V(0, 0, -L), V(0, 0, 1))
    bottom = [e for e in stem.Edges
              if all(abs(v.Point.z + L) < 1e-9 for v in e.Vertexes) and e.Curve.__class__.__name__ == "Circle"]
    stem = stem.makeChamfer(c, bottom)
    body = ball.fuse(stem)
    return body.cut(box(-2 * R, -2 * R, h, 2 * R, 2 * R, 2 * R))


if __name__ == "__main__":
    main(PART_ID, build)
