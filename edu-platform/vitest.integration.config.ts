import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration test configuration — runs against real services.
 * Usage: npx vitest run --config vitest.integration.config.ts --reporter=verbose
 *
 * Prerequisites:
 *   docker compose up -d   (postgres, redis, minio)
 *   RAG service running on localhost:8001
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["__tests__/integration/**/*.test.ts"],
    setupFiles: ["__tests__/integration/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run integration tests serially to avoid connection pool issues
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
