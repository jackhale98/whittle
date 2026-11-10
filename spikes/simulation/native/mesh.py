#!/usr/bin/env python3
"""Spike S0: mesh a Wren part with native Gmsh (pip wheel) into second-order tets.

Reads out/<part>/part.brep + faces.json (from export/export.test.ts), imports the B-rep through
Gmsh's OCC kernel, maps every Gmsh surface tag to a Wren persistent face name by geometry (area +
centroid; never by assumed order), creates one physical surface group per face named after its
persistent name plus a physical volume "solid", meshes 3D at order 2 and writes:

  out/<part>/<run>/mesh.json   nodes, tet10 (Gmsh node order), tri6 per physical group
  out/<part>/<run>/stats.json  counts, timings, peak RSS, tag-order check

Usage: python mesh.py <part-dir> <run-name> --size H [--algo3d 1|10] [--threads N] [--no-json]

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import json
import os
import resource
import sys
import time

import gmsh


def match_faces(faces):
    """Wren face index -> Gmsh surface tag, by (area, centroid). Raises if not one-to-one."""
    tags = [t for (_, t) in gmsh.model.getEntities(2)]
    if len(tags) != len(faces):
        raise SystemExit(f"face count differs: gmsh {len(tags)} vs wren {len(faces)}")
    geo = {}
    for t in tags:
        geo[t] = (gmsh.model.occ.getMass(2, t), gmsh.model.occ.getCenterOfMass(2, t))
    mapping = {}
    for f in faces:
        best = None
        for t, (a, c) in geo.items():
            d = abs(a - f["area"]) / max(f["area"], 1e-9) + sum(
                (c[i] - f["centroid"][i]) ** 2 for i in range(3)
            ) ** 0.5
            if best is None or d < best[0]:
                best = (d, t)
        if best[0] > 1e-5:
            raise SystemExit(f"no geometric match for face {f['index']} {f['name']} (d={best[0]})")
        if best[1] in mapping.values():
            raise SystemExit(f"ambiguous match for face {f['index']}")
        mapping[f["index"]] = best[1]
    return mapping


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("part_dir")
    ap.add_argument("run")
    ap.add_argument("--size", type=float, required=True)
    ap.add_argument("--algo3d", type=int, default=1, help="1 Delaunay, 4 Frontal, 10 HXT")
    ap.add_argument("--algo2d", type=int, default=6, help="6 Frontal-Delaunay")
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--curv", type=int, default=12, help="Mesh.MeshSizeFromCurvature (0 = off)")
    ap.add_argument("--no-json", action="store_true", help="skip mesh.json (big runs)")
    args = ap.parse_args()

    faces = json.load(open(os.path.join(args.part_dir, "faces.json")))["faces"]
    run_dir = os.path.join(args.part_dir, args.run)
    os.makedirs(run_dir, exist_ok=True)

    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.option.setNumber("General.NumThreads", args.threads)
    gmsh.model.add("part")
    t0 = time.perf_counter()
    gmsh.model.occ.importShapes(os.path.join(args.part_dir, "part.brep"), highestDimOnly=False)
    gmsh.model.occ.synchronize()
    t_import = time.perf_counter() - t0

    mapping = match_faces(faces)
    tag_is_topexp = all(mapping[i] == i + 1 for i in mapping)
    for f in faces:
        gmsh.model.addPhysicalGroup(2, [mapping[f["index"]]], name=f["name"])
    vols = [t for (_, t) in gmsh.model.getEntities(3)]
    gmsh.model.addPhysicalGroup(3, vols, name="solid")

    o = gmsh.option.setNumber
    o("Mesh.MeshSizeMax", args.size)
    o("Mesh.MeshSizeMin", args.size / 10)
    o("Mesh.MeshSizeFromCurvature", args.curv)
    o("Mesh.MeshSizeExtendFromBoundary", 1)
    o("Mesh.Algorithm", args.algo2d)
    o("Mesh.Algorithm3D", args.algo3d)
    o("Mesh.ElementOrder", 2)
    o("Mesh.SecondOrderLinear", 0)  # mid-side nodes on the true geometry
    o("Mesh.Optimize", 1)
    o("Mesh.MaxNumThreads3D", args.threads)

    t1 = time.perf_counter()
    gmsh.model.mesh.generate(3)
    t_mesh = time.perf_counter() - t1

    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    index = {int(t): i for i, t in enumerate(node_tags)}
    _, tet_nodes = gmsh.model.mesh.getElementsByType(11)  # tet10
    tets = [index[int(t)] for t in tet_nodes]
    groups = []
    for f in faces:
        tag = mapping[f["index"]]
        tris = []
        types, _, enodes = gmsh.model.mesh.getElements(2, tag)
        for ty, en in zip(types, enodes):
            if ty == 9:  # tri6
                tris.extend(index[int(t)] for t in en)
        groups.append({"name": f["name"], "index": f["index"], "tag": tag, "tri6": tris})

    # Quality: min / mean SICN over tets.
    _, tet_tags, _ = gmsh.model.mesh.getElements(3)
    q = gmsh.model.mesh.getElementQualities(list(tet_tags[0]), "minSICN") if tet_tags else []
    peak_rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0

    stats = {
        "gmsh": gmsh.__version__,
        "occ": gmsh.option.getString("General.BuildInfo").split("OCC version: ")[1].split(";")[0],
        "size": args.size,
        "algo3d": args.algo3d,
        "threads": args.threads,
        "nodes": len(node_tags),
        "tets": len(tets) // 10,
        "surfaceTris": sum(len(g["tri6"]) for g in groups) // 6,
        "importS": round(t_import, 4),
        "meshS": round(t_mesh, 3),
        "peakRssMB": round(peak_rss_mb, 1),
        "minSICN": round(min(q), 4) if len(q) else None,
        "meanSICN": round(sum(q) / len(q), 4) if len(q) else None,
        "tagOrderIsTopExp": tag_is_topexp,
    }
    if not args.no_json:
        mesh = {"nodes": [round(c, 9) for c in coords], "tet10": tets, "groups": groups}
        with open(os.path.join(run_dir, "mesh.json"), "w") as fh:
            json.dump(mesh, fh, separators=(",", ":"))
    with open(os.path.join(run_dir, "stats.json"), "w") as fh:
        json.dump(stats, fh, indent=1)
    print(json.dumps(stats))
    gmsh.finalize()


if __name__ == "__main__":
    sys.exit(main())
