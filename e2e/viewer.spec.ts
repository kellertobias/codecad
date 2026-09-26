// The mobile viewer at phone width: it loads quickly, never scrolls
// sideways, ticks parts off as cut on the server, and keeps working
// without a network once it has been opened.
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { shop } from "../tests/support/documents.js";

let project = "";

async function createProject(request: APIRequestContext, base: string) {
  const { token } = (await (await request.get("/api/session")).json()) as {
    token: string;
  };
  const solver = await SketchSolver.create();
  const document = shop(solver);
  solver.dispose();
  const created = await request.post("/api/projects", {
    headers: { "x-codecad-token": token, origin: base },
    data: { name: "Workshop shelf", document },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  // Saving started the prebuild; asking waits for it.
  const manifest = await request.get(`/api/projects/${id}/viewer`);
  expect(manifest.ok()).toBe(true);
  return id;
}

const noSideways = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test.beforeAll(async ({ request, baseURL }) => {
  project = await createProject(request, baseURL!);
});

test("the viewer is interactive quickly and fits 375 px", async ({ page }) => {
  // A first visit, with the processor slowed down like a phone's.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`/p/${project}/view`);
  await expect(page.getByText("Workshop shelf")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cut list" })).toBeEnabled();
  const ms = await page.evaluate(
    () => performance.getEntriesByName("viewer-interactive")[0]!.startTime,
  );
  console.log(`Viewer interactive after ${Math.round(ms)} ms (CPU ×4 slower)`);
  expect(ms).toBeLessThan(2000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  for (const tab of ["Model", "Drawings", "Cut list", "Layouts"]) {
    await page.getByRole("button", { name: tab, exact: true }).tap();
    await page.waitForTimeout(300);
    expect(await noSideways(page), `${tab} scrolls sideways`).toBe(true);
  }
});

test("the model loads and a tapped part is picked", async ({ page }) => {
  await page.goto(`/p/${project}/view`);
  await page.getByRole("button", { name: "Model", exact: true }).tap();
  await expect(page.getByText("Loading the model")).toHaveCount(0, {
    timeout: 15_000,
  });
  const canvas = page.locator(".model-view canvas");
  const box = (await canvas.boundingBox())!;
  // The empty middle picks nothing; the bottom panel below it is picked.
  await canvas.tap({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator(".selection-bar strong")).toHaveCount(0);
  await canvas.tap({ position: { x: box.width * 0.55, y: box.height * 0.62 } });
  await expect(page.locator(".selection-bar strong")).toHaveText("Bottom");
  await page.getByRole("button", { name: "Alone" }).tap();
  await expect(page.getByRole("button", { name: "Alone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await noSideways(page)).toBe(true);
});

test("drawings open with pinch-zoom and a PDF", async ({ page }) => {
  await page.goto(`/p/${project}/view`);
  await page.getByRole("button", { name: "Drawings", exact: true }).tap();
  await page.getByRole("button", { name: "Assembly" }).tap();
  const sheet = page.locator(".sheet-zoom img");
  await expect(sheet).toBeVisible();
  expect(
    await sheet.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  const pdf = page.getByRole("link", { name: "PDF" });
  const response = await page.request.get((await pdf.getAttribute("href"))!);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  // Two fingers spread apart zoom in, and a double tap puts it back.
  const zoom = page.locator(".sheet-zoom");
  await zoom.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type: string, id: number, x: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          clientX: x,
          clientY: cy,
          isPrimary: id === 1,
          bubbles: true,
        }),
      );
    fire("pointerdown", 1, cx - 20);
    fire("pointerdown", 2, cx + 20);
    for (let step = 1; step <= 10; step++) {
      fire("pointermove", 1, cx - 20 - step * 8);
      fire("pointermove", 2, cx + 20 + step * 8);
    }
    fire("pointerup", 1, cx - 100);
    fire("pointerup", 2, cx + 100);
  });
  await expect(zoom).toHaveClass(/zoomed/);
  const scale = await page
    .locator(".sheet-zoom .zoom-pan-content")
    .evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).a,
    );
  expect(scale).toBeGreaterThan(4);
  await page.waitForTimeout(400);
  await zoom.tap({ position: { x: 20, y: 20 } });
  await zoom.tap({ position: { x: 20, y: 20 } });
  await expect(zoom).not.toHaveClass(/zoomed/);
  // A double tap zooms in.
  const box = (await zoom.boundingBox())!;
  await zoom.tap({ position: { x: box.width / 2, y: box.height / 2 } });
  await zoom.tap({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(zoom).toHaveClass(/zoomed/);
  expect(await noSideways(page)).toBe(true);
});

test("parts ticked off as cut are kept on the server", async ({
  page,
  request,
}) => {
  await page.goto(`/p/${project}/view`);
  await page.getByRole("button", { name: "Cut list", exact: true }).tap();
  // Tapping a part highlights it in the layouts too.
  await page.locator(".cut-name", { hasText: "Bottom" }).tap();
  await page
    .locator(".cut-rows li", { hasText: "Bottom" })
    .getByRole("checkbox")
    .check();
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect(page.getByText("to sync")).toHaveCount(0);
  await page.getByRole("button", { name: "Layouts", exact: true }).tap();
  await expect(page.locator('g.placed[data-part="bottom:0"]')).toHaveClass(
    /same-part/,
  );
  await expect(page.locator('g.placed[data-part="bottom:0"]')).toHaveClass(
    /done/,
  );
  // Tap the other part on the sheet and tick it there.
  await page.locator('g.placed[data-part="side:0"] polygon').tap();
  await page.locator(".selection-bar.floating").getByRole("checkbox").check();
  await expect(page.getByText("2 of 2 cut")).toBeVisible();
  await expect(page.getByText("to sync")).toHaveCount(0);

  const stored = (await (
    await request.get(`/api/projects/${project}/progress/1`)
  ).json()) as { done: string[] };
  expect(stored.done).toEqual(["bottom:0#0", "side:0#0"]);
  await page.reload();
  await page.getByRole("button", { name: "Cut list", exact: true }).tap();
  await expect(page.getByText("2 of 2")).toBeVisible();
});

test("drawings, cut list and layouts work offline after a first visit", async ({
  page,
  context,
  request,
}) => {
  await page.goto(`/p/${project}/view`);
  await expect(page.getByText("Workshop shelf")).toBeVisible();
  // Wait until the service worker holds every file of the revision.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const manifest = await (
            await fetch(
              location.pathname.replace(
                /^\/p\/([^/]+)\/view.*/,
                "/api/projects/$1/viewer",
              ),
            )
          ).json();
          const files = [
            manifest.model,
            ...manifest.drawings.map((d: { svg: string }) => d.svg),
          ];
          const cache = await caches.open("codecad-viewer-files-v1");
          const found = await Promise.all(
            files.map((f: string) =>
              cache.match(
                `/api/projects/${manifest.project}/viewer/${manifest.revision}/${f}`,
              ),
            ),
          );
          return !!navigator.serviceWorker.controller && found.every(Boolean);
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Workshop shelf")).toBeVisible();
  await expect(page.getByText("offline")).toBeVisible();

  await page.getByRole("button", { name: "Drawings", exact: true }).tap();
  const thumbnails = page.locator(".sheet-list img");
  await expect(thumbnails.first()).toBeVisible();
  await expect
    .poll(() =>
      thumbnails.evaluateAll((imgs) =>
        imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Layouts", exact: true }).tap();
  await expect(page.locator("g.placed")).toHaveCount(2);

  await page.getByRole("button", { name: "Cut list", exact: true }).tap();
  const side = page
    .locator(".cut-rows li", { hasText: "side" })
    .getByRole("checkbox");
  // Unticked offline: kept on the phone until the network is back.
  await side.uncheck();
  await expect(page.getByText("1 to sync")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("to sync")).toHaveCount(0, { timeout: 10_000 });
  const stored = (await (
    await request.get(`/api/projects/${project}/progress/1`)
  ).json()) as { done: string[] };
  expect(stored.done).toEqual(["bottom:0#0"]);
});
