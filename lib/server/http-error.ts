// A refused request: bad input, no login, wrong role, or an engine refusal such as a late pick.
// Not an error in the fail-open sense: nothing changes, and the route answers with this status.

import type { Caller } from "./auth";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: { caseId?: string; caller?: Caller; userId?: string } = {},
  ) {
    super(message);
  }
}
