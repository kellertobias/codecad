# Roadmap: CodeCAD as an interactive browser CAD

Status: proposal, 2026-09-26. Baseline: v0.14.0 (`fd82f2b`).

## Goal

Move from "CAD written as TypeScript" to a browser-based, history-based parametric
CAD for furniture and sheet-goods work. It should cover:

1. Variables, and sketches driven by them.
2. Extrudes into one or more bodies, sketches on faces of those bodies, and
   further features.
3. 2D output: projections, cutaways, plans, DXF, cut lists, and nesting on stock
   the user owns.
4. Joints between two selected parts, such as finger joints or dominos.
5. A personal library of parts and assemblies with declared interfaces, such as
   screw positions.
6. Browser plus server. There are no users now, and per-user projects come later.
   Editing happens on desktop, while viewing drawings and cut lists also works
   on mobile.

## Starting point

### What we keep

These already exist and carry straight into the new application:

| Asset | Where | Role in the new app |
| --- | --- | --- |
| OCCT kernel via `brepjs` + `occt-wasm` (WASM) | `src/engine.ts` | Same kernel, and it can also run in a browser worker |
| Serializable `Recipe` IR | `src/model.ts` | Low-level target that features compile to |
| `brepjs` lineage refs (`shapeRef`, `*WithEvolution`), `sketchOnFace2D`, true 2D curves | node_modules/brepjs | The answer to topological naming, sketch-on-face, and real arcs |
| `PartInterface`, `attach`, edges | `src/model.ts`, `src/edges.ts`, `src/stock.ts` | Basis for joints and library interfaces |
| Finger, domino, miter and groove techniques; tools | `src/techniques.ts`, `src/tools.ts` | Joint generators |
| HLR drawings, sheet editor, dimensions | `src/drawing*.ts`, `web/drawing-plan-editor.ts` | 2D views and plans |
| DXF encoder, thin-material check, guillotine nesting, reports | `src/manufacturing.ts`, `src/nesting.ts`, `src/reports.ts` | Manufacturing outputs |
| Parameter schema | `src/parameters.ts` | Seed for the variables system |

### What blocks us

- **The model can only be authored as executable TypeScript.** A GUI edit has
  nothing to write to.
- **Every edit rebuilds everything.** Each change spawns a process, compiles TS,
  rebuilds the whole model and ships the meshes as JSON arrays, which takes
  seconds. Interactive sketching needs milliseconds.
- **There are no sketch entities or constraint solver.** Profiles are point
  polygons, and circles are 128-gons.
- **Faces can only be named by direction** (north, front, …). You cannot pick an
  arbitrary face and keep that reference stable across edits.
- **The server serves one localhost project per process.** It rejects other Host
  headers and has no project store.
- **The UI is two vanilla-TS monoliths**: `web/app.ts` at 2k lines and
  `web/drawing-plan-editor.ts` at 1.8k.
- **Nesting is rectangular only.**

## Core architectural decisions

### D1. The source of truth becomes a JSON document with a feature tree

A project is a versioned JSON document:

```
Document
  variables[]        name, expression, unit, (min/max/options), group
  partStudios[]      feature list (ordered history) producing bodies
    features[]       Sketch | Extrude | Cut | Fillet | Chamfer | Shell | Pattern | Mirror
                     | Boolean | SheetBody | Joint | InsertLibraryItem | ...
  assemblies[]       instances of bodies/library items + mates + joints
  stock[]            materials and physical stock (sheets, boards, offcuts)
  drawings[]         sheets and views (today's drawings.json, generalized)
  layouts[]          stock layouts (nesting results, manual placements)
```

- Features refer to geometry through **stable references**: a feature ID, the role
  of the generated entity, and a geometric hint. Kernel indices are never used.
- Every numeric field is an **expression string** (`"width - 2*t"`), not a
  number.
- The evaluator compiles features to `brepjs` calls. It reuses today's
  `Recipe`/engine code for primitives, booleans, techniques and drawings.
- **The code-first SDK stays** as the npm library. User TypeScript is supported
  as **code parts** (see D7).
- **User code runs only in the user's browser.** The server stores and uses
  the generated model and never executes user code. Whole-project code mode
  stays local/desktop only.

Why a document and not generated code: GUI editing, undo/redo, diffing, per-feature
regeneration, collaboration and safe multi-tenant hosting all need data, not
programs.

