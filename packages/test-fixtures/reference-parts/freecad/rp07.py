"""RP07 Duct adapter: block, ruled FreeCAD loft between the two rectangles, bore cut."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, box, cyl, main  # noqa: E402

PART_ID = "rp07-duct-adapter"


def rect(l, w, z):
    pts = [V(-l / 2, -w / 2, z), V(l / 2, -w / 2, z), V(l / 2, w / 2, z), V(-l / 2, w / 2, z)]
    return Part.makePolygon(pts + [pts[0]])


def build(d):
    L, W, T, h, i = d["base_l"], d["base_w"], d["base_t"], d["loft_h"], d["inset"]
    base = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    loft = Part.makeLoft([rect(L - 2 * i, W - 2 * i, T), rect(d["top_l"], d["top_w"], T + h)], True, True)
    body = base.fuse(loft)
    return body.cut(cyl(0, 0, -1, d["bore_d"] / 2, T + h + 2))


if __name__ == "__main__":
    main(PART_ID, build)
