// Feature-list edits the editor makes: adding a feature where the rollback
// bar is, moving one without putting it before something it uses, and
// finding what a feature depends on.
import type {
  CadDocument,
  EdgeReference,
  FaceReference,
  Feature,
  FeatureType,
} from "./schema.js";

/** The feature that made a body, from its id: `<feature>:<n>` for a body
 * an extrude made, `<pattern>#<copy>:<original body id>` for a copy. */
export function bodyFeature(body: string): string {
  const head = body.split(":")[0]!;
  return head.split("#")[0]!;
}

const faceFeatures = (ref: FaceReference) => [
  bodyFeature(ref.body),
  ref.origin.split("#")[0]!,
];
const edgeFeatures = (ref: EdgeReference) => [
  ...faceFeatures(ref.a),
  ...faceFeatures(ref.b),
];

/** Ids of the features this one uses: its sketch, the features and bodies
 * it repeats, and the features that made the faces it refers to. */
export function dependencies(feature: Feature): Set<string> {
  const used: string[] = [];
  switch (feature.type) {
    case "sketch":
      if (feature.face) used.push(...faceFeatures(feature.face));
      break;
    case "extrude":
      used.push(feature.sketch);
      if (feature.upTo) used.push(...faceFeatures(feature.upTo));
      used.push(...(feature.targets ?? []).map(bodyFeature));
      break;
    case "fillet":
    case "chamfer":
      used.push(...feature.edges.flatMap(edgeFeatures));
      break;
    case "shell":
      used.push(...feature.faces.flatMap(faceFeatures));
      break;
    case "hole":
      used.push(feature.sketch, ...(feature.targets ?? []).map(bodyFeature));
      break;
    case "pattern":
    case "mirror":
      used.push(
        ...(feature.features ?? []),
        ...(feature.bodies ?? []).map(bodyFeature),
      );
      break;
  }
  return new Set(used.filter((id) => id !== feature.id));
}

/** Why the feature cannot move to `index`, or undefined when it can: it
 * must stay after everything it uses and before everything that uses it. */
export function whyNotMove(
  document: CadDocument,
  id: string,
  index: number,
): string | undefined {
  const from = document.features.findIndex((f) => f.id === id);
  if (from < 0) return "There is no such feature";
  const feature = document.features[from]!;
  const order = document.features.filter((f) => f.id !== id);
  const at = Math.max(0, Math.min(index, order.length));
  const before = new Set(order.slice(0, at).map((f) => f.id));
  const known = new Set(order.map((f) => f.id));
  for (const used of dependencies(feature))
    if (known.has(used) && !before.has(used))
      return `${feature.name} uses ${nameOf(document, used)}, which would come after it`;
  for (const later of order.slice(0, at))
    if (dependencies(later).has(id))
      return `${later.name} uses ${feature.name}, which would come after it`;
  return undefined;
}

const nameOf = (document: CadDocument, id: string) =>
  document.features.find((f) => f.id === id)?.name ?? id;

/** The document with the feature moved to `index` (counted without it). */
export function moveFeature(
  document: CadDocument,
  id: string,
  index: number,
): CadDocument {
  const feature = document.features.find((f) => f.id === id);
  if (!feature) return document;
  const order = document.features.filter((f) => f.id !== id);
  const at = Math.max(0, Math.min(index, order.length));
  return {
    ...document,
    features: [...order.slice(0, at), feature, ...order.slice(at)],
  };
}

/** The document with a feature added after the one at `after` (at the end
 * when left out). */
export function insertFeature(
  document: CadDocument,
  feature: Feature,
  after?: number,
): CadDocument {
  const at =
    after === undefined ? document.features.length : Math.max(0, after + 1);
  return {
    ...document,
    features: [
      ...document.features.slice(0, at),
      feature,
      ...document.features.slice(at),
    ],
  };
}

const labels: Record<FeatureType, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  fillet: "Fillet",
  chamfer: "Chamfer",
  shell: "Shell",
  hole: "Hole",
  pattern: "Pattern",
  mirror: "Mirror",
};

export const featureLabel = (type: FeatureType) => labels[type];

/** "Extrude 3": the type's name and the first unused number. */
export function nextName(document: CadDocument, type: FeatureType): string {
  const names = new Set(document.features.map((f) => f.name));
  let n = document.features.filter((f) => f.type === type).length + 1;
  while (names.has(`${labels[type]} ${n}`)) n++;
  return `${labels[type]} ${n}`;
}

/** A short random id, unused by the document's features. */
export function newFeatureId(document: CadDocument, type: FeatureType): string {
  for (;;) {
    const id = `${type.slice(0, 2)}${Math.random().toString(36).slice(2, 7)}`;
    if (!document.features.some((f) => f.id === id)) return id;
  }
}
