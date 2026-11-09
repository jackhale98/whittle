# RP01 Base plate

CSWA-like. A rectangular aluminium plate with four mounting holes, a central bore and a shallow pocket.

_Original Whittle reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp01-base-plate.svg](rp01-base-plate.svg). Machine-readable spec: [rp01-base-plate.spec.json](rp01-base-plate.spec.json).

## Material

Aluminium 6061-T6 (`whittle:aluminium-6061-t6`), density 2.70 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `length` | 120 mm | Plate length (X) |
| `width` | 80 mm | Plate width (Y) |
| `thickness` | 12 mm | Plate thickness (Z) |
| `hole_d` | 10 mm | Diameter of the four mounting holes |
| `hole_x` | 45 mm | Hole centres from the centre line, along X |
| `hole_y` | 25 mm | Hole centres from the centre line, along Y |
| `bore_d` | 30 mm | Central through bore diameter |
| `pocket_w` | 40 mm | Pocket size along X |
| `pocket_h` | 14 mm | Pocket size along Y |
| `pocket_y` | 20 mm | Pocket near edge, measured from the centre line |
| `pocket_d` | 5 mm | Pocket depth |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (the XY plane): a rectangle length x width centred on the origin.
2. **extrude** (`base`): Extrude the rectangle by thickness, as a new body.
3. **sketch** (`holes_sk`): Sketch on the top face: four circles of hole_d at (+-hole_x, +-hole_y) and a bore_d circle at the origin.
4. **extrude** (`holes`): Cut-extrude the five circles through all, downwards.
5. **sketch** (`pocket_sk`): Sketch on the top face: a pocket_w x pocket_h rectangle whose near edge is pocket_y from the centre line.
6. **extrude** (`pocket`): Cut-extrude the rectangle downwards by pocket_d.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 100147.789 mm^3 |
| Mass | 270.3990 g |
| Surface area | 25136.903 mm^2 |
| Bounding box | (-60, -40, 0) to (60, 40, 12) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Blank | `length x width x thickness` | 115200.000 |
| Four mounting holes | `-4 pi (hole_d/2)^2 thickness` | -3769.911 |
| Central bore | `-pi (bore_d/2)^2 thickness` | -8482.300 |
| Pocket | `-pocket_w pocket_h pocket_d` | -2800.000 |
| **Total** | | **100147.789** |

Mass = volume x density = 100147.789 mm^3 x 2.7 g/cm^3 / 1000 = **270.3990 g**.

Method and accuracy: Exact closed form: the plate is a box minus cylinders and one box pocket. The surface area is exact too. Accuracy is limited only by floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 100147.789 | 270.3990 |
| Stage 2: length -> 140 mm | 119347.789 | 322.2390 |
| Stage 3: hole_d -> 12 mm and thickness -> 16 mm | 132252.037 | 357.0805 |
| Stage 4: bore_d -> 36 mm and pocket_d -> 8 mm | 94735.577 | 255.7861 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp01.py` (a different construction than Whittle's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 100147.789 | 100147.789 | -1.7e-15 |
| Stage 2: length -> 140 mm | 119347.789 | 119347.789 | -1.2e-15 |
| Stage 3: hole_d -> 12 mm and thickness -> 16 mm | 132252.037 | 132252.037 | 1.6e-12 |
| Stage 4: bore_d -> 36 mm and pocket_d -> 8 mm | 94735.577 | 94735.577 | 3.7e-13 |

