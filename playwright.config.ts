// Browser tests for the mobile viewer, against a server started with a
// throwaway storage directory. Run with npm run test:e2e (builds the app
// first).
import { defineConfig } from "@playwright/test";

const port = 4391;

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
  webServer: {
    command:
      "rm -rf tmp/e2e && node --import tsx src/server.ts examples/joined-solids/index.ts",
    env: { PORT: String(port), CODECAD_STORAGE: "tmp/e2e" },
    url: `http://127.0.0.1:${port}/api/session`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
