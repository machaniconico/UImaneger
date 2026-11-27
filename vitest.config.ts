import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/*.test.mjs", "server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "tests/acceptance/**/*.test.ts"],
  },
});
