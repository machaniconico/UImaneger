import { defineConfig, devices } from "@playwright/test";

// CI では 3 エンジンすべてを実行する。ローカルでは `npx playwright test --project=chromium` で絞れる。
// WebKit は Linux でシステムライブラリが必要(`npx playwright install --with-deps webkit`)。
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
});
