import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // The 4096x4096 encoder benchmark is the slowest case and needs headroom.
    testTimeout: 60_000,
  },
});
