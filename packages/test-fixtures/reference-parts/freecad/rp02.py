"""RP02 Stepped shaft: the finished half-profile (with its fillet arc and chamfer line drawn
explicitly) revolved about Z. No fillet or chamfer operator is used."""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, main  # noqa: E402

PART_ID = "rp02-stepped-shaft"


def build(d):
    R1, R2, R3 = d["d1"] / 2, d["d2"] / 2, d["d3"] / 2
    l1, l2, l3 = d["l1"], d["l2"], d["l3"]
    r, c = d["fillet_r"], d["chamfer_c"]
    H = l1 + l2 + l3
    p = lambda x, z: V(x, 0, z)  # noqa: E731
    k = r * math.sqrt(0.5)
    edges = [
        Part.LineSegment(p(0, 0), p(R1, 0)).toShape(),
        Part.LineSegment(p(R1, 0), p(R1, l1)).toShape(),
        Part.LineSegment(p(R1, l1), p(R2 + r, l1)).toShape(),
        Part.Arc(p(R2 + r, l1), p(R2 + r - k, l1 + r - k), p(R2, l1 + r)).toShape(),
        Part.LineSegment(p(R2, l1 + r), p(R2, l1 + l2)).toShape(),
        Part.LineSegment(p(R2, l1 + l2), p(R3, l1 + l2)).toShape(),
        Part.LineSegment(p(R3, l1 + l2), p(R3, H - c)).toShape(),
        Part.LineSegment(p(R3, H - c), p(R3 - c, H)).toShape(),
        Part.LineSegment(p(R3 - c, H), p(0, H)).toShape(),
        Part.LineSegment(p(0, H), p(0, 0)).toShape(),
    ]
    face = Part.Face(Part.Wire(edges))
    return face.revolve(V(0, 0, 0), V(0, 0, 1), 360)


if __name__ == "__main__":
    main(PART_ID, build)
