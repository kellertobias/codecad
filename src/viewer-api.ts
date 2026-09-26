// What the mobile viewer reads, prebuilt after every save so a phone never
// waits on the kernel:
//
//   GET  /api/projects/:id/viewer              the latest revision's manifest
//                                              (built first if it is not yet)
//   GET  /api/projects/:id/viewer/:rev/:file   a file the manifest names
//   GET  /api/projects/:id/progress/:rev       copies ticked off as cut
//   POST /api/projects/:id/progress/:rev       { changes: [{ key, done }] }
//
// Built revisions live on disk under <storage>/viewer/<id>/<revision>; the
// newest few of each project are kept.
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
import { BadRequest, readJson } from "./projects-api.js";
import { readDocument } from "./document/schema.js";
import type { ViewerManifest } from "./document/viewer.js";
import { viewerBundle } from "./kernel/viewer.js";

const keep = 3;
const types: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
};

export interface ViewerService {
  /** Builds the project's latest revision for the viewer, unless it is
   * built already; joins a build that is under way. */
  build(id: string): Promise<ViewerManifest>;
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    trusted: () => boolean,
  ): Promise<boolean>;
}

export function viewerService(options: {
  readonly directory: string;
  readonly workspace: Workspace;
  readonly jobs: JobQueue;
  readonly progress: CutProgress;
}): ViewerService {
  const { directory, workspace, jobs, progress } = options;
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
  const make = (project: Project) =>
    jobs.run({
      key: `viewer\0${project.id}\0${project.revision}`,
      lane: `viewer\0${project.id}`,
      label: `${project.name}: viewer files`,
      work: async (report) => {
        const existing = await built(project.id, project.revision);
        if (existing) return existing;
        const bundle = await viewerBundle(
          readDocument(project.document),
          project,
          (fraction, message) => report({ fraction, message }),
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

  const service: ViewerService = {
    async build(id) {
      const project = workspace.get(id);
      return (await built(id, project.revision)) ?? make(project);
    },
    async handle(req, res, url, trusted) {
      const match =
        /^\/api\/projects\/([0-9a-f-]{36})\/(viewer|progress)(?:\/(\d+)(?:\/([a-z0-9-]+\.[a-z]+))?)?$/.exec(
          url.pathname,
        );
      if (!match) return false;
      const [, id, what, rev, file] = match as unknown as [
        string,
        string,
        "viewer" | "progress",
        string | undefined,
        string | undefined,
      ];
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(value));
      };
      const method = req.method ?? "GET";
      try {
        if (what === "viewer" && !rev && method === "GET") {
          json(await service.build(id));
        } else if (what === "viewer" && rev && file && method === "GET") {
          let data: Buffer;
          try {
            data = await readFile(join(folder(id, Number(rev)), file));
          } catch {
            json({ error: "There is no such file" }, 404);
            return true;
          }
          res.writeHead(200, {
            "Content-Type":
              types[file.slice(file.lastIndexOf("."))] ??
              "application/octet-stream",
            "Content-Length": data.byteLength,
            // A revision never changes once built.
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(data);
        } else if (what === "progress" && rev && !file && method === "GET") {
          workspace.get(id);
          json({ revision: Number(rev), done: progress.get(id, Number(rev)) });
        } else if (what === "progress" && rev && !file && method === "POST") {
          if (!trusted()) {
            json({ error: "Invalid editor session" }, 403);
            return true;
          }
          workspace.get(id);
          const body = await readJson(req);
          const changes = body.changes;
          if (
            !Array.isArray(changes) ||
            changes.some(
              (c) =>
                !c ||
                typeof c.key !== "string" ||
                c.key.length > 300 ||
                typeof c.done !== "boolean",
            )
          )
            throw new BadRequest("changes must list { key, done } entries");
          json({
            revision: Number(rev),
            done: progress.change(id, Number(rev), changes),
          });
        } else {
          res.writeHead(405).end();
        }
      } catch (error) {
        if (error instanceof ProjectNotFound)
          json({ error: error.message }, 404);
        else if (error instanceof BadRequest)
          json({ error: error.message }, 400);
        else throw error;
      }
      return true;
    },
  };
  return service;
}
