"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Flash, Notice, PageTitle, Panel, Segmented, SkeletonList, Stat, StatGrid, useResource } from "@/components/ui";
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

type View = "open" | "paid" | "all";

const VIEWS = [
  ["open", "Open"],
  ["paid", "Paid"],
  ["all", "All"],
] as const;

export function InvoicesBoard({ clientId }: { clientId: string }) {
  const board = useResource<InvoiceBook>(`/clients/${clientId}/invoices`);
  const user = useSession();
  const approve = canApproveCharges(user?.role);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("open");

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

  const data = board.data;
  const list = (data?.invoices ?? []).filter((invoice) => view === "all" || (view === "open" ? invoice.status === "open" : invoice.status !== "open"));

  return (
    <div>
      <PageTitle
        kicker="Invoices"
        title="Accounts receivable"
        detail="Approved charges become one invoice. Open invoices are what the client still owes."
        actions={
          approve && data ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={data.readyCents <= 0}
              title={data.readyCents <= 0 ? "There are no approved charges to invoice." : undefined}
              onClick={() => {
                if (window.confirm(`Make one invoice for ${money(data.readyCents)} of approved charges?`)) void act(`/clients/${clientId}/invoices`);
              }}
            >
              Make invoice{data.readyCents > 0 ? ` · ${money(data.readyCents)}` : ""}
            </button>
          ) : null
        }
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      {board.loading && !data ? <SkeletonList rows={3} /> : null}
      {data ? (
        <>
          <StatGrid columns={3}>
            <Stat label="Open" value={money(data.openCents)} tone={data.openCents > 0 ? "warn" : undefined} note="still owed" />
            <Stat label="Paid" value={money(data.paidCents)} tone="ok" />
            <Stat label="Ready to invoice" value={money(data.readyCents)} note="approved charges" />
          </StatGrid>
          <Panel title="Invoices" count={list.length} actions={<Segmented label="Show invoices" options={VIEWS} value={view} onChange={setView} />}>
            {list.length === 0 ? <EmptyRow title={view === "paid" ? "No paid invoices" : view === "open" ? "No open invoices" : "No invoices yet"}>Invoices appear here once approved charges are billed.</EmptyRow> : null}
            <ul className="divide-y divide-black/5">
              {list.map((invoice) => (
                <li key={invoice.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3.5 hover:bg-black/[0.02] sm:px-5 [&::-webkit-details-marker]:hidden">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 flex-none text-muted transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m8 5 5 5-5 5" />
                        </svg>
                        <span className="min-w-0">
                          <span className="block truncate font-mono font-semibold">{invoice.number}</span>
                          <span className="block text-xs text-muted">
                            Issued {new Date(invoice.issuedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                            {invoice.paidAt ? ` · paid ${when(invoice.paidAt)}` : ""}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <Badge tone={invoice.status === "open" ? "warn" : "ok"} dot>
                          <span className="capitalize">{invoice.status}</span>
                        </Badge>
                        <span className="font-mono font-medium tabular-nums">{money(invoice.amountCents)}</span>
                      </span>
                    </summary>
                    <div className="border-t border-black/5 bg-black/[0.015] px-4 py-3 sm:px-5">
                      <ul className="space-y-1.5 text-sm">
                        {invoice.lines.map((line, index) => (
                          <li key={`${invoice.id}-${index}`} className="flex justify-between gap-3">
                            <span className="min-w-0">{line.description}</span>
                            <span className="flex-none font-mono tabular-nums">{money(line.amountCents)}</span>
                          </li>
                        ))}
                      </ul>
                      {approve && invoice.status === "open" ? (
                        <button
                          className="btn btn-sm mt-3"
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Mark ${invoice.number} for ${money(invoice.amountCents)} as paid?`)) void act(`/billing/invoices/${invoice.id}/paid`);
                          }}
                        >
                          Mark paid
                        </button>
                      ) : null}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
