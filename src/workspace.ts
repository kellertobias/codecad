// Projects edited in the browser, stored in SQLite. Every save appends a new
// revision instead of overwriting, so history and undo across sessions come
// for free, and a save based on an outdated revision is refused rather than
// silently dropping someone else's change.
//
// Every row carries an owner. Until there are user accounts that owner is
// always "local"; adding accounts means passing a real owner in, not
// changing what is stored.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  /** Increases by one with every save; a save must name the one it edits. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface Project extends ProjectSummary {
  readonly document: Record<string, unknown>;
}

/** A save named a revision other than the latest: someone saved in between. */
export class RevisionConflict extends Error {
  constructor(
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Project ${id} is at revision ${actual}, but the save was based on revision ${expected}`,
    );
  }
}
export class ProjectNotFound extends Error {
  constructor(readonly id: string) {
    super(`No project ${id}`);
  }
}

/** Largest document accepted, as serialized JSON. */
export const maxDocumentBytes = 8 * 2 ** 20;

export interface Workspace {
  list(): ProjectSummary[];
  create(name: string, document: Record<string, unknown>): Project;
  get(id: string): Project;
  /** Stores a new revision. `basedOn` is the revision the edit started from. */
  save(
    id: string,
    basedOn: number,
    change: { name?: string; document: Record<string, unknown> },
  ): Project;
  rename(id: string, basedOn: number, name: string): Project;
  delete(id: string): void;
  close(): void;
}

/** Opens (and creates, if needed) the workspace database for one owner.
 * Pass ":memory:" for a throwaway database. */
export function openWorkspace(file: string, owner = "local"): Workspace {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_by_owner
      ON projects (owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS project_revisions (
      project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      document TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, revision)
    );
  `);
  const statements = {
    list: db.prepare(
      `SELECT id, name, revision, created_at, updated_at FROM projects
       WHERE owner_id = ? ORDER BY updated_at DESC, name`,
    ),
    head: db.prepare(
      `SELECT id, name, revision, created_at, updated_at FROM projects
       WHERE owner_id = ? AND id = ?`,
    ),
    document: db.prepare(
      `SELECT document FROM project_revisions
       WHERE owner_id = ? AND project_id = ? AND revision = ?`,
    ),
    insertProject: db.prepare(
      `INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertRevision: db.prepare(
      `INSERT INTO project_revisions (project_id, revision, owner_id, document, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    // The revision in the WHERE clause makes the check and the update one
    // step: a concurrent save that got there first leaves nothing to update.
    advance: db.prepare(
      `UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?
       WHERE owner_id = ? AND id = ? AND revision = ?`,
    ),
    remove: db.prepare(`DELETE FROM projects WHERE owner_id = ? AND id = ?`),
  };

  type Row = {
    id: string;
    name: string;
    revision: number;
    created_at: string;
    updated_at: string;
  };
  const summary = (row: Row): ProjectSummary => ({
    id: row.id,
    name: row.name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const head = (id: string): Row => {
    const row = statements.head.get(owner, id) as Row | undefined;
    if (!row) throw new ProjectNotFound(id);
    return row;
  };
  const serialize = (document: Record<string, unknown>): string => {
    if (!document || typeof document !== "object" || Array.isArray(document))
      throw new TypeError("A project document must be a JSON object");
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text) > maxDocumentBytes)
      throw new RangeError(
        `A project document may be at most ${maxDocumentBytes / 2 ** 20} MB`,
      );
    return text;
  };
  const checkName = (name: string): string => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200)
      throw new RangeError("A project name must be 1 to 200 characters");
    return trimmed;
  };
  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const workspace: Workspace = {
    list: () => (statements.list.all(owner) as Row[]).map(summary),
    create(name, document) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const text = serialize(document);
      transaction(() => {
        statements.insertProject.run(id, owner, checkName(name), 1, now, now);
        statements.insertRevision.run(id, 1, owner, text, now);
      });
      return workspace.get(id);
    },
    get(id) {
      const row = head(id);
      const stored = statements.document.get(owner, id, row.revision) as
        { document: string } | undefined;
      if (!stored) throw new ProjectNotFound(id);
      return { ...summary(row), document: JSON.parse(stored.document) };
    },
    save(id, basedOn, change) {
      const text = serialize(change.document);
      transaction(() => {
        const row = head(id);
        const now = new Date().toISOString();
        const name =
          change.name === undefined ? row.name : checkName(change.name);
        const updated = statements.advance.run(name, now, owner, id, basedOn);
        if (Number(updated.changes) !== 1)
          throw new RevisionConflict(id, basedOn, row.revision);
        statements.insertRevision.run(id, basedOn + 1, owner, text, now);
      });
      return workspace.get(id);
    },
    rename(id, basedOn, name) {
      return workspace.save(id, basedOn, {
        name,
        document: workspace.get(id).document,
      });
    },
    delete(id) {
      head(id);
      statements.remove.run(owner, id);
    },
    close: () => db.close(),
  };
  return workspace;
}
