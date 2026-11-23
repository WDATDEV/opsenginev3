import { createHash } from "node:crypto";

export type LaborSegment = {
  id: string;
  ms: number;
  // Same work at the same price. Pauses and resumes of that work land on one line.
  groupKey: string;
  label: string;
  rate: { id?: string | null; rateCents: number };
};

export type ExistingCharge = {
  id: string;
  status: string;
  invoiceId: string | null;
  sourceType: string;
  sourceId: string;
};

export type LaborLine = {
  description: string;
  quantity: number;
  amountCents: number;
  rate: LaborSegment["rate"];
  sourceId: string;
  idempotencyKey: string;
};

const isLabor = (charge: ExistingCharge) => charge.sourceType === "segment" || charge.sourceType === "labor";
const idsOf = (charge: ExistingCharge) => charge.sourceId.split(",");

/**
 * One draft line per kind of work. Approved or invoiced charges are never touched, and their
 * time is never charged again. Rounding happens on the total, so short stints are not rounded up one by one.
 */
export function planLaborLines(rows: LaborSegment[], existing: ExistingCharge[]) {
  const labor = existing.filter(isLabor);
  const editable = labor.filter((charge) => charge.status === "draft" && !charge.invoiceId);
  const locked = new Set(labor.filter((charge) => !editable.includes(charge)).flatMap(idsOf));
  const groups = new Map<string, LaborSegment[]>();
  for (const row of rows) {
    if (locked.has(row.id)) continue;
    groups.set(row.groupKey, [...(groups.get(row.groupKey) ?? []), row]);
  }

  const replace = new Set<string>();
  const lines: LaborLine[] = [];
  for (const group of groups.values()) {
    const ids = group.map((row) => row.id).sort();
    const drafts = editable.filter((charge) => idsOf(charge).some((id) => ids.includes(id)));
    const unchanged = drafts.length === 1 && [...idsOf(drafts[0]!)].sort().join(",") === ids.join(",");
    if (unchanged) continue;
    for (const charge of drafts) replace.add(charge.id);
    const first = group[0]!;
    const minutes = Math.max(1, Math.round(group.reduce((sum, row) => sum + row.ms, 0) / 60_000));
    const sourceId = ids.join(",");
    lines.push({
      description: `${first.label}, ${minutes} min`,
      quantity: minutes,
      amountCents: Math.round((minutes * first.rate.rateCents) / 60),
      rate: first.rate,
      sourceId,
      idempotencyKey: `labor:${createHash("sha256").update(sourceId).digest("hex")}`,
    });
  }
  return { replace: [...replace], lines };
}
