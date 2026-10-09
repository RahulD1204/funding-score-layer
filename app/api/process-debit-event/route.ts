// POST /api/process-debit-event. A failed due-date debit from the event injector.
// Requires a login with the role checked in lib/server/route.ts; the work is in lib/server/flows/process-debit-event.ts.

import { routeHandler } from "@/lib/server/route";
import { processDebitEvent } from "@/lib/server/flows/process-debit-event";

export const POST = routeHandler("process-debit-event", ["ops"], processDebitEvent);
