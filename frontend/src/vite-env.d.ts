/// <reference types="vite/client" />

/** Injected by Vite's `define` at build time from the repo-root VERSION
 *  file. Falls back to a `dev` sentinel under vitest (where vite's define
 *  pass does not run). See vite.config.ts and the runtime fallback in
 *  `profile-crud.ts` for the substitution pattern. */
declare const __APP_VERSION__: string;

