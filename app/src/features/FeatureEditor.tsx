// The inspector for one feature: its parameters as a form. Faces and edges
// are picked in the 3D view: a "Pick" button hands the view's clicks to
// that field until it is pressed again.
import type {
  CadDocument,
  EdgeReference,
  ExtrudeFeature,
  FaceReference,
  Feature,
  HoleFeature,
  MirrorFeature,
  PatternFeature,
  SketchFeature,
} from "../../../src/document/schema.ts";
import type { VariableValues } from "../../../src/document/variables.ts";
import {
  detectProfiles,
  matchRegions,
} from "../../../src/document/profiles.ts";
import { bodyFeature } from "../../../src/document/features.ts";
import type { FeatureStatus } from "../../../src/kernel/evaluator.ts";
import type { Model } from "../kernel.ts";
import { Checklist, Choice, ExpressionField, Field } from "./fields.tsx";

/** Which reference field the 3D view's clicks go to. */
export type PickField = "edges" | "faces" | "upTo" | "face";

export interface FeatureEditorProps {
  document: CadDocument;
  feature: Feature;
  status: FeatureStatus | undefined;
  variables: VariableValues;
  model: Model | undefined;
  picking: PickField | undefined;
  setPicking(field: PickField | undefined): void;
  update(next: Feature, merge?: string): void;
  editSketch(id: string): void;
  close(): void;
}

export function FeatureEditor(props: FeatureEditorProps) {
  const { feature, status, update, close } = props;
  return (
    <section className="feature-editor" aria-label={`Edit ${feature.name}`}>
      <header>
        <h2>{feature.name}</h2>
        <button onClick={close}>Done</button>
      </header>
      {status?.state === "error" ? (
        <p className="error feature-problem">
          {status.message}
          {status.broken ? " — pick it again below." : null}
        </p>
      ) : null}
      <Field label="Name">
        <input
          value={feature.name}
          onChange={(event) =>
            update(
              { ...feature, name: event.target.value },
              `name:${feature.id}`,
            )
          }
        />
      </Field>
      {feature.type === "sketch" ? (
        <SketchFields {...props} feature={feature} />
      ) : feature.type === "extrude" ? (
        <ExtrudeFields {...props} feature={feature} />
      ) : feature.type === "fillet" || feature.type === "chamfer" ? (
        <EdgeFields {...props} feature={feature} />
      ) : feature.type === "shell" ? (
        <ShellFields {...props} feature={feature} />
      ) : feature.type === "hole" ? (
        <HoleFields {...props} feature={feature} />
      ) : (
        <RepeatFields {...props} feature={feature} />
      )}
    </section>
  );
}

type Props<F extends Feature> = FeatureEditorProps & { feature: F };

const roleNames: Record<string, string> = {
  start: "start face",
  end: "end face",
};

/** "end face of Extrude 1", "side of Extrude 1 (line l3k2)". */
export function describeFace(document: CadDocument, ref: FaceReference) {
  const origin = ref.origin.split("#")[0]!;
  const feature =
    document.features.find((f) => f.id === origin)?.name ?? ref.origin;
  const [kind, entity] = ref.role.split(":");
  const what =
    roleNames[ref.role] ??
    (kind === "side"
      ? `side (${entity})`
      : kind === "wall" || kind === "floor" || kind === "head"
        ? `hole ${kind}`
        : ref.role);
  const copy = ref.origin.includes("#") ? " (copy)" : "";
  return `${what} of ${feature}${copy}`;
}

const describeEdge = (document: CadDocument, ref: EdgeReference) =>
  `${describeFace(document, ref.a)} × ${describeFace(document, ref.b)}`;

function PickButton({
  field,
  picking,
  setPicking,
  what,
}: {
  field: PickField;
  picking: PickField | undefined;
  setPicking(field: PickField | undefined): void;
  what: string;
}) {
  const on = picking === field;
  return (
    <button
      className={on ? "primary" : undefined}
      onClick={() => setPicking(on ? undefined : field)}
    >
      {on ? `Picking ${what}… (done)` : `Pick ${what}`}
    </button>
  );
}

function SketchFields({
  document,
  feature,
  update,
  editSketch,
  picking,
  setPicking,
}: Props<SketchFeature>) {
  return (
    <>
      <Field label="On">
        <span>
          {feature.face
            ? describeFace(document, feature.face)
            : `${feature.plane} plane`}
        </span>
      </Field>
      {feature.face ? null : (
        <Choice
          label="Plane"
          value={feature.plane}
          options={[
            ["XY", "XY (top)"],
            ["XZ", "XZ (front)"],
            ["YZ", "YZ (side)"],
          ]}
          commit={(plane) => update({ ...feature, plane })}
        />
      )}
      <div className="button-row">
        <PickButton
          field="face"
          picking={picking}
          setPicking={setPicking}
          what="a flat face"
        />
        {feature.face ? (
          <button
            onClick={() => {
              const { face: _face, ...rest } = feature;
              update(rest);
            }}
          >
            Use the plane instead
          </button>
        ) : null}
        <button className="primary" onClick={() => editSketch(feature.id)}>
          Edit sketch
        </button>
      </div>
    </>
  );
}

