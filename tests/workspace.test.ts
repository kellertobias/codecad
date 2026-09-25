import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWorkspace,
  ProjectNotFound,
  RevisionConflict,
} from "../src/workspace.js";

const document = (width: number) => ({
  schemaVersion: 1,
  variables: { width },
});

test("a created project can be listed and loaded", () => {
  const workspace = openWorkspace(":memory:");
  const created = workspace.create("Shelf", document(600));
  assert.equal(created.revision, 1);
  assert.deepEqual(
    workspace.list().map((p) => p.name),
    ["Shelf"],
  );
  assert.deepEqual(workspace.get(created.id).document, document(600));
  workspace.close();
});

test("every save adds a revision and a stale save is refused", () => {
  const workspace = openWorkspace(":memory:");
  const { id } = workspace.create("Shelf", document(600));
  const saved = workspace.save(id, 1, { document: document(800) });
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.document, document(800));
  // A second editor still working from revision 1 must not overwrite it.
  assert.throws(
    () => workspace.save(id, 1, { document: document(400) }),
    (error) =>
      error instanceof RevisionConflict &&
      error.expected === 1 &&
      error.actual === 2,
  );
  assert.deepEqual(workspace.get(id).document, document(800));
  workspace.close();
});

test("renaming keeps the document and advances the revision", () => {
  const workspace = openWorkspace(":memory:");
  const { id } = workspace.create("Shelf", document(600));
  const renamed = workspace.rename(id, 1, "  Tall shelf ");
  assert.equal(renamed.name, "Tall shelf");
  assert.equal(renamed.revision, 2);
  assert.deepEqual(renamed.document, document(600));
  workspace.close();
});

test("owners only see their own projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-workspace-"));
  try {
    const file = join(directory, "workspace.sqlite");
    const local = openWorkspace(file);
    const other = openWorkspace(file, "someone-else");
    const { id } = local.create("Mine", document(1));
    assert.deepEqual(other.list(), []);
    assert.throws(() => other.get(id), ProjectNotFound);
    assert.throws(() => other.delete(id), ProjectNotFound);
    assert.equal(local.list().length, 1);
    local.close();
    other.close();
    // The data outlives the connection.
    const reopened = openWorkspace(file);
    assert.equal(reopened.get(id).name, "Mine");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("documents must be JSON objects and names must not be blank", () => {
  const workspace = openWorkspace(":memory:");
  assert.throws(
    () => workspace.create("List", [] as unknown as Record<string, unknown>),
    TypeError,
  );
  assert.throws(() => workspace.create("   ", document(1)), RangeError);
  assert.deepEqual(workspace.list(), []);
  workspace.close();
});

test("deleting a project removes it and its history", () => {
  const workspace = openWorkspace(":memory:");
  const { id } = workspace.create("Shelf", document(600));
  workspace.save(id, 1, { document: document(700) });
  workspace.delete(id);
  assert.deepEqual(workspace.list(), []);
  assert.throws(() => workspace.get(id), ProjectNotFound);
  workspace.close();
});
