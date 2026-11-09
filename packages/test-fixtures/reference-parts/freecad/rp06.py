"""RP06 Cable guide: FreeCAD pipe shells (Frenet, solid) along the line-arc-line paths."""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, box, main  # noqa: E402

PART_ID = "rp06-cable-guide"


def path(points_and_arcs):
    """Wire from ('L', p0, p1) and ('A', p0, pmid, p1) pieces."""
    edges = []
    for piece in points_and_arcs:
        if piece[0] == "L":
            edges.append(Part.LineSegment(piece[1], piece[2]).toShape())
        else:
            edges.append(Part.Arc(piece[1], piece[2], piece[3]).toShape())
    return Part.Wire(edges)


def build(d):
    L, W, T = d["blk_l"], d["blk_w"], d["blk_t"]
    block = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    # Groove: path in the plane z = T.
    b, y0, x1 = d["ch_bend"], -d["ch_in"], d["ch_turn_x"]
    k = b * math.sqrt(0.5)
    groove_path = path([
        ("L", V(-L / 2, y0, T), V(x1, y0, T)),
        ("A", V(x1, y0, T), V(x1 + k, y0 + b - k, T), V(x1 + b, y0 + b, T)),
        ("L", V(x1 + b, y0 + b, T), V(x1 + b, W / 2, T)),
    ])
    prof = Part.Wire(Part.makeCircle(d["ch_d"] / 2, V(-L / 2, y0, T), V(1, 0, 0)))
    groove = groove_path.makePipeShell([prof], True, True)
    block = block.cut(groove)
    # Rod: path in the plane x = -rod_x.
    x, y, h, rb, tail = -d["rod_x"], d["rod_y"], d["rod_h"], d["rod_bend"], d["rod_tail"]
    k = rb * math.sqrt(0.5)
    rod_path = path([
        ("L", V(x, y, T), V(x, y, T + h)),
        ("A", V(x, y, T + h), V(x, y - rb + k, T + h + k), V(x, y - rb, T + h + rb)),
        ("L", V(x, y - rb, T + h + rb), V(x, y - rb - tail, T + h + rb)),
    ])
    prof2 = Part.Wire(Part.makeCircle(d["rod_d"] / 2, V(x, y, T), V(0, 0, 1)))
    rod = rod_path.makePipeShell([prof2], True, True)
    return block.fuse(rod)


if __name__ == "__main__":
    main(PART_ID, build)
