# RP02 Stepped shaft

CSWA-like. A three-diameter steel shaft turned from one profile, with a shoulder fillet and an end chamfer.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp02-stepped-shaft.svg](rp02-stepped-shaft.svg). Machine-readable spec: [rp02-stepped-shaft.spec.json](rp02-stepped-shaft.spec.json).

## Material

Structural steel (S235/A36) (`whittle:structural-steel`), density 7.85 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `d1` | 40 mm | Diameter of the large (flange) section |
| `l1` | 15 mm | Length of the large section |
| `d2` | 30 mm | Diameter of the middle section |
| `l2` | 40 mm | Length of the middle section |
| `d3` | 20 mm | Diameter of the end section |
| `l3` | 30 mm | Length of the end section |
| `fillet_r` | 3 mm | Fillet radius in the corner between d1 shoulder and d2 |
| `chamfer_c` | 2 mm | Equal-distance chamfer on the outer edge of the end face |

## Build intent

1. **sketch** (`prof_sk`): Sketch on Front (the XZ plane): the half profile of the shaft, from the axis out and back, closed along the axis.
2. **revolve** (`shaft`): Revolve the profile 360 degrees about the Z axis.
3. **fillet** (`fil`): Fillet the circular corner where the d1 shoulder meets the d2 cylinder, radius fillet_r.
4. **chamfer** (`cham`): Chamfer the outer edge of the end face by chamfer_c.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 56621.545 mm^3 |
| Mass | 444.4791 g |
| Surface area | 9856.928 mm^2 |
| Bounding box | (-20, -20, 0) to (20, 20, 85) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Large section | `pi (d1/2)^2 l1` | 18849.556 |
| Middle section | `pi (d2/2)^2 l2` | 28274.334 |
| End section | `pi (d3/2)^2 l3` | 9424.778 |
| Fillet (adds material) | `(1 - pi/4) r^2 x 2 pi (d2/2 + 0.2234 r)` | 190.164 |
| Chamfer (removes material) | `-(c^2/2) x 2 pi (d3/2 - c/3)` | -117.286 |
| **Total** | | **56621.545** |

Mass = volume x density = 56621.545 mm^3 x 7.85 g/cm^3 / 1000 = **444.4791 g**.

Method and accuracy: Exact. The blank is three cylinders. The fillet and the chamfer are corner pieces of a revolved profile, so Pappus gives their volumes: area of the cross-section times 2 pi times the radius of its centroid. The fillet gap area is (1 - pi/4) r^2 with its centroid 0.2234 r from both walls; the chamfer triangle has area c^2/2 and centroid c/3 from both legs. The surface area uses Pappus on each profile segment. Accuracy: floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 56621.545 | 444.4791 |
| Stage 2: d2 -> 32 mm | 60529.256 | 475.1547 |
| Stage 3: l2 -> 55 mm and fillet_r -> 4 mm | 67377.145 | 528.9106 |
| Stage 4: d3 -> 24 mm and chamfer_c -> 3 mm | 60574.716 | 475.5115 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp02.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 56621.545 | 56621.545 | -4.5e-13 |
| Stage 2: d2 -> 32 mm | 60529.256 | 60529.256 | -2.3e-13 |
| Stage 3: l2 -> 55 mm and fillet_r -> 4 mm | 67377.145 | 67377.145 | -1.7e-13 |
| Stage 4: d3 -> 24 mm and chamfer_c -> 3 mm | 60574.716 | 60574.716 | 6.9e-13 |

