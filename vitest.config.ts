import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
