"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "info";
  children: React.ReactNode;
}) {
  const styles = {
    ok: "bg-moss/10 text-moss",
    bad: "bg-rust/10 text-rust",
    info: "bg-white text-ink",
  }[tone];
  return <p className={`rounded-xl px-3 py-2 text-sm ${styles}`}>{children}</p>;
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
}: {
  kicker: string;
  title: string;
  detail: string;
}) {
  return (
    <header className="mb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">{kicker}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-2xl text-muted">{detail}</p>
    </header>
  );
}
