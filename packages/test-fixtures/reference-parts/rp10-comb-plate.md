# RP10 Comb plate

CSWP-like. An acetal plate with a row of through slots (one instance of the linear pattern skipped) and a drilled mounting ear on each end; the second ear is a mirror of the first.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp10-comb-plate.svg](rp10-comb-plate.svg). Machine-readable spec: [rp10-comb-plate.spec.json](rp10-comb-plate.spec.json).

## Material

Acetal (POM) (`whittle:acetal-pom`), density 1.41 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `plate_l` | 120 mm | Plate length (X) |
| `plate_w` | 40 mm | Plate width (Y) |
| `plate_t` | 8 mm | Thickness of plate and ears (Z) |
| `slot_l` | 6 mm | Slot size along X |
| `slot_w` | 24 mm | Slot size along Y |
| `slot_x0` | -45 mm | X of the first slot centre |
| `slot_pitch` | 18 mm | Slot pattern spacing |
| `slot_n` | 5 | Number of slots: the pattern has slot_n + 1 positions, position 3 skipped (corrected from the pattern setting 6, see the README) |
| `ear_l` | 20 mm | Ear length beyond the plate end |
| `ear_w` | 24 mm | Ear width (Y) |
| `ear_hole_d` | 8 mm | Ear hole diameter |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (XY): a rectangle plate_l x plate_w centred on the origin.
2. **extrude** (`base`): Extrude by plate_t as a new body.
3. **sketch** (`slot_sk`): Sketch on Top: one slot, slot_l x slot_w, centred on y = 0 with its centre at slot_x0.
4. **extrude** (`slot`): Cut-extrude the slot through all (both ways from the sketch plane).
5. **linearPattern** (`slots`): Linear pattern of the slot along X: slot_n + 1 instances, spacing slot_pitch, skip instance 3 (slot_n slots).
6. **sketch** (`ear_sk`): Sketch on Top: the +X ear, a rectangle ear_l x ear_w against the plate end.
7. **extrude** (`ear`): Extrude the ear by plate_t, adding to the plate.
8. **sketch** (`eh_sk`): Sketch on Top: a circle of ear_hole_d at the centre of the ear.
9. **extrude** (`eh`): Cut-extrude the circle through all (both ways).
10. **mirror** (`mir`): Mirror the ear and its hole about the Right plane (YZ).

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 39515.752 mm^3 |
| Mass | 55.7172 g |
| Surface area | 15881.062 mm^2 |
| Bounding box | (-80, -20, 0) to (80, 20, 8) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Plate | `plate_l x plate_w x plate_t` | 38400.000 |
| Slots (slot_n + 1 positions minus the skipped one) | `-slot_n slot_l slot_w plate_t` | -5760.000 |
| Two ears | `2 ear_l ear_w plate_t` | 7680.000 |
| Two ear holes | `-2 pi (ear_hole_d/2)^2 plate_t` | -804.248 |
| **Total** | | **39515.752** |

Mass = volume x density = 39515.752 mm^3 x 1.41 g/cm^3 / 1000 = **55.7172 g**.

Method and accuracy: Exact. Plate, ears and slots are boxes and the ear holes are cylinders. The slot pattern has slot_n + 1 positions; position 3 is skipped, so slot_n slots are cut. The mirror copies the ear and its hole, so there are two of each. Accuracy: floating point (1e-12 relative). The surface area is the top and bottom faces plus the side walls (outer outline with the ears attached, slot walls, ear hole walls).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 39515.752 | 55.7172 |
| Stage 2: slot_n -> 6 (seven positions, one skipped) and slot_pitch -> 15 mm | 38363.752 | 54.0929 |
| Stage 3: ear_l -> 26 mm and ear_hole_d -> 10 mm | 41367.363 | 58.3280 |
| Stage 4: plate_t -> 10 mm and slot_w -> 20 mm | 50594.690 | 71.3385 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp10.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 39515.752 | 39515.752 | -4.8e-13 |
| Stage 2: slot_n -> 6 (seven positions, one skipped) and slot_pitch -> 15 mm | 38363.752 | 38363.752 | -4.9e-13 |
| Stage 3: ear_l -> 26 mm and ear_hole_d -> 10 mm | 41367.363 | 41367.363 | -8.7e-13 |
| Stage 4: plate_t -> 10 mm and slot_w -> 20 mm | 50594.690 | 50594.690 | -9.6e-13 |

