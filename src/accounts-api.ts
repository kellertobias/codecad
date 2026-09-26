// Signing up and in with passkeys (see accounts.ts):
//
//   GET  /api/auth/me                   { accounts, user? }
//   POST /api/auth/register/options     { name } (or none, signed in: add
//                                       a passkey to the account)
//   POST /api/auth/register             { credential }   → sets the cookie
//   POST /api/auth/login/options
//   POST /api/auth/login                { credential }   → sets the cookie
//   POST /api/auth/logout
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AccountError,
  sessionLifetime,
  type Accounts,
  type RelyingParty,
  type User,
} from "./accounts.js";
import { BadRequest, readJson } from "./projects-api.js";

export const sessionCookie = "codecad_session";

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/** The site passkeys are bound to: its host name and origin, as the
 * browser sees them (CODECAD_ORIGIN when behind a proxy). */
export function relyingParty(req: IncomingMessage): RelyingParty {
  const configured = process.env.CODECAD_ORIGIN;
  const origin =
    configured ??
    `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}`;
  return { id: new URL(origin).hostname, origin, name: "CodeCAD" };
}

export async function handleAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: {
    readonly accounts: Accounts | undefined;
    readonly user: User | undefined;
    readonly trusted: () => boolean;
  },
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/auth/")) return false;
  const { accounts, user, trusted } = context;
  const json = (value: unknown, status = 200, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(value));
  };
  const rp = relyingParty(req);
  const setCookie = (token: string) => ({
    "Set-Cookie": `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetime / 1000)}${rp.origin.startsWith("https:") ? "; Secure" : ""}`,
  });
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    json({ accounts: !!accounts, ...(user ? { user } : {}) });
    return true;
  }
  if (!accounts) {
    json({ error: "This server has no accounts" }, 404);
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return true;
  }
  if (!trusted()) {
    json({ error: "Invalid editor session" }, 403);
    return true;
  }
  try {
    const body = await readJson(req);
    switch (url.pathname) {
      case "/api/auth/register/options":
        json(
          accounts.registrationOptions(
            rp,
            user && body.name === undefined
              ? { user }
              : { name: String(body.name ?? "") },
          ),
        );
        break;
      case "/api/auth/register": {
        const made = accounts.register(rp, body.credential);
        json({ user: made.user }, 200, setCookie(made.session));
        break;
      }
      case "/api/auth/login/options":
        json(accounts.loginOptions(rp));
        break;
      case "/api/auth/login": {
        const signed = accounts.login(rp, body.credential);
        json({ user: signed.user }, 200, setCookie(signed.session));
        break;
      }
      case "/api/auth/logout":
        accounts.logout(cookie(req, sessionCookie));
        json({}, 200, {
          "Set-Cookie": `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        });
        break;
      default:
        json({ error: "No such route" }, 404);
    }
  } catch (error) {
    if (error instanceof AccountError || error instanceof BadRequest)
      json({ error: error.message }, 400);
    else throw error;
  }
  return true;
}
