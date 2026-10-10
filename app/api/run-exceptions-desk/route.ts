// POST /api/run-exceptions-desk. Ops only: runs the exceptions desk for a desk case that has no fixes yet.
// process-debit-event runs the same desk for every new desk case. The work is in lib/server/flows/run-exceptions-desk.ts.

import { routeHandler } from "@/lib/server/route";
import { runExceptionsDesk } from "@/lib/server/flows/run-exceptions-desk";

export const POST = routeHandler("run-exceptions-desk", ["ops"], runExceptionsDesk);
