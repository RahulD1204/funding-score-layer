// POST /api/advance-day. The demo clock's Next day button.
// Requires a login with the role checked in lib/server/route.ts; the work is in lib/server/flows/advance-day.ts.

import { routeHandler } from "@/lib/server/route";
import { advanceDay } from "@/lib/server/flows/advance-day";

export const POST = routeHandler("advance-day", ["ops"], advanceDay);
