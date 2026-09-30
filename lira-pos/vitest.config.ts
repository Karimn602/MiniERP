import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so the Tauri dev-server settings there
// (fixed port, HMR host, src-tauri watch excludes) never affect a test run.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Report SQL uses date(posted_at, 'localtime'). Pinning the zone keeps
    // those tests deterministic on any developer machine or CI runner.
    env: { TZ: "UTC" },
    clearMocks: true,
    restoreMocks: true,
  },
});
