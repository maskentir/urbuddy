import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lab/adaptive-single-flow/session.test.ts"],
  },
});
