// User accounts with passkeys, and sign-in sessions. Stored beside the
// projects in the workspace database. Only used when the server runs with
// accounts (CODECAD_ACCOUNTS=1); otherwise everything belongs to "local".
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  fromBase64url,
  toBase64url,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn.js";

export interface User {
  readonly id: string;
  readonly name: string;
}

/** Where passkeys are used: the site's host name and full origin. */
export interface RelyingParty {
  readonly id: string;
  readonly origin: string;
  readonly name: string;
}

export class AccountError extends Error {}

const challengeLifetime = 5 * 60_000;
export const sessionLifetime = 30 * 24 * 60 * 60_000;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export interface Accounts {
  /** Options for navigator.credentials.create: a new account called
   * `name`, or another passkey for `user`. */
  registrationOptions(
    rp: RelyingParty,
    request: { name: string } | { user: User },
  ): Record<string, unknown>;
  /** Stores the passkey; returns its user and a new session token. */
  register(
    rp: RelyingParty,
    credential: unknown,
  ): { user: User; session: string };
  /** Options for navigator.credentials.get (any of the site's passkeys). */
  loginOptions(rp: RelyingParty): Record<string, unknown>;
  login(rp: RelyingParty, credential: unknown): { user: User; session: string };
  /** The user a session token belongs to, while it is valid. */
  session(token: string | undefined): User | undefined;
  logout(token: string | undefined): void;
  close(): void;
}

export function openAccounts(file: string): Accounts {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  const q = {
    userByName: db.prepare(`SELECT id, name FROM users WHERE name = ?`),
    userById: db.prepare(`SELECT id, name FROM users WHERE id = ?`),
    addUser: db.prepare(
      `INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)`,
    ),
    addPasskey: db.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    passkey: db.prepare(
      `SELECT id, user_id, public_key, sign_count FROM passkeys WHERE id = ?`,
    ),
    count: db.prepare(`UPDATE passkeys SET sign_count = ? WHERE id = ?`),
    addSession: db.prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
    ),
    session: db.prepare(
      `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ),
    endSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    expired: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),
  };

  /** Challenges handed out and not used yet, by their base64url. */
  const challenges = new Map<
    string,
    {
      readonly kind: "register" | "login";
      readonly expires: number;
      readonly name?: string;
      readonly user?: User;
      readonly userId?: string;
    }
  >();
  const issue = (
    value: Omit<Parameters<typeof challenges.set>[1], "expires">,
  ) => {
    const now = Date.now();
    for (const [key, c] of challenges)
      if (c.expires < now) challenges.delete(key);
    if (challenges.size > 10_000)
      throw new AccountError("Too many sign-ins at once");
    const challenge = toBase64url(randomBytes(32));
    challenges.set(challenge, { ...value, expires: now + challengeLifetime });
    return challenge;
  };
  /** The challenge a response answers, used up. */
  const take = (credential: unknown, kind: "register" | "login") => {
    const raw = (credential as { response?: { clientDataJSON?: unknown } })
      ?.response?.clientDataJSON;
    let challenge: unknown;
    try {
      challenge = JSON.parse(
        fromBase64url(raw, "clientDataJSON").toString("utf8"),
      ).challenge;
    } catch {
      throw new AccountError("The passkey response cannot be read");
    }
    const found =
      typeof challenge === "string" ? challenges.get(challenge) : undefined;
    if (!found || found.kind !== kind || found.expires < Date.now())
      throw new AccountError("The sign-in expired; try again");
    challenges.delete(challenge as string);
    return { challenge: challenge as string, ...found };
  };
  const startSession = (user: User) => {
    q.expired.run(Date.now());
    const token = toBase64url(randomBytes(32));
    q.addSession.run(hashToken(token), user.id, Date.now() + sessionLifetime);
    return token;
  };
  const wrap = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof WebAuthnError) throw new AccountError(error.message);
      throw error;
    }
  };

  return {
    registrationOptions(rp, request) {
      let user: User | undefined;
      let name: string;
      if ("user" in request) {
        user = request.user;
        name = user.name;
      } else {
        name = request.name.trim();
        if (!/^[\p{L}\p{N}][\p{L}\p{N} ._@-]{0,63}$/u.test(name))
          throw new AccountError(
            "A name is 1 to 64 letters, digits, spaces or . _ @ -",
          );
        if (q.userByName.get(name)) throw new AccountError(`${name} is taken`);
      }
      const userId = user?.id ?? randomUUID();
      const challenge = issue({
        kind: "register",
        name,
        userId,
        ...(user ? { user } : {}),
      });
      return {
        challenge,
        rp: { id: rp.id, name: rp.name },
        user: {
          id: toBase64url(Buffer.from(userId)),
          name,
          displayName: name,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "preferred",
        },
        attestation: "none",
        timeout: challengeLifetime,
      };
    },
    register(rp, credential) {
      const pending = take(credential, "register");
      const key = wrap(() =>
        verifyRegistration(credential, {
          challenge: pending.challenge,
          origin: rp.origin,
          rpId: rp.id,
        }),
      );
      if (q.passkey.get(key.id))
        throw new AccountError("This passkey is already registered");
      let user = pending.user;
      db.exec("BEGIN");
      try {
        if (!user) {
          if (q.userByName.get(pending.name!))
            throw new AccountError(`${pending.name} is taken`);
          user = { id: pending.userId!, name: pending.name! };
          q.addUser.run(user.id, user.name, new Date().toISOString());
        }
        q.addPasskey.run(
          key.id,
          user.id,
          JSON.stringify(key.publicKey),
          key.signCount,
          new Date().toISOString(),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { user, session: startSession(user) };
    },
    loginOptions(rp) {
      return {
        challenge: issue({ kind: "login" }),
        rpId: rp.id,
        allowCredentials: [],
        userVerification: "preferred",
        timeout: challengeLifetime,
      };
    },
    login(rp, credential) {
      const pending = take(credential, "login");
      const id = (credential as { id?: unknown })?.id;
      const stored =
        typeof id === "string"
          ? (q.passkey.get(id) as
              | {
                  id: string;
                  user_id: string;
                  public_key: string;
                  sign_count: number;
                }
              | undefined)
          : undefined;
      if (!stored) throw new AccountError("This passkey is not known here");
      const signCount = wrap(() =>
        verifyAuthentication(credential, {
          challenge: pending.challenge,
          origin: rp.origin,
          rpId: rp.id,
          publicKey: JSON.parse(stored.public_key) as JsonWebKey,
          signCount: stored.sign_count,
        }),
      );
      q.count.run(signCount, stored.id);
      const user = q.userById.get(stored.user_id) as unknown as User;
      return {
        user: { id: user.id, name: user.name },
        session: startSession(user),
      };
    },
    session(token) {
      if (!token) return undefined;
      const row = q.session.get(hashToken(token), Date.now()) as
        User | undefined;
      return row ? { id: row.id, name: row.name } : undefined;
    },
    logout(token) {
      if (token) q.endSession.run(hashToken(token));
    },
    close: () => db.close(),
  };
}
