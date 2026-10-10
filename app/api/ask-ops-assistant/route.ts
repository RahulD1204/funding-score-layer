// POST /api/ask-ops-assistant. The Ops assistant box on the ops console. Ops only: a merchant has no route to it.
// The work is in lib/server/flows/ask-ops-assistant.ts.

import { routeHandler } from "@/lib/server/route";
import { askOpsAssistantFlow } from "@/lib/server/flows/ask-ops-assistant";

export const POST = routeHandler("ask-ops-assistant", ["ops"], askOpsAssistantFlow);
