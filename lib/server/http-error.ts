// A refused request: bad input, no login, wrong role, or an engine refusal such as a late pick.
// Not an error in the fail-open sense: nothing changes, and the route answers with this status.

import type { Caller } from "./auth";

// Plain fields rather than constructor parameter properties, so Node can run this file directly
// (scripts/history.ts, under the seed); Node's type stripping does not support those.
export class HttpError extends Error {
  status: number;
  code: string;
  extra: { caseId?: string; caller?: Caller; userId?: string };

  constructor(status: number, code: string, message: string, extra: { caseId?: string; caller?: Caller; userId?: string } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
