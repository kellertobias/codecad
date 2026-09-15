import { test } from "node:test";
import assert from "node:assert/strict";
import { IsolationSession } from "../web/isolation.js";

test("second eye click restores the original visibility and view snapshot", () => {
  const session = new IsolationSession<{
    visible: boolean[];
    center: number[];
  }>();
  const before = { visible: [true, false, true], center: [10, 20, 30] };
  assert.equal(
    session.toggle("drawer", () => before),
    undefined,
  );
  assert.equal(session.path, "drawer");
  assert.equal(
    session.toggle("drawer", () => {
      throw new Error("Must not capture isolated view");
    }),
    before,
  );
  assert.equal(session.path, "");
});
test("switching targets retains the pre-isolation snapshot, while a new session captures afresh", () => {
  const session = new IsolationSession<number>();
  session.toggle("drawer", () => 1);
  session.toggle("rail", () => 2);
  assert.equal(
    session.toggle("rail", () => 3),
    1,
  );
  session.toggle("handle", () => 4);
  assert.equal(session.restore(), 4);
  assert.equal(session.restore(), undefined);
});
