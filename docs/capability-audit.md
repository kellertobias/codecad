# CodeCAD capability audit

Baseline checkpoint: `c4e0832`. This is an implementation audit, not fabrication certification.

## Working today

- Class/decorator authoring, automatic assembly/part registration, independent copies,
  local and relative placement, mounting interfaces and explicit solid/outline clearance.
- OpenCascade solid booleans, drilling, pockets, countersinks, example domino/finger/miter joinery.
- Stock-aware cut lists, rectangular multi-sheet nesting, PDF reports and DXF/CSV downloads.
- Exact-solid STEP and tessellated glTF output, live rebuild/editor, hierarchical selection and isolation.
- Linear/revolute motion with delays, sampled clearance checks, exploded drawings and code dimensions.
- Flat-first sheet metal with cutouts, neutral-axis bend allowances and actual cylindrical bends.
  The keyboard demo exercises four full-width bends, two different top bend angles,
  bottom returns, sloped deck placement and a shared metal/wood mating outline.
- History-based `unfold()` snapshots with cutouts, reliefs, bend centers, tangent limits,
  allowances and deductions. `makeBentProfile()` develops tangent-to-tangent lengths automatically.
- Rectangular/round edge-opening relief cuts for partial-width flanges, final-position flange
  collision checks, closed developed CNC contours, and rejection of pierced bend bands.
- Multi-page PDF/DXF drawings, bottom-right title blocks, graphic scale bars, per-view scales,
  true-length isometric dimensions, projected angular dimensions and leaders. Smooth tangent
  edges are suppressed by default. Sampled profiles can opt into circular arc reconstruction.

## Still missing or limited

1. **Sheet metal:** recognition/unfolding of arbitrary imported folded solids; pierced bend zones;
   interacting multi-flange corner reliefs; bend-order/tool collision planning; hems and formed features.
   Unfolding uses the authored development history, not automatic STEP feature recognition.
   Partial flange reliefs require `autoRelief: true` and extend to the free edge; tear relief is rejected.
   Intersecting bend bands and blind milling in the flat cutting DXF are explicitly rejected.
   Material K-factor and springback still require a fabricator's tooling/process data.
2. **Manufacturing:** true contour nesting and remnant inventory; CNC toolpaths, feeds/speeds,
   lead-ins, workholding, compensation and machine-specific G-code. DXF layers communicate
   operations, not a validated machining process. Arbitrary edge drilling setups remain limited.
3. **Mechanical design:** general constraint solving, contact-driven motion and continuous
   swept-volume collision detection. Simplified hardware is not a supplier-qualified part library.
4. **Documentation:** richer section/detail views, native associative CAD dimension entities,
   manufacturing tolerances and fit specifications, fastener BOMs and stud/weld schedules.
5. **Editor/runtime:** full multi-file editing and exhaustive dependency/source tracing,
   project switching, persisted sessions, packaging and stronger untrusted-code isolation.
   Project code executes with the local Node process's permissions.
6. **Quality/distribution:** broader real-fabrication acceptance cases, performance benchmarks,
   CI/release packaging, license selection and dependency-license review before distribution.

## Keyboard demo assumptions and limitations

- Two columns and six rows of 96 × 11 mm rectangular openings; 8 mm between adjacent slots.
  Sheet width 216 mm gives 8 mm end margins. The 176 mm deck has 35 mm front/back slot margins.
- 1.5 mm steel, inside bend radius 5 mm, provisional K=0.42, top inclined 20°.
  The straight front wall is 40 mm; rear height is derived to align the two bottom returns.
- Top bends turn 70° and 110° to make the walls vertical after the 20° deck tilt.
  Bottom bends are 90°; both returns are 30 mm, with an open gap between them.
- Four M3 × 10 mm internal weld-stud envelopes. Threads and welding details are not modeled;
  confirm stud type, edge distance, mounting loads and tooling with the fabricator.
- Each MDF cheek is 18 mm thick: 15 mm external shoulder plus a 3 mm inner fitting tongue.
  The cheek outline extends 8 mm beyond the nominal outside sheet profile. A 0.25 mm mating
  clearance is applied. The tongue/rebate and blank are generated from the shared section,
  with sampled radiused portions reconstructed into circular arcs using a 0.01 mm radial fit
  tolerance. Manufacturing DXF curves are tessellated at 0.02 mm; STEP retains circular curves.
- The keyboard PDF has two A3 pages: assembly/true-length and angular dimensions, then the
  developed 216 x 411.57 mm sheet, twelve cuts, center/tangent bend marks and a four-bend schedule.
  This open-ended full-width shell needs no partial-flange reliefs. See `sheet-metal-reliefs.ts`
  for a separate round/rectangular partial-flange comparison and a folded-first Z profile.
- The MDF-to-metal interface is demonstrated geometrically; a production retention method,
  assembly access, finish allowance and structural validation have not been specified.

Run `npm run dev -- examples/keyboard-case.ts` or
`node --import tsx src/worker.ts examples/keyboard-case.ts output/keyboard-case`.
