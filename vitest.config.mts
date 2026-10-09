import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The database tests share the test project, and Reset demo empties tables another file's
    // fixtures live in. One file at a time keeps them apart.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // "server-only" stops browser code from importing server files. Next.js handles it; in the
      // tests, which run on the server anyway, it is the package's empty module.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
