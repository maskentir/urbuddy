import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evaluation/meeting-lab/*.test.tsx"],
  },
});
