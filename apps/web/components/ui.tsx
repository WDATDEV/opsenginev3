"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** Small help text under the control. */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink/80">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs leading-5 text-muted">{hint}</span> : null}
    </div>
  );
}

/** Text input for counts and prices so typing is not blocked by browser number controls. */
export function CountInput({
  value,
  onChange,
  decimal,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  decimal?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      className="field min-w-0 flex-1"
      type="text"
      inputMode={decimal ? "decimal" : "numeric"}
      autoComplete="off"
      placeholder={placeholder}
      value={value}
      onChange={(event) => {
        const next = event.target.value.replace(decimal ? /[^\d.]/g : /\D/g, "");
        if (!decimal) {
          onChange(next);
          return;
        }
        const [whole = "", ...rest] = next.split(".");
        onChange(rest.length > 0 ? `${whole}.${rest.join("").slice(0, 2)}` : whole);
      }}
    />
  );
}

export function asCount(value: string, fallback = 0) {
  if (value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const NOTICE_ICONS = {
  ok: <path d="m5 10.5 3.2 3.2L15 6.8" />,
  bad: <path d="M10 6v5M10 14h.01" />,
  info: <path d="M10 9v5M10 6h.01" />,
  warn: <path d="M10 6v5M10 14h.01" />,
};

export function Notice({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "info" | "warn";
  children: React.ReactNode;
}) {
  const styles = {
    warn: "border-clay/25 bg-clay/10 text-clay",
    ok: "border-moss/20 bg-moss/10 text-moss",
    bad: "border-rust/20 bg-rust/10 text-rust",
    info: "border-black/10 bg-white text-ink",
  }[tone];
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm ${styles}`}>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-none" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="8" />
        {NOTICE_ICONS[tone]}
      </svg>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));

  const reload = useCallback(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api<T>(path)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not load this board.");
      })
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export function PageTitle({
  kicker,
  title,
  detail,
  actions,
}: {
  kicker: string;
  title: string;
  detail: string;
  /** Buttons that sit on the right of the heading. */
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-enter mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">{kicker}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-6 text-muted">{detail}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------- small building blocks

export function Badge({
  tone = "neutral",
  dot,
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad";
  /** Shows a small colored dot before the text. */
  dot?: boolean;
  children: React.ReactNode;
}) {
  const cls = { neutral: "", ok: "badge-ok", warn: "badge-warn", bad: "badge-bad" }[tone];
  return (
    <span className={`badge ${cls}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="spinner" aria-hidden="true" />
      {label ?? <span className="sr-only">Loading</span>}
    </span>
  );
}

/** Grey placeholder rows while a list loads. */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton h-20" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-moss/10 text-moss">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 13.5z" />
          <path d="m3.5 6 6.5 5 6.5-5" />
        </svg>
      </span>
      <p className="font-semibold">{title}</p>
      {children ? <div className="max-w-md text-sm leading-6 text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}

/** A labelled on/off switch. */
export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" role="switch" className="switch mt-0.5" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-5 text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Two letters from a name or an email, for the round avatars. */
export function initials(text: string) {
  const words = text
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = (words[0]?.[0] ?? "?") + (words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : (words[0]?.[1] ?? ""));
  return letters.toUpperCase();
}

/** "5 min ago", "Yesterday", or a short date. */
export function timeAgo(iso: string) {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
