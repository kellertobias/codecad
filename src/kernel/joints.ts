// Joints between two panels: how they meet, which joints fit that, and
// what each joint cuts, adds and needs as hardware.
//
// A panel is a body read as a flat blank: the thinnest way its blank can be
// seen (a panel drawn edge-on is still a panel). Joints need panels square
// to the model's axes, as the finger joint generator in techniques.ts does.
// Each joint is worked out again whenever the model is evaluated, so it
// follows the panels when their dimensions change.
import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import {
  Shapes,
  construction,
  Assembly,
  PartInterface,
  type Recipe,
} from "../model.js";
import { SheetMaterial, SheetPart } from "../stock.js";
import { DominoJoint, FingerJoint } from "../techniques.js";
import { frameMatrix } from "../document/frames.js";
import type { Blank, Body } from "./evaluator.js";
import { sheetBlank } from "./parts.js";

export type Axis = 0 | 1 | 2;

export interface Panel {
  readonly id: string;
  readonly name: string;
  /** The body's blank, seen with its thickness along the blank normal. */
  readonly blank: Blank;
  readonly thickness: number;
  /** The world axis the panel's thickness runs along. */
  readonly normalAxis: Axis;
  /** Where the blank lies in the model. */
  readonly box: Box3;
}

const eps = 1e-6;

/** The body as a panel, or why it is not one. */
export function panelOf(
  body: Pick<Body, "id" | "name" | "blank">,
): Panel | string {
  const blank = body.blank;
  if (!blank) return `${body.name} is not a flat blank`;
  let thinnest = blank;
  const o = blank.outline;
  if (o.length === 4)
    for (let i = 0; i < 2; i++) {
      const side = Math.hypot(
        o[(i + 1) % 4]!.x - o[i]!.x,
        o[(i + 1) % 4]!.y - o[i]!.y,
      );
      const turned = side < thinnest.depth && sheetBlank(blank, side);
      if (turned) thinnest = turned;
    }
  const n = thinnest.frame.normal;
  const axis = [0, 1, 2].find((i) => Math.abs(Math.abs(n[i]!) - 1) < 1e-9) as
    Axis | undefined;
  if (axis === undefined)
    return `${body.name} is not square to the model's axes`;
  return {
    id: body.id,
    name: body.name,
    blank: thinnest,
    thickness: thinnest.depth,
    normalAxis: axis,
    box: blankBox(thinnest),
  };
}

function blankBox(blank: Blank): Box3 {
  const m = new Matrix4().fromArray(frameMatrix(blank.frame));
  const box = new Box3();
  const xs = blank.outline.map((p) => p.x);
  const ys = blank.outline.map((p) => p.y);
  for (const x of [Math.min(...xs), Math.max(...xs)])
    for (const y of [Math.min(...ys), Math.max(...ys)])
      for (const z of [0, blank.depth])
        box.expandByPoint(new Vector3(x, y, z).applyMatrix4(m));
  return box;
}

const lo = (box: Box3, axis: number) => box.min.getComponent(axis);
const hi = (box: Box3, axis: number) => box.max.getComponent(axis);
const overlap = (a: Box3, b: Box3, axis: number) =>
  Math.min(hi(a, axis), hi(b, axis)) - Math.max(lo(a, axis), lo(b, axis));

/** Where two panels meet: the contact plane is square to `n` at `plane`,
 * the joint runs along `r` from `rFrom` to `rTo`, and `m` is the third
 * axis, across the joint, from `mFrom` to `mTo`. `toward` is the direction
 * along `n` from the first panel to the second. */
export interface Meeting {
  readonly n: Axis;
  readonly r: Axis;
  readonly m: Axis;
  readonly plane: number;
  readonly toward: 1 | -1;
  readonly rFrom: number;
  readonly rTo: number;
  readonly mFrom: number;
  readonly mTo: number;
}

