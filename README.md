# CodeCAD Studio

A local TypeScript CAD application with classes, standard decorators, automatic
part registration, an OpenCascade geometry engine, live preview, and manufacturing
outputs.

## Run

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4317**. The default project is
[the four-drawer cabinet](examples/kitchen-cabinet.ts).
Edit its source in the application and press **Save & build** (Cmd/Ctrl+S), or save
from your usual editor. Changes to project-directory and runtime TypeScript files
trigger a fresh build. Select parts, hide panels, inspect drawings and sheet
layouts, scrub drawer motion, or download the generated files.

The Parts registry is an expandable ownership tree (also available as
`project.registry.tree` and `project.parts.tree`). Selecting or hiding an assembly
affects its descendants; filtering keeps matching nodes and their ancestors.
At smaller window sizes, use the **Parts** and **Source** buttons.
Each row's **Show only** control isolates that component and its descendants,
fits the visible geometry, and centers the orbit target. **Show all** restores
the complete model; **Fit** always fits currently visible geometry.

The Monaco TypeScript editor provides syntax highlighting, completion, and folded
imports on load. Type an unimported symbol and accept its **Auto import** completion
(Ctrl+Space opens suggestions) to insert or merge the import. This uses a local
TypeScript language service, not a cloud service.

Component selection highlights construction, placement, machining callsites and
lexical references in the open project file. Reused definitions share highlighted
lines; copied recipes retain their original construction locations. This is
source provenance, not exhaustive dataflow analysis: indirect dependencies and
code in other files are not all highlighted in the current single-file editor.
Unsaved edits clear build-linked highlights until the next save and rebuild.
The sample's three-member slides are cabinet-owned and its handles are single solids;
hardware expands further when authored as an assembly with child components.

The cabinet example opens each drawer over 3 seconds, starting successive drawers
0.75 seconds apart (25% of the opening duration). `delaySeconds` is also available
on `MotionStudy.animate`. Each provisional slide has a stationary `fixed` member,
a `middle` member moving 190 mm, and an `inner` member moving the drawer's full
380 mm. These are kinematic envelopes, not manufacturer-qualified slide profiles.

Paired domino mortises join the corpus sides to the top/bottom (20 × 6 mm,
10 mm deep per side, three per joint) and drawer sides to their backs (16 × 4 mm,
6 mm deep per side, two per joint). Tenon solids are not included. Edge-entry
mortises require a separate machining setup: the CNC ZIP includes `-edge-X_MIN`
and `-edge-X_MAX` DXFs with along-edge horizontal coordinates and stock thickness
vertically, in millimetres. Sheet-face DXFs carry reference notes rather than
misrepresenting these mortises as face-routing pockets.

To open another project:

```sh
npm run dev -- examples/sheet-metal-project.ts
npm run dev -- examples/joinery-techniques.ts
```

For exports without the viewer:

```sh
npm run build
node --import tsx src/worker.ts examples/sheet-metal-project.ts output/sheet-metal
npm run check
npm test
```

The default build writes to `output/kitchen-cabinet/`. Live-build artifacts are
stored under `.codecad/`. Project source runs as trusted local Node.js code,
with your account's filesystem access. Use projects you trust.

## Authoring

```ts
@cad.project({ id: "cabinet", units: "mm" })
export class Cabinet extends Project {
  constructor() {
    super({ id: "cabinet" });
    const material = new SheetMaterial({
      width: 1250,
      height: 2500,
      thickness: 18,
    });
    const left = material.makePart({
      id: "left",
      width: 600,
      height: 900,
    });
    new Drill({ size: 8 }).drill(left, {
      x: 50,
      y: 100,
      z: [18, -6],
    });
    left.copy({ id: "right" }).place({
      relativeTo: left,
      x: 600,
    });
  }

  @cad.output.cutList({ fileName: "cut-list.csv" })
  cutList() {
    return new CutList({ includeLayouts: true });
  }
}
```

### Registry and construction

- Classes decorated with `@cad.project` or `@cad.part` create a construction
  scope. Every component created in that scope becomes a child of that project
  or assembly. Temporary `Shapes` and tools are not registered as manufactured
  parts.
