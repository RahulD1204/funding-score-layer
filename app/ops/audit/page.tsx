// Audit log and model card (specs/02 screen 9). Ops only. Every decision with its inputs, choice
// and versions, filterable by case or obligation; the model card with the median-day baseline,
// the quantile model and the AFT model side by side.

import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip, Fact, Panel } from "@/components/ui";
import { formatDate } from "@/lib/engine";
import { getModelCards, listAudit, type ModelCardRow } from "@/lib/data/ops";
import { requireViewer } from "@/lib/data/session";

/** A case id ("L-1041:2026-04-02") or an obligation id ("L-1041"). Anything else is ignored. */
function cleanFilter(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,40}(:\d{4}-\d{2}-\d{2})?$/.test(value) ? value : null;
}

async function AuditLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer(["ops"]);
  const filter = cleanFilter((await searchParams).q);
  const rows = await listAudit(filter);
  return (
    <Panel title={filter ? `Audit log for ${filter}` : "Audit log, newest first"} aside={<span className="text-xs text-muted">Append-only. {rows.length} rows shown</span>}>
      <form className="mb-3 flex flex-wrap items-center gap-2" action="/ops/audit">
        <input
          name="q"
          defaultValue={filter ?? ""}
          placeholder="Obligation (L-1041) or case (L-1041:2026-04-02)"
          aria-label="Filter by obligation or case"
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action-dark">
          Filter
        </button>
        {filter && (
          <Link href="/ops/audit" className="text-sm font-medium text-action hover:underline">
            Show all
          </Link>
        )}
      </form>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No audit rows match.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-muted">#{a.id}</span>
                <span className="font-medium whitespace-nowrap">{formatDate(a.clock_date)}</span>
                <Chip tone="info">{a.decision}</Chip>
                {a.case_id && (
                  <Link href={`/ops/cases/${encodeURIComponent(a.case_id)}`} className="text-action hover:underline">
                    {a.case_id}
                  </Link>
                )}
                <span className="text-muted">{a.actor}</span>
                <span className="text-xs text-muted">
                  policy {a.policy_version}
                  {a.model_version && ` · model ${a.model_version}`}
                </span>
              </div>
              {a.internal_reason && <p className="mt-1">{a.internal_reason}</p>}
              {a.public_reason && <p className="text-muted">Shown to the merchant: {a.public_reason}</p>}
              {a.inputs && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-action">Inputs</summary>
                  <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-canvas p-2 text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(a.inputs, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const days = (v: unknown) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(2)} days`);

function parsed<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function ModelCardView({ card }: { card: ModelCardRow }) {
  const coverage = parsed<Record<string, number>>(card.coverage_80) ?? {};
  const bands = parsed<{ band: string; stated: string; n: number; observed: number; holds: boolean }[]>(card.band_calibration) ?? [];
  const models = [
    { key: "rule", name: "Median-day baseline", error: card.day_error_baseline },
    { key: "quantile", name: "XGBoost quantile", error: card.day_error_quantile },
    { key: "aft", name: "XGBoost AFT", error: card.day_error_aft },
  ];
  return (
    <Panel tone="internal" title={`Model card · ${card.model_version}`} aside={<Chip tone="paid">Chosen: {String(card.chosen_model)}</Chip>}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Trained on">{String(card.training_period ?? "—")}</Fact>
        <Fact label="Tuned on">{String(card.tune_period ?? "—")}</Fact>
        <Fact label="Tested on">{String(card.test_period ?? "—")}</Fact>
      </dl>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {models.map((m) => (
          <div key={m.key} className={`rounded-lg border px-3 py-2 ${card.chosen_model === m.key ? "border-action bg-white" : "border-line bg-white"}`}>
            <p className="font-semibold text-navy">{m.name}</p>
            <p className="text-sm">
              Day error <span className="font-medium">{days(m.error)}</span>
            </p>
            <p className="text-sm">
              80% range covers <span className="font-medium">{pct(coverage[m.key])}</span>
            </p>
          </div>
        ))}
      </div>
      {coverage.chosen_calibrated !== undefined && (
        <p className="mt-2 text-sm text-muted">
          After calibration, the chosen model&apos;s 80% range covers {pct(coverage.chosen_calibrated)} with a day error of {days(card.day_error_chosen)}.
        </p>
      )}
      {bands.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Band</th>
              <th className="py-1 pr-3 font-medium">Stated</th>
              <th className="py-1 pr-3 font-medium">Observed</th>
              <th className="py-1 font-medium">Holds</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.band} className="border-t border-line">
                <td className="py-1.5 pr-3 font-medium">{b.band}</td>
                <td className="py-1.5 pr-3">{b.stated}</td>
                <td className="py-1.5 pr-3">{pct(b.observed)}</td>
                <td className="py-1.5">{b.holds ? <Chip tone="paid">Yes</Chip> : <Chip tone="failed">No</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-muted">Synthetic data: this shows the method works, not real-world lift.</p>
    </Panel>
  );
}

async function ModelCards() {
  await requireViewer(["ops"]);
  const cards = await getModelCards();
  return (
    <>
      {cards.map((card) => (
        <ModelCardView key={card.model_version} card={card} />
      ))}
    </>
  );
}

export default function AuditPage({ searchParams }: PageProps<"/ops/audit">) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-navy">Audit log and model card</h1>
      <Suspense fallback={<PageLoading />}>
        <ModelCards />
      </Suspense>
      <Suspense fallback={<PageLoading />}>
        <AuditLog searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
