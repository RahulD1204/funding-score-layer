// Small display pieces shared by every screen and the engine preview.

import type { ReactNode } from "react";
import type { Tone } from "@/lib/demo/words";

const TONE_CLASS: Record<Tone, string> = {
  paid: "bg-paid-soft text-paid",
  waiting: "bg-waiting-soft text-waiting",
  info: "bg-info-soft text-info",
  idle: "bg-idle-soft text-idle",
  failed: "bg-failed-soft text-failed",
};

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function Panel({
  title,
  aside,
  children,
  tone = "plain",
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  tone?: "plain" | "internal";
}) {
  const frame =
    tone === "internal" ? "border-navy/30 bg-[#f1f5fb]" : "border-line bg-white";
  return (
    <section className={`rounded-lg border ${frame}`}>
      {(title || aside) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          {title && <h3 className="text-sm font-semibold text-navy">{title}</h3>}
          {aside}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  title?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-action text-white hover:bg-action-dark disabled:bg-idle-soft disabled:text-muted",
    secondary: "border border-line bg-white text-ink hover:bg-canvas disabled:text-muted",
    quiet: "text-action hover:underline disabled:text-muted disabled:no-underline",
    danger: "bg-failed text-white hover:bg-[#991b1b] disabled:bg-idle-soft disabled:text-muted",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${styles}`}
    >
      {children}
    </button>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}
