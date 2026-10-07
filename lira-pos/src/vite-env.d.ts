/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * "sandbox" in the training build, "production" otherwise. Injected by
   * `vite.config.ts` from Vite's `--mode`; see `src/lib/appMode.ts`.
   */
  readonly VITE_APP_MODE: "production" | "sandbox";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
