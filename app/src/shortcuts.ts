// Every keyboard shortcut of the editor in one place: the handlers match
// events against it, buttons show it in their tooltips, and the overview
// (press ?) lists it.

export interface KeySpec {
  /** `event.key`, compared without case for letters. */
  readonly key: string;
  /** Matched on `event.code` instead, for keys Alt changes the meaning of
   * (Alt+1 types ¡ on a Mac). */
  readonly code?: string;
  /** Ctrl, or ⌘ on a Mac. */
  readonly mod?: boolean;
  /** Must Shift be held; "any" for keys typed with Shift such as ?. */
  readonly shift?: boolean | "any";
  readonly alt?: boolean;
}

export type ShortcutGroup =
  "General" | "Model" | "View" | "Sketch" | "Sketch constraints" | "Layouts";

export interface Shortcut {
  readonly label: string;
  readonly group: ShortcutGroup;
  readonly keys: readonly KeySpec[];
}

const k = (key: string, extra: Omit<KeySpec, "key"> = {}): KeySpec => ({
  key,
  ...extra,
});

export const shortcuts = {
  save: { label: "Save", group: "General", keys: [k("s", { mod: true })] },
  undo: { label: "Undo", group: "General", keys: [k("z", { mod: true })] },
  redo: {
    label: "Redo",
    group: "General",
    keys: [k("z", { mod: true, shift: true }), k("y", { mod: true })],
  },
  help: {
    label: "Keyboard shortcuts",
    group: "General",
    keys: [k("?", { shift: "any" })],
  },
  cancel: {
    label: "Cancel picking, measuring or a joint",
    group: "General",
    keys: [k("Escape")],
  },
  areaModel: {
    label: "Show the model",
    group: "General",
    keys: [k("1", { alt: true, code: "Digit1" })],
  },
  areaDrawings: {
    label: "Show drawings",
    group: "General",
    keys: [k("2", { alt: true, code: "Digit2" })],
  },
  areaLayouts: {
    label: "Show stock & layouts",
    group: "General",
    keys: [k("3", { alt: true, code: "Digit3" })],
  },
  areaLibrary: {
    label: "Show the library",
    group: "General",
    keys: [k("4", { alt: true, code: "Digit4" })],
  },

  sketch: { label: "Sketch", group: "Model", keys: [k("s")] },
  extrude: { label: "Extrude", group: "Model", keys: [k("e")] },
  hole: { label: "Hole", group: "Model", keys: [k("h")] },
  fillet: { label: "Fillet", group: "Model", keys: [k("f")] },
  chamfer: { label: "Chamfer", group: "Model", keys: [k("c")] },
  shell: { label: "Shell", group: "Model", keys: [k("l")] },
  pattern: { label: "Pattern", group: "Model", keys: [k("p")] },
  mirror: { label: "Mirror", group: "Model", keys: [k("m", { shift: true })] },
  joint: { label: "Joint", group: "Model", keys: [k("j")] },
  mate: { label: "Mate", group: "Model", keys: [k("m")] },
  move: { label: "Move", group: "Model", keys: [k("g")] },
  measure: { label: "Measure", group: "Model", keys: [k("d")] },
  previousFeature: {
    label: "Select the previous feature",
    group: "Model",
    keys: [k("ArrowUp")],
  },
  nextFeature: {
    label: "Select the next feature",
    group: "Model",
    keys: [k("ArrowDown")],
  },
  editFeature: {
    label: "Edit the selected sketch",
    group: "Model",
    keys: [k("Enter")],
  },
  deleteFeature: {
    label: "Delete the selected feature",
    group: "Model",
    keys: [k("Delete"), k("Backspace")],
  },
  suppressFeature: {
    label: "Suppress or unsuppress the selected feature",
    group: "Model",
    keys: [k("s", { shift: true })],
  },
  rollbackUp: {
    label: "Move the rollback bar up",
    group: "Model",
    keys: [k("[")],
  },
  rollbackDown: {
    label: "Move the rollback bar down",
    group: "Model",
    keys: [k("]")],
  },
  variables: { label: "Variables panel", group: "Model", keys: [k("v")] },
  parts: { label: "Parts panel", group: "Model", keys: [k("b")] },

  viewFit: { label: "Fit the model", group: "View", keys: [k("0"), k("Home")] },
  viewFront: { label: "Front view", group: "View", keys: [k("1")] },
  viewTop: { label: "Top view", group: "View", keys: [k("2")] },
  viewRight: { label: "Right view", group: "View", keys: [k("3")] },

  sketchSelect: { label: "Select", group: "Sketch", keys: [k("Escape")] },
  sketchLine: { label: "Line", group: "Sketch", keys: [k("l")] },
  sketchRectangle: { label: "Rectangle", group: "Sketch", keys: [k("r")] },
  sketchCircle: { label: "Circle", group: "Sketch", keys: [k("c")] },
  sketchArc: { label: "Arc", group: "Sketch", keys: [k("a")] },
  sketchSlot: { label: "Slot", group: "Sketch", keys: [k("s")] },
  sketchTrim: { label: "Trim", group: "Sketch", keys: [k("t")] },
  sketchConstruction: {
    label: "Construction geometry on or off",
    group: "Sketch",
    keys: [k("x")],
  },
  sketchOffset: {
    label: "Offset the selection",
    group: "Sketch",
    keys: [k("o", { shift: true })],
  },
  sketchDelete: {
    label: "Delete the selection",
    group: "Sketch",
    keys: [k("Delete"), k("Backspace")],
  },
  sketchFit: { label: "Fit the sketch", group: "Sketch", keys: [k("f")] },
  closeSketch: {
    label: "Close the sketch",
    group: "Sketch",
    keys: [k("Enter", { mod: true })],
  },

  constrainHorizontal: {
    label: "Horizontal",
    group: "Sketch constraints",
    keys: [k("h")],
  },
  constrainVertical: {
    label: "Vertical",
    group: "Sketch constraints",
    keys: [k("v")],
  },
  constrainParallel: {
    label: "Parallel",
    group: "Sketch constraints",
    keys: [k("p")],
  },
  constrainPerpendicular: {
    label: "Perpendicular",
    group: "Sketch constraints",
    keys: [k("n")],
  },
  constrainEqual: {
    label: "Equal",
    group: "Sketch constraints",
    keys: [k("e")],
  },
  constrainTangent: {
    label: "Tangent",
    group: "Sketch constraints",
    keys: [k("g")],
  },
  constrainCoincident: {
    label: "Coincident",
    group: "Sketch constraints",
    keys: [k("i")],
  },
  constrainOn: {
    label: "Point on curve",
    group: "Sketch constraints",
    keys: [k("o")],
  },
  constrainMidpoint: {
    label: "Midpoint",
    group: "Sketch constraints",
    keys: [k("m")],
  },
  constrainSymmetric: {
    label: "Symmetric",
    group: "Sketch constraints",
    keys: [k("y")],
  },
  constrainFix: {
    label: "Fix",
    group: "Sketch constraints",
    keys: [k("k")],
  },
  dimension: {
    label: "Distance or diameter",
    group: "Sketch constraints",
    keys: [k("d")],
  },
  dimensionRadius: {
    label: "Radius",
    group: "Sketch constraints",
    keys: [k("d", { shift: true })],
  },
  dimensionHorizontal: {
    label: "Horizontal distance",
    group: "Sketch constraints",
    keys: [k("h", { shift: true })],
  },
  dimensionVertical: {
    label: "Vertical distance",
    group: "Sketch constraints",
    keys: [k("v", { shift: true })],
  },

  layoutRotateLeft: {
    label: "Turn the selected part 90° counter-clockwise",
    group: "Layouts",
    keys: [k("r")],
  },
  layoutRotateRight: {
    label: "Turn the selected part 90° clockwise",
    group: "Layouts",
    keys: [k("r", { shift: true })],
  },
  layoutFlip: {
    label: "Flip the selected part",
    group: "Layouts",
    keys: [k("f")],
  },
  layoutNudge: {
    label: "Move the selected part 1 mm (with Shift 10 mm)",
    group: "Layouts",
    keys: [
      k("ArrowLeft", { shift: "any" }),
      k("ArrowRight", { shift: "any" }),
      k("ArrowUp", { shift: "any" }),
      k("ArrowDown", { shift: "any" }),
    ],
  },
  layoutRemove: {
    label: "Take the selected part off the stock",
    group: "Layouts",
    keys: [k("Delete"), k("Backspace")],
  },
  layoutNext: {
    label: "Select the next placed part",
    group: "Layouts",
    keys: [k("]")],
  },
  layoutPrevious: {
    label: "Select the previous placed part",
    group: "Layouts",
    keys: [k("[")],
  },
  layoutNest: {
    label: "Auto-nest the layout",
    group: "Layouts",
    keys: [k("n")],
  },
} satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof shortcuts;