/** Sketches listed before `feature`. */
const sketchesBefore = (document: CadDocument, feature: Feature) =>
  document.features
    .slice(
      0,
      document.features.findIndex((f) => f.id === feature.id),
    )
    .filter((f): f is SketchFeature => f.type === "sketch");

/** Bodies of the model not made by this feature, for target lists. */
const bodyItems = (model: Model | undefined, feature: Feature) =>
  (model?.bodies ?? [])
    .filter((body) => bodyFeature(body.id) !== feature.id)
    .map((body) => ({ value: body.id, label: body.name }));

function without<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function ExtrudeFields({
  document,
  feature,
  variables,
  model,
  update,
  picking,
  setPicking,
}: Props<ExtrudeFeature>) {
  const sketch = document.features.find(
    (f): f is SketchFeature => f.id === feature.sketch && f.type === "sketch",
  );
  const regions = sketch
    ? [...detectProfiles(sketch).regions].sort((p, q) => (p.id < q.id ? -1 : 1))
    : [];
  const chosen = feature.regions
    ? matchRegions(feature.regions, regions).flatMap((r) => (r ? [r.id] : []))
    : regions.map((r) => r.id);
  const missing = feature.regions ? feature.regions.length - chosen.length : 0;
  const set = (change: Partial<ExtrudeFeature>, merge?: string) =>
    update({ ...feature, ...change }, merge);
  return (
    <>
      <Choice
        label="Sketch"
        value={feature.sketch}
        options={sketchesBefore(document, feature).map(
          (s) => [s.id, s.name] as const,
        )}
        commit={(id) => update(without({ ...feature, sketch: id }, "regions"))}
      />
      <Checklist
        label="Regions"
        items={regions.map((region, i) => ({
          value: region.id,
          label: `Region ${i + 1} · ${Math.round(region.area).toLocaleString()} mm²`,
        }))}
        checked={chosen}
        // At least one: no regions at all would mean every region.
        commit={(ids) => {
          if (ids.length) set({ regions: ids });
        }}
        empty="The sketch has no closed region yet."
        {...(missing
          ? { hint: `${missing} chosen region(s) no longer exist.` }
          : {})}
      />
      <Choice
        label="Result"
        value={feature.operation}
        options={[
          ["new", "New bodies"],
          ["add", "Add to bodies"],
          ["cut", "Cut from bodies"],
          ["intersect", "Keep the overlap"],
        ]}
        commit={(operation) => set({ operation })}
      />
      <Choice
        label="Extent"
        value={feature.extent}
        options={[
          ["blind", "Distance"],
          ["symmetric", "Symmetric"],
          ["throughAll", "Through all"],
          ["upTo", "Up to a face"],
        ]}
        commit={(extent) =>
          set({
            extent,
            ...(extent === "blind" || extent === "symmetric"
              ? { distance: feature.distance ?? "10" }
              : {}),
          })
        }
      />
      {feature.extent === "blind" || feature.extent === "symmetric" ? (
        <ExpressionField
          label={feature.extent === "symmetric" ? "Total depth" : "Depth"}
          value={feature.distance}
          variables={variables}
          commit={(distance) => set({ distance: distance ?? "10" })}
        />
      ) : null}
      {feature.extent === "upTo" ? (
        <Field label="Up to">
          <span className={feature.upTo ? undefined : "hint"}>
            {feature.upTo
              ? describeFace(document, feature.upTo)
              : "no face yet"}
          </span>
          <PickButton
            field="upTo"
            picking={picking}
            setPicking={setPicking}
            what="the face"
          />
        </Field>
      ) : null}
      {feature.extent !== "symmetric" && feature.extent !== "upTo" ? (
        <label className="check">
          <input
            type="checkbox"
            checked={!!feature.reverse}
            onChange={(event) => set({ reverse: event.target.checked })}
          />
          Other direction
        </label>
      ) : null}
      {feature.operation !== "new" ? (
        <Checklist
          label="Bodies"
          items={bodyItems(model, feature)}
          checked={feature.targets ?? []}
          commit={(targets) =>
            update(
              targets.length
                ? { ...feature, targets }
                : without(feature, "targets"),
            )
          }
          empty="There are no bodies yet."
          hint="None chosen: every body it reaches."
        />
      ) : null}
    </>
  );
}