export type Contact =
  | { readonly kind: "none"; readonly reason: string }
  /** The edge of `entering` against the face of `receiving`: at its end
   * (an L, `corner`) or in its middle (a T). */
  | {
      readonly kind: "butt";
      readonly entering: Panel;
      readonly receiving: Panel;
      readonly corner: boolean;
      readonly meeting: Meeting;
    }
  /** Two panels in one plane, edge against edge. */
  | {
      readonly kind: "edge";
      readonly first: Panel;
      readonly second: Panel;
      readonly meeting: Meeting;
    }
  /** Two panels stacked face on face; `first` is the one screwed through. */
  | {
      readonly kind: "face";
      readonly first: Panel;
      readonly second: Panel;
      readonly meeting: Meeting;
    }
  /** Panels at right angles that already run into each other: at a
   * corner, or crossing through each other's middle. */
  | {
      readonly kind: "overlap";
      readonly first: Panel;
      readonly second: Panel;
      readonly crossing: boolean;
    };

function meeting(first: Panel, second: Panel, n: Axis, m: Axis): Meeting {
  const r = (3 - n - m) as Axis;
  const toward = lo(second.box, n) >= hi(first.box, n) - eps ? 1 : -1;
  return {
    n,
    r,
    m,
    plane: toward > 0 ? hi(first.box, n) : lo(first.box, n),
    toward,
    rFrom: Math.max(lo(first.box, r), lo(second.box, r)),
    rTo: Math.min(hi(first.box, r), hi(second.box, r)),
    mFrom: Math.max(lo(first.box, m), lo(second.box, m)),
    mTo: Math.min(hi(first.box, m), hi(second.box, m)),
  };
}

/** How two panels meet. */
export function contact(a: Panel, b: Panel): Contact {
  const sizes = [0, 1, 2].map((axis) => overlap(a.box, b.box, axis));
  if (sizes.some((size) => size < -eps))
    return { kind: "none", reason: `${a.name} and ${b.name} do not touch` };
  const touching = [0, 1, 2].filter(
    (axis) => Math.abs(sizes[axis]!) <= eps,
  ) as Axis[];
  if (touching.length > 1)
    return {
      kind: "none",
      reason: `${a.name} and ${b.name} only touch along a line`,
    };
  if (!touching.length) {
    if (a.normalAxis === b.normalAxis)
      return {
        kind: "none",
        reason: `${a.name} and ${b.name} are parallel and run into each other`,
      };
    // Crossing: each lies within the other's extent across its thickness.
    const within = (host: Panel, guest: Panel) =>
      lo(guest.box, guest.normalAxis) > lo(host.box, guest.normalAxis) + eps &&
      hi(guest.box, guest.normalAxis) < hi(host.box, guest.normalAxis) - eps;
    return {
      kind: "overlap",
      first: a,
      second: b,
      crossing: within(a, b) && within(b, a),
    };
  }
  const n = touching[0]!;
  if (n === a.normalAxis && n === b.normalAxis) {
    const rest = ([0, 1, 2] as Axis[]).filter((axis) => axis !== n);
    const m = sizes[rest[0]!]! < sizes[rest[1]!]! ? rest[0]! : rest[1]!;
    return { kind: "face", first: a, second: b, meeting: meeting(a, b, n, m) };
  }
  if (n === b.normalAxis || n === a.normalAxis) {
    const [entering, receiving] = n === b.normalAxis ? [a, b] : [b, a];
    const m = entering.normalAxis;
    // At the receiving panel's end when the entering panel is flush with it.
    const corner =
      Math.abs(lo(entering.box, m) - lo(receiving.box, m)) <= eps ||
      Math.abs(hi(entering.box, m) - hi(receiving.box, m)) <= eps;
    return {
      kind: "butt",
      entering,
      receiving,
      corner,
      meeting: meeting(entering, receiving, n, m),
    };
  }
  if (a.normalAxis === b.normalAxis)
    return {
      kind: "edge",
      first: a,
      second: b,
      meeting: meeting(a, b, n, a.normalAxis),
    };
  return {
    kind: "none",
    reason: `${a.name} and ${b.name} meet edge to edge at an angle`,
  };
}

/** How two panels meet, in words. */
export function describeContact(c: Contact): string {
  switch (c.kind) {
    case "none":
      return c.reason;
    case "butt":
      return `${c.entering.name} stands against ${c.receiving.name}${c.corner ? " at its end (a corner)" : " (a T)"}`;
    case "edge":
      return `${c.first.name} and ${c.second.name} meet edge to edge`;
    case "face":
      return `${c.first.name} lies on ${c.second.name}`;
    case "overlap":
      return c.crossing
        ? `${c.first.name} and ${c.second.name} cross each other`
        : `${c.first.name} and ${c.second.name} overlap at a corner`;
  }
}

