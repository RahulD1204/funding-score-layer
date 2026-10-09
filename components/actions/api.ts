"use client";

// Calls one of the server functions in app/api/ from a screen. The login cookie goes with the
// request automatically. Screens never write a table themselves.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface ApiAnswer {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
  /** The server's plain-words message on a refusal or an error. */
  message: string | null;
}

export async function callApi(route: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  try {
    const response = await fetch(`/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message = response.ok ? null : typeof data.message === "string" ? data.message : "Something went wrong.";
    return { ok: response.ok, status: response.status, data, message };
  } catch {
    return { ok: false, status: 0, data: {}, message: "The server could not be reached. Check the connection and try again." };
  }
}

/** Runs a server function, then reloads the page's data. Holds the pending state and any refusal. */
export function useApi() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function run(route: string, body: Record<string, unknown>): Promise<ApiAnswer> {
    setBusy(true);
    setError(null);
    const answer = await callApi(route, body);
    setBusy(false);
    if (!answer.ok) setError(answer.message);
    startTransition(() => router.refresh());
    return answer;
  }

  return { run, pending: busy || refreshing, error, setError };
}
