// Where each role lands after signing in, and the three seeded demo accounts.

export const HOME = { lender: "/lender", insurer: "/insurer", ops: "/ops" } as const;

export type HomeRole = keyof typeof HOME;

/** The seeded demo users (scripts/targets.ts). Emails only: their passwords never leave the server. */
export const DEMO_ACCOUNTS: { email: string; role: HomeRole; who: string; button: string }[] = [
  { email: "lender@northfield.example", role: "lender", who: "Lender: Northfield Finance, collections", button: "Sign in as lender" },
  { email: "insurer@harbour.example", role: "insurer", who: "Insurer: Harbour Life, renewals", button: "Sign in as insurer" },
  { email: "ops@fsl.example", role: "ops", who: "Razorpay ops: internal console", button: "Sign in as Razorpay ops" },
];
