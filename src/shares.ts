// View links: anyone with a link's token sees one project in the phone
// viewer, read-only, without an account. The owner makes and revokes them.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export interface Share {
  readonly token: string;
  readonly project: string;
  readonly createdAt: string;
}

export interface Shares {
  create(owner: string, project: string): Share;
  list(owner: string, project: string): Share[];
  revoke(owner: string, token: string): boolean;
  /** Whose project a link shows, while it is not revoked. */
  resolve(token: string): { owner: string; project: string } | undefined;
  close(): void;
}

/** Links per project, so a mistake cannot fill the table. */
const maxLinks = 20;

export function openShares(file: string): Shares {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shares_by_project ON shares (owner_id, project_id);
  `);
  const q = {
    add: db.prepare(
      `INSERT INTO shares (token, owner_id, project_id, created_at) VALUES (?, ?, ?, ?)`,
    ),
    list: db.prepare(
      `SELECT token, project_id, created_at FROM shares
       WHERE owner_id = ? AND project_id = ? ORDER BY created_at`,
    ),
    remove: db.prepare(`DELETE FROM shares WHERE owner_id = ? AND token = ?`),
    resolve: db.prepare(
      `SELECT owner_id, project_id FROM shares WHERE token = ?`,
    ),
  };
  type Row = { token: string; project_id: string; created_at: string };
  const share = (row: Row): Share => ({
    token: row.token,
    project: row.project_id,
    createdAt: row.created_at,
  });
  const shares: Shares = {
    create(owner, project) {
      if (shares.list(owner, project).length >= maxLinks)
        throw new RangeError(
          `A project can have at most ${maxLinks} view links`,
        );
      const token = randomBytes(24).toString("base64url");
      const createdAt = new Date().toISOString();
      q.add.run(token, owner, project, createdAt);
      return { token, project, createdAt };
    },
    list: (owner, project) => (q.list.all(owner, project) as Row[]).map(share),
    revoke: (owner, token) => q.remove.run(owner, token).changes > 0,
    resolve(token) {
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
      const row = q.resolve.get(token) as
        { owner_id: string; project_id: string } | undefined;
      return row ? { owner: row.owner_id, project: row.project_id } : undefined;
    },
    close: () => db.close(),
  };
  return shares;
}
