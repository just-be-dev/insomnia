import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { dedupe: ["effect"] },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
