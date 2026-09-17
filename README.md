# CodeCAD Studio

<p align="center">
  <img src="assets/codecad-icon.png" alt="CodeCAD Studio icon" width="144">
</p>

A local TypeScript CAD application with classes, standard decorators, automatic
part registration, an OpenCascade geometry engine, live preview, and manufacturing
outputs.

Projects can define geometry for the infinite **Drawings** workspace,
independent of printable plans. Add paths, lines, or circles in millimetres
from a project constructor. Drawings remains available even for an empty plane,
and configured plans can be downloaded there. See `examples/infinite-drawing.ts`:

```ts
this.view2D.path(
  [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 900 },
    { x: 0, y: 900 },
  ],
  { closed: true, label: "Front outline" },
);
this.view2D.circle({ x: 300, y: 450 }, 12, { label: "Pull" });
```

Drag to pan the unbounded grid, scroll to zoom around the cursor, and use Fit to
reframe project geometry. The infinite view itself does not create an export file;
add a technical drawing output for a printable plan.

![CodeCAD Studio displaying the four-drawer kitchen cabinet](assets/codecad-studio-kitchen-cabinet.png)

## Use as a library

The published package is `@tobisk/codecad`: the generic TypeScript CAD SDK, not
the desktop application or its examples. Install it in an independent project:

```sh
npm install @tobisk/codecad
```

Then author reusable parts or an entire model in that project's source tree:

```ts
import { cad, Project, SheetMaterial } from "@tobisk/codecad";

@cad.project({ id: "shelf", units: "mm" })
export class Shelf extends Project {
  constructor() {
    super();
    const plywood = new SheetMaterial({ thickness: 18 });
    plywood.makePart({ id: "side", width: 300, height: 700 });
  }
}
```

`npm run package:check` emits the public library and imports it through the same
package export map a consumer receives. `npm pack --dry-run` shows the exact
publish payload; it contains only `dist/`, the README, and license notices.

### Build the desktop app through npm

The package also exposes an explicit macOS launcher/build command:

```sh
npx @tobisk/codecad app
```

It downloads the source archive for the matching `v<package-version>` Git tag
from GitHub into `~/Library/Caches/CodeCAD/source/`, builds the Tauri app with
the local Xcode, Rust and Node toolchains, and opens it. A previously built copy
is opened directly; use `npx @tobisk/codecad app --rebuild` to build it again.
This command still builds locally; it does not download the GitHub Release ZIP.

## Releases

GitHub is the release authority. Pull requests and pushes validate with
`npm run check`, `npm test`, and `npm run package:check`. A trusted push to
`main` runs semantic-release on a macOS runner. It prepares one version across
the npm package, lockfile, Tauri configuration, and Rust crate, updates
`CHANGELOG.md`, builds a macOS archive, commits those version files, and creates
a `vX.Y.Z` tag. It then publishes `@tobisk/codecad` through npm trusted
publishing (OIDC) and creates a hosted GitHub Release with the macOS ZIP and
SHA-256 checksum. The archive is ad-hoc signed and not notarized; macOS may
require an explicit trust override before opening it.

Conventional Commit messages control versioning: `fix:` and `perf:` publish a
patch, `feat:` publishes a minor, and `type!:` or a `BREAKING CHANGE:` footer
publishes a major. `docs:`, `test:`, `style:`, `refactor:`, `build:`, `ci:` and
`chore:` do not release by themselves. Run `npm run release:dry-run` locally to
preview a release without publishing.

The existing npm trusted publisher for `@tobisk/codecad` must name this GitHub
repository and `.github/workflows/release.yml`; the repository variable
`NPM_PUBLISH_ENABLED` must be `true`. Until it is set, the entire release job is
intentionally skipped. No `NPM_TOKEN` is stored in GitHub. The release job needs
GitHub `contents: write` for the release commit, tag, and hosted assets, and
`id-token: write` for npm OIDC. Only the trusted `main` release job receives
those permissions. A fresh checkout with full history and tags is required for
semantic-release. Run `npm run release:dry-run` locally to preview versioning;
it does not build an archive or publish anything. CI runs the build only after
tests pass and semantic-release finds a releasable commit.

## Run

### Desktop app (Tauri)

