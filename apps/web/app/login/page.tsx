"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ApiError, post, type User } from "@/lib/api";
import { Field, Notice } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("nora@opsengine.local");
  const [password, setPassword] = useState("OpsEngine!dev");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await post<{ user: User }>("/auth/login", { email, password });
      const clientPortal = result.user.role === "external_customer" || result.user.role === "client_services";
      router.push(clientPortal ? "/jobs" : params.get("next") || "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form className="card w-full max-w-md space-y-4 p-6" onSubmit={submit}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Ops Engine</p>
          <h1 className="mt-1 text-2xl font-semibold">Sign in to the floor</h1>
          <p className="mt-2 text-sm text-muted">
            Supervisors watch who is on which task. The QR gate and the floor phone use badges.
          </p>
        </div>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Email">
          <input className="field" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password">
          <input
            className="field"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <button className="btn btn-primary w-full" disabled={pending} type="submit">
          {pending ? "Signing in" : "Sign in"}
        </button>
        <p className="text-sm text-muted">
          Supervisor nora@opsengine.local. IceCartel lina@ or ice@. Jacob owen@ or jacob@. Password OpsEngine!dev.
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
