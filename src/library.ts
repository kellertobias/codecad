// The personal part library, stored beside the projects in the workspace
// database. An item keeps every version it was saved as; projects pin one
// (they keep a copy of it) and move to a newer one only when asked.
//
// Rows carry an owner like projects do, so each user will have their own
// library once there are accounts.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  checkVersion,
  libraryFileFormat,
  LibraryError,
  readLibraryFile,
  type LibraryFile,
  type LibraryVersionData,
} from "./document/library-file.js";
import { contentKey } from "./document/code-part.js";

export interface LibraryItemSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly latest: number;
  readonly thumbnail?: string;
  /** Whether the latest version is a code part. */
  readonly kind: "document" | "code";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LibraryItem extends LibraryItemSummary {
  readonly versions: readonly {
    readonly version: number;
    readonly createdAt: string;
    readonly note?: string;
  }[];
}

export class LibraryItemNotFound extends Error {
  constructor(readonly id: string) {
    super(`No library item ${id}`);
  }
}

export interface NewVersion {
  /** A document, or `code` for a code part. */
  readonly document?: unknown;
  readonly code?: unknown;
  readonly exposed: unknown;
  readonly note?: string;
  readonly thumbnail?: string;
}

export interface Library {
  list(): LibraryItemSummary[];
  get(id: string): LibraryItem;
  version(id: string, version: number): LibraryVersionData;
  create(
    details: { name: string; description?: string; tags?: readonly string[] },
    first: NewVersion,
  ): LibraryItem;
  addVersion(id: string, next: NewVersion): LibraryItem;
  update(
    id: string,
    details: { name?: string; description?: string; tags?: readonly string[] },
  ): LibraryItem;
  delete(id: string): void;
  exportFile(id: string): LibraryFile;
  importFile(value: unknown): LibraryItem;
  close(): void;
}

const maxThumbnail = 512 * 1024;