The repository-root wrapper builds the complete macOS application, including its
icon, web assets, native shell, bundled Node runtime and TypeScript 7 compiler:

```sh
./build                  # bootstrap dependencies and build
./build open             # rebuild and launch the build-directory app
./build install          # rebuild, replace /Applications/CodeCAD.app, and launch
./build archive          # clean app release build and macOS ZIP in artifacts/
./build archive install  # archive, replace the installed app, and launch
```

It works from other working directories too. ZIP filenames include the version
and host architecture; these are host-architecture macOS builds, not universal,
Windows or Linux packages. Native dependency caches are retained; archive builds
clean the CodeCAD crate. Node 22+, Rust and Apple Command Line Tools are required;
missing Node/Rust can be installed through an existing Homebrew installation.
If Homebrew or Apple's installer needs user action, the wrapper explains how to
continue. Locked npm dependencies are installed when their fingerprint changes.

Install validates the bundle ID, stages and verifies the new app before stopping
the exact old process, and preserves an existing app at the printed hidden
`/Applications/.CodeCAD-previous-...app` path. Project files and application data
are not removed. `/Applications` must be writable. Builds use local ad-hoc signing
unless `CODECAD_SIGN_IDENTITY` is set; no notarization is performed.

The macOS app has a custom draggable window frame with minimize, maximize/restore
and close controls. **Open from disk…** on the welcome screen opens a native file
picker directly: select a project's `.ts` or `.mts` entry file, not its folder.
Recent projects and examples are shown directly on the welcome screen with model
previews. Cmd/Ctrl+O opens the project picker from the editor. Opening a new
project executes local TypeScript and asks for trust the first time only. The
Studio toolbar's home button closes the current project and stops its CAD
engine; the adjacent sidebar button hides or shows the code completely. View
presets, parallel/perspective projection, and contextual measurement are in the
same toolbar. Hold Shift near a circular edge to measure from its hole centre.
**Build & checks** shows build status and can copy its output for bug reports.

The welcome screen also offers editable copies of the cabinet, keyboard and
apartment examples with previews rendered from their actual models. Copies live
in the application's data directory, separate from bundled resources. Recent
project previews are captured after a successful build. The app bundles Node.js,
OpenCascade and its TypeScript tools; users do not need a separately installed
Node runtime.

To develop/build, install Node.js 22+, Rust and the platform's Tauri prerequisites
(Xcode Command Line Tools on macOS), then run:

```sh
npm ci
npm run desktop:dev
# Or build the macOS application:
npm run desktop:build
```

The app is written to `src-tauri/target/release/bundle/macos/CodeCAD.app`.
Preparation downloads an official Node 22 runtime and checks its SHA-256 against
the published manifest. Subsequent builds reuse the cached runtime. Only macOS
has been built and tested; Windows runtime packaging is not implemented. The
local build is not a signed/notarized distribution release.

