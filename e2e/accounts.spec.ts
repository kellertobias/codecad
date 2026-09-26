// Accounts in a real browser: passkeys made and used through Chromium's
// virtual authenticator, projects kept apart per user, and a view link
// that opens without an account.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { accountsPort } from "../playwright.config.js";

const base = `http://localhost:${accountsPort}`;

test.use({
  baseURL: base,
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

/** A page whose browser has a passkey authenticator that always agrees. */
async function withAuthenticator(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

async function signUp(page: Page, name: string) {
  await page.goto("/app/");
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.locator(".account-name")).toHaveText(name);
}

test("people sign up with passkeys, keep their own projects, and share view links", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const adaContext = await browser.newContext({ baseURL: base });
  const ada = await withAuthenticator(adaContext);
  await signUp(ada, "Ada");
  await ada.getByRole("button", { name: "New" }).click();
  await expect(ada.locator(".sidebar .list button")).toHaveCount(1);

  const bobContext = await browser.newContext({ baseURL: base });
  const bob = await withAuthenticator(bobContext);
  await signUp(bob, "Bob");
  await expect(bob.locator(".sidebar .list button")).toHaveCount(0);
  const theirs = await bob.request.get("/api/projects");
  expect(((await theirs.json()) as { projects: unknown[] }).projects).toEqual(
    [],
  );

  // Without a session nothing is visible.
  const stranger = await browser.newContext({ baseURL: base });
  const anonymous = await stranger.newPage();
  expect((await anonymous.request.get("/api/projects")).status()).toBe(401);
  await anonymous.goto("/app/");
  await expect(
    anonymous.getByRole("button", { name: "Sign in with a passkey" }),
  ).toBeVisible();

  // Ada shares her project; the link opens for anyone, view only.
  await ada.locator(".sidebar .list button").first().click();
  await ada.getByRole("button", { name: /View links/ }).click();
  await ada.getByRole("button", { name: "New view link" }).click();
  const link = await ada
    .getByRole("textbox", { name: "View link" })
    .inputValue();
  expect(link).toMatch(new RegExp(`^${base}/s/[A-Za-z0-9_-]{32}$`));
  await anonymous.goto(link);
  await expect(anonymous.locator(".viewer-title strong")).toContainText(
    "Project",
  );
  await expect(anonymous.getByText("view only")).toBeVisible();

  // Revoked, it stops working.
  await ada.getByRole("button", { name: "Revoke the link" }).click();
  await expect(ada.getByRole("textbox", { name: "View link" })).toHaveCount(0);
  const gone = await anonymous.request.get(
    link.replace("/s/", "/api/shared/") + "/viewer",
  );
  expect(gone.status()).toBe(404);
  await ada.keyboard.press("Escape");

  // Signed out and in again with the same passkey.
  await ada.getByRole("button", { name: "Sign out" }).click();
  await expect(
    ada.getByRole("button", { name: "Sign in with a passkey" }),
  ).toBeVisible();
  await ada.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(ada.locator(".account-name")).toHaveText("Ada");
  await expect(ada.locator(".sidebar .list button")).toHaveCount(1);

  await Promise.all([adaContext.close(), bobContext.close(), stranger.close()]);
});
