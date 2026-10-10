"use client";

// The Ops assistant box on the ops console (specs/07 section 3). Sends the question to
// ask-ops-assistant and shows the answer with the audit rows it cites. An answer without a
// citation arrives as "Not found in the audit log."; a failed call says the assistant is unavailable.

import Link from "next/link";
import { useState } from "react";
import { callApi } from "@/components/actions/api";
import { Button } from "@/components/ui";
import { formatDate } from "@/lib/engine";

interface CitedRow {
  id: number;
  clock_date: string;
  case_id: string | null;
  decision: string;
  internal_reason: string | null;
}

type Reply = { kind: "answer"; text: string; cited: CitedRow[] } | { kind: "unavailable"; text: string };

export default function OpsAssistant() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setReply(null);
    const answer = await callApi("ask-ops-assistant", { question: q });
    setBusy(false);
    const d = answer.data;
    if (answer.ok && d.available === true && typeof d.answer === "string") {
      setReply({ kind: "answer", text: d.answer, cited: Array.isArray(d.cited) ? (d.cited as CitedRow[]) : [] });
    } else {
      const text = typeof d.message === "string" ? d.message : (answer.message ?? "The assistant is unavailable right now.");
      setReply({ kind: "unavailable", text });
    }
  }

  return (
    <div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="Why did L-1041 retry on 8 April?"
          aria-label="Question for the Ops assistant"
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm"
        />
        <Button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Reading the log…" : "Ask"}
        </Button>
      </form>

      {reply?.kind === "unavailable" && (
        <p role="alert" className="mt-3 text-sm text-failed">
          {reply.text}
        </p>
      )}
      {reply?.kind === "answer" && (
        <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2">
          <p className="text-sm whitespace-pre-line">{reply.text}</p>
          {reply.cited.length > 0 && (
            <>
              <p className="mt-2 text-xs font-medium text-muted">Audit rows cited</p>
              <ul className="mt-1 flex flex-col gap-1">
                {reply.cited.map((row) => (
                  <li key={row.id} className="text-xs">
                    <Link
                      href={row.case_id ? `/ops/audit?q=${encodeURIComponent(row.case_id)}` : "/ops/audit"}
                      className="font-medium text-action hover:underline"
                    >
                      #{row.id}
                    </Link>
                    <span className="text-muted">
                      {" "}
                      · {formatDate(row.clock_date)} · {row.case_id ?? "no case"} · {row.decision}
                      {row.internal_reason && ` · ${row.internal_reason}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
