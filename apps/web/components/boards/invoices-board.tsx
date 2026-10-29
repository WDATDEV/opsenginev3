"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canApproveCharges, money, post, when } from "@/lib/api";

type InvoiceBook = {
  clientName: string;
  openCents: number;
  paidCents: number;
  readyCents: number;
  invoices: {
    id: string;
    number: string;
    status: string;
    issuedAt: string;
    paidAt: string | null;
    amountCents: number;
    lines: { description: string; amountCents: number }[];
  }[];
};

export function InvoicesBoard({ clientId }: { clientId: string }) {
  const board = useResource<InvoiceBook>(`/clients/${clientId}/invoices`);
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(path: string) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, {});
      setMessage(result.message ?? "Saved.");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that invoice.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Invoices"
        title="Accounts receivable"
        detail="Approved charges become one invoice. Time, pallets, cartons, or SKUs are already chosen on the project. Open invoices are what the client still owes."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {board.data ? (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-3">
            <article className="card p-4">
              <p className="text-sm text-muted">Open</p>
              <p className="font-mono text-2xl">{money(board.data.openCents)}</p>
            </article>
            <article className="card p-4">
              <p className="text-sm text-muted">Paid</p>
              <p className="font-mono text-2xl">{money(board.data.paidCents)}</p>
            </article>
            <article className="card p-4">
              <p className="text-sm text-muted">Approved, not invoiced</p>
              <p className="font-mono text-2xl">{money(board.data.readyCents)}</p>
            </article>
          </section>
          {canApproveCharges(user?.role) ? (
            <button className="btn btn-primary" type="button" onClick={() => void act(`/clients/${clientId}/invoices`)}>
              Make invoice from approved charges
            </button>
          ) : null}
          <div className="space-y-4">
            {board.data.invoices.length === 0 ? <p className="text-muted">No invoices yet.</p> : null}
            {board.data.invoices.map((invoice) => (
              <article key={invoice.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-mono text-lg font-semibold">{invoice.number}</h2>
                    <p className="text-sm capitalize text-muted">
                      {invoice.status} · {when(invoice.issuedAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">{money(invoice.amountCents)}</p>
                    {canApproveCharges(user?.role) && invoice.status === "open" ? (
                      <button className="btn btn-ghost mt-2" type="button" onClick={() => void act(`/billing/invoices/${invoice.id}/paid`)}>
                        Mark paid
                      </button>
                    ) : null}
                  </div>
                </div>
                <ul className="mt-3 space-y-1 text-sm">
                  {invoice.lines.map((line, index) => (
                    <li key={`${invoice.id}-${index}`} className="flex justify-between gap-3">
                      <span>{line.description}</span>
                      <span>{money(line.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
