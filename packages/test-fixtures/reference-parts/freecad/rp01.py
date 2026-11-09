"""RP01 Base plate: a box, cylinders and a pocket box, cut with FreeCAD booleans."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import box, cut_all, cyl, main  # noqa: E402

PART_ID = "rp01-base-plate"


def build(d):
    L, W, T = d["length"], d["width"], d["thickness"]
    plate = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    tools = [cyl(sx * d["hole_x"], sy * d["hole_y"], -1, d["hole_d"] / 2, T + 2)
             for sx in (-1, 1) for sy in (-1, 1)]
    tools.append(cyl(0, 0, -1, d["bore_d"] / 2, T + 2))
    tools.append(box(-d["pocket_w"] / 2, d["pocket_y"], T - d["pocket_d"],
                     d["pocket_w"] / 2, d["pocket_y"] + d["pocket_h"], T + 1))
    return cut_all(plate, tools)


if __name__ == "__main__":
    main(PART_ID, build)