### D2. The kernel runs in the browser, and the server also runs it headless

- **Interactive:** the editor runs `occt-wasm` in a **Web Worker** with a
  persistent session. It regenerates incrementally from the first changed feature
  and caches a shape per feature. Meshes are sent as transferable typed arrays,
  not JSON.
- **Server:** the same evaluator package runs in Node workers for:
  - heavy or authoritative jobs such as PDF/DXF/STEP exports, HLR drawings and
    nesting
  - thumbnails
  - **mobile**, which never loads the kernel and only gets prebuilt artifacts.
- Therefore the evaluator is a pure, isomorphic TS package: no `fs`, and the
  kernel is injected.

### D3. Sketch solver

- **Spike first:** check whether the kernel adapter we use exposes brepjs's
  `ConstraintSketchCapability` (`sketchAddConstraint`/`sketchSolve`/`sketchDof`).
  It appears to be tied to the alternative `brepkit` kernel.
- **Fallback, and probably the default:** **planegcs**, FreeCAD's solver compiled
  to WASM (`@salusoft89/planegcs`). It is proven, and it reports DOF and
  conflicting or redundant constraints.
- The sketch model is our own:
  - Entities: point, line, arc, circle, and later spline.
  - Constraints: coincident, horizontal, vertical, parallel, perpendicular,
    tangent, equal, distance, angle, radius, symmetric, fix, midpoint, on-entity.
  - Driving dimensions reference variables.

### D4. Topological naming

- Every feature records a role table for what it creates. For example, an
  extrude records `start cap`, `end cap`, and `side:<sketch-entity-id>`.
- A downstream reference is `{feature, role, hint}` and is resolved through
  `brepjs` `shapeRef`/evolution after booleans, fillets and similar operations.
- A broken reference makes the feature fail visibly. The tree marks it red and
  offers "re-pick", the way Onshape and Fusion do. It never silently binds to
  the wrong face.

### D5. Server and storage

- **Node server** (keep `node:http` or move to Fastify) bound to a configurable
  host, so phones on the LAN work.
- **SQLite** through `better-sqlite3`, or Postgres later:
  - tables `projects`, `document_revisions` (append-only snapshots plus an op log
    for undo/history), `library_items`, `artifacts`
  - artifacts are cached by `(document revision, output kind)` hash.
- **Multi-tenancy-ready from day one:** every row has `owner_id`, fixed to
  `"local"` for now. All data access goes through a `Workspace` interface. Adding
  auth later means adding middleware, not a migration of semantics.
- A **job queue**, in-process with worker threads for now, runs exports,
  drawings and nesting. Clients subscribe over SSE (today's progress events carry
  over).

### D6. Frontend

- **Vite + a component framework**; we recommend **React** for dialog-heavy CAD
  UI. The panels are the feature tree, property panes, variable table, library
  browser and joint wizard.
- The **three.js viewport and the 2D sketch canvas stay imperative** modules
  wrapped by components.
- Today's modules are split and ported: viewer, measurement, isolation, surface
  visibility, sheet editor and PDF viewer.
- **Two shells over one codebase:**
  - **Editor**, desktop only, with a keyboard/mouse-first layout.
  - **Viewer**, responsive and touch-first, which also works on mobile: a GLB
    model viewer, drawing sheets (SVG/PDF), cut lists, and stock layouts with
    zoom. It is read-only, with optional "mark as cut" checkboxes on the cut
    list.
- **Tauri:** we recommend keeping it as a thin wrapper that points at a local
  server, or dropping it later. It is not on the critical path.

### D7. Code parts: code runs in the browser, the server uses the model

A code part is TypeScript source plus a parameter schema. It returns bodies and
interfaces, such as screw positions, mounting frames and role tables for stable
face references.

- **Generating:** the user's browser compiles the code with esbuild-wasm and runs
  it in a Web Worker, with the kernel injected and a timeout that kills runaway
  code. It then uploads a *generated result*:
  - BREP/STEP geometry
  - preview meshes
  - interfaces and metadata.

  Each result is keyed by `hash(code version, parameters)`.
- **Using the result:** everything downstream works from the stored result:
  - the server: exports, drawings, nesting, DXF
  - the mobile viewer
  - mates, joints and sketches on its faces.

  **The server never executes user code.**