export type JointKind =
  | "finger"
  | "domino"
  | "dowel"
  | "screw"
  | "dado"
  | "rabbet"
  | "miter"
  | "halfLap";

export const jointNames: Record<JointKind, string> = {
  finger: "Finger joint",
  domino: "Dominos",
  dowel: "Dowels",
  screw: "Screws",
  dado: "Dado (housing)",
  rabbet: "Rabbet",
  miter: "Miter",
  halfLap: "Half-lap",
};

/** The joints that fit how two panels meet, most usual first. */
export function jointsFor(c: Contact): JointKind[] {
  switch (c.kind) {
    case "butt":
      return c.corner
        ? ["finger", "domino", "dowel", "screw", "rabbet", "miter"]
        : ["domino", "dowel", "screw", "dado", "finger"];
    case "edge":
      return ["domino", "dowel"];
    case "face":
      return ["screw"];
    case "overlap":
      return c.crossing ? ["halfLap"] : ["finger"];
    case "none":
      return [];
  }
}

export interface JointParameters {
  readonly fingerWidth?: number;
  readonly clearance?: number;
  readonly count?: number;
  readonly edgeOffset?: number;
  readonly depth?: number;
  readonly diameter?: number;
  readonly length?: number;
  /** Domino size, thickness × length, e.g. "5x30". */
  readonly domino?: string;
}

export interface JointCut {
  readonly body: string;
  readonly kind:
    | "cut"
    | "domino"
    | "drill"
    | "edge-drill"
    | "countersink"
    | "dado"
    | "rabbet"
    | "miter";
  /** In model coordinates. */
  readonly recipe: Recipe;
  readonly diameter?: number;
  readonly depth?: number;
}

export interface Hardware {
  readonly kind: "domino" | "dowel" | "screw";
  readonly size: string;
  readonly count: number;
}

export interface JointPlan {
  /** Material added to a panel first (the part of it that reaches into
   * the other), as a box in the model. */
  readonly grow: readonly { readonly body: string; readonly box: Box3 }[];
  readonly cuts: readonly JointCut[];
  readonly hardware: readonly Hardware[];
}

export class JointError extends Error {}

const unit = (axis: Axis, sign = 1) => new Vector3().setComponent(axis, sign);

const boxRecipe = (box: Box3): Recipe => ({
  kind: "transform",
  matrix: new Matrix4()
    .makeTranslation(box.min.x, box.min.y, box.min.z)
    .toArray(),
  source: {
    kind: "box",
    width: box.max.x - box.min.x,
    depth: box.max.y - box.min.y,
    height: box.max.z - box.min.z,
  },
});

/** A box from per-axis ranges. */
function range(spans: Record<Axis, [number, number]>): Box3 {
  return new Box3(
    new Vector3(spans[0][0], spans[1][0], spans[2][0]),
    new Vector3(spans[0][1], spans[1][1], spans[2][1]),
  );
}

/** The panel after a box is added to it: its blank's outline grows to
 * cover the box. */
