import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "src/web/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:47862",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "tsx src/web/test-support/e2e-server.ts",
    url: "http://127.0.0.1:47862/healthz",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
