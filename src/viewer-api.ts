// What the mobile viewer reads, prebuilt after every save so a phone never
// waits on the kernel:
//
//   GET  /api/projects/:id/viewer              the latest revision's manifest
//                                              (built first if it is not yet)
//   GET  /api/projects/:id/viewer/:rev/:file   a file the manifest names
//   GET  /api/projects/:id/progress/:rev       copies ticked off as cut
//   POST /api/projects/:id/progress/:rev       { changes: [{ key, done }] }
//
// and the same, read-only, through a view link, without an account:
//
//   GET  /api/shared/:token/viewer[/:rev/:file]
//   GET  /api/shared/:token/progress/:rev
//
// Built revisions live on disk under <storage>/viewer/<id>/<revision>; the
// newest few of each project are kept. Builds run as bounded kernel jobs,
// one at a time per owner.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { JobQueue } from "./jobs.js";
import type { Project, Workspace } from "./workspace.js";
import { ProjectNotFound } from "./workspace.js";
import type { CutProgress } from "./cut-progress.js";
import type { CodeResultStore } from "./code-results.js";
import type { Shares } from "./shares.js";
import { BadRequest, readJson } from "./projects-api.js";
import { readDocument } from "./document/schema.js";
import type { ViewerManifest } from "./document/viewer.js";
import { viewerJob, type KernelJobLimits } from "./kernel-jobs.js";
import { JobsBusy, ownerLane } from "./jobs.js";

const keep = 3;
const types: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
};

/** What one owner's projects are kept in. */
export interface OwnerStores {
  readonly workspace: Workspace;
  readonly progress: CutProgress;
  readonly codeResults?: CodeResultStore;
}

export interface ViewerService {
  /** Builds the project's latest revision for the viewer, unless it is
   * built already; joins a build that is under way. */
  build(owner: string, id: string): Promise<ViewerManifest>;
  /** Forgets built revisions that were missing a code part's result, so
   * they are built again with it. */
  refreshRegenerated(): Promise<void>;
  /** The owner's routes, under /api/projects/:id. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    who: { readonly owner: string; readonly trusted: () => boolean },
  ): Promise<boolean>;
  /** A view link's routes, under /api/shared/:token. */
  handleShared(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean>;
}

export function viewerService(options: {
  readonly directory: string;
  readonly jobs: JobQueue;
  readonly stores: (owner: string) => OwnerStores;
  readonly shares?: Shares;
  readonly limits?: KernelJobLimits;
}): ViewerService {
  const { directory, jobs, stores, shares, limits } = options;
  const folder = (id: string, revision: number) =>
    join(directory, id, String(revision));
  const built = async (id: string, revision: number) => {
    try {
      return JSON.parse(
        await readFile(join(folder(id, revision), "manifest.json"), "utf8"),
      ) as ViewerManifest;
    } catch {
      return undefined;
    }
  };
  const make = (owner: string, project: Project) =>
    jobs.run({
      key: `viewer\0${project.id}\0${project.revision}`,
      lane: ownerLane(owner),
      label: `${project.name}: viewer files`,
      work: async (report) => {
        const existing = await built(project.id, project.revision);
        if (existing) return existing;
        const document = readDocument(project.document);
        const results =
          (await stores(owner).codeResults?.results(document)) ?? [];
        const bundle = await viewerJob(
          document,
          project,
          results,
          (fraction, message) => report({ fraction, message }),
          limits,
        );
        // Written beside the target and renamed into place, so a reader
        // never sees half a revision.
        const target = folder(project.id, project.revision);
        const staging = `${target}.part-${process.pid}-${Date.now()}`;
        await mkdir(staging, { recursive: true });
        for (const [name, file] of bundle.files)
          await writeFile(join(staging, name), file.bytes);
        await writeFile(
          join(staging, "manifest.json"),
          JSON.stringify(bundle.manifest),
        );
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
        await prune(project.id);
        return bundle.manifest;
      },
    });
  const prune = async (id: string) => {
    const revisions = (await readdir(join(directory, id)))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => b - a);
    for (const old of revisions.slice(keep))
      await rm(folder(id, old), { recursive: true, force: true });
  };

  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const sendFile = async (
    res: ServerResponse,
    id: string,
    rev: string,
    file: string,
  ) => {
    let data: Buffer;
    try {
      data = await readFile(join(folder(id, Number(rev)), file));
    } catch {
      json(res, { error: "There is no such file" }, 404);
      return;
    }
    res.writeHead(200, {
      "Content-Type":
        types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "Content-Length": data.byteLength,
      // A revision never changes once built.
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(data);
  };
  /** Errors every route answers the same way. */
  const guarded = async (res: ServerResponse, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof ProjectNotFound)
        json(res, { error: "There is no such project" }, 404);
      else if (error instanceof BadRequest)
        json(res, { error: error.message }, 400);
      else if (error instanceof JobsBusy)
        json(res, { error: error.message }, 429);
      else throw error;
    }
  };
  const route = (base: string, path: string) =>
    new RegExp(
      `^${base}\\/(viewer|progress)(?:\\/(\\d+)(?:\\/([a-z0-9-]+\\.[a-z]+))?)?$`,
    ).exec(path);