function EdgeFields({
  document,
  feature,
  variables,
  update,
  picking,
  setPicking,
}: Props<Extract<Feature, { type: "fillet" | "chamfer" }>>) {
  const fillet = feature.type === "fillet";
  return (
    <>
      {fillet ? (
        <ExpressionField
          label="Radius"
          value={feature.radius}
          variables={variables}
          commit={(radius) => update({ ...feature, radius: radius ?? "3" })}
        />
      ) : (
        <ExpressionField
          label="Distance"
          value={feature.distance}
          variables={variables}
          commit={(distance) =>
            update({ ...feature, distance: distance ?? "3" })
          }
        />
      )}
      <RefList
        label="Edges"
        items={feature.edges.map((edge) => describeEdge(document, edge))}
        remove={(i) =>
          update({
            ...feature,
            edges: feature.edges.filter((_, j) => j !== i),
          })
        }
      />
      <PickButton
        field="edges"
        picking={picking}
        setPicking={setPicking}
        what="edges"
      />
    </>
  );
}

function ShellFields({
  document,
  feature,
  variables,
  update,
  picking,
  setPicking,
}: Props<Extract<Feature, { type: "shell" }>>) {
  return (
    <>
      <ExpressionField
        label="Wall"
        value={feature.thickness}
        variables={variables}
        commit={(thickness) =>
          update({ ...feature, thickness: thickness ?? "3" })
        }
      />
      <RefList
        label="Open faces"
        items={feature.faces.map((face) => describeFace(document, face))}
        remove={(i) =>
          update({
            ...feature,
            faces: feature.faces.filter((_, j) => j !== i),
          })
        }
      />
      <PickButton
        field="faces"
        picking={picking}
        setPicking={setPicking}
        what="faces"
      />
    </>
  );
}

function HoleFields({
  document,
  feature,
  variables,
  model,
  update,
}: Props<HoleFeature>) {
  const set = (change: Partial<HoleFeature>) =>
    update({ ...feature, ...change });
  const sketch = document.features.find(
    (f): f is SketchFeature => f.id === feature.sketch && f.type === "sketch",
  );
  const free = sketch ? freePoints(sketch) : [];
  return (
    <>
      <Choice
        label="Sketch"
        value={feature.sketch}
        options={sketchesBefore(document, feature).map(
          (s) => [s.id, s.name] as const,
        )}
        commit={(id) => update(without({ ...feature, sketch: id }, "points"))}
      />
      <p className="hint">
        Drills at {feature.points ? feature.points.length : free.length} point
        {(feature.points?.length ?? free.length) === 1 ? "" : "s"}: the sketch's
        points that are not part of a line or curve.
      </p>
      <Choice
        label="Kind"
        value={feature.kind}
        options={[
          ["simple", "Simple"],
          ["counterbore", "Counterbore"],
          ["countersink", "Countersink"],
        ]}
        commit={(kind) =>
          set({
            kind,
            ...(kind !== "simple" && !feature.headDiameter
              ? { headDiameter: "10" }
              : {}),
            ...(kind === "counterbore" && !feature.headDepth
              ? { headDepth: "3" }
              : {}),
          })
        }
      />
      <ExpressionField
        label="Diameter"
        value={feature.diameter}
        variables={variables}
        commit={(diameter) => set({ diameter: diameter ?? "5" })}
      />
      <ExpressionField
        label="Depth"
        value={feature.depth}
        variables={variables}
        optional
        placeholder="through all"
        commit={(depth) =>
          update(depth ? { ...feature, depth } : without(feature, "depth"))
        }
      />
      {feature.kind !== "simple" ? (
        <ExpressionField
          label="Head diameter"
          value={feature.headDiameter}
          variables={variables}
          commit={(headDiameter) => set({ headDiameter: headDiameter ?? "10" })}
        />
      ) : null}
      {feature.kind === "counterbore" ? (
        <ExpressionField
          label="Head depth"
          value={feature.headDepth}
          variables={variables}
          commit={(headDepth) => set({ headDepth: headDepth ?? "3" })}
        />
      ) : null}
      {feature.kind === "countersink" ? (
        <ExpressionField
          label="Angle"
          value={feature.angle}
          variables={variables}
          unit="°"
          optional
          placeholder="90"
          commit={(angle) =>
            update(angle ? { ...feature, angle } : without(feature, "angle"))
          }
        />
      ) : null}
      <Checklist
        label="Bodies"
        items={bodyItems(model, feature)}
        checked={feature.targets ?? []}
        commit={(targets) =>
          update(
            targets.length
              ? { ...feature, targets }
              : without(feature, "targets"),
          )
        }
        empty="There are no bodies yet."
        hint="None chosen: every body it reaches."
      />
    </>
  );
}

