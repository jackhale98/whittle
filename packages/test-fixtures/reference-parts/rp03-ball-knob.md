# RP03 Ball knob

CSWA-like. A brass ball with a stem below it and a flat on top. The ball is a revolved semicircle; the flat is cut from a reference plane.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp03-ball-knob.svg](rp03-ball-knob.svg). Machine-readable spec: [rp03-ball-knob.spec.json](rp03-ball-knob.spec.json).

## Material

Brass C360 (`whittle:brass-c360`), density 8.50 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `ball_d` | 50 mm | Ball diameter |
| `stem_d` | 16 mm | Stem diameter |
| `stem_l` | 40 mm | Stem length below the ball centre |
| `flat_h` | 18 mm | Height of the flat above the ball centre (reference plane offset) |
| `chamfer_c` | 1.5 mm | Chamfer on the stem end |

## Build intent

1. **sketch** (`ball_sk`): Sketch on Front (XZ): a semicircle centred on the origin, to the right of the Z axis, closed by a line along the axis.
2. **revolve** (`ball`): Revolve the half disc 360 degrees about the Z axis: a sphere.
3. **sketch** (`stem_sk`): Sketch on Top (XY): a circle of stem_d at the origin.
4. **extrude** (`stem`): Extrude the circle downwards by stem_l, adding to the ball.
5. **plane** (`flat_pl`): Reference plane: offset flat_h above the Top plane.
6. **sketch** (`flat_sk`): Sketch on the new plane: a square, ball_d + 10 on a side, centred on the origin.
7. **extrude** (`flat`): Cut-extrude the square upwards through all: this removes the top of the ball.
8. **chamfer** (`cham`): Chamfer the circular edge at the end of the stem by chamfer_c.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 65054.464 mm^3 |
| Mass | 552.9629 g |
| Surface area | 8467.579 mm^2 |
| Bounding box | (-25, -25, -40) to (25, 25, 18) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Sphere | `4/3 pi R^3, R = ball_d/2` | 65449.847 |
| Flat: spherical cap removed | `-pi hc^2 (3R - hc)/3, hc = R - flat_h` | -3489.262 |
| Stem outside the ball | `pi a^2 stem_l - 2 pi/3 (R^3 - (R^2 - a^2)^(3/2)), a = stem_d/2` | 3146.894 |
| Chamfer | `-(c^2/2) x 2 pi (a - c/3)` | -53.014 |
| **Total** | | **65054.464** |

Mass = volume x density = 65054.464 mm^3 x 8.5 g/cm^3 / 1000 = **552.9629 g**.

Method and accuracy: Exact closed forms: sphere 4/3 pi R^3; spherical cap pi h^2 (3R - h)/3; the part of the stem outside the ball is the cylinder minus its intersection with the ball, 2 pi/3 (R^3 - (R^2 - a^2)^(3/2)); the chamfer by Pappus. The surface area is a sum of a sphere zone, a flat disc, a cylinder, a cone and an end disc. Accuracy: floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 65054.464 | 552.9629 |
| Stage 2: ball_d -> 60 mm | 103401.357 | 878.9115 |
| Stage 3: stem_d -> 20 mm and stem_l -> 55 mm | 71641.295 | 608.9510 |
| Stage 4: flat_h -> 10 mm | 54406.559 | 462.4558 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp03.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 65054.464 | 65054.464 | -1.7e-13 |
| Stage 2: ball_d -> 60 mm | 103401.357 | 103401.357 | 1.1e-13 |
| Stage 3: stem_d -> 20 mm and stem_l -> 55 mm | 71641.295 | 71641.295 | 2.3e-13 |
| Stage 4: flat_h -> 10 mm | 54406.559 | 54406.559 | 4.0e-13 |

