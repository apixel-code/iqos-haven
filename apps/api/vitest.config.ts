import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps decorator metadata so Nest DI works under Vitest.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.int.test.ts"] },
});
