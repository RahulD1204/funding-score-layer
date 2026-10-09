// POST /api/customer-case. What the customer phone mock shows for one case.
// Takes the signed case link (customerToken) instead of a login; the work is in lib/server/flows/customer-case.ts.

import { routeHandler } from "@/lib/server/route";
import { customerCase } from "@/lib/server/flows/customer-case";

export const POST = routeHandler("customer-case", ["customer"], customerCase);
