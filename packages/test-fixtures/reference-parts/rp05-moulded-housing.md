# RP05 Moulded housing

CSWP-like. An ABS housing: a box whose four walls lean inward by a draft angle, then hollowed to a uniform wall with the top face removed.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp05-moulded-housing.svg](rp05-moulded-housing.svg). Machine-readable spec: [rp05-moulded-housing.spec.json](rp05-moulded-housing.spec.json).

## Material

ABS (`whittle:abs`), density 1.04 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `base_l` | 90 mm | Length at the bottom (X) |
| `base_w` | 60 mm | Width at the bottom (Y) |
| `height` | 40 mm | Height (Z) |
| `draft_a` | 3 deg | Draft angle of the four walls |
| `wall` | 3 mm | Wall thickness, measured normal to the walls and floor |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (XY): a rectangle base_l x base_w centred on the origin.
2. **extrude** (`base`): Extrude by height as a new body.
3. **draft** (`dr`): Draft the four side faces by draft_a, neutral plane = the bottom face, so the walls lean inward going up.
4. **shell** (`sh`): Shell inward by wall, removing the top face.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 47137.447 mm^3 |
| Mass | 49.0229 g |
| Bounding box | (-45, -30, 0) to (45, 30, 40) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Drafted box | `integral 0..H of (l - 2 z tan a)(w - 2 z tan a) dz` | 203656.507 |
| Cavity | `-integral wall..H of (l - 2 s - 2 z tan a)(w - 2 s - 2 z tan a) dz, s = wall/cos a` | -156519.061 |
| **Total** | | **47137.447** |

Mass = volume x density = 47137.447 mm^3 x 1.04 g/cm^3 / 1000 = **49.0229 g**.

Method and accuracy: Exact by integration. The cross-section at height z is a rectangle (l - 2 z tan a) x (w - 2 z tan a); its area is quadratic in z, so the antiderivative is exact. The cavity is the same family inset horizontally by wall/cos(a) on every side (the wall is thick normal to the drafted face) and starting at z = wall (the floor is horizontal). Volume = outer integral minus cavity integral. Accuracy: floating point (1e-12 relative). Assumed draft direction: neutral plane = the bottom face, walls lean inward going up (the top is smaller).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 47137.447 | 49.0229 |
| Stage 2: wall -> 4 mm | 61093.367 | 63.5371 |
| Stage 3: draft_a -> 5 deg | 46490.457 | 48.3501 |
| Stage 4: height -> 50 mm and base_l -> 100 mm | 59841.182 | 62.2348 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp05.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 47137.447 | 47137.447 | -9.8e-14 |
| Stage 2: wall -> 4 mm | 61093.367 | 61093.367 | -5.8e-13 |
| Stage 3: draft_a -> 5 deg | 46490.457 | 46490.457 | -3.4e-13 |
| Stage 4: height -> 50 mm and base_l -> 100 mm | 59841.182 | 59841.182 | 5.5e-13 |

