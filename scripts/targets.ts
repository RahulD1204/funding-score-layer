// Which Supabase project a script talks to, and the demo users it creates.
// Values come from environment variables (.env.local locally). Nothing here is ever printed.
//
//   test  the second Supabase project, used only by the automated tests (the default)
//   demo  the project added through the Vercel Marketplace. Its variables come from `vercel env pull`.

export type Target = "test" | "demo";

export interface TargetConfig {
  target: Target;
  /** The project URL, https://<ref>.supabase.co */
  url: string;
  /** The secret (service-role) key. Bypasses access rules: scripts and server code only. */
  secretKey: string;
  /** A Postgres connection string for the database owner. Only migrations and the seed use it. */
  dbUrl: string;
}

const NAMES: Record<Target, { url: string[]; secretKey: string[]; dbUrl: string[] }> = {
  test: {
    url: ["TEST_SUPABASE_URL"],
    secretKey: ["TEST_SUPABASE_SECRET_KEY"],
    dbUrl: ["TEST_SUPABASE_DB_URL"],
  },
  demo: {
    url: ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    secretKey: ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    dbUrl: ["POSTGRES_URL_NON_POOLING", "SUPABASE_DB_URL"],
  },
};

function firstSet(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Reads `--target test|demo` from the command line. Defaults to test, so nothing touches the demo by accident. */
export function targetFromArgs(argv: string[]): Target {
  const i = argv.indexOf("--target");
  const value = i >= 0 ? argv[i + 1] : "test";
  if (value !== "test" && value !== "demo") throw new Error(`Unknown target "${value}". Use --target test or --target demo.`);
  return value;
}

export function loadTarget(target: Target): TargetConfig {
  const names = NAMES[target];
  const url = firstSet(names.url);
  const secretKey = firstSet(names.secretKey);
  const dbUrl = firstSet(names.dbUrl);
  const missing = [
    url ? null : names.url.join(" or "),
    secretKey ? null : names.secretKey.join(" or "),
    dbUrl ? null : names.dbUrl.join(" or "),
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) throw new Error(`Missing for the ${target} project: ${missing.join(", ")}. Add them to .env.local.`);
  if (target === "demo" && url === process.env.TEST_SUPABASE_URL?.trim()) {
    throw new Error("The demo URL is the same as the test URL. Check .env.local.");
  }
  return { target, url: url!, secretKey: secretKey!, dbUrl: dbUrl! };
}

/**
 * Supabase encrypts every database connection. Its certificate is signed by Supabase's own
 * authority rather than a public one, so the chain is not checked here.
 */
export const DB_SSL = { rejectUnauthorized: false };

/** The simulated date the demo starts on. */
export const SEED_TODAY = "2026-04-02";

export interface DemoUser {
  key: "lender" | "insurer" | "ops";
  /** Synthetic address on a reserved domain. Supabase sends it no email. */
  email: string;
  role: "lender" | "insurer" | "ops";
  merchantId: string | null;
  passwordVariable: string;
}

export const DEMO_USERS: DemoUser[] = [
  { key: "lender", email: "lender@northfield.example", role: "lender", merchantId: "m-northfield", passwordVariable: "DEMO_LENDER_PASSWORD" },
  { key: "insurer", email: "insurer@harbour.example", role: "insurer", merchantId: "m-harbour", passwordVariable: "DEMO_INSURER_PASSWORD" },
  { key: "ops", email: "ops@fsl.example", role: "ops", merchantId: null, passwordVariable: "DEMO_OPS_PASSWORD" },
];

export function demoPassword(user: DemoUser): string {
  const value = process.env[user.passwordVariable]?.trim();
  if (!value) throw new Error(`${user.passwordVariable} is empty. Set it in .env.local.`);
  return value;
}