export function grown(panel: Panel, box: Box3): Panel {
  const inverse = new Matrix4()
    .fromArray(frameMatrix(panel.blank.frame))
    .invert();
  const corners = [box.min, box.max].flatMap((p) =>
    [box.min, box.max].flatMap((q) =>
      [box.min, box.max].map((r) =>
        new Vector3(p.x, q.y, r.z).applyMatrix4(inverse),
      ),
    ),
  );
  const o = panel.blank.outline;
  const xs = [...o.map((p) => p.x), ...corners.map((p) => p.x)];
  const ys = [...o.map((p) => p.y), ...corners.map((p) => p.y)];
  const [x0, x1, y0, y1] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const blank: Blank = {
    ...panel.blank,
    outline: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
  return { ...panel, blank, box: blankBox(blank) };
}

/** Positions along a joint `length` long: `count` of them, the outer ones
 * `edge` from the ends (or one in the middle). */
function spread(length: number, count: number, edge: number): number[] {
  if (!Number.isInteger(count) || count < 1)
    throw new JointError("The count must be a whole number of at least 1");
  if (count === 1) return [length / 2];
  if (edge < 0 || 2 * edge > length)
    throw new JointError("The edge distance leaves no room for the joint");
  return Array.from(
    { length: count },
    (_, i) => edge + (i * (length - 2 * edge)) / (count - 1),
  );
}

const dominoSizes: Record<
  string,
  { thickness: number; width: number; length: number }
> = {
  "4x20": { thickness: 4, width: 17, length: 20 },
  "5x30": { thickness: 5, width: 19, length: 30 },
  "6x40": { thickness: 6, width: 20, length: 40 },
  "8x40": { thickness: 8, width: 22, length: 40 },
  "8x50": { thickness: 8, width: 22, length: 50 },
  "10x50": { thickness: 10, width: 24, length: 50 },
};
export const dominoSizeNames = Object.keys(dominoSizes);

/** What a joint of `kind` does to the two panels. */
export function planJoint(
  kind: JointKind,
  c: Contact,
  p: JointParameters,
): JointPlan {
  if (c.kind === "none") throw new JointError(c.reason);
  if (!jointsFor(c).includes(kind))
    throw new JointError(
      `A ${jointNames[kind].toLowerCase()} does not fit how these panels meet`,
    );
  switch (kind) {
    case "finger":
      return finger(c, p);
    case "domino":
      return domino(c as Extract<Contact, { meeting: Meeting }>, p);
    case "dowel":
    case "screw":
      return holes(kind, c as Extract<Contact, { meeting: Meeting }>, p);
    case "dado":
    case "rabbet":
      return housing(kind, c as Extract<Contact, { kind: "butt" }>, p);
    case "miter":
      return miter(c as Extract<Contact, { kind: "butt" }>);
    case "halfLap":
      return halfLap(c as Extract<Contact, { kind: "overlap" }>, p);
  }
}

/** The box by which the entering panel reaches `depth` into the other. */
function reachInto(c: Extract<Contact, { kind: "butt" }>, depth: number): Box3 {
  const { n, r, m, plane, toward, rFrom, rTo } = c.meeting;
  const e = c.entering.box;
  const spans = {} as Record<Axis, [number, number]>;
  spans[n] = toward > 0 ? [plane, plane + depth] : [plane - depth, plane];
  spans[r] = [rFrom, rTo];
  spans[m] = [lo(e, m), hi(e, m)];
  return range(spans);
}

// ---------------------------------------------------------------- finger

class JointParts extends Assembly {}

/** A panel as a SheetPart where it stands, for the techniques. */
function sheetPart(panel: Panel, id: string): SheetPart {
  const part = new SheetPart(
    new SheetMaterial({ id: `${id}-stock`, thickness: panel.thickness }),
    {
      id,
      outline: new Shapes.Polygon({ points: panel.blank.outline }),
    },
  );
  part.extraMatrixForMate(
    new Matrix4().fromArray(frameMatrix(panel.blank.frame)),
  );
  return part;
}

/** The cuts a technique added to a placed part, in model coordinates. */
function cutsOf(
  part: SheetPart,
  body: string,
  kind: JointCut["kind"],
  from = 0,
): JointCut[] {
  const world = part.worldMatrix();
  return part.operations.slice(from).map((op) => ({
    body,
    kind: op.kind === "domino" ? "domino" : kind,
    recipe: { kind: "transform", source: op.recipe, matrix: world.toArray() },
    ...(op.depth !== undefined ? { depth: op.depth } : {}),
  }));
}

function finger(c: Contact, p: JointParameters): JointPlan {
  const fingerWidth = p.fingerWidth ?? 20;
  if (!(fingerWidth > 0))
    throw new JointError("The finger width must be more than 0");
  let first: Panel;
  let second: Panel;
  const grow: { body: string; box: Box3 }[] = [];
  if (c.kind === "butt") {
    // The entering panel reaches through the other, as a box joint's
    // panels both run to the outside of the corner.
    const box = reachInto(c, c.receiving.thickness);
    grow.push({ body: c.entering.id, box });
    first = grown(c.entering, box);
    second = c.receiving;
  } else if (c.kind === "overlap") {
    first = c.first;
    second = c.second;
  } else throw new JointError("A finger joint needs panels at right angles");
  const cuts = construction(() => {
    new JointParts({ id: "joint" });
    const a = sheetPart(first, "a");
    const b = sheetPart(second, "b");
    try {
      new FingerJoint(a, b, {
        fingerWidth,
        ...(p.clearance !== undefined ? { clearance: p.clearance } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new JointError(
        message
          .replaceAll("joint/a", first.name)
          .replaceAll("joint/b", second.name),
      );
    }
    return [...cutsOf(a, first.id, "cut"), ...cutsOf(b, second.id, "cut")];
  });
  return { grow, cuts, hardware: [] };
}

// ---------------------------------------------------------------- dominos, dowels, screws

/** The two sides of a meeting as mating frames in the model: x along the
 * joint from its start, z out of each panel toward the other, y across the
 * joint (along the first panel's thickness for a butt joint). */
function sides(c: Extract<Contact, { meeting: Meeting }>) {
  const { n, r, m, plane, toward, rFrom, mFrom, mTo } = c.meeting;
  const [first, second] =
    c.kind === "butt" ? [c.entering, c.receiving] : [c.first, c.second];
  const middle = (mFrom + mTo) / 2;
  const origin = new Vector3()
    .setComponent(n, plane)
    .setComponent(r, rFrom)
    .setComponent(m, middle);
  const x = unit(r);
  const side = (panel: Panel, z: Vector3) => ({
    panel,
    origin,
    x,
    z,
    y: z.clone().cross(x),
  });
  return [
    side(first, unit(n, toward)),
    side(second, unit(n, -toward)),
  ] as const;
}

type Side = ReturnType<typeof sides>[number];

/** A PartInterface on a placed part for one side of a meeting. */
function sideInterface(
  part: SheetPart,
  s: Side,
  length: number,
  width: number,
) {
  const inverse = part.worldMatrix().invert();
  const origin = s.origin.clone().applyMatrix4(inverse);
  const x = s.x.clone().transformDirection(inverse);
  const y = s.y.clone().transformDirection(inverse);
  return new PartInterface({
    frame: {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      xAxis: { x: x.x, y: x.y, z: x.z },
      yAxis: { x: y.x, y: y.y, z: y.z },
    },
    outline: new Shapes.Rectangle({ width: length, height: width }),
  }).bind(part);
}

function domino(
  c: Extract<Contact, { meeting: Meeting }>,
  p: JointParameters,
): JointPlan {
  const size = dominoSizes[p.domino ?? "5x30"];
  if (!size) throw new JointError(`There is no domino size ${p.domino}`);
  const [first, second] = sides(c);
  const length = c.meeting.rTo - c.meeting.rFrom;
  const across = c.meeting.mTo - c.meeting.mFrom;
  const perSide = size.length / 2;
  for (const s of [first, second]) {
    // Into a face, the mortise must leave material behind it.
    const room =
      s.panel.normalAxis === c.meeting.n ? s.panel.thickness : Infinity;
    if (perSide >= room)
      throw new JointError(
        `A ${p.domino ?? "5x30"} domino is too long for ${s.panel.name}`,
      );
  }
  if (size.thickness >= across)
    throw new JointError(`A ${p.domino ?? "5x30"} domino is too thick here`);
  const count = p.count ?? 2;
  return construction(() => {
    new JointParts({ id: "joint" });
    const a = sheetPart(first.panel, "a");
    const b = sheetPart(second.panel, "b");
    try {
      new DominoJoint({
        width: size.width,
        thickness: size.thickness,
        depthPerSide: perSide,
      }).connect({
        first: sideInterface(a, first, length, across),
        second: sideInterface(b, second, length, across),
        count,
        edgeOffset: p.edgeOffset ?? Math.min(50, length / 4),
      });
    } catch (error) {
      throw new JointError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      grow: [],
      cuts: [
        ...cutsOf(a, first.panel.id, "domino"),
        ...cutsOf(b, second.panel.id, "domino"),
      ],
      hardware: [{ kind: "domino" as const, size: p.domino ?? "5x30", count }],
    };
  });
}

/** The rotation taking +z onto `axis`. */
const turnedTo = (axis: Vector3) =>
  new Matrix4().makeRotationFromQuaternion(
    new Quaternion().setFromUnitVectors(
      new Vector3(0, 0, 1),
      axis.clone().normalize(),
    ),
  );

/** A cylinder along `axis` from `start` for `depth`. */
function bore(
  start: Vector3,
  axis: Vector3,
  diameter: number,
  depth: number,
): Recipe {
  // Cylinder recipes run along +z, centred on their middle.
  const centre = start.clone().addScaledVector(axis, depth / 2);
  return {
    kind: "transform",
    matrix: new Matrix4()
      .makeTranslation(centre.x, centre.y, centre.z)
      .multiply(turnedTo(axis))
      .toArray(),
    source: { kind: "cylinder", diameter, length: depth },
  };
}

function holes(
  kind: "dowel" | "screw",
  c: Extract<Contact, { meeting: Meeting }>,
  p: JointParameters,
): JointPlan {
  const [first, second] = sides(c);
  const length = c.meeting.rTo - c.meeting.rFrom;
  const count = p.count ?? 2;
  const positions = spread(
    length,
    count,
    p.edgeOffset ?? Math.min(50, length / 4),
  );
  const cuts: JointCut[] = [];
  /** Whether holes into this side go into the panel's face. */
  const intoFace = (s: Side) => s.panel.normalAxis === c.meeting.n;
  const kindFor = (s: Side): JointCut["kind"] =>
    intoFace(s) ? "drill" : "edge-drill";
  if (kind === "dowel") {
    const diameter = p.diameter ?? 8;
    const total = p.length ?? 30;
    for (const s of [first, second]) {
      const depth = total / 2 + 1;
      if (intoFace(s) && depth >= s.panel.thickness)
        throw new JointError(
          `${total} mm dowels are too long for ${s.panel.name}`,
        );
      if (diameter >= c.meeting.mTo - c.meeting.mFrom)
        throw new JointError(`${diameter} mm dowels are too thick here`);
      for (const x of positions) {
        const at = s.origin.clone().addScaledVector(s.x, x);
        // Into the panel: against its z.
        cuts.push({
          body: s.panel.id,
          kind: kindFor(s),
          recipe: bore(at, s.z.clone().negate(), diameter, depth),
          diameter,
          depth,
        });
      }
    }
    return {
      grow: [],
      cuts,
      hardware: [{ kind: "dowel", size: `${diameter}x${total}`, count }],
    };
  }
  // Screws go through the panel whose face lies on the joint (the
  // receiving panel of a butt joint, the first of two stacked panels),
  // from its far face, into the other.
  const [through, into] =
    intoFace(second) && c.kind === "butt" ? [second, first] : [first, second];
  const diameter = p.diameter ?? 4;
  const screw = p.length ?? 40;
  const t = through.panel.thickness;
  const reach = screw - t;
  if (reach <= 0)
    throw new JointError(
      `${screw} mm screws do not reach through ${through.panel.name}`,
    );
  if (intoFace(into) && reach >= into.panel.thickness)
    throw new JointError(`${screw} mm screws come out of ${into.panel.name}`);
  const head = diameter * 2;
  for (const x of positions) {
    const onJoint = through.origin.clone().addScaledVector(through.x, x);
    // The far face of the panel screwed through, and the way in from it.
    const outside = onJoint.clone().addScaledVector(through.z, -t);
    cuts.push({
      body: through.panel.id,
      kind: "drill",
      recipe: bore(outside, through.z, diameter + 0.5, t),
      diameter: diameter + 0.5,
      depth: t,
    });
    cuts.push({
      body: through.panel.id,
      kind: "countersink",
      recipe: {
        kind: "transform",
        matrix: new Matrix4()
          .makeTranslation(outside.x, outside.y, outside.z)
          .multiply(turnedTo(through.z))
          .toArray(),
        source: { kind: "cone", diameter: head, length: head / 2 },
      },
      diameter: head,
      depth: head / 2,
    });
    const pilot = diameter * 0.7;
    cuts.push({
      body: into.panel.id,
      kind: kindFor(into),
      recipe: bore(onJoint, into.z.clone().negate(), pilot, reach),
      diameter: pilot,
      depth: reach,
    });
  }
  return {
    grow: [],
    cuts,
    hardware: [{ kind: "screw", size: `${diameter}x${screw}`, count }],
  };
}

// ---------------------------------------------------------------- housings, miter, half-lap

function housing(
  kind: "dado" | "rabbet",
  c: Extract<Contact, { kind: "butt" }>,
  p: JointParameters,
): JointPlan {
  const depth = p.depth ?? Math.round((c.receiving.thickness / 2) * 10) / 10;
  if (!(depth > 0 && depth < c.receiving.thickness))
    throw new JointError(
      `The depth must be between 0 and ${c.receiving.thickness} mm`,
    );
  const clearance = p.clearance ?? 0;
  const box = reachInto(c, depth);
  const slot = box.clone();
  const m = c.meeting.m;
  slot.min.setComponent(m, lo(box, m) - clearance / 2);
  slot.max.setComponent(m, hi(box, m) + clearance / 2);
  return {
    grow: [{ body: c.entering.id, box }],
    cuts: [
      {
        body: c.receiving.id,
        kind,
        recipe: boxRecipe(slot),
        depth,
      },
    ],
    hardware: [],
  };
}

function miter(c: Extract<Contact, { kind: "butt" }>): JointPlan {
  if (!c.corner)
    throw new JointError("A miter needs panels meeting at a corner");
  const { n, r, m, toward, rFrom, rTo } = c.meeting;
  const reach = reachInto(c, c.receiving.thickness);
  // The corner square both panels now fill, in the (n, m) plane.
  const inner = { n: c.meeting.plane, m: 0 };
  const outer = { n: 0, m: 0 };
  outer.n = toward > 0 ? hi(c.receiving.box, n) : lo(c.receiving.box, n);
  // Along m the corner runs from the receiving panel's body to its end.
  const eFrom = lo(c.entering.box, m);
  const eTo = hi(c.entering.box, m);
  const atLow = Math.abs(eFrom - lo(c.receiving.box, m)) <= eps;
  outer.m = atLow ? eFrom : eTo;
  inner.m = atLow ? eTo : eFrom;
  // The entering panel keeps the triangle on its side of the diagonal from
  // the inner to the outer corner, the receiving panel the other one.
  const triangle = (points: { n: number; m: number }[]): Recipe => {
    const world = (q: { n: number; m: number }, rr: number) =>
      new Vector3()
        .setComponent(n, q.n)
        .setComponent(m, q.m)
        .setComponent(r, rr);
    // Local x along n, y along m, z along r (flipped when that is
    // left-handed, so the prism is not turned inside out).
    const zDir = unit(n).cross(unit(m));
    const along = zDir.getComponent(r);
    const start = along > 0 ? rFrom : rTo;
    const matrix = new Matrix4().makeBasis(unit(n), unit(m), zDir);
    matrix.setPosition(world({ n: 0, m: 0 }, start));
    return {
      kind: "transform",
      matrix: matrix.toArray(),
      source: {
        kind: "extrude",
        points: points.map((q) => ({ x: q.n, y: q.m })),
        height: rTo - rFrom,
      },
    };
  };
  const cornerE = { n: inner.n, m: outer.m };
  const cornerR = { n: outer.n, m: inner.m };
  return {
    grow: [{ body: c.entering.id, box: reach }],
    cuts: [
      {
        body: c.entering.id,
        kind: "miter",
        recipe: triangle([inner, cornerR, outer]),
      },
      {
        body: c.receiving.id,
        kind: "miter",
        recipe: triangle([inner, cornerE, outer]),
      },
    ],
    hardware: [],
  };
}

function halfLap(
  c: Extract<Contact, { kind: "overlap" }>,
  p: JointParameters,
): JointPlan {
  const clearance = p.clearance ?? 0;
  const a = c.first;
  const b = c.second;
  const r = (3 - a.normalAxis - b.normalAxis) as Axis;
  const shared = a.box.clone().intersect(b.box);
  const middle = (lo(shared, r) + hi(shared, r)) / 2;
  // Each panel is slotted half-way: the first from above, the second from
  // below, each slot as wide as the other panel is thick.
  const slot = (panel: Panel, other: Panel, upper: boolean) => {
    const box = shared.clone();
    const across = other.normalAxis;
    box.min.setComponent(across, lo(other.box, across) - clearance / 2);
    box.max.setComponent(across, hi(other.box, across) + clearance / 2);
    if (upper) box.min.setComponent(r, middle);
    else box.max.setComponent(r, middle);
    // Right out of the panel's edge on that side.
    if (upper) box.max.setComponent(r, hi(panel.box, r));
    else box.min.setComponent(r, lo(panel.box, r));
    return box;
  };
  return {
    grow: [],
    cuts: [
      { body: a.id, kind: "cut", recipe: boxRecipe(slot(a, b, true)) },
      { body: b.id, kind: "cut", recipe: boxRecipe(slot(b, a, false)) },
    ],
    hardware: [],
  };
}