export function openLibrary(file: string, owner = "local"): Library {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS library_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      thumbnail TEXT,
      latest INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS library_by_owner
      ON library_items (owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS library_versions (
      item_id TEXT NOT NULL REFERENCES library_items (id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      document TEXT NOT NULL,
      exposed TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, version)
    );
  `);
  // Code parts keep their code beside (instead of) a document.
  const columns = db.prepare(`PRAGMA table_info(library_versions)`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === "code"))
    db.exec(`ALTER TABLE library_versions ADD COLUMN code TEXT`);
  type Row = {
    id: string;
    name: string;
    description: string;
    tags: string;
    thumbnail: string | null;
    latest: number;
    created_at: string;
    updated_at: string;
    latest_kind?: string | null;
  };
  const summary = (row: Row): LibraryItemSummary => ({
    id: row.id,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    latest: row.latest,
    ...(row.thumbnail ? { thumbnail: row.thumbnail } : {}),
    kind: row.latest_kind === "code" ? "code" : "document",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const q = {
    list: db.prepare(
      `SELECT i.*, CASE WHEN v.code IS NULL THEN 'document' ELSE 'code' END AS latest_kind
       FROM library_items i JOIN library_versions v ON v.item_id = i.id AND v.version = i.latest
       WHERE i.owner_id = ? ORDER BY i.updated_at DESC, i.name`,
    ),
    item: db.prepare(
      `SELECT i.*, CASE WHEN v.code IS NULL THEN 'document' ELSE 'code' END AS latest_kind
       FROM library_items i JOIN library_versions v ON v.item_id = i.id AND v.version = i.latest
       WHERE i.owner_id = ? AND i.id = ?`,
    ),
    versions: db.prepare(
      `SELECT version, created_at, note FROM library_versions
       WHERE owner_id = ? AND item_id = ? ORDER BY version`,
    ),
    version: db.prepare(
      `SELECT * FROM library_versions WHERE owner_id = ? AND item_id = ? AND version = ?`,
    ),
    insertItem: db.prepare(
      `INSERT INTO library_items (id, owner_id, name, description, tags, thumbnail, latest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertVersion: db.prepare(
      `INSERT INTO library_versions (item_id, version, owner_id, document, exposed, note, created_at, code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    advance: db.prepare(
      `UPDATE library_items SET latest = ?, updated_at = ?, thumbnail = COALESCE(?, thumbnail)
       WHERE owner_id = ? AND id = ?`,
    ),
    details: db.prepare(
      `UPDATE library_items SET name = ?, description = ?, tags = ?, updated_at = ?
       WHERE owner_id = ? AND id = ?`,
    ),
    remove: db.prepare(
      `DELETE FROM library_items WHERE owner_id = ? AND id = ?`,
    ),
  };
  const row = (id: string): Row => {
    const found = q.item.get(owner, id) as Row | undefined;
    if (!found) throw new LibraryItemNotFound(id);
    return found;
  };
  const name = (value: unknown) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > 200)
      throw new LibraryError("An item's name must be 1 to 200 characters");
    return text;
  };
  const tags = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  const thumbnail = (value: unknown) => {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length > maxThumbnail)
      throw new LibraryError("The thumbnail must be an SVG of at most 512 kB");
    return value;
  };
  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const library: Library = {
    list: () => (q.list.all(owner) as Row[]).map(summary),
    get(id) {
      const versions = q.versions.all(owner, id) as {
        version: number;
        created_at: string;
        note: string | null;
      }[];
      return {
        ...summary(row(id)),
        versions: versions.map((v) => ({
          version: v.version,
          createdAt: v.created_at,
          ...(v.note ? { note: v.note } : {}),
        })),
      };
    },
    version(id, version) {
      row(id);
      const found = q.version.get(owner, id, version) as
        | {
            version: number;
            document: string;
            exposed: string;
            note: string | null;
            created_at: string;
            code: string | null;
          }
        | undefined;
      if (!found) throw new LibraryItemNotFound(`${id} version ${version}`);
      return {
        version: found.version,
        createdAt: found.created_at,
        ...(found.note ? { note: found.note } : {}),
        ...(found.code
          ? { code: JSON.parse(found.code) }
          : { document: JSON.parse(found.document) }),
        exposed: JSON.parse(found.exposed),
      };
    },
    create(details, first) {
      const checked = checkVersion(first.document, first.exposed, first.code);
      const id = randomUUID();
      const now = new Date().toISOString();
      transaction(() => {
        q.insertItem.run(
          id,
          owner,
          name(details.name),
          details.description ?? "",
          JSON.stringify(tags(details.tags)),
          thumbnail(first.thumbnail),
          1,
          now,
          now,
        );
        q.insertVersion.run(
          id,
          1,
          owner,
          JSON.stringify(checked.document ?? null),
          JSON.stringify(checked.exposed),
          first.note ?? null,
          now,
          checked.code ? JSON.stringify(checked.code) : null,
        );
      });
      return library.get(id);
    },
    addVersion(id, next) {
      const checked = checkVersion(next.document, next.exposed, next.code);
      const version = row(id).latest + 1;
      const now = new Date().toISOString();
      transaction(() => {
        q.insertVersion.run(
          id,
          version,
          owner,
          JSON.stringify(checked.document ?? null),
          JSON.stringify(checked.exposed),
          next.note ?? null,
          now,
          checked.code ? JSON.stringify(checked.code) : null,
        );
        q.advance.run(version, now, thumbnail(next.thumbnail), owner, id);
      });
      return library.get(id);
    },
    update(id, details) {
      const current = row(id);
      q.details.run(
        details.name === undefined ? current.name : name(details.name),
        details.description ?? current.description,
        JSON.stringify(
          details.tags ? tags(details.tags) : JSON.parse(current.tags),
        ),
        new Date().toISOString(),
        owner,
        id,
      );
      return library.get(id);
    },
    delete(id) {
      row(id);
      q.remove.run(owner, id);
    },
    exportFile(id) {
      const item = library.get(id);
      // Code parts' files go into the file's `files` once each, by content.
      const files: Record<string, string> = {};
      const versions = item.versions.map((v) => {
        const version = library.version(id, v.version);
        if (!version.code?.files) return version;
        return {
          ...version,
          code: {
            ...version.code,
            files: Object.fromEntries(
              Object.entries(version.code.files).map(([name, data]) => {
                const key = contentKey(data);
                files[key] = data;
                return [name, `@${key}`];
              }),
            ),
          },
        };
      });
      return {
        format: libraryFileFormat,
        formatVersion: 1,
        item: {
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          tags: item.tags,
          ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
        },
        versions,
        files,
      };
    },
    importFile(value) {
      const file = readLibraryFile(value);
      const id = randomUUID();
      const now = new Date().toISOString();
      const latest = file.versions.at(-1)!.version;
      transaction(() => {
        q.insertItem.run(
          id,
          owner,
          file.item.name,
          file.item.description ?? "",
          JSON.stringify(file.item.tags),
          thumbnail(file.item.thumbnail),
          latest,
          now,
          now,
        );
        for (const v of file.versions)
          q.insertVersion.run(
            id,
            v.version,
            owner,
            JSON.stringify(v.document ?? null),
            JSON.stringify(v.exposed),
            v.note ?? null,
            v.createdAt,
            v.code ? JSON.stringify(v.code) : null,
          );
      });
      return library.get(id);
    },
    close: () => db.close(),
  };
  return library;
}
