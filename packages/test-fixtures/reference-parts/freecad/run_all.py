"""
Runs every `rpNN.py` build for the baseline and each CSWP-style stage, prints a table of the
relative difference to the analytic volume, and writes `../freecad-results.json` (the record kept
next to the analytic values; the Markdown specs and a test read it).

    python run_all.py            # table only
    python run_all.py --write    # also write freecad-results.json

SPDX-License-Identifier: GPL-3.0-or-later
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402

PARTS = ["rp%02d" % i for i in range(1, 11)]


def main():
    import json  # FreeCAD's start-up can clear names imported before it; import here
    results = {
        "tool": "FreeCAD %s.%s.%s" % tuple(common.FreeCAD.Version()[:3]),
        "parts": {},
    }
    worst = 0.0
    for name in PARTS:
        mod = __import__(name)
        run = common.run_part(mod.PART_ID, mod.build)
        stages = run["stages"]
        for s in stages:
            worst = max(worst, abs(s["relative_difference"]))
            print("%-24s %-52s %14.4f  %+.2e%s" % (
                mod.PART_ID, s["name"][:52], s["volume"], s["relative_difference"],
                "" if s["valid"] and s["solids"] == 1 else "  (INVALID OR MULTI-SOLID)"))
        keep = lambda s: {  # noqa: E731
            "volume": s["volume"], "area": s["area"], "bbox": s["bbox"]}
        results["parts"][mod.PART_ID] = {
            "baseline": keep(stages[0]),
            "stages": [keep(s) for s in stages[1:]],
        }
    print("worst relative volume difference: %.2e" % worst)
    if "--write" in sys.argv:
        with open(os.path.join(common.ROOT, "freecad-results.json"), "w", encoding="utf8") as f:
            json.dump(results, f, indent=1)
            f.write("\n")


if __name__ == "__main__":
    main()
