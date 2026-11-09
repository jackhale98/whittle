# RP06 Cable guide

CSWP-like. A nylon block with a round groove swept along a straight-arc-straight path across its top, and a bent rod swept up from the top face.

_Original Whittle reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp06-cable-guide.svg](rp06-cable-guide.svg). Machine-readable spec: [rp06-cable-guide.spec.json](rp06-cable-guide.spec.json).

## Material

Nylon PA12 (`whittle:nylon-pa12`), density 1.01 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `blk_l` | 100 mm | Block length (X) |
| `blk_w` | 50 mm | Block width (Y) |
| `blk_t` | 20 mm | Block thickness (Z) |
| `ch_d` | 10 mm | Groove diameter (its centre line lies on the top face) |
| `ch_in` | 10 mm | Groove entry: offset of its first leg from the centre line, towards -Y |
| `ch_turn_x` | 20 mm | X where the groove starts to bend |
| `ch_bend` | 10 mm | Groove bend radius (a quarter turn to +Y) |
| `rod_d` | 8 mm | Rod diameter |
| `rod_x` | 30 mm | Rod plane: distance from the YZ plane towards -X |
| `rod_y` | 15 mm | Rod foot position along Y |
| `rod_h` | 20 mm | Length of the straight rising leg |
| `rod_bend` | 10 mm | Rod bend radius (a quarter turn towards -Y) |
| `rod_tail` | 15 mm | Length of the straight horizontal tail |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (XY): a rectangle blk_l x blk_w centred on the origin.
2. **extrude** (`base`): Extrude by blk_t as a new body.
3. **plane** (`top_pl`): Reference plane: offset blk_t above the Top plane (the block top).
4. **sketch** (`ch_path`): Sketch the groove path on the new plane: a line in from the -X end, a quarter arc of ch_bend, and a line out to the +Y side.
5. **plane** (`ch_pl`): Reference plane: offset blk_l/2 from the Right plane (YZ) towards -X, the plane of the groove start.
6. **sketch** (`ch_prof`): Sketch on that plane: a circle of ch_d centred on the groove start, level with the block top.
7. **sweep** (`groove`): Sweep-cut the circle along the groove path (profile follows the path).
8. **plane** (`rod_pl`): Reference plane: offset rod_x from the Right plane (YZ) towards -X, the plane of the rod path.
9. **sketch** (`rod_path`): Sketch the rod path on that plane: a line up from the block top, a quarter arc of rod_bend towards -Y, and a horizontal tail.
10. **sketch** (`rod_prof`): Sketch on the block-top plane: a circle of rod_d at (-rod_x, rod_y).
11. **sweep** (`rod`): Sweep the circle along the rod path, adding to the block.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 98201.369 mm^3 |
| Mass | 99.1834 g |
| Bounding box | (-50, -25, 0) to (50, 25, 54) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Block | `blk_l x blk_w x blk_t` | 100000.000 |
| Groove (half circle swept) | `-(pi rc^2 / 2) s_groove, s_groove = turn_x + l/2 + (pi/2) bend + (w/2 - (bend - in))` | -4347.492 |
| Rod | `pi rr^2 s_rod, s_rod = rod_h + (pi/2) rod_bend + rod_tail` | 2548.860 |
| **Total** | | **98201.369** |

Mass = volume x density = 98201.369 mm^3 x 1.01 g/cm^3 / 1000 = **99.1834 g**.

Method and accuracy: Exact by Pappus. A circular profile swept along a path of length s has volume pi r^2 s. The groove profile is centred on the top face, so half of it is cut; the centroid of the removed half disc lies straight below the path, at the same bend radius, so the volume is (pi r^2 / 2) s_groove with no correction. The rod sits clear of the groove and above the block. Accuracy: floating point (1e-12 relative). The kernel result also depends on the sweep keeping the profile normal to the path (a planar path, so Frenet is exact).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 98201.369 | 99.1834 |
| Stage 2: ch_d -> 12 mm | 96288.472 | 97.2514 |
| Stage 3: rod_h -> 30 mm and rod_d -> 10 mm | 100420.501 | 101.4247 |
| Stage 4: blk_t -> 25 mm and ch_bend -> 12 mm | 123156.538 | 124.3881 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp06.py` (a different construction than Whittle's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 98201.369 | 98201.369 | -8.7e-14 |
| Stage 2: ch_d -> 12 mm | 96288.472 | 96288.472 | -4.1e-13 |
| Stage 3: rod_h -> 30 mm and rod_d -> 10 mm | 100420.501 | 100420.501 | 2.2e-12 |
| Stage 4: blk_t -> 25 mm and ch_bend -> 12 mm | 123156.538 | 123156.538 | 1.8e-12 |

