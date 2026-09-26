// Code parts in the editor: the code runs in this browser only, a runaway
// loop is stopped without freezing the page, and what a part makes is
// stored so the server's outputs can use it without running anything.
import { test, expect, type Page } from "@playwright/test";
import { SketchSolver } from "../src/document/sketch-solver.js";
import {
  extrude,
  rectangle,
  solvedDocument,
} from "../tests/support/documents.js";
import { plateSource } from "../tests/support/code.js";

test.use({
  viewport: { width: 1400, height: 900 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

let project = "";

test.beforeAll(async ({ request, baseURL }) => {
  const { token } = (await (await request.get("/api/session")).json()) as {
    token: string;
  };
  const solver = await SketchSolver.create();
  const document = solvedDocument(solver, {}, [
    rectangle("d", "XY", "0", "0", "400", "600"),
    extrude("door", "d", { name: "Door" }),
  ]);
  solver.dispose();
  const created = await request.post("/api/projects", {
    headers: { "x-codecad-token": token, origin: baseURL! },
    data: { name: "Door with code", document },
  });
  expect(created.status()).toBe(201);
  project = ((await created.json()) as { id: string }).id;
});

async function write(page: Page, source: string) {
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(source);
}

test("a code part is written, run, saved and inserted; a loop is stopped", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/app/");
  await page.getByRole("button", { name: /Door with code/ }).click();
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: "Code part" }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });

  // A loop that never ends: stopped after 10 s, and the page answers all
  // the while.
  await write(
    page,
    "export default { parameters: {}, build() { while (true) {} } };",
  );
  await page.getByRole("button", { name: "Run" }).click();
  await page.waitForTimeout(1000);
  const lag = await page.evaluate(async () => {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return performance.now() - started;
  });
  expect(lag).toBeLessThan(500);
  const name = page.getByRole("textbox", { name: "Code part name" });
  await name.fill("Plate");
  await expect(name).toHaveValue("Plate");
  await expect(page.locator(".code-problem")).toContainText(
    "stopped after 10 s",
    { timeout: 15_000 },
  );
  await expect(page.locator("iframe[sandbox]")).toHaveCount(0);

  // The sandbox has no network: the editor's API is out of reach.
  await write(
    page,
    `export default { parameters: {}, build() { fetch("/api/projects"); return { bodies: [] }; } };`,
  );
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".code-problem")).toContainText("fetch");

  // A real part: previewed, then saved with its parameters.
  await write(page, plateSource);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".code-preview")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".code-part-side")).toContainText("1 interface");
  await expect(page.locator(".code-part-side")).toContainText("Width");
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(page.getByText("Saved Plate to the library.")).toBeVisible({
    timeout: 20_000,
  });

  // Inserted, it uses the result stored when it was saved.
  const card = page.locator(".item-grid li", { hasText: "Plate" });
  await expect(card).toContainText("code part");
  await card.getByRole("button", { name: "Insert" }).click();
  await expect(page.locator(".code-status")).toContainText(
    "using its stored result",
    { timeout: 20_000 },
  );
  await expect(page.locator(".model-status")).toContainText("2 bodies");

  // A new width: the code runs again here, and the result is stored.
  const width = page
    .locator(".inspector label", { hasText: "Width" })
    .locator("input");
  await width.fill("120");
  await width.press("Enter");
  await expect(page.locator(".code-status")).toContainText(
    "made here just now",
    {
      timeout: 20_000,
    },
  );

  // Saved, the server builds its outputs from the stored result.
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText(/Saved revision 2/)).toBeVisible();
  const bom = await page.request.get(
    `/api/projects/${project}/outputs/bom?format=csv`,
  );
  expect(bom.status()).toBe(200);
  expect(await bom.text()).toContain("Plate · Plate");
});
