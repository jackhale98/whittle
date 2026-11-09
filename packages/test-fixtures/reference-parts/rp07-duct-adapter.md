# RP07 Duct adapter

CSWP-like. A PETG adapter: a rectangular flange block, a ruled loft from an inset copy of its top outline to a smaller rectangle higher up, and a round bore straight through.

_Original Whittle reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp07-duct-adapter.svg](rp07-duct-adapter.svg). Machine-readable spec: [rp07-duct-adapter.spec.json](rp07-duct-adapter.spec.json).

## Material

PETG (`whittle:petg`), density 1.27 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `base_l` | 80 mm | Flange block length (X) |
| `base_w` | 60 mm | Flange block width (Y) |
| `base_t` | 10 mm | Flange block thickness (Z) |
| `inset` | 15 mm | Offset of the loft start inside the top outline |
| `loft_h` | 40 mm | Loft height above the block |
| `top_l` | 30 mm | Length of the loft end rectangle |
| `top_w` | 14 mm | Width of the loft end rectangle |
| `bore_d` | 8 mm | Through bore diameter |

## Build intent

1. **sketch** (`base_sk`): Sketch on Top (XY): a rectangle base_l x base_w centred on the origin.
2. **extrude** (`base`): Extrude by base_t as a new body.
3. **sketch** (`sec_sk`): Sketch on the top face. Convert Entities on the four top edges, then Offset Entities on that loop inwards by inset (the offset dimension is -inset: positive is outward for a counter-clockwise loop).
4. **plane** (`top_pl`): Reference plane: offset base_t + loft_h above the Top plane.
5. **sketch** (`top_sk`): Sketch on the new plane: a rectangle top_l x top_w centred on the origin.
6. **loft** (`lo`): Loft (ruled, open) from the offset rectangle to the top rectangle, adding to the block.
7. **sketch** (`bore_sk`): Sketch on the top plane again: a circle of bore_d at the origin.
8. **extrude** (`bore`): Cut-extrude the circle downwards through all.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 81753.393 mm^3 |
| Mass | 103.8268 g |
| Bounding box | (-40, -30, 0) to (40, 30, 50) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Flange block | `base_l x base_w x base_t` | 48000.000 |
| Ruled loft (prismatoid) | `(h/6)(A1 + 4 Am + A2), A1 = (l - 2 inset)(w - 2 inset), A2 = top_l top_w, Am = mid-section` | 36266.667 |
| Bore | `-pi (bore_d/2)^2 (base_t + loft_h)` | -2513.274 |
| **Total** | | **81753.393** |

Mass = volume x density = 81753.393 mm^3 x 1.27 g/cm^3 / 1000 = **103.8268 g**.

Method and accuracy: Exact. A ruled loft between two parallel rectangles with parallel edges is a prismatoid; the section sides vary linearly, so the area is quadratic in height and Simpson (h/6)(A1 + 4 Am + A2) is exact, with Am the area of the mid-section ((a1+a2)/2 x (b1+b2)/2). The bore lies wholly inside the solid (bore_d is at most top_w), so it removes pi r^2 x total height. Accuracy: floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 81753.393 | 103.8268 |
| Stage 2: inset -> 20 mm | 69486.726 | 88.2481 |
| Stage 3: loft_h -> 55 mm | 94599.410 | 120.1413 |
| Stage 4: top_l -> 24 mm and top_w -> 12 mm | 78126.726 | 99.2209 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp07.py` (a different construction than Whittle's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 81753.393 | 81753.393 | -6.3e-14 |
| Stage 2: inset -> 20 mm | 69486.726 | 69486.726 | 4.1e-13 |
| Stage 3: loft_h -> 55 mm | 94599.410 | 94599.410 | 3.5e-13 |
| Stage 4: top_l -> 24 mm and top_w -> 12 mm | 78126.726 | 78126.726 | 3.6e-13 |