- **Regenerating:** code only runs again, in an editor browser, when the code or
  its parameters change, the result is missing, or the user asks for it. If a
  server job needs a result that is missing, it reports "needs regeneration in
  the editor", and the editor regenerates the next time the project is opened.
- **Safety:**
  - Uploaded results are untrusted data: size limits, schema validation, and
    BREP parsing in a worker with limits.
  - Running the code in a sandboxed iframe (opaque origin, no network) is cheap
    and recommended now, so code cannot use the app session. Once code parts are
    shared between users, it is mandatory.
  - With users, recipients use the stored results; re-running someone else's
    code requires explicit trust.

## Phases

Each phase ends in something shippable. Sizes are relative: S is about a week, M
two to three weeks, L more than a month of focused work.

### Phase 0: Foundations (M)

- Extract an isomorphic `@codecad/core` package: recipe evaluation, techniques,
  drawings and manufacturing without Node-only imports. Keep `@tobisk/codecad`
  as the code-first facade over it.
- Run the kernel in a browser Web Worker. Prove we can load `occt-wasm`, build a
  box, and mesh it into transferable buffers. **Measure load time and memory.**
- Spikes, each ending in a short written verdict:
  1. planegcs vs brepjs constraint capability.
  2. `shapeRef` resolution through extrude → cut → fillet.
  3. Build a new UI shell with Vite + React next to the existing Studio.
- Add a server project store (SQLite), a projects list API and a configurable
  bind host. Keep the existing single-file mode working.

### Phase 1: Variables and sketches (L)

- Document schema v1 with a JSON schema, a migration version field and
  validation.
- **Variables:**
  - table UI; expressions with units (`mm`, `deg`); dependency graph with cycle
    detection
  - groups; project-level vs studio-level scope
  - `select` and `boolean` types, carried over from `parameters.ts`.
- **Sketcher (desktop):**
  - on a standard plane or datum
  - draw line, rectangle, circle, arc and slot
  - constraints with visual glyphs and dimensions editable in place (the value is
    an expression)
  - DOF status and highlighting of over- or under-constrained entities
  - construction geometry
  - snapping, trim and offset
- Profiles are detected from closed regions, including nested ones, so holes are
  supported.
- Undo/redo is document-level, through the op log.

### Phase 2: Bodies and features (L)

- Extrude:
  - new body, add, cut or intersect
  - blind, symmetric, up-to-face, or through-all
  - multiple selected regions produce multiple bodies.
- **Sketch on face:** pick a planar face, which creates a sketch on a stable
  face reference. Project edges into the sketch as reference geometry.
- Fillet, chamfer, shell, hole (simple, countersink or counterbore, reusing
  `src/tools.ts`), linear/circular pattern and mirror.
- Feature tree:
  - reorder, suppress, rollback bar, and edit-in-place with regeneration from
    that feature
  - error states for broken references.
- **Bodies become parts:** a body gets a name, a material and a stock kind
  (sheet or board of thickness *t*, or generic solid). A sheet body can be
  auto-detected when an extrude depth equals a stock thickness, and it then
  feeds the existing sheet/nesting/DXF pipeline.
- Selection filters (face, edge, vertex, body), and measurement that carries
  over from the current tool.

### Phase 3: Assemblies and joints (L)

