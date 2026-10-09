"use client";

// A button that calls one server function and reloads the page. An optional confirm step for
// actions that are hard to undo, such as the kill switch or Reset demo.

import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { useApi } from "./api";

export default function ActionButton({
  route,
  body,
  children,
  confirm,
  variant = "primary",
  disabled,
  title,
  pendingLabel = "Working…",
}: {
  route: string;
  body: Record<string, unknown>;
  children: ReactNode;
  confirm?: string;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  disabled?: boolean;
  title?: string;
  pendingLabel?: string;
}) {
  const { run, pending, error } = useApi();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        disabled={disabled || pending}
        title={title}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          void run(route, body);
        }}
      >
        {pending ? pendingLabel : children}
      </Button>
      {error && (
        <span role="alert" className="max-w-xs text-xs text-failed">
          {error}
        </span>
      )}
    </span>
  );
}
