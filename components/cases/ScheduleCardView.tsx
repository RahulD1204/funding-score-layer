// One schedule card as a lender sees it (specs/02 screen 3): label, dates, likelihood band, days
// overdue, charges for waiting and the difference against Razorpay's original first retry.
// Shared by the engine preview and the live case screen. It shows a band, never a number.

import type { ReactNode } from "react";
import { formatDay, formatRupees, type ScheduleCard } from "@/lib/engine";
import type { Tone } from "@/lib/demo/words";
import { Chip } from "@/components/ui";

const BAND_TONE: Record<string, Tone> = { High: "paid", Medium: "waiting", Lower: "idle" };

export interface ScheduleCardViewProps {
  card: ScheduleCard;
  dueDate: string;
  penalChargePerDayPaise: number | null;
  /** Razorpay's original first retry day. */
  originalFirstDay: number | undefined;
  chosen: boolean;
  chosenBy: "merchant" | "default" | null;
  isDefault: boolean;
  /** The pick button and its deadline, when the viewer may pick. */
  footer?: ReactNode;
}

export default function ScheduleCardView({
  card,
  dueDate,
  penalChargePerDayPaise: perDay,
  originalFirstDay,
  chosen,
  chosenBy,
  isDefault,
  footer,
}: ScheduleCardViewProps) {
  const [main, ...backups] = card.attemptDays;
  return (
    <article
      className={`flex flex-col rounded-lg border px-3 py-3 ${
        chosen ? "border-action bg-info-soft/40 ring-1 ring-action" : "border-line bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1">
        <h4 className="font-semibold text-navy">{card.labels.join(" and ")}</h4>
        <div className="flex gap-1">
          {chosen && <Chip tone="info">{chosenBy === "default" ? "Applied by default" : "Your pick"}</Chip>}
          {!chosen && isDefault && <Chip tone="idle">Standing default</Chip>}
        </div>
      </div>

      <p className="mt-2 text-xl font-semibold">{formatDay(dueDate, main)}</p>
      <p className="text-sm text-muted">
        {backups.length > 0
          ? `Backup on ${backups.map((d) => formatDay(dueDate, d)).join(", ")} if needed`
          : "One attempt, no backup inside your cap"}
      </p>

      <dl className="mt-3 flex flex-col gap-2 border-t border-line pt-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Likelihood on first attempt</dt>
          <dd>
            <Chip tone={BAND_TONE[card.band] ?? "idle"}>{card.band}</Chip>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Days overdue by then</dt>
          <dd className="font-medium">{card.daysOverdue}</dd>
        </div>
        {card.waitingChargePaise !== null && perDay !== null && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">Charges for waiting</dt>
            <dd className="font-medium">
              {formatRupees(card.waitingChargePaise)}{" "}
              <span className="font-normal text-muted">
                ({card.daysOverdue} × {formatRupees(perDay)})
              </span>
            </dd>
          </div>
        )}
        {card.versusOriginal && originalFirstDay !== undefined && (
          <div className="text-muted">
            Against the original first retry on {formatDay(dueDate, originalFirstDay)}:{" "}
            <span className="font-medium text-ink">
              {card.versusOriginal.daysLater === 0
                ? "the same day"
                : `${Math.abs(card.versusOriginal.daysLater)} day${Math.abs(card.versusOriginal.daysLater) === 1 ? "" : "s"} ${card.versusOriginal.daysLater > 0 ? "later" : "earlier"}`}
              {card.versusOriginal.extraChargePaise !== null &&
                card.versusOriginal.extraChargePaise !== 0 &&
                `, ${formatRupees(Math.abs(card.versusOriginal.extraChargePaise))} ${card.versusOriginal.extraChargePaise > 0 ? "more" : "less"}`}
            </span>
          </div>
        )}
      </dl>

      {footer && <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">{footer}</div>}
    </article>
  );
}
