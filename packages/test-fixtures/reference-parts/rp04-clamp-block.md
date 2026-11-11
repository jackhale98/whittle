# RP04 Clamp block

CSWA-like. A rounded base plate with a softened top edge and a chamfered underside, and a round boss added as a second body, combined, then pulled taller.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp04-clamp-block.svg](rp04-clamp-block.svg). Machine-readable spec: [rp04-clamp-block.spec.json](rp04-clamp-block.spec.json).

## Material

Aluminium 7075-T6 (`whittle:aluminium-7075-t6`), density 2.81 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `plate_l` | 100 mm | Plate length (X) |
| `plate_w` | 60 mm | Plate width (Y) |
| `plate_t` | 16 mm | Plate thickness (Z) |
| `corner_r` | 8 mm | Radius of the four vertical corners |
| `top_r` | 3 mm | Fillet on the whole top edge loop |
| `bot_c` | 2 mm | Chamfer on the whole bottom edge loop |
| `boss_d` | 30 mm | Boss diameter |
| `boss_h` | 26 mm | Boss height above the plate, as built (extruded boss_h - boss_up, then pulled up by boss_up; corrected from 20, see the README) |
| `boss_up` | 6 mm | Push/pull distance added to the boss top |
| `boss_c` | 2 mm | Chamfer on the boss top edge |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top: a rectangle plate_l x plate_w centred on the origin.
2. **extrude** (`base`): Extrude by plate_t as a new body.
3. **fillet** (`fc`): Fillet the four vertical corner edges, radius corner_r.
4. **fillet** (`ft`): Fillet ONE top edge with "propagate along tangent edges" on, radius top_r: the whole rounded top loop follows.
5. **chamfer** (`cb`): Chamfer the bottom loop by bot_c with "propagate" OFF: pick all eight edges (four straight, four corner arcs) one by one.
6. **sketch** (`boss_sk`): Sketch on the top face: a circle of boss_d at the origin.
7. **extrude** (`boss`): Extrude the circle upwards by boss_h - boss_up as a NEW body (a second body touching the plate).
8. **boolean** (`join`): Combine: add the boss body to the plate body.
9. **pushPull** (`pull`): Push/pull the boss top face outwards by boss_up.
10. **chamfer** (`cboss`): Chamfer the boss top edge by boss_c (propagate off: it is a single circular edge).

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 112131.642 mm^3 |
| Mass | 315.0899 g |
| Bounding box | (-50, -30, 0) to (50, 30, 42) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Plate | `plate_l x plate_w x plate_t` | 96000.000 |
| Four corner fillets | `-4 (1 - pi/4) corner_r^2 plate_t` | -879.009 |
| Top edge loop fillet | `-(1 - pi/4) r^2 [straight + 4 (pi/2)(Rc - 0.2234 r)]` | -583.394 |
| Bottom edge loop chamfer | `-(c^2/2) [straight + 4 (pi/2)(Rc - c/3)]` | -604.153 |
| Boss after push/pull | `pi (boss_d/2)^2 boss_h` | 18378.317 |
| Boss top chamfer | `-(cb^2/2) x 2 pi (a - cb/3)` | -180.118 |
| **Total** | | **112131.642** |

Mass = volume x density = 112131.642 mm^3 x 2.81 g/cm^3 / 1000 = **315.0899 g**.

Method and accuracy: Exact. Every blend runs along a loop of straight edges and quarter arcs, so Pappus gives its volume: the corner area of the cross-section times the length of the path of its centroid. Along a convex arc of radius Rc the centroid of a fillet gap lies 0.2234 r inside the wall, of a chamfer triangle c/3 inside. The top fillet is a single pick with propagation on; the bottom chamfer picks all eight edges with propagation off, and both are the same kind of loop. Accuracy: floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 112131.642 | 315.0899 |
| Stage 2: plate_l -> 120 mm | 131174.386 | 368.6000 |
| Stage 3: boss_d -> 36 mm, boss_up -> 10 mm with the boss as first extruded unchanged (boss_h -> 30) | 124251.907 | 349.1479 |
| Stage 4: corner_r -> 12 mm and top_r -> 4 mm | 110621.263 | 310.8457 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp04.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 112131.642 | 112131.642 | 2.2e-12 |
| Stage 2: plate_l -> 120 mm | 131174.386 | 131174.386 | 5.7e-13 |
| Stage 3: boss_d -> 36 mm, boss_up -> 10 mm with the boss as first extruded unchanged (boss_h -> 30) | 124251.907 | 124251.907 | -1.6e-12 |
| Stage 4: corner_r -> 12 mm and top_r -> 4 mm | 110621.263 | 110621.263 | 2.7e-12 |

