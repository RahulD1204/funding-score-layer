// POST /api/choose-schedule. The lender picks a schedule for one case.
// Requires a login with the role checked in lib/server/route.ts; the work is in lib/server/flows/choose-schedule.ts.

import { routeHandler } from "@/lib/server/route";
import { chooseSchedule } from "@/lib/server/flows/choose-schedule";

export const POST = routeHandler("choose-schedule", ["lender"], chooseSchedule);
