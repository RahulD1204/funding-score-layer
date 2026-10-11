// The built site holds none of the three demo passwords (specs/08 rows 9 and 21). Scans the output
// of `npm run build` in .next/, skipping the build cache. Skipped when there is no build, or when
// the passwords are not in .env.local. A finding names the file, never the password.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_USERS } from "@/scripts/targets";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No local settings file: the passwords are missing and the check is skipped.
}

const BUILD = ".next";
const passwords = DEMO_USERS.map((u) => process.env[u.passwordVariable]?.trim()).filter((p): p is string => !!p);
const built = existsSync(join(BUILD, "BUILD_ID"));

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === join(BUILD, "cache") || path === join(BUILD, "dev")) continue;
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

describe.skipIf(!built || passwords.length < DEMO_USERS.length)("the built site", () => {
  it("contains none of the three demo passwords", () => {
    const found: string[] = [];
    for (const path of files(BUILD)) {
      const text = readFileSync(path).toString("latin1");
      passwords.forEach((p, i) => {
        if (text.includes(p)) found.push(`${DEMO_USERS[i].key} password in ${path}`);
      });
    }
    expect(found).toEqual([]);
  });
});