- Local variables are sufficient; parts need no repeated class fields or manual
  registration calls. `this.registry` includes nested assemblies and parts;
  `this.parts` filters to parts. `Assembly.add()` remains available for explicitly
  adopting existing components.
- IDs are unique within an assembly. Repeated drawers can each have a child
  named `front`. Ambiguous short lookups throw; use
  `this.parts.require("cabinet/drawer-2/front", SheetPart)`.
- `copy()` copies the completed component graph and machining history at the
  moment of the call. Children, interfaces, and internal references are copied;
  stock definitions remain shared. Changes to the source's geometry do not
  affect its copy.
- Each live build runs in a fresh process. A failed constructor cannot contaminate
  the next registry, and kernel resources are released when the process exits.
  Build failures leave the previous successful preview visible. Output failures
  are reported individually and make the CLI exit nonzero.

### Coordinates

- Distances are millimetres; angles are degrees.
- Sheet profiles occupy local XY, with thickness from local Z=0 to Z=thickness.
  Boxes start at their minimum corner. Cylinders use their center position.
- Operations on a part use that part's local coordinates by default.
  `z: [18, -6]` enters at Z=18 and cuts toward Z=12.
- `place()` replaces placement. Its default frame is the containing assembly;
  `relativeTo: "world"` selects world space, and `relativeTo: component` or an
  interface selects that frame. Relative placement follows subsequent changes
  to the reference. Circular placement references are rejected.
- `move()` without a reference adds a local transform. `mirror({ axis: "z" })`
  reflects placement about the local XY plane; it preserves the part's local
  manufacturing program. To mirror a 2D blank itself, mirror its profile.
- A boolean or tool operation resolves its reference into target-local space
  when recorded. Later assembly movement carries the completed machining with it.
- Side drilling uses a rotated interface frame; its local Z axis is the drill
  axis. Face-oriented XY DXF is intended for machining from a sheet's top/bottom.

### Interfaces and tools

An interface offers an optional solid, outline, mounting features, and local
coordinate frame. Bind it to a part with `addInterface()`, or publish it from a
method using `@cad.interface()`.

- `subtract(interface)` consumes its explicit solid, or its owning part's solid.
  It never guesses a cut depth from hole metadata.
- `withClearance(0.5)` offsets a solid by 0.5 mm. Solid offset currently requires
  a single valid solid. An outline alone is consumed by `Groove`/`RouterBit`.
- `Drill.pattern(panel, handle.interface(), { z: [18, -18] })` drills named hole
  positions with the chosen drill. Supply `placement` to position the pattern.
  Slot features require routing.
- Countersinks specify diameter and included angle; their explicit depth must
  match the resulting full cone. Standard drill point geometry is currently
  represented by a flat-ended cylindrical removal.
- Domino joints cut paired rounded mortises. Finger joints alternate edge cuts;
  miters remove wedges in named interface frames. The joint interfaces must be
  bound to actual parts and provide an edge outline.

### Materials and manufacturing

`SheetMaterial` and `BoardMaterial` create manufactured XY blanks;
`BlockMaterial` creates three-dimensional blanks. All appear in cut lists.
Stock sheet width/height can be omitted for modeling, but nesting requires them.

Nesting uses a deterministic rectangular guillotine algorithm, respects margins,
part spacing/kerf, allowed rotations and grain, and allocates more sheets as needed.
Oversized parts produce errors. Arbitrary profiles pack by their bounding rectangles;
there is no contour nesting optimizer or remnant inventory yet.
`quantity` multiplies a blank in the cut list/nesting; use copies for multiple
addressable instances in the assembly.

DXF exports are in millimetres:

- `BLANK_OUTLINE` is the stock blank, not a finished toolpath.
- `DRILL_TOP_D6.000`, `POCKET_BOTTOM_D6.000`, `CUT_THROUGH_D18.000`, etc.
  describe machining operations and depth/side in part coordinates.
- Axial circular holes are DXF circles. Other contours are chained polylines
  tessellated at a requested 0.02 mm tolerance.