  const service: ViewerService = {
    async build(owner, id) {
      const project = stores(owner).workspace.get(id);
      return (await built(id, project.revision)) ?? make(owner, project);
    },
    async refreshRegenerated() {
      const projects = await readdir(directory).catch(() => [] as string[]);
      for (const id of projects) {
        const revisions = await readdir(join(directory, id)).catch(
          () => [] as string[],
        );
        for (const revision of revisions.filter((r) => /^\d+$/.test(r))) {
          const manifest = await built(id, Number(revision));
          if (manifest?.needsRegeneration)
            await rm(folder(id, Number(revision)), {
              recursive: true,
              force: true,
            });
        }
      }
    },
    async handle(req, res, url, { owner, trusted }) {
      const match = route("\\/api\\/projects\\/([0-9a-f-]{36})", url.pathname);
      if (!match) return false;
      const [, id, what, rev, file] = match as unknown as [
        string,
        string,
        "viewer" | "progress",
        string | undefined,
        string | undefined,
      ];
      const { workspace, progress } = stores(owner);
      const method = req.method ?? "GET";
      await guarded(res, async () => {
        if (what === "viewer" && !rev && method === "GET")
          json(res, await service.build(owner, id));
        else if (what === "viewer" && rev && file && method === "GET") {
          workspace.get(id);
          await sendFile(res, id, rev, file);
        } else if (what === "progress" && rev && !file && method === "GET") {
          workspace.get(id);
          json(res, {
            revision: Number(rev),
            done: progress.get(id, Number(rev)),
          });
        } else if (what === "progress" && rev && !file && method === "POST") {
          if (!trusted()) {
            json(res, { error: "Invalid editor session" }, 403);
            return;
          }
          workspace.get(id);
          const body = await readJson(req);
          const changes = body.changes;
          if (
            !Array.isArray(changes) ||
            changes.length > 5000 ||
            changes.some(
              (c) =>
                !c ||
                typeof c.key !== "string" ||
                c.key.length > 300 ||
                typeof c.done !== "boolean",
            )
          )
            throw new BadRequest("changes must list { key, done } entries");
          json(res, {
            revision: Number(rev),
            done: progress.change(id, Number(rev), changes),
          });
        } else res.writeHead(405).end();
      });
      return true;
    },
    async handleShared(req, res, url) {
      const match = route(
        "\\/api\\/shared\\/([A-Za-z0-9_-]{1,64})",
        url.pathname,
      );
      if (!match) return false;
      const [, token, what, rev, file] = match as unknown as [
        string,
        string,
        "viewer" | "progress",
        string | undefined,
        string | undefined,
      ];
      const link = shares?.resolve(token);
      if (!link) {
        json(res, { error: "This view link does not exist" }, 404);
        return true;
      }
      if ((req.method ?? "GET") !== "GET") {
        // View links are read-only.
        res.writeHead(405, { Allow: "GET" }).end();
        return true;
      }
      const { workspace, progress } = stores(link.owner);
      await guarded(res, async () => {
        if (what === "viewer" && !rev)
          json(res, await service.build(link.owner, link.project));
        else if (what === "viewer" && rev && file) {
          workspace.get(link.project);
          await sendFile(res, link.project, rev, file);
        } else if (what === "progress" && rev && !file)
          json(res, {
            revision: Number(rev),
            done: progress.get(link.project, Number(rev)),
          });
        else res.writeHead(404).end();
      });
      return true;
    },
  };
  return service;
}