- Part instances with placement:
  - mates: fastened, planar, edge-to-edge (today's `attach`), and later revolute
    and slider (today's `motion.ts`)
  - drag to place, then mate to snap.
- **Joint wizard:**
  1. Select two parts.
  2. The app finds contact or overlap regions: coplanar faces, butt edges and
     overlaps.
  3. It lists the applicable joint types:
     - butt with screws or dowels
     - finger/box joint
     - dominos
     - rabbet, dado or groove
     - miter
     - half-lap.
  4. Pick one and edit its parameters (count, spacing, clearance, tool diameter,
     depth) with a live preview.
- Joints are features, so they re-evaluate when the parts change. The generators
  wrap `src/techniques.ts`, which today works on `PartInterface`s.
- Joint output feeds manufacturing: pockets on faces, edge-drilling setups
  (already handled in DXF edge files), and hardware and dominos in the BOM.

### Phase 4: 2D, manufacturing and stock (L)

- Drawings are generalized from `drawings.json` into document `drawings[]`:
  - standard and auxiliary projections
  - **section views** by cut plane (extends `cutHeight` to arbitrary planes)
  - detail views and exploded views
  - per-part manufacturing sheets generated automatically.
- **Stock inventory:** the user defines materials and pieces they own. That
  means full sheets, offcuts drawn as a rectangle or an arbitrary polygon, and
  boards, each with thickness, grain direction and cost.
- **Layout editor:**
  - drop part outlines onto a stock piece, then drag, rotate in 90° steps or
    freely, and flip
  - live collision, kerf, edge-margin and grain checks, and a
    thin-material/"will it fit" warning.
  - "Auto-nest" fills the layout, using today's guillotine nesting for
    rectangles.
  - **True-shape nesting** comes later: a no-fit-polygon approach (for example
    a port of the SVGnest/Deepnest algorithm) running in a worker.
- DXF per layout and per part, cut lists, and BOM (including joint hardware), all
  from server jobs. PDF sheets are rendered with the existing pipeline.

### Phase 5: Personal library (M)

- A library item is a part studio or assembly plus:
  - **exposed variables**, which become the instance parameters
  - **interfaces**: named frames carrying features such as screw holes, dowel
    positions, mounting planes and connector points. These are generalized from
    `PartInterface`.
  - a thumbnail and tags.
- Insert from the library, then mate by interface: "connect interface A of the
  hinge to interface B of the door" places the item and **transfers the
  interface features** as cuts on the target, such as screw pilot holes.
- Items are versioned. A project pins a version, and "update available" is shown
  per instance.
- Import and export as a single file (JSON plus embedded STEP for imported
  hardware).

### Phase 5b: Code parts (M)

Code parts per D7, built in this order:

1. Browser execution spike.
2. Code-part API and document feature.
3. Browser runner.
4. Generated-result format and validated upload.
5. Result cache and library integration.
6. Regeneration flow.

### Phase 6: Mobile viewer and sharing polish (M)

- The responsive viewer route `/p/:id/view` has:
  - a 3D GLB model viewer with orbit on touch and part isolation
  - drawing sheets as SVG with pinch-zoom, and PDF download
  - cut lists and stock layouts (tap a part to highlight it), checkboxes for
    progress in the workshop
  - an offline cache via a service worker, for the workshop without wifi.
- Artifacts are prebuilt on save by the server job queue, so the phone never
  runs the kernel.

### Phase 7: Users and projects (later, M)

- Auth (OIDC or passkeys), `owner_id` becomes real, per-user libraries, and
  project sharing (view links first).
- Hardening: resource limits on kernel jobs, no user code execution, quotas.

## Cross-cutting

- **Testing:**
  - golden tests on evaluated documents (volume, bounding box, face count, DXF
    snapshot)
  - solver tests
  - reference-stability tests (edit the upstream sketch, and downstream features
    must still resolve)
  - Playwright tests for the editor and for the mobile viewer at 375 px.
- **Performance budgets:**
  - a sketch drag re-solves in under 16 ms
  - a single-feature edit regenerates in under 300 ms for a typical cabinet
  - the mobile viewer is interactive in under 2 s on LAN.
- **Migration:** the examples keep running through the code-first path. Port the
  kitchen cabinet to a document as the flagship acceptance test for phases 2–4.
- **Docs:** keep `docs/capability-audit.md` honest per phase.

## Open questions

- **Collaboration:** single-editor per document with revision locking (simple)
  or real-time multi-user (CRDT such as Yjs)? We recommend single-editor now,
  with the op log shaped so that a CRDT can be added later.
- **Sheet metal (bends, unfold) in the GUI:** in scope for the first release, or
  code-first only for now?
- **CNC toolpaths/G-code:** out of scope (DXF to external CAM), or a later phase?
- **Tauri desktop app:** keep it as a wrapper, or retire it once the browser
  version is complete?

## Suggested first slice (vertical, about 4–6 weeks)

1. Variables table.
2. One sketch on XY with lines, rectangles and circles, plus the core
   constraints.
3. Extrude into multiple bodies.
4. Sketch on a face, then a cut extrude.
5. Each body gets a material and thickness.
6. Existing DXF and cut-list output.
7. Mobile cut-list page.

This exercises every new architectural piece (document, browser kernel, solver,
stable references, server store, viewer) before investing in breadth.