- Sheet-metal DXF includes bend-direction/angle/radius layers.
- Miters appear on `REFERENCE_BEVEL_*_DEGREES` layers for a separate bevel/saw
  setup; these reference contours are not through-pocket instructions. Side
  drilling is rejected by this XY exporter and needs its own setup.
- Per-part and nested-sheet exports are available. Cutter contours and blank
  boundaries are separate: downstream CAM determines tool compensation, cut
  order, trimming and workholding. Additive solids and enclosed cavities that
  cannot be described by this export are reported as errors.

### Sheet metal

Flat blanks remain the manufacturing source. Bends consume a neutral-axis bend
allowance of `angleRadians × (insideRadius + kFactor × thickness)`. Preview and
STEP use exact cylindrical bend surfaces and transformed flanges.

The implemented bend family is straight, full-width bends with an uncut rectangular
bend band. Use `movingSide: "left" | "right"` relative to the directed bend line.
Cuts outside the bend band are carried with the flange. Partial-width bends,
cuts through bend bands, general unfolding, and automatic corner relief are
not implemented; unsupported band geometry produces a build error.

### Drawings, motion and exports

- Technical drawings use kernel edge projection and optional hidden lines.
  Views support programmable dimensions/notes and exploded arrangements.
  Plans, sheet layouts and cut lists default to PDF downloads in Studio;
  each download has its own DXF dropdown option. Cut lists also offer CSV.
  SVG is retained internally for previews. Cut-list PDFs paginate; sheet PDFs
  include a scaled A4 overview and a numbered part legend.
- Plan DXFs preserve drawing-page coordinates and view scales, including
  dimension labels and notes. Cut-list DXFs contain vector tables, not toolpaths.
  Sheet-layout DXFs are full-size millimetres with stock boundaries and nested
  machining contours/layers. Use these or the per-part CNC exports for CAM,
  not the scaled plan DXFs.
- STEP preserves exact evaluated solids and their placements.
- glTF/GLB provides a portable tessellated preview; its scene scale converts
  millimetres to glTF metres.
- Linear and revolute joints animate components and descendants. Clearance
  studies measure exact shape distances at discrete samples. They are sampled
  checks, not continuous collision proofs or a general assembly constraint solver.
- G-code and router-specific postprocessors remain a later extension, as planned.

## Examples

- [Kitchen cabinet](examples/kitchen-cabinet.ts): complete four-drawer example,
  handle screw patterns/countersinks, back grooves, rails, nesting and all outputs.
- [Simple cabinet API example](examples/simple-kitchen-cabinet.ts): compact
  constructor syntax from the interface discussion. Its provisional hinge
  intentionally produces a clearance warning.
- [Reusable hinge](examples/my-custom-hinge.ts): named interfaces and revolute motion.
- [Joinery project](examples/joinery-techniques.ts): paired Domino, finger and miter samples.
- [Sheet-metal project](examples/sheet-metal-project.ts): cut flat blank and two bends.

The example hardware uses provisional simplified geometry; replace it with
measured or supplier STEP geometry and mounting dimensions for your hardware.

## Source map

- `src/model.ts`: component registry, construction scopes, coordinates, copies, shape recipes.
- `src/decorators.ts`: class and output discovery.
- `src/stock.ts`, `tools.ts`, `techniques.ts`: stock and machining operations.
- `src/engine.ts`: OpenCascade evaluation, meshing, exact solids and folding.
- `src/manufacturing.ts`: cut lists, nesting, DXF.
- `src/drawing.ts`, `exporters.ts`: projections, PDF, glTF and clearance results.
- `src/server.ts`, `worker.ts`: local server and isolated rebuild/export process.
- `web/`: editor, Three.js viewer, registry, output browser.
- `tests/`: numerical geometry, construction semantics and export integration checks.

## Dependencies

The geometry adapter uses [brepjs](https://github.com/andymai/brepjs) and
[occt-wasm](https://www.npmjs.com/package/occt-wasm), with Three.js for rendering.
Exact versions are pinned in `package-lock.json`. Dependency licenses remain
those of their respective packages; review the OpenCascade/LGPL obligations
before distributing a packaged application.
