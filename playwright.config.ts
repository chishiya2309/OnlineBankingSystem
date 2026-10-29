import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: ".e2e/results",
  reporter: [["list"], ["html", { outputFolder: ".e2e/report", open: "never" }], ["json", { outputFile: ".e2e/results.json" }]],
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/e2e/local-stack.mjs",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