### Browser development

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
npm run dev -- examples/small-apartment.ts
```

The apartment example has an 8 x 6.4 m footprint and approximately 43.70 m2 of
clear room floor area: hallway, L-shaped living/kitchen, bedroom and bathroom.
All four rooms have exterior windows. The entrance has a door; the 1000 mm
hall-to-living opening has no door. PDF/DXF plans include a north-up floor plan
cut at 1400 mm, door-swing symbols and a cutaway isometric page. The 3D model
retains full-height walls. It is a spatial concept, not a construction/permit plan.
`DrawingView.cutHeight` clips only the drawing; `drawing.path()` and
`drawing.label()` place symbols and labels in world coordinates in a named view.

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

### Material drawing styles

Materials can define regular edge styling and a separate cutaway style:

```ts
const wall = new BlockMaterial({
  name: "Plastered wall",
  drawingStyle: {
    regular: { stroke: "#555555", lineWidth: 0.18 },
    cutaway: {
      stroke: "#202020",
      lineWidth: 0.5,
      hatch: { angle: 45, spacing: 1.8, stroke: "#777777", lineWidth: 0.13 },
    },
  },
});
```

`cutaway` applies to actual faces exposed by a drawing view's `cutHeight`, not
the entire clipped part. Openings remain unhatched. Use `cross: true` inside
`hatch` for cross-hatching, or `hatch: false` to show only the cut outline.
Widths and spacing are in **paper millimetres**, angle is in degrees on the page,
and colours are six-digit hex values. Styles affect drawings, not 3D materials
or CNC toolpaths. Regular styles also apply to developed sheet-metal drawing
outlines. Cut edges inherit unspecified regular line settings; hatch defaults
are 45°, 2 mm spacing and 0.13 mm line width.

SVG previews and PDF use the same vector geometry. DXF stores clipped hatch
segments on `SECTION_HATCH_*` layers (not native editable HATCH entities), with
true colour and the nearest supported DXF line weight. The apartment demo uses
this for its walls. Joined generic solids do not inherit source material styles.

### Joining solids

Use `this.joinSolids([floor, leftWall, rightWall], { id: "shell" })` in a
project or assembly to fuse placed parts (including whole nested assemblies).
Their current world positions are captured in the owning assembly's coordinate
system. The returned `Part` can be drilled, cut, moved, copied or exported to STEP.
Source components are removed from the registry and exports by default; pass
`keepSources: true` to retain them deliberately. Later source edits do not change
the joined snapshot. References to consumed components retain their original
world placement, but are no longer independently animated/exported.

For additive edits in a part's **local coordinates**, use
`part.union(new Shapes.Box({ width: 10, depth: 10, height: 10 }), { x: 20 })`.
To union another placed part without consuming it, use
`part.union(other, { relativeTo: other })`.

See [the joined room shell](examples/joined-solids.ts). Overlapping or face-touching
inputs can form one solid; disconnected inputs remain separate bodies within one
part. Joining does not bridge gaps or guarantee printability. Material, cut-list,
bend and machining metadata are not merged; folded sheet metal is explicitly
rejected to avoid joining its flat blank by mistake. This is a geometric union,
not a woodworking joint or a slicer/toolpath generator.

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
}
```

Outputs may stay on the project or live in separate classes. A class decorated
with `@cad.outputsFor(Cabinet)` receives the active `Cabinet` instance in its
constructor, so drawings, lists, exports, and motion refer to the same built
assembly and parameter values rather than constructing a second copy:

```ts
@cad.outputsFor(Cabinet)
export class CabinetCutList {
  constructor(readonly cabinet: Cabinet) {}

  @cad.output.cutList({ fileName: "cut-list.csv" })
  cutList() {
    return new CutList({ includeLayouts: true });
  }
}
```

See [the kitchen cabinet](examples/kitchen-cabinet.ts) for separate drawing,
manufacturing, and motion provider classes. The project entry still exports
exactly one decorated `Project` subclass.

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

Use `movingSide: "left" | "right"` relative to the directed bend line. Its start/end
describe the fixed-side **tangent line**, not the bend center. Cuts outside the
band move with the flange. Partial-width bends use `autoRelief: true` and rectangular
or round relief slots, extending from the root to the free edge. Specify
`reliefWidth` and `reliefDepth` (both at least material thickness).

`part.unfold()` returns an independent, unregistered snapshot with `shape` (all cuts
and reliefs), `outline` (stock envelope), and `bends` (center lines, tangent lines,
allowances and deductions). `flatPattern` is only the original stock outline;
use `unfold().shape` for finished geometry. Per-part sheet-metal DXFs section the
finished developed solid so edge-open reliefs are incorporated in the outer loop.

`material.makeBentProfile({ width, lengths, bends, bendRules })` accepts straight
**tangent-to-tangent** lengths and inserts neutral-axis allowances automatically.
This is history-based development, not recognition/unfolding of arbitrary STEP solids.
Pierced/intersecting bend bands, tear reliefs, multi-flange corner reliefs and tooling
collision planning are not supported. Unsupported geometry is rejected. Final-position
flange self-intersections are checked, but this is not press-brake feasibility analysis.

See [sheet-metal authoring and drawing examples](docs/sheet-metal-and-drawings.md),
the [keyboard case](examples/keyboard-case.ts), and
[relief comparison / Z profile](examples/sheet-metal-reliefs.ts).

### Drawings, motion and exports

