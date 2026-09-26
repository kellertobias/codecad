// Which copies of a project's parts have been cut, per saved revision: a
// workshop ticks them off on a phone. A new revision starts unticked,
// because the parts may have changed.
import { DatabaseSync } from "node:sqlite";

export interface CutProgress {
  get(project: string, revision: number): string[];
  /** Ticks or unticks copies; returns what is ticked afterwards. */
  change(
    project: string,
    revision: number,
    changes: readonly { readonly key: string; readonly done: boolean }[],
  ): string[];
  close(): void;
}

export function openCutProgress(file: string, owner = "local"): CutProgress {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cut_progress (
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      part_key TEXT NOT NULL,
      done_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, project_id, revision, part_key)
    );
  `);
  const q = {
    list: db.prepare(
      `SELECT part_key FROM cut_progress
       WHERE owner_id = ? AND project_id = ? AND revision = ? ORDER BY part_key`,
    ),
    tick: db.prepare(
      `INSERT OR IGNORE INTO cut_progress (owner_id, project_id, revision, part_key, done_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    untick: db.prepare(
      `DELETE FROM cut_progress
       WHERE owner_id = ? AND project_id = ? AND revision = ? AND part_key = ?`,
    ),
  };
  const progress: CutProgress = {
    get: (project, revision) =>
      (q.list.all(owner, project, revision) as { part_key: string }[]).map(
        (row) => row.part_key,
      ),
    change(project, revision, changes) {
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        for (const { key, done } of changes)
          if (done) q.tick.run(owner, project, revision, key, now);
          else q.untick.run(owner, project, revision, key);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return progress.get(project, revision);
    },
    close: () => db.close(),
  };
  return progress;
}
