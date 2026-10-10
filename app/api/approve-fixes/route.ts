// POST /api/approve-fixes. The exceptions desk's approve buttons. Lender or insurer, own fixes only.
// The work is in lib/server/flows/approve-fixes.ts.

import { routeHandler } from "@/lib/server/route";
import { approveFixes } from "@/lib/server/flows/approve-fixes";

export const POST = routeHandler("approve-fixes", ["lender", "insurer"], approveFixes);
