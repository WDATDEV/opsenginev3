"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ApiError, post, type User } from "@/lib/api";
import { Field, Notice, Spinner } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("owner@opsengine.local");
  const [password, setPassword] = useState("");
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
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel. Hidden on small screens so the form comes first. */}
      <section className="relative hidden overflow-hidden bg-moss p-12 text-paper lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10" aria-hidden="true" />
        <div className="absolute -bottom-32 -left-16 h-[28rem] w-[28rem] rounded-full bg-black/10" aria-hidden="true" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-paper text-lg font-bold text-moss">O</span>
          <span className="text-xl font-semibold tracking-tight">Ops Engine</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">Run the floor and the inbox from one place.</h2>
          <p className="mt-4 text-lg leading-7 text-paper/80">See who is working on what, and let Claude draft the replies while your team stays in control.</p>
        </div>
        <p className="relative text-sm text-paper/60">Drafts are reviewed by a person. Nothing is sent on its own.</p>
      </section>

      <section className="grid place-items-center px-4 py-10">
        <form className="page-enter w-full max-w-sm space-y-5" onSubmit={submit}>
          <div className="flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-moss font-bold text-paper">O</span>
            <span className="text-lg font-semibold tracking-tight">Ops Engine</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1.5 text-sm text-muted">Sign in to continue.</p>
          </div>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="Email">
            <input className="field" type="email" autoComplete="username" autoFocus value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Password">
            <input className="field" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <button className="btn btn-primary w-full" disabled={pending || !email || !password} type="submit">
            {pending ? <Spinner /> : null}
            {pending ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
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
