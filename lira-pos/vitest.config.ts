import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Kept separate from vite.config.ts so the Tauri dev-server settings there
// (fixed port, HMR host, src-tauri watch excludes) never affect a test run.
export default defineConfig({
  // Needed only by the component tests (`*.test.tsx`), which render real pages
  // to prove the register BEHAVES correctly and not merely that its extracted
  // helpers compute correctly. The pure tests are unaffected.
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Default stays `node`: the pure tests need no DOM and are faster without
    // one. A component test opts in with `@vitest-environment jsdom`.
    environment: "node",
    // Report SQL uses date(posted_at, 'localtime'). Pinning the zone keeps
    // those tests deterministic on any developer machine or CI runner.
    env: { TZ: "UTC" },
    clearMocks: true,
    restoreMocks: true,
  },
});
