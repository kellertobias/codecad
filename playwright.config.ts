// Browser tests for the editor and the mobile viewer, against servers
// started with throwaway storage directories. Run with npm run test:e2e (builds the app
// first).
import { defineConfig } from "@playwright/test";

const port = 4391;
/** A second server with accounts on, for e2e/accounts.spec.ts. Passkeys
 * need a domain, so it is reached as localhost. */
export const accountsPort = 4392;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "rm -rf tmp/e2e && node --import tsx src/server.ts examples/joined-solids/index.ts",
      env: { PORT: String(port), CODECAD_STORAGE: "tmp/e2e" },
      url: `http://127.0.0.1:${port}/api/session`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "rm -rf tmp/e2e-accounts && node --import tsx src/server.ts examples/joined-solids/index.ts",
      env: {
        PORT: String(accountsPort),
        CODECAD_STORAGE: "tmp/e2e-accounts",
        CODECAD_ACCOUNTS: "1",
      },
      url: `http://127.0.0.1:${accountsPort}/api/session`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
