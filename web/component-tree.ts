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
