import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HARDWARE_GROUP,
  groupHardware,
  initiallyExpandedPaths,
  type HardwareTreeComponent,
} from "../web/component-tree.js";

test("initial component tree exposes drawers and their nested rails", () => {
  assert.deepEqual(
    initiallyExpandedPaths([
      { path: "cabinet" },
      { path: "cabinet/drawer", parent: "cabinet" },
      { path: "cabinet/drawer/rail", parent: "cabinet/drawer" },
      { path: "cabinet/drawer/rail/inner", parent: "cabinet/drawer/rail" },
    ]),
    ["cabinet", "cabinet/drawer"],
  );
});

test("two or more hardware parts under one parent fold into a hardware branch", () => {
  const part = (
    path: string,
    type: string,
    mass?: number,
  ): HardwareTreeComponent => ({
    path,
    id: path.split("/").at(-1)!,
    label: path,
    type,
    ...(path.includes("/")
      ? { parent: path.split("/").slice(0, -1).join("/") }
      : {}),
    inspection: {
      kind: "part",
      volume: 10,
      ...(mass === undefined ? {} : { mass }),
      partCount: 1,
      operations: [],
    },
  });
  const tree = groupHardware([
    part("cab", "Project"),
    part("cab/left", "SheetPart"),
    part("cab/domino-1", "HardwarePart", 5),
    part("cab/domino-2", "HardwarePart"),
    part("cab/back", "SheetPart"),
    part("cab/drawer", "Assembly"),
    part("cab/drawer/screw", "HardwarePart"),
  ]);
  assert.deepEqual(
    tree.map((c) => [c.path, c.parent ?? null]),
    [
      ["cab", null],
      ["cab/left", "cab"],
      ["cab/#hardware", "cab"],
      ["cab/domino-1", "cab/#hardware"],
      ["cab/domino-2", "cab/#hardware"],
      ["cab/back", "cab"],
      ["cab/drawer", "cab"],
      // A lone fitting stays where it is.
      ["cab/drawer/screw", "cab/drawer"],
    ],
  );
  const branch = tree.find((c) => c.type === HARDWARE_GROUP)!;
  assert.equal(branch.label, "2 hardware parts");
  assert.deepEqual(branch.inspection, {
    kind: "assembly",
    volume: 20,
    mass: 5,
    massPartial: true,
    partCount: 2,
    operations: [],
  });
});