/** The shortcut offered for each sketch constraint or dimension, by the
 * label the sketch editor gives it. */
export const constraintShortcuts: Readonly<Record<string, ShortcutId>> = {
  Horizontal: "constrainHorizontal",
  Vertical: "constrainVertical",
  Parallel: "constrainParallel",
  Perpendicular: "constrainPerpendicular",
  Equal: "constrainEqual",
  Tangent: "constrainTangent",
  Coincident: "constrainCoincident",
  On: "constrainOn",
  Midpoint: "constrainMidpoint",
  Symmetric: "constrainSymmetric",
  Fix: "constrainFix",
  Distance: "dimension",
  Diameter: "dimension",
  Radius: "dimensionRadius",
  "Horizontal distance": "dimensionHorizontal",
  "Vertical distance": "dimensionVertical",
};

const mac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function matchesKey(event: KeyEventLike, spec: KeySpec): boolean {
  if (
    spec.code
      ? event.code !== spec.code
      : event.key.toLowerCase() !== spec.key.toLowerCase()
  )
    return false;
  if (!!spec.mod !== (event.metaKey || event.ctrlKey)) return false;
  if (!!spec.alt !== event.altKey) return false;
  return spec.shift === "any" || !!spec.shift === event.shiftKey;
}

export const matches = (event: KeyEventLike, id: ShortcutId) =>
  shortcuts[id].keys.some((spec) => matchesKey(event, spec));

const names: Record<string, string> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Delete: "Del",
  Backspace: "⌫",
  Enter: "↵",
  Home: "Home",
};

export function keyLabel(spec: KeySpec): string {
  const key = names[spec.key] ?? spec.key.toUpperCase();
  const parts = [
    ...(spec.mod ? [mac ? "⌘" : "Ctrl"] : []),
    ...(spec.alt ? [mac ? "⌥" : "Alt"] : []),
    ...(spec.shift === true ? [mac ? "⇧" : "Shift"] : []),
    key,
  ];
  return parts.join(mac ? "" : "+");
}

/** The first key of a shortcut, as a tooltip shows it. */
export const hint = (id: ShortcutId) => keyLabel(shortcuts[id].keys[0]!);

/** A tooltip: what the button does and its key. */
export const tip = (id: ShortcutId, label: string = shortcuts[id].label) =>
  `${label} (${hint(id)})`;

/** Whether keys typed now belong to a field rather than to shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !("tagName" in element)) return false;
  return (
    element.isContentEditable ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    (element.tagName === "INPUT" &&
      !["checkbox", "radio", "button", "range"].includes(
        (element as HTMLInputElement).type,
      ))
  );
}
