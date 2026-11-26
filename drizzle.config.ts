import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/platform/persistence/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
