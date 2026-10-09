// The shell every route handler in app/api/ shares: JSON body, login and role check, the flow,
// and the answer. A refused request gets an audit row (except a call with no valid login or from
// another site, so anonymous calls cannot fill the log). An unexpected error outside a case also gets one.
// Errors inside a case are handled by the flow itself, which fails the case open.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireRole, type Caller, type CallerRole } from "./auth";
import { HttpError } from "./http-error";
import { adminClient } from "./supabase";
import { appendAudit, auditRow, errorText, readToday } from "./store";
import { asBody, type Body } from "./validate";

export interface FlowContext {
  db: SupabaseClient;
  caller: Caller;
  body: Body;
}

export interface FlowResult {
  status?: number;
  body: unknown;
}

export type Flow = (ctx: FlowContext) => Promise<FlowResult>;

async function readBody(request: Request): Promise<Body> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_input", "The request body is not valid JSON.");
  }
  return asBody(raw);
}

/** Writes an audit row without letting a failure here hide the original answer. */
async function auditQuietly(db: SupabaseClient, build: (today: string) => ReturnType<typeof auditRow>) {
  try {
    await appendAudit(db, build(await readToday(db)));
  } catch {
    // Nothing more can be done: the database itself is unreachable.
  }
}

/** A customer link is a credential: it never goes into the audit log. */
function withoutToken(body: Body | null): Body | null {
  if (!body || !("customerToken" in body)) return body;
  const rest = { ...body };
  delete rest.customerToken;
  return rest;
}

export function routeHandler(name: string, roles: CallerRole[], flow: Flow) {
  return async function POST(request: Request): Promise<Response> {
    let db: SupabaseClient;
    try {
      db = adminClient();
    } catch {
      return Response.json({ error: "server_not_configured", message: "The server is not set up." }, { status: 500 });
    }
    let caller: Caller | undefined;
    let body: Body | null = null;
    try {
      body = await readBody(request);
      caller = await requireRole(request, db, roles, body);
      const result = await flow({ db, caller, body });
      return Response.json(result.body, { status: result.status ?? 200 });
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status !== 401 && error.code !== "cross_site") {
          const who = caller ?? error.extra.caller;
          await auditQuietly(db, (today) =>
            auditRow(today, who?.actor ?? `unknown:${error.extra.userId ?? "no-profile"}`, "request_refused", {
              caseId: error.extra.caseId,
              internal: `${name} refused: ${error.code}. ${error.message}`,
              inputs: { route: name, body: withoutToken(body) },
            }),
          );
        }
        return Response.json({ error: error.code, message: error.message }, { status: error.status });
      }
      const message = errorText(error);
      await auditQuietly(db, (today) =>
        auditRow(today, caller?.actor ?? "unknown", "server_error", {
          internal: `${name} failed: ${message}`,
          inputs: { route: name, body: withoutToken(body) },
        }),
      );
      return Response.json(
        { error: "server_error", message: "Something went wrong. Razorpay's original retries apply." },
        { status: 500 },
      );
    }
  };
}