- Technical drawings use kernel edge projection and optional hidden lines.
  Tangent seams are hidden by default (`tangentEdges: true` opts in).
  Views support true-length dimensions (also isometric), angles, leaders, notes,
  developed sheet views (`kind: "flat"`), and exploded arrangements.
  `drawing.page(otherDrawing)` appends PDF pages and Studio previews; drawing DXF
  lays pages side by side. Title blocks include project, drawing number, revision,
  material, author, scale, units and page numbers, plus a calibrated graphic scale.
  Plans, sheet layouts and cut lists default to PDF downloads in Studio;
  each download has its own DXF dropdown option. Cut lists also offer CSV.
  Drawings and sheet layouts use PDF.js to display the actual PDFs in one
  continuous workspace per section, with shared zoom, page navigation, drag-pan,
  pinch zoom, and Ctrl/Command-wheel zoom. Plain scrolling moves through pages.
  SVG remains an intermediate for PDF generation. Cut-list PDFs paginate; sheet PDFs
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

- [MKSP toolbox](examples/mksp-toolbox.ts): port of the existing Python toolbox,
  with finger-jointed plywood, telescoping rails and animated drawers. See the
  [port notes](docs/mksp-toolbox-port.md) for dimensions and hardware assumptions.
- [Kitchen cabinet](examples/kitchen-cabinet.ts): complete four-drawer example,
  handle screw patterns/countersinks, back grooves, rails, nesting and all outputs.
- [Simple cabinet API example](examples/simple-kitchen-cabinet.ts): compact
  constructor syntax from the interface discussion. Its provisional hinge
  intentionally produces a clearance warning.
- [Reusable hinge](examples/my-custom-hinge.ts): named interfaces and revolute motion.
- [Joinery project](examples/joinery-techniques.ts): paired Domino, finger and miter samples.
- [Sheet-metal project](examples/sheet-metal-project.ts): cut flat blank and two bends.
- [Keyboard case](examples/keyboard-case.ts): twelve slots, four R5 bends,
  a 20° deck, bottom returns, internal stud envelopes, and routed MDF cheeks
  consuming the shell's mating outline. See the [capability audit](docs/capability-audit.md)
  for assumptions, current coverage and missing features.

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

`npm run check` uses the native TypeScript **7.0.2** compiler. The dependency
`@typescript/native` aliases `typescript@7.0.2`, while `typescript` aliases
Microsoft's `@typescript/typescript6@6.0.2` compatibility package. This follows
[Microsoft's side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/):
the auto-import language service and source-link analysis still need the JavaScript
compiler API, which TypeScript 7.0 does not expose. `npm run check:compat` provides
the corresponding compatibility check; keep both packages when upgrading.

On the development Mac, five warm-process-launch measurements of `--noEmit`
on 2026-09-15 gave medians of 129 ms (native) and 784 ms (compatibility), about 6x
faster. These are type-check timings, not CAD rebuild timings. CAD rebuilds now
use TypeScript 7 to emit the project and SDK, then run the emitted JavaScript
through Node and evaluate OpenCascade geometry and reports. The launcher/server
still bootstraps with `tsx`. Monaco's browser-bundled language service is unchanged;
upgrading the CLI does not replace it with a native language server.

`npm run cad:build -- examples/mksp-toolbox.ts output/mksp-toolbox` uses the same
native rebuild path as the UI. Emission uses `noCheck` for iteration speed;
`npm run check` remains the strict project type-check. Each rebuild gets an isolated
`.native` output directory and never writes JavaScript beside your project.
Original module URLs and inline source maps preserve assets and source highlighting.
Imported TypeScript helpers must be statically discoverable (literal dynamic imports
also work); computed TypeScript imports are rejected if not emitted. Use
`CODECAD_COMPILER=esbuild npm run dev -- <project.ts>` for the previous runtime path.
The compiler does not accelerate OpenCascade booleans, drawing projection or exports.

The geometry adapter uses [brepjs](https://github.com/andymai/brepjs) and
[occt-wasm](https://www.npmjs.com/package/occt-wasm), with Three.js for rendering.
Exact versions are pinned in `package-lock.json`. Dependency licenses remain
those of their respective packages; review the OpenCascade/LGPL obligations.

## License

CodeCAD's own source code is licensed under [Apache-2.0](LICENSE). The bundled
OpenCascade WebAssembly kernel (`occt-wasm`) is separately LGPL-2.1-only. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the included software,
attributions, and the replacement instructions for that kernel.
before distributing a packaged application.
