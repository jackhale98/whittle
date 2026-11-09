"""RP05 Moulded housing: a ruled loft between the bottom rectangle and the smaller top rectangle
stands for the drafted box; the shell is FreeCAD's makeThickness (open top, inward)."""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, main  # noqa: E402

PART_ID = "rp05-moulded-housing"


def rect(l, w, z):
    pts = [V(-l / 2, -w / 2, z), V(l / 2, -w / 2, z), V(l / 2, w / 2, z), V(-l / 2, w / 2, z)]
    return Part.makePolygon(pts + [pts[0]])


def build(d):
    L, W, H, t = d["base_l"], d["base_w"], d["height"], math.tan(math.radians(d["draft_a"]))
    solid = Part.makeLoft([rect(L, W, 0), rect(L - 2 * H * t, W - 2 * H * t, H)], True, True)
    top = [f for f in solid.Faces if abs(f.CenterOfMass.z - H) < 1e-9]
    return solid.makeThickness(top, -d["wall"], 1e-4, False, False, 0, 0)


if __name__ == "__main__":
    main(PART_ID, build)
