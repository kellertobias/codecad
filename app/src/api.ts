// The editor's view of the server's project API (src/projects-api.ts).

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
