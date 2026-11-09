"""RP10 Comb plate: plate, two ears (the second built by mirroring the first with FreeCAD's
mirror), slots cut with instance 3 left out."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import V, box, cut_all, cyl, fuse_all, main  # noqa: E402

PART_ID = "rp10-comb-plate"
SKIP = (3,)


def build(d):
    L, W, T = d["plate_l"], d["plate_w"], d["plate_t"]
    plate = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    ear = box(L / 2, -d["ear_w"] / 2, 0, L / 2 + d["ear_l"], d["ear_w"] / 2, T)
    ear = ear.cut(cyl(L / 2 + d["ear_l"] / 2, 0, -1, d["ear_hole_d"] / 2, T + 2))
    mirrored = ear.mirror(V(0, 0, 0), V(1, 0, 0))
    body = fuse_all(plate, [ear, mirrored])
    slots = []
    for k in range(int(d["slot_n"])):
        if k in SKIP:
            continue
        x = d["slot_x0"] + k * d["slot_pitch"]
        slots.append(box(x - d["slot_l"] / 2, -d["slot_w"] / 2, -1, x + d["slot_l"] / 2, d["slot_w"] / 2, T + 1))
    return cut_all(body, slots).removeSplitter()


if __name__ == "__main__":
    main(PART_ID, build)
