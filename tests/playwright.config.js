const { defineConfig, devices } = require("@playwright/test");

/* The app is a file:// page with no server, so there is nothing to start and
   nothing to tear down. Workers are capped at 4 because every worker boots a
   1,861-concept mock vocabulary and validates it. */
module.exports = defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium" }]
});
