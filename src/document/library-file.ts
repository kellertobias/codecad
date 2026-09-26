// A library item as one file: its name, tags and thumbnail, and every
// version (the document, and which variables an instance may set). Parts
// made from imported hardware will carry their STEP files in `files`,
// base64-encoded, keyed by the path the document names them by.
import { readDocument, type CadDocument } from "./schema.js";

export const libraryFileFormat = "codecad-library-item";

export interface LibraryVersionData {
  readonly version: number;
  readonly createdAt: string;
  readonly note?: string;
  readonly document: CadDocument;
  readonly exposed: readonly string[];
}

export interface LibraryFile {
  readonly format: typeof libraryFileFormat;
  readonly formatVersion: 1;
  readonly item: {
    readonly name: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly thumbnail?: string;
  };
  readonly versions: readonly LibraryVersionData[];
  readonly files: Readonly<Record<string, string>>;
}

export class LibraryError extends Error {}

/** Checks what a library version holds: a valid document without library
 * items of its own, and exposed names that are its variables. */
export function checkVersion(
  document: unknown,
  exposed: unknown,
): { document: CadDocument; exposed: string[] } {
  let checked: CadDocument;
  try {
    checked = readDocument(document);
  } catch (error) {
    throw new LibraryError(
      `The item's document is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (checked.features.some((f) => f.type === "instance"))
    throw new LibraryError("A library item cannot contain library items yet");
  if (!Array.isArray(exposed) || exposed.some((n) => typeof n !== "string"))
    throw new LibraryError("exposed must list variable names");
  const names = new Set(checked.variables.map((v) => v.name));
  const unknown = (exposed as string[]).filter((n) => !names.has(n));
  if (unknown.length)
    throw new LibraryError(`The item has no variable ${unknown.join(", ")}`);
  return { document: checked, exposed: [...new Set(exposed as string[])] };
}

/** Reads a library file, checking every version. */
export function readLibraryFile(value: unknown): LibraryFile {
  const file = value as Partial<LibraryFile> | null;
  if (!file || typeof file !== "object" || file.format !== libraryFileFormat)
    throw new LibraryError("This is not a CodeCAD library item file");
  if (file.formatVersion !== 1)
    throw new LibraryError(
      `Library files of format version ${String(file.formatVersion)} are not supported`,
    );
  const item = file.item;
  if (!item || typeof item.name !== "string" || !item.name.trim())
    throw new LibraryError("The file names no item");
  if (!Array.isArray(file.versions) || !file.versions.length)
    throw new LibraryError("The file has no versions");
  const versions = file.versions.map((v, i) => {
    if (!Number.isInteger(v?.version) || v.version < 1)
      throw new LibraryError(`Version ${i + 1} has no version number`);
    return {
      version: v.version,
      createdAt:
        typeof v.createdAt === "string"
          ? v.createdAt
          : new Date().toISOString(),
      ...(typeof v.note === "string" ? { note: v.note } : {}),
      ...checkVersion(v.document, v.exposed),
    };
  });
  return {
    format: libraryFileFormat,
    formatVersion: 1,
    item: {
      name: item.name.trim(),
      ...(typeof item.description === "string"
        ? { description: item.description }
        : {}),
      tags: Array.isArray(item.tags)
        ? item.tags.filter((t): t is string => typeof t === "string")
        : [],
      ...(typeof item.thumbnail === "string"
        ? { thumbnail: item.thumbnail }
        : {}),
    },
    versions: versions.sort((a, c) => a.version - c.version),
    files:
      file.files && typeof file.files === "object" ? { ...file.files } : {},
  };
}
