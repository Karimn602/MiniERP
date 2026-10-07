import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],

  // Build-time application mode (see src/lib/appMode.ts).
  //
  // `vite build --mode sandbox` marks the bundle as the training build; any
  // other mode is production. This is a literal substitution, not a runtime
  // env lookup, so the sandbox banner is dead code in a production build and
  // Rollup drops it. Driving it off Vite's own `--mode` rather than a shell
  // variable keeps the sandbox scripts identical on Windows and POSIX, and
  // keeps the flag in version control instead of an untracked `.env` file.
  define: {
    "import.meta.env.VITE_APP_MODE": JSON.stringify(
      mode === "sandbox" ? "sandbox" : "production",
    ),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
