// Lets scripts/seed.ts run the app's server functions (scripts/history.ts) under plain Node 24.
// Adds what Next.js and the tests provide: the "@/" path alias for the repository root, and an empty
// "server-only" module (the guard that stops browser code importing server files). Use together with
// ml/bridge/register.mjs, which adds the ".ts" that the app's relative imports leave out.

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const EMPTY = new URL("../node_modules/server-only/empty.js", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return next(EMPTY.href, context);
    if (specifier.startsWith("@/")) {
      const base = new URL(specifier.slice(2), ROOT);
      for (const suffix of ["", ".ts", "/index.ts"]) {
        const path = fileURLToPath(base) + suffix;
        if (suffix === "" ? /\.[cm]?[jt]s$/.test(path) && existsSync(path) : existsSync(path)) {
          return next(pathToFileURL(path).href, context);
        }
      }
    }
    return next(specifier, context);
  },
});
