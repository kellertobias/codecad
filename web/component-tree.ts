export interface TreeComponent {
  path: string;
  parent?: string;
}

/** Open the root and its direct assembly branches so nested components are discoverable. */
export function initiallyExpandedPaths(
  components: readonly TreeComponent[],
): string[] {
  const roots = new Set(
    components
      .filter((component) => !component.parent)
      .map((component) => component.path),
  );
  const parents = new Set(
    components
      .map((component) => component.parent)
      .filter((path): path is string => !!path),
  );
  return components
    .filter(
      (component) =>
        parents.has(component.path) &&
        (roots.has(component.path) || roots.has(component.parent ?? "")),
    )
    .map((component) => component.path);
}

export interface HardwareTreeComponent extends TreeComponent {
  id: string;
  label: string;
  type: string;
  inspection: {
    kind: "part" | "assembly";
    volume: number;
    mass?: number;
    massPartial?: boolean;
    partCount: number;
    operations: unknown[];
  };
}
export const HARDWARE_GROUP = "HardwareGroup";
/** Folds the hardware parts under one parent (connectors, fittings: any
 * `HardwarePart`) into a single collapsed branch when there are two or
 * more, so a dozen dominoes do not bury the panels they join. The branch
 * carries their summed volume and weight. */
export function groupHardware<T extends HardwareTreeComponent>(
  components: readonly T[],
): (T | HardwareTreeComponent)[] {
  const byParent = new Map<string, T[]>();
  for (const c of components)
    if (c.type === "HardwarePart" && c.parent)
      byParent.set(c.parent, [...(byParent.get(c.parent) ?? []), c]);
  const out: (T | HardwareTreeComponent)[] = [];
  const grouped = new Map<string, string>();
  for (const [parent, parts] of byParent) {
    if (parts.length < 2) continue;
    const path = parent + "/#hardware";
    for (const part of parts) grouped.set(part.path, path);
    const weighed = parts.filter((p) => p.inspection.mass !== undefined);
    out.push({
      path,
      parent,
      id: "Hardware",
      label: `${parts.length} hardware parts`,
      type: HARDWARE_GROUP,
      inspection: {
        kind: "assembly",
        volume: parts.reduce((sum, p) => sum + p.inspection.volume, 0),
        ...(weighed.length
          ? {
              mass: weighed.reduce((sum, p) => sum + p.inspection.mass!, 0),
            }
          : {}),
        ...(weighed.length && weighed.length < parts.length
          ? { massPartial: true }
          : {}),
        partCount: parts.length,
        operations: [],
      },
    });
  }
  // The branch takes the place of its first hardware part, so the tree keeps
  // its order; the parts themselves move under the branch.
  const result: (T | HardwareTreeComponent)[] = [];
  const placed = new Set<string>();
  for (const c of components) {
    const group = grouped.get(c.path);
    if (group && !placed.has(group)) {
      placed.add(group);
      result.push(out.find((g) => g.path === group)!);
    }
    result.push(group ? { ...c, parent: group } : c);
  }
  return result;
}
