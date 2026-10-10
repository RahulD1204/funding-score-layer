// POST /api/compose-message. Ops only: composes any customer message a running case is missing.
// advance-day and process-debit-event compose messages as actions lock. The work is in lib/server/flows/compose-message.ts.

import { routeHandler } from "@/lib/server/route";
import { composeMessage } from "@/lib/server/flows/compose-message";

export const POST = routeHandler("compose-message", ["ops"], composeMessage);
