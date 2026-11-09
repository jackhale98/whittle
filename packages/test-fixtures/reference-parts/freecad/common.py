"""
Shared helpers for the independent FreeCAD checks of the Whittle reference parts (PLAN 12A).

Each `rpNN.py` defines `PART_ID` and `build(d)`, which receives the driving dimensions (a dict of
name -> number, in mm and degrees) and returns a FreeCAD `Part.Shape`. It builds the geometry with
FreeCAD's own modelling calls (primitives, booleans, fillet/chamfer, revolve, loft, pipe shell),
not with the formulas used for the analytic values. `run_part` evaluates the baseline and every
CSWP-style stage from `<part>.spec.json` and prints volume, area and bounding box as JSON.

Usage (FreeCAD 0.21 or newer, headless):

    freecadcmd -c "exec(open('rp01.py').read())"        # inside a FreeCAD install
    python rp01.py                                       # with FreeCAD importable (conda-forge)
    FREECAD_LIB=/path/to/freecad/lib python rp01.py      # FreeCAD.so lives elsewhere

SPDX-License-Identifier: GPL-3.0-or-later
"""

import json
import math
import os
import sys

try:
    import FreeCAD  # noqa: F401
except ImportError:  # pragma: no cover - environment dependent
    lib = os.environ.get("FREECAD_LIB")
    if lib:
        sys.path.append(lib)
    else:
        prefix = os.path.dirname(os.path.dirname(sys.executable))
        sys.path.append(os.path.join(prefix, "lib"))
    import FreeCAD  # noqa: F401

import Part  # noqa: E402

V = FreeCAD.Vector
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PI = math.pi


def box(x0, y0, z0, x1, y1, z1):
    return Part.makeBox(x1 - x0, y1 - y0, z1 - z0, V(x0, y0, z0))


def cyl(cx, cy, z0, r, h, axis=(0, 0, 1)):
    return Part.makeCylinder(r, h, V(cx, cy, z0), V(*axis))


def cut_all(shape, tools):
    for t in tools:
        shape = shape.cut(t)
    return shape


def fuse_all(shape, tools):
    for t in tools:
        shape = shape.fuse(t)
    return shape


def clean(shape):
    s = shape.removeSplitter()
    return s if s.isValid() else shape


def edges_where(shape, pred):
    return [e for e in shape.Edges if pred(e)]


def all_vertices_z(e, z, tol=1e-6):
    return all(abs(v.Point.z - z) < tol for v in e.Vertexes)


def info(shape):
    bb = shape.BoundBox
    return {
        "volume": shape.Volume,
        "area": shape.Area,
        "bbox": {"min": [bb.XMin, bb.YMin, bb.ZMin], "max": [bb.XMax, bb.YMax, bb.ZMax]},
        "valid": shape.isValid(),
        "solids": len(shape.Solids),
    }


def load_spec(part_id):
    with open(os.path.join(ROOT, part_id + ".spec.json"), encoding="utf8") as f:
        return json.load(f)


def run_part(part_id, build):
    spec = load_spec(part_id)
    base = {k: v["value"] for k, v in spec["dimensions"].items()}
    cases = [("Stage 1: as drawn", {}, spec["expected"])]
    for s in spec["stages"]:
        cases.append((s["name"], s["set"], s["expected"]))
    out = {"part": part_id, "stages": []}
    for name, change, expected in cases:
        d = dict(base)
        d.update(change)
        got = info(build(d))
        got["name"] = name
        got["analytic_volume"] = expected["volume_mm3"]
        got["relative_difference"] = (got["volume"] - expected["volume_mm3"]) / expected["volume_mm3"]
        out["stages"].append(got)
    return out


def main(part_id, build):
    print(json.dumps(run_part(part_id, build), indent=1))
