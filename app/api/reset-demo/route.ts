// POST /api/reset-demo. The Reset demo button.
// Requires a login with the role checked in lib/server/route.ts; the work is in lib/server/flows/reset-demo.ts.

import { routeHandler } from "@/lib/server/route";
import { resetDemo } from "@/lib/server/flows/reset-demo";

export const POST = routeHandler("reset-demo", ["ops"], resetDemo);
