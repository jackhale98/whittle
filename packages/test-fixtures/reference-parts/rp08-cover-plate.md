# RP08 Cover plate

CSWP-like. A stainless plate with an M6 counterbored hole, an M6 countersunk hole placed on a reference point, and a row of blind M8 tapped holes patterned along X with one instance skipped.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp08-cover-plate.svg](rp08-cover-plate.svg). Machine-readable spec: [rp08-cover-plate.spec.json](rp08-cover-plate.spec.json).

## Material

Stainless steel 304 (`whittle:stainless-steel-304`), density 8.00 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `plate_l` | 100 mm | Plate length (X) |
| `plate_w` | 70 mm | Plate width (Y) |
| `plate_t` | 14 mm | Plate thickness (Z) |
| `cb_x` | -30 mm | Counterbored hole X |
| `cb_y` | 18 mm | Counterbored hole Y |
| `cb_d` | 11 mm | Counterbore diameter |
| `cb_h` | 6.5 mm | Counterbore depth |
| `cs_x` | 30 mm | Countersunk hole X (the reference point) |
| `cs_y` | 18 mm | Countersunk hole Y (the reference point) |
| `cs_d` | 12.4 mm | Countersink diameter at the face (90 degree cone) |
| `tap_x0` | -36 mm | X of the first tapped hole |
| `tap_dx` | 24 mm | Pattern spacing along X |
| `tap_n` | 4 | Pattern count (including the original and the skipped one) |
| `tap_y` | -18 mm | Y of the tapped row |
| `tap_depth` | 12 mm | Tapped hole depth (drill depth) |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (XY): a rectangle plate_l x plate_w centred on the origin.
2. **extrude** (`base`): Extrude by plate_t as a new body.
3. **point** (`cs_pt`): Reference point at (cs_x, cs_y) on the top face (coordinates).
4. **sketch** (`pts_sk`): Sketch on the top face: a point for the counterbored hole and a point for the first tapped hole.
5. **hole** (`h_cb`): Hole wizard: ISO counterbore for M6 (normal fit) at the first point, through all; counterbore cb_d x cb_h.
6. **hole** (`h_cs`): Hole wizard: ISO countersink for M6 (normal fit) on the reference point, through all; countersink cs_d, 90 degrees.
7. **hole** (`h_tap`): Hole wizard: tapped M8 (tap drill from the table) at the third point, blind to tap_depth, cosmetic thread over the full depth.
8. **linearPattern** (`pat`): Linear pattern of the tapped hole along X: tap_n instances, spacing tap_dx, skip instance 1.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 95226.594 mm^3 |
| Mass | 761.8127 g |
| Bounding box | (-50, -35, 0) to (50, 35, 14) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Plate | `plate_l x plate_w x plate_t` | 98000.000 |
| Counterbored hole: clearance bore | `-pi (6.6/2)^2 plate_t` | -478.967 |
| Counterbored hole: counterbore step | `-pi ((cb_d/2)^2 - (6.6/2)^2) cb_h` | -395.338 |
| Countersunk hole: clearance bore | `-pi (6.6/2)^2 plate_t` | -478.967 |
| Countersunk hole: cone beyond the bore | `-(frustum(cs_d/2, 6.6/2, depth) - pi (6.6/2)^2 depth), depth = cs_d/2 - 6.6/2` | -112.729 |
| Tapped holes (instances minus the skipped one) | `-(tap_n - 1) pi (6.8/2)^2 tap_depth` | -1307.405 |
| **Total** | | **95226.594** |

Mass = volume x density = 95226.594 mm^3 x 8 g/cm^3 / 1000 = **761.8127 g**.

Method and accuracy: Exact. Every hole is a cylinder, a step or a cone frustum. The counterbore and countersink diameters and depths are the named dimensions above (so the model does not depend on a table row that might be edited); only the clearance diameter (M6, normal fit, 6.6 mm) and the tap drill (M8, 6.8 mm) come from the ISO tables. The tapped hole is its drill diameter, flat-bottomed, to tap_depth; the cosmetic thread adds no geometry. The pattern has tap_n instances; instance 1 is skipped. Accuracy: floating point (1e-12 relative). If the kernel hole tables ever change these two values the golden fails by design.

Standards values used:

- ISO 273 medium clearance, M6: 6.6 mm
- ISO 261/262 coarse tap drill, M8 (pitch 1.25): 6.8 mm

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 95226.594 | 761.8127 |
| Stage 2: plate_t -> 18 mm | 122952.898 | 983.6232 |
| Stage 3: cb_h -> 8 mm and cs_d -> 13 mm | 95107.615 | 760.8609 |
| Stage 4: tap_n -> 5, tap_dx -> 16 mm, tap_x0 -> -32 mm | 94790.792 | 758.3263 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp08.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 95226.594 | 95226.594 | 3.2e-13 |
| Stage 2: plate_t -> 18 mm | 122952.898 | 122952.898 | -1.2e-12 |
| Stage 3: cb_h -> 8 mm and cs_d -> 13 mm | 95107.615 | 95107.615 | -4.9e-13 |
| Stage 4: tap_n -> 5, tap_dx -> 16 mm, tap_x0 -> -32 mm | 94790.792 | 94790.792 | 2.6e-13 |

