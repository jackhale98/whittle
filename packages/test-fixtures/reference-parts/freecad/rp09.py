"""RP09 Flanged hub: half-section revolved about Z; bolt holes drilled at 360/n degree steps,
instances 2 and 5 left out."""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, cut_all, cyl, main  # noqa: E402

PART_ID = "rp09-flanged-hub"
SKIP = (2, 5)


def build(d):
    R, rh, rb = d["flange_d"] / 2, d["hub_d"] / 2, d["bore_d"] / 2
    t, hh = d["flange_t"], d["hub_h"]
    pts = [(rb, 0), (R, 0), (R, t), (rh, t), (rh, t + hh), (rb, t + hh)]
    wire = Part.makePolygon([V(x, 0, z) for x, z in pts] + [V(rb, 0, 0)])
    body = Part.Face(wire).revolve(V(0, 0, 0), V(0, 0, 1), 360)
    n = int(d["bolt_n"]) + len(SKIP)  # positions: bolt_n holes plus the skipped ones
    holes = []
    for k in range(n):
        if k in SKIP:
            continue
        a = 2 * math.pi * k / n
        holes.append(cyl(d["pcd"] / 2 * math.cos(a), d["pcd"] / 2 * math.sin(a), -1, d["bolt_d"] / 2, t + 2))
    return cut_all(body, holes)


if __name__ == "__main__":
    main(PART_ID, build)
