// Everything a user keeps, opened per owner: projects, library, cut
// progress (all in the workspace database, rows by owner_id) and stored
// code-part results (a directory each, with a quota). Without accounts the
// only owner is "local".
import { join } from "node:path";
import { openWorkspace, type Workspace } from "./workspace.js";
import { openLibrary, type Library } from "./library.js";
import { openCutProgress, type CutProgress } from "./cut-progress.js";
import { openCodeResults, type CodeResultStore } from "./code-results.js";

export interface OwnedStores {
  readonly workspace: Workspace;
  readonly library: Library;
  readonly progress: CutProgress;
  readonly codeResults: CodeResultStore;
}

export function ownerStores(
  storage: string,
  options: { readonly resultQuotaBytes?: number } = {},
) {
  const database = join(storage, "workspace.sqlite");
  const open = new Map<string, OwnedStores>();
  return {
    get(owner: string): OwnedStores {
      let stores = open.get(owner);
      if (!stores) {
        if (owner !== "local" && !/^[0-9a-f-]{36}$/.test(owner))
          throw new Error(`Not an owner: ${owner}`);
        stores = {
          workspace: openWorkspace(database, owner),
          library: openLibrary(database, owner),
          progress: openCutProgress(database, owner),
          codeResults: openCodeResults(
            owner === "local"
              ? join(storage, "code-results")
              : join(storage, "code-results", "users", owner),
            // The local owner is the machine's own; users have a quota.
            owner === "local" || options.resultQuotaBytes === undefined
              ? {}
              : { quotaBytes: options.resultQuotaBytes },
          ),
        };
        open.set(owner, stores);
      }
      return stores;
    },
    async close() {
      for (const stores of open.values()) {
        stores.workspace.close();
        stores.library.close();
        stores.progress.close();
        await stores.codeResults.close();
      }
      open.clear();
    },
  };
}
