// What a project keeps of the library: a copy of each item version its
// instances use. Inserting pins the version; only `updateInstance` moves an
// instance to another version, so a project builds the same until then.
import type { LibraryVersionData } from "./library-file.js";
import type { CadDocument, InstanceFeature } from "./schema.js";
import { insertFeature, newFeatureId } from "./features.js";

export interface LibraryItemRef {
  readonly id: string;
  readonly name: string;
}

/** The document with a copy of the item version, unless it has one, and
 * with the item's materials it lacks. */
export function pinItem(
  document: CadDocument,
  item: LibraryItemRef,
  version: LibraryVersionData,
): CadDocument {
  const pinned = document.library ?? [];
  const has = pinned.some(
    (p) => p.item === item.id && p.version === version.version,
  );
  const materials = document.materials ?? [];
  const added = (version.document.materials ?? []).filter(
    (m) => !materials.some((own) => own.id === m.id),
  );
  return {
    ...document,
    ...(added.length ? { materials: [...materials, ...added] } : {}),
    library: has
      ? pinned
      : [
          ...pinned,
          {
            item: item.id,
            version: version.version,
            name: item.name,
            document: version.document,
            exposed: version.exposed,
          },
        ],
  };
}

/** Places an instance of the item, after the feature at `after`. */
export function insertInstance(
  document: CadDocument,
  item: LibraryItemRef,
  version: LibraryVersionData,
  after?: number,
): { document: CadDocument; id: string } {
  const pinned = pinItem(document, item, version);
  const id = newFeatureId(pinned, "instance");
  const feature: InstanceFeature = {
    id,
    type: "instance",
    name: nextUnique(pinned, item.name),
    item: item.id,
    version: version.version,
  };
  return { document: insertFeature(pinned, feature, after), id };
}

function nextUnique(document: CadDocument, base: string): string {
  const names = new Set(document.features.map((f) => f.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Moves one instance to another version of its item. Values for
 * variables the new version no longer exposes are dropped. */
export function updateInstance(
  document: CadDocument,
  instance: string,
  item: LibraryItemRef,
  version: LibraryVersionData,
): CadDocument {
  const pinned = pinItem(document, item, version);
  return prunePinned({
    ...pinned,
    features: pinned.features.map((f) => {
      if (f.id !== instance || f.type !== "instance") return f;
      const values = Object.fromEntries(
        Object.entries(f.values ?? {}).filter(([name]) =>
          version.exposed.includes(name),
        ),
      );
      const { values: _old, ...rest } = f;
      return {
        ...rest,
        version: version.version,
        ...(Object.keys(values).length ? { values } : {}),
      };
    }),
  });
}

/** Drops copies of item versions no instance uses any more. */
export function prunePinned(document: CadDocument): CadDocument {
  if (!document.library) return document;
  const used = new Set(
    document.features.flatMap((f) =>
      f.type === "instance" ? [`${f.item}\0${f.version}`] : [],
    ),
  );
  const library = document.library.filter((p) =>
    used.has(`${p.item}\0${p.version}`),
  );
  return library.length === document.library.length
    ? document
    : { ...document, library };
}

/** Instances with a newer version of their item in the library. */
export function updatesAvailable(
  document: CadDocument,
  latest: ReadonlyMap<string, number>,
): Map<string, number> {
  const updates = new Map<string, number>();
  for (const f of document.features)
    if (f.type === "instance") {
      const newest = latest.get(f.item);
      if (newest !== undefined && newest > f.version) updates.set(f.id, newest);
    }
  return updates;
}