function freePoints(sketch: SketchFeature) {
  const used = new Set(
    sketch.entities.flatMap((e) =>
      e.type === "line"
        ? [e.start, e.end]
        : e.type === "circle"
          ? [e.center]
          : e.type === "arc"
            ? [e.center, e.start, e.end]
            : [],
    ),
  );
  return sketch.entities.filter((e) => e.type === "point" && !used.has(e.id));
}

function RepeatFields({
  document,
  feature,
  variables,
  model,
  update,
}: Props<PatternFeature | MirrorFeature>) {
  const index = document.features.findIndex((f) => f.id === feature.id);
  const repeatable = document.features
    .slice(0, index)
    .filter((f) => f.type === "extrude" || f.type === "hole")
    .map((f) => ({ value: f.id, label: f.name }));
  const lists = (
    <>
      <Checklist
        label="Features"
        items={repeatable}
        checked={feature.features ?? []}
        commit={(features) => update({ ...feature, features })}
        empty="There are no extrudes or holes before this feature."
        hint="What they cut or add is repeated on the bodies it reaches."
      />
      <Checklist
        label="Bodies"
        items={bodyItems(model, feature)}
        checked={feature.bodies ?? []}
        commit={(bodies) => update({ ...feature, bodies })}
        empty="There are no bodies yet."
        hint="Each chosen body is copied as a new body."
      />
    </>
  );
  if (feature.type === "mirror")
    return (
      <>
        <Choice
          label="Mirror plane"
          value={feature.plane}
          options={[
            ["YZ", "YZ (left ↔ right)"],
            ["XZ", "XZ (front ↔ back)"],
            ["XY", "XY (top ↔ bottom)"],
          ]}
          commit={(plane) => update({ ...feature, plane })}
        />
        <ExpressionField
          label="Plane offset"
          value={feature.offset}
          variables={variables}
          optional
          placeholder="0"
          commit={(offset) =>
            update(offset ? { ...feature, offset } : without(feature, "offset"))
          }
        />
        {lists}
      </>
    );
  const set = (change: Partial<PatternFeature>) =>
    update({ ...feature, ...change });
  return (
    <>
      <Choice
        label="Kind"
        value={feature.kind}
        options={[
          ["linear", "In a row"],
          ["circular", "Around an axis"],
        ]}
        commit={(kind) =>
          set({
            kind,
            ...(kind === "linear" && !feature.spacing ? { spacing: "32" } : {}),
          })
        }
      />
      <Choice
        label={feature.kind === "linear" ? "Direction" : "Axis"}
        value={feature.axis}
        options={[
          ["X", "X"],
          ["Y", "Y"],
          ["Z", "Z"],
        ]}
        commit={(axis) => set({ axis })}
      />
      <ExpressionField
        label="Count"
        value={feature.count}
        variables={variables}
        unit=""
        commit={(count) => set({ count: count ?? "2" })}
      />
      {feature.kind === "linear" ? (
        <ExpressionField
          label="Spacing"
          value={feature.spacing}
          variables={variables}
          commit={(spacing) => set({ spacing: spacing ?? "32" })}
        />
      ) : (
        <>
          <ExpressionField
            label="Angle"
            value={feature.angle}
            variables={variables}
            unit="°"
            optional
            placeholder="360"
            commit={(angle) =>
              update(angle ? { ...feature, angle } : without(feature, "angle"))
            }
          />
          {(["x", "y", "z"] as const).map((axis, i) => (
            <ExpressionField
              key={axis}
              label={`Centre ${axis}`}
              value={feature.center?.[i]}
              variables={variables}
              optional
              placeholder="0"
              commit={(value) => {
                const center = [...(feature.center ?? ["0", "0", "0"])] as [
                  string,
                  string,
                  string,
                ];
                center[i] = value ?? "0";
                set({ center });
              }}
            />
          ))}
        </>
      )}
      {lists}
    </>
  );
}

function RefList({
  label,
  items,
  remove,
}: {
  label: string;
  items: readonly string[];
  remove(index: number): void;
}) {
  return (
    <fieldset className="checklist">
      <legend>{label}</legend>
      {items.length === 0 ? <p className="hint">None picked yet.</p> : null}
      <ul className="ref-list">
        {items.map((item, i) => (
          <li key={i}>
            <span>{item}</span>
            <button
              className="icon"
              aria-label={`Remove ${item}`}
              onClick={() => remove(i)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
