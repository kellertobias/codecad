// The editor's view of the server's project API (src/projects-api.ts).
import type { LibraryVersionData } from "../../src/document/library-file.ts";
import type { CodePart, CodeResult } from "../../src/document/code-part.ts";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: string;
}
export interface Project<Document> extends ProjectSummary {
  readonly document: Document;
}

/** Another save came first; `revision` is the one now stored. */
export class Conflict extends Error {
  constructor(readonly revision: number) {
    super("This project was changed elsewhere since it was opened");
  }
}

let token: Promise<string> | undefined;
const sessionToken = () =>
  (token ??= fetch("/api/session")
    .then((response) => response.json())
    .then((body: { token: string }) => body.token));

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(path, {
    method,
    headers: {
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "x-codecad-token": await sessionToken() }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 409)
    throw new Conflict(
      ((await response.json()) as { revision: number }).revision,
    );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      body.error ?? `${method} ${path} failed (${response.status})`,
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const projects = {
  list: () =>
    request<{ projects: ProjectSummary[] }>("/api/projects").then(
      (r) => r.projects,
    ),
  create: <D>(name: string, document: D) =>
    request<Project<D>>("/api/projects", {
      method: "POST",
      body: { name, document },
    }),
  get: <D>(id: string) => request<Project<D>>(`/api/projects/${id}`),
  save: <D>(id: string, basedOn: number, document: D) =>
    request<Project<D>>(`/api/projects/${id}`, {
      method: "PUT",
      body: { basedOn, document },
    }),
};

/** Where the server makes a file from the saved project. */
export const outputUrl = (
  project: string,
  kind: "drawing" | "layout" | "part" | "cutlist" | "bom",
  format: "svg" | "pdf" | "dxf" | "csv",
  target?: string,
) =>
  `/api/projects/${project}/outputs/${kind}?format=${format}${
    target ? `&target=${encodeURIComponent(target)}` : ""
  }`;

export interface LibraryItemSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly latest: number;
  readonly thumbnail?: string;
  readonly kind: "document" | "code";
  readonly updatedAt: string;
}
export type LibraryVersion = LibraryVersionData;

export const library = {
  list: () =>
    request<{ items: LibraryItemSummary[] }>("/api/library").then(
      (r) => r.items,
    ),
  create: <D>(body: {
    name: string;
    description?: string;
    tags?: readonly string[];
    document?: D;
    code?: CodePart;
    exposed: readonly string[];
    thumbnail?: string;
    note?: string;
  }) => request<LibraryItemSummary>("/api/library", { method: "POST", body }),
  addVersion: <D>(
    id: string,
    body: {
      document?: D;
      code?: CodePart;
      exposed: readonly string[];
      thumbnail?: string;
      note?: string;
    },
  ) =>
    request<LibraryItemSummary>(`/api/library/${id}/versions`, {
      method: "POST",
      body,
    }),
  version: (id: string, version: number) =>
    request<LibraryVersion>(`/api/library/${id}/versions/${version}`),
  remove: (id: string) =>
    request<void>(`/api/library/${id}`, { method: "DELETE" }),
  importFile: (file: unknown) =>
    request<LibraryItemSummary>("/api/library/import", {
      method: "POST",
      body: file,
    }),
  fileUrl: (id: string) => `/api/library/${id}/file`,
};

/** Stored results of code parts (src/code-results-api.ts). */
export const codeResults = {
  async get(key: string): Promise<CodeResult | undefined> {
    const response = await fetch(`/api/code-results/${key}`);
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        ((await response.json().catch(() => ({}))) as { error?: string })
          .error ?? `Loading a code result failed (${response.status})`,
      );
    return (await response.json()) as CodeResult;
  },
  put: (result: CodeResult, replace = false) =>
    request<{ key: string }>(
      `/api/code-results/${result.key}${replace ? "?replace" : ""}`,
      { method: "PUT", body: result },
    ),
};

// ---------------------------------------------------------------- accounts

export interface AccountState {
  /** Whether the server has accounts at all. */
  readonly accounts: boolean;
  readonly user?: { readonly id: string; readonly name: string };
}

const toB64 = (buffer: ArrayBuffer) => {
  let text = "";
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (text: string) => {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
};

/** A credential as JSON, with its binary parts in base64url. */
function credentialJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const parts: Record<string, string> = {
    clientDataJSON: toB64(response.clientDataJSON),
  };
  if ("attestationObject" in response && response.attestationObject)
    parts.attestationObject = toB64(response.attestationObject);
  if ("authenticatorData" in response && response.authenticatorData) {
    parts.authenticatorData = toB64(response.authenticatorData);
    parts.signature = toB64(response.signature);
    if (response.userHandle) parts.userHandle = toB64(response.userHandle);
  }
  return { id: credential.id, type: credential.type, response: parts };
}

export const account = {
  me: () => request<AccountState>("/api/auth/me"),
  /** Makes an account (or, signed in, adds a passkey to it). */
  async register(name?: string) {
    const options = await request<
      PublicKeyCredentialCreationOptions & {
        challenge: string;
        user: { id: string; name: string; displayName: string };
      }
    >("/api/auth/register/options", {
      method: "POST",
      body: name === undefined ? {} : { name },
    });
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: fromB64(options.challenge),
        user: { ...options.user, id: fromB64(options.user.id) },
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was made");
    return request<{ user: AccountState["user"] }>("/api/auth/register", {
      method: "POST",
      body: { credential: credentialJson(credential) },
    });
  },
  async login() {
    const options = await request<
      PublicKeyCredentialRequestOptions & { challenge: string }
    >("/api/auth/login/options", { method: "POST", body: {} });
    const credential = (await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: fromB64(options.challenge),
        allowCredentials: [],
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was chosen");
    return request<{ user: AccountState["user"] }>("/api/auth/login", {
      method: "POST",
      body: { credential: credentialJson(credential) },
    });
  },
  logout: () => request<void>("/api/auth/logout", { method: "POST", body: {} }),
};

// ---------------------------------------------------------------- view links

export interface ViewLink {
  readonly token: string;
  readonly path: string;
  readonly createdAt: string;
}

export const viewLinks = {
  list: (project: string) =>
    request<{ shares: ViewLink[] }>(`/api/projects/${project}/shares`).then(
      (r) => r.shares,
    ),
  create: (project: string) =>
    request<ViewLink>(`/api/projects/${project}/shares`, {
      method: "POST",
      body: {},
    }),
  revoke: (token: string) =>
    request<void>(`/api/shares/${token}`, { method: "DELETE" }),
};
