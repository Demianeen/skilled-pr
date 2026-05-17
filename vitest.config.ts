import { defineConfig } from "vitest/config";

// Minimal vitest config. The default behaviour fits our needs:
//   - auto-discovers `tests/**/*.test.ts`
//   - uses native Node ESM
//   - parallelizes by default
// We don't need globals (we explicitly import describe/test/expect from vitest).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
