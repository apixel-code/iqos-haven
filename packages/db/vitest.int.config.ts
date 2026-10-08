import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.int.test.ts"], fileParallelism: false, testTimeout: 20_000 },
});
