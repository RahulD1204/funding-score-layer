// Where each role lands after signing in.

export const HOME = { lender: "/lender", insurer: "/insurer", ops: "/ops" } as const;

export type HomeRole = keyof typeof HOME;
