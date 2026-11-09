# RP09 Flanged hub

CSWP-like. A cast-iron flanged hub revolved from one profile, with a ring of bolt holes made by a circular pattern about a reference axis taken from the bore, two instances left out.

_Original Wren reference part. Not derived from any published exam or textbook drawing._

Drawing: [rp09-flanged-hub.svg](rp09-flanged-hub.svg). Machine-readable spec: [rp09-flanged-hub.spec.json](rp09-flanged-hub.spec.json).

## Material

Cast iron (grey) (`whittle:cast-iron`), density 7.20 g/cm^3.

## Driving dimensions

| Name | Value | Meaning |
| --- | --- | --- |
| `flange_d` | 120 mm | Flange outside diameter |
| `flange_t` | 12 mm | Flange thickness |
| `hub_d` | 56 mm | Hub outside diameter |
| `hub_h` | 30 mm | Hub height above the flange |
| `bore_d` | 32 mm | Through bore diameter |
| `bolt_d` | 9 mm | Bolt hole diameter (ISO 273 M8 normal clearance) |
| `pcd` | 90 mm | Bolt circle diameter |
| `bolt_n` | 8 | Pattern count (including the original and the skipped ones) |

## Build intent

1. **sketch** (`prof_sk`): Sketch on Front (XZ): the half section of the hub, bore edge to flange rim to hub top, as a closed polygon.
2. **revolve** (`hub`): Revolve the profile 360 degrees about the Z axis.
3. **axis** (`ax`): Reference axis: through the axis of the bore (pick the bore face).
4. **sketch** (`bolt_sk`): Sketch on the flange top face: one point on the bolt circle at (pcd/2, 0).
5. **hole** (`bolt`): Hole wizard: simple ISO M8 clearance hole (normal fit), through all.
6. **circularPattern** (`ring`): Circular pattern of the hole about the reference axis: bolt_n instances over 360 degrees, equal spacing, skip instances 2 and 5.

## Expected result

| Quantity | Value |
| --- | --- |
| Volume | 171248.216 mm^3 |
| Mass | 1232.9872 g |
| Surface area | 36307.386 mm^2 |
| Bounding box | (-60, -60, 0) to (60, 60, 42) mm |

## Derivation of the volume

| Term | Formula | Volume (mm^3) |
| --- | --- | --- |
| Flange disc | `pi (flange_d/2)^2 flange_t` | 135716.803 |
| Hub cylinder | `pi (hub_d/2)^2 hub_h` | 73890.259 |
| Bore | `-pi (bore_d/2)^2 (flange_t + hub_h)` | -33778.404 |
| Bolt holes (instances minus the skipped ones) | `-(bolt_n - 2) pi (bolt_d/2)^2 flange_t` | -4580.442 |
| **Total** | | **171248.216** |

Mass = volume x density = 171248.216 mm^3 x 7.2 g/cm^3 / 1000 = **1232.9872 g**.

Method and accuracy: Exact. The solid of revolution is two stacked annular cylinders; each bolt hole is a cylinder through the flange only (the bolt circle lies outside the hub). The pattern has bolt_n instances equally spaced over 360 degrees; instances 2 and 5 are skipped, so bolt_n - 2 holes are cut. The surface area adds the cylinders and annuli and replaces, for each hole, two annular patches by the hole wall. Accuracy: floating point (1e-12 relative).

## Modification stages (CSWP style)

| Stage | Expected volume (mm^3) | Expected mass (g) |
| --- | --- | --- |
| Stage 1: as drawn | 171248.216 | 1232.9872 |
| Stage 2: bolt_n -> 10 (instances 2 and 5 still skipped) | 169721.402 | 1221.9941 |
| Stage 3: pcd -> 100 mm | 171248.216 | 1232.9872 |
| Stage 4: hub_h -> 45 mm and bore_d -> 36 mm | 183952.816 | 1324.4603 |

## Independent check

Built in FreeCAD 26.3.0 with `freecad/rp09.py` (a different construction than Wren's).

| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |
| --- | --- | --- | --- |
| Stage 1: as drawn | 171248.216 | 171248.216 | 1.0e-12 |
| Stage 2: bolt_n -> 10 (instances 2 and 5 still skipped) | 169721.402 | 169721.402 | -2.7e-12 |
| Stage 3: pcd -> 100 mm | 171248.216 | 171248.216 | 1.0e-12 |
| Stage 4: hub_h -> 45 mm and bore_d -> 36 mm | 183952.816 | 183952.816 | 1.6e-12 |

