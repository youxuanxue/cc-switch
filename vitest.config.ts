import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["{src,tests}/**/*.{test,spec}.{ts,tsx,js,jsx}"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    // Pi 表单用例在整套并行时会超过默认 5s，单独跑约 1.5s。
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
