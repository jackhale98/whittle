"""RP08 Cover plate: counterbore, countersink cone and drilled holes cut as solids.
ISO 273 medium clearance for M6 = 6.6 mm; ISO 261 tap drill for M8 = 6.8 mm."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import Part  # noqa: E402
from common import V, box, cut_all, cyl, main  # noqa: E402

PART_ID = "rp08-cover-plate"
CLEARANCE_M6 = 6.6
TAP_DRILL_M8 = 6.8


def build(d):
    L, W, T = d["plate_l"], d["plate_w"], d["plate_t"]
    plate = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    tools = []
    # Counterbored hole.
    tools.append(cyl(d["cb_x"], d["cb_y"], -1, CLEARANCE_M6 / 2, T + 2))
    tools.append(cyl(d["cb_x"], d["cb_y"], T - d["cb_h"], d["cb_d"] / 2, d["cb_h"] + 1))
    # Countersunk hole: a 90 degree cone from the face down to the clearance diameter.
    depth = d["cs_d"] / 2 - CLEARANCE_M6 / 2
    tools.append(cyl(d["cs_x"], d["cs_y"], -1, CLEARANCE_M6 / 2, T + 2))
    tools.append(Part.makeCone(CLEARANCE_M6 / 2, d["cs_d"] / 2, depth, V(d["cs_x"], d["cs_y"], T - depth), V(0, 0, 1)))
    # Tapped holes: n instances, instance 1 skipped.
    for k in range(int(d["tap_n"])):
        if k == 1:
            continue
        tools.append(cyl(d["tap_x0"] + k * d["tap_dx"], d["tap_y"], T - d["tap_depth"], TAP_DRILL_M8 / 2, d["tap_depth"] + 1))
    return cut_all(plate, tools)


if __name__ == "__main__":
    main(PART_ID, build)
