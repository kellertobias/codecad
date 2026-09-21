# Makerspace toolbox port

Entry: `examples/mksp-toolbox/index.ts`. Source of truth:
`../Projects/MKSP-Toolbox/project.py`, with the accompanying Python drawer,
drawer-rail, angle-bracket and interlock-finger library definitions. This is the
360 × 220 × 300 mm version, not the older `makerspace_toolbox.py` variant.

The port has 16 multiplex sheets (6 mm, 1250 × 2500 mm stock), two 45 mm-high
drawer bodies, 346 × 48 mm fronts, 1 mm front gaps, shelf underside at Z=105 mm,
120 mm upper front wall, 180 mm back wall, R30 sidewall corners and a 30 × 2 mm
handle tube. Internal finger joints now reserve at least 20% of the original overlap
length at each end (or the configured 30 mm margin, whichever is larger), with
0.15 mm transverse clearance. The entering sheet is notched at those ends so that
the reserved material on the receiving sheet does not collide with it. Ordinary
edge-to-edge joints keep their full overlap length.

Hardware contains four 200 mm, three-member slides. All measured hole/slot
patterns are included on the channels; receiving sheets use the selected Python
mounting features only, converted to round screw holes at slot centres. Slots in
the metal remain elongated. Four provisional 30 × 30 × 40 × 2 mm brackets connect the
drawer floors and fronts, with their 4.5 mm holes transferred to the sheets.
Threads, rolling elements and supplier-specific bearing details are not modeled.

One deliberate correction: the Python middle member starts 6.375 mm inside the
rail and extends another 9.5 mm, beyond the stated 12.75 mm outside-face envelope.
The port centres that member at 1.625 mm instead. Hardware remains a simplified
channel model; verify physical fit before fabrication. The drawers move 160 mm,
the middle members 80 mm, with the second drawer delayed by 0.75 seconds.

Run `npm run dev -- examples/mksp-toolbox/index.ts`, or generate outputs with:

```sh
node --import tsx src/worker.ts examples/mksp-toolbox/index.ts output/mksp-toolbox
```

Outputs include a two-page assembly/elevation PDF, drawing DXF, cut-list PDF/DXF/CSV,
sheet-layout PDF and full-size DXF, per-part machining DXFs, STEP, preview GLB and
animated GLB. `tests/mksp-toolbox.test.ts` verifies the sheet count, full assembled
bounds and two-stage slide movement. No fabrication certification is implied.

## Connection API

`interface.screwHoles()` returns a named round-hole interface, preserving its owner
and frame. Slot `x/y` denotes the lower-left of its bounding rectangle; the centre
uses half the full length and half the width, respecting the slot axis. The default
mating diameter is the slot width; use a `Drill` diameter for a smaller pilot hole.
`Drill.pattern()` also accepts slots directly and drills their centres. Its existing
placement argument controls where the pattern is applied (part-local by default).

`FingerJoint.connect()` detects an interior receiving face from the sheet outline
and the interface frame, reserves both end margins, and notches the entering sheet.
`FingerJoint.interval(length, { internal: true, edgeMargin })` exposes the same
minimum-20% policy to custom intersection techniques such as this toolbox's
orthogonal-panel helper. A smaller explicit margin cannot disable the minimum.

The drawing renderer samples trimmed HLR curves to 0.01 mm chord tolerance rather
than relying on cached edge polygons. Correcting the intersecting joint ends also
removes the ambiguous overlapping faces responsible for the broken shelf lines.
