import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["lab/audio-slice/**/*.test.ts", "lab/audio-slice/**/*.test.tsx"],
  },
});
