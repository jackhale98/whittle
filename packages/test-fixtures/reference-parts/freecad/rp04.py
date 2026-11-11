"""RP04 Clamp block: FreeCAD fillet and chamfer operators on the plate (whole edge loops picked),
then a cylinder fused on top, its top edge chamfered. The boss height already includes the push."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import all_vertices_z, box, cyl, edges_where, main  # noqa: E402

PART_ID = "rp04-clamp-block"


def build(d):
    L, W, T = d["plate_l"], d["plate_w"], d["plate_t"]
    plate = box(-L / 2, -W / 2, 0, L / 2, W / 2, T)
    vertical = edges_where(plate, lambda e: abs(e.Vertexes[0].Point.z - e.Vertexes[-1].Point.z) > 1e-9)
    plate = plate.makeFillet(d["corner_r"], vertical)
    plate = plate.makeFillet(d["top_r"], edges_where(plate, lambda e: all_vertices_z(e, T)))
    plate = plate.makeChamfer(d["bot_c"], edges_where(plate, lambda e: all_vertices_z(e, 0)))
    a, H = d["boss_d"] / 2, T + d["boss_h"]  # boss_h is the boss as built (the push included)
    body = plate.fuse(cyl(0, 0, T, a, H - T)).removeSplitter()
    circle = edges_where(body, lambda e: all_vertices_z(e, H) and abs(e.BoundBox.XLength - 2 * a) < 1e-6)
    return body.makeChamfer(d["boss_c"], circle)


if __name__ == "__main__":
    main(PART_ID, build)
