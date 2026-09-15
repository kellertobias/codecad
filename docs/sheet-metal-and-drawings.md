# Sheet metal and CAD drawings

## Folded-first profile

```ts
const steel = new SheetMaterial({ thickness: 1.5, width: 1000, height: 2000 });
const z = steel.makeBentProfile({
  id: "z-bracket",
  width: 60,
  lengths: [30, 80, 25], // straight tangent-to-tangent lengths, mm
  bendRules: { kFactor: 0.42, minimumInsideRadius: 2, defaultRelief: "round" },
  bends: [
    { id: "a", direction: "up", angle: 90, insideRadius: 2 },
    { id: "b", direction: "down", angle: 60, insideRadius: 2 },
  ],
});
const flat = z.unfold(); // unregistered, independent snapshot
flat.shape; // developed solid, with cuts and reliefs
flat.bends; // centers, tangents, BA and bend deductions
```

Length includes straight lengths plus each `angleRadians * (R + K * thickness)`.
The profile factory orders distal bends first, keeping subsequent axes in flat
coordinates. Directions refer to the original local +Z side. Supply cuts in the
developed part's local coordinates. Do not treat `lengths` as outside dimensions.
Deduction is `2 * (R + thickness) * tan(angle / 2) - allowance`; verify process data.

## Partial flange with real relief cuts

```ts
const panel = steel.makeSheetMetalPart({
  id: "tab",
  outline: new Shapes.Rectangle({ width: 100, height: 80 }),
  bendRules: { kFactor: 0.42, minimumInsideRadius: 2, defaultRelief: "round" },
});
panel.bend(
  new Bend({
    id: "tab-bend",
    start: { x: 20, y: 35 },
    end: { x: 80, y: 35 },
    movingSide: "left",
    direction: "up",
    angle: 90,
    insideRadius: 2,
    autoRelief: true,
    relief: "round",
    reliefWidth: 2,
    reliefDepth: 4,
  }),
);
```

The directed line is the stationary tangent edge. The bend band lies on
`movingSide`; its center mark is half an allowance into that side. Relief slots
are **outside** both endpoints, from `reliefDepth` behind the tangent to the blank's
free edge. This deliberately releases the entire tab. Round relief has a
semicircular root; rectangular relief has a square root. Adjacent flanges needing
shared corner treatment are not automatically solved. Full-width open-ended
bends do not need these slots. The keyboard shell is such a part.

## Multi-page drawing and dimensions

```ts
const drawing = new TechnicalDrawing({
  title: "Bracket assembly",
  project: "My project",
  drawingNumber: "BR-001",
  revision: "A",
  author: "TK",
  material: "Steel 1.5 mm",
  paper: "A3",
})
  .view({
    id: "iso",
    kind: "isometric",
    of: panel,
    at: { x: 25, y: 35 },
    scale: 1,
  })
  .dimension({
    view: "iso",
    relativeTo: panel,
    from: { x: 0, y: 0, z: 0 },
    to: { x: 100, y: 0, z: 0 },
    offset: 0,
    paperOffset: 12,
  })
  .leader({
    view: "iso",
    relativeTo: panel,
    from: { x: 0, y: 0, z: 0 },
    at: { x: 180, y: 50 },
    text: "Deburr all edges",
  })
  .page(
    new TechnicalDrawing({
      title: "Developed bracket",
      drawingNumber: "BR-001",
    }).view({
      id: "flat",
      kind: "flat",
      of: panel,
      at: { x: 25, y: 35 },
      scale: 1,
    }),
  );
```

`dimension` uses true 3D length, not foreshortened isometric length. Plain points
are world coordinates unless `relativeTo` is specified. These are geometric
coordinates in the **formed local model**, not automatically folded flat feature
coordinates. Interfaces use their own world frames. Flat-view annotations instead
use developed local XY coordinates and reject world/relative interface coordinates.

`offset` is in model mm; `paperOffset` overrides it in paper mm. Angular dimensions:
`drawing.angle({ view, vertex, from, to, radius: 25 })` uses two non-collinear 3D rays
and projects the angle arc into the view. Radius is in paper mm. Use `label` only
when an intentional displayed override is required. Leaders are arbitrary callouts,
not automatically verified radius/diameter constraints.

Reserve the bottom 50 mm at the right for the title block, and bottom 30 mm at the
left for the graphic scale. `at` is each view's top-left bounding position, in paper
mm. Views are explicitly placed; there is no automatic collision-avoiding layout.
Print at 100% to retain the stated scale; the graphic bar remains a visual check.

Drawing DXF contains scaled sheet graphics, text, arrows and line types; it does
not contain native associative DIMENSION objects. **Use the separate 1:1 part CNC
DXF for manufacturing.** Curves in CNC DXFs have 0.02 mm tessellation tolerance.
STEP preserves analytic curves and solids. Blind milling cannot be represented
as through-cut sheet contours and is rejected by the sheet-metal flat DXF exporter.

## Boundaries

This is history-based unfolding of authored sheet-metal parts and automatic
development of straight/cylindrical profiles, not general reverse engineering of
imported folded STEP. It does not yet support holes crossing a bend, hems, formed
features, automatic multi-flange corner reliefs, press tooling simulation, springback
calibration, continuous forming collisions, or router G-code. Final-position flange
collisions and unsupported band geometry fail explicitly rather than export a
plausible but incorrect blank. Validate K-factor, tolerances and tooling with a shop.
