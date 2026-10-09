// POST /api/update-controls. Merchant settings, and the actions that end or pause a plan.
// Requires a login with the role checked in lib/server/route.ts; the work is in lib/server/flows/update-controls.ts.

import { routeHandler } from "@/lib/server/route";
import { updateControls } from "@/lib/server/flows/update-controls";

export const POST = routeHandler("update-controls", ["lender", "insurer", "ops"], updateControls);
