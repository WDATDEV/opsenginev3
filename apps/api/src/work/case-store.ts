import { activity, caseNotes, cases, type Database } from "@opsengine/db";

type NewCase = typeof cases.$inferInsert;

export const CASE_KIND_LABELS: Record<string, string> = {
  receiving_discrepancy: "Receiving discrepancy",
  damage: "Damage",
  missort: "Missort",
  inventory_discrepancy: "Inventory discrepancy",
  employee_error: "Employee error",
  system_exception: "System exception",
  other: "Other problem",
};

/** Opens a case with its first note (and photo) in the caller's transaction. Used by managers, the floor, and system checks. */
export async function openCase(
  conn: Database,
  values: NewCase,
  first: { authorName: string; authorUserId?: string | null; authorEmployeeId?: string | null; text?: string | null; photo?: string | null },
) {
  const [created] = await conn.insert(cases).values(values).returning();
  if (!created) throw new Error("Could not open that case.");
  await conn.insert(caseNotes).values({
    caseId: created.id,
    authorName: first.authorName,
    authorUserId: first.authorUserId ?? null,
    authorEmployeeId: first.authorEmployeeId ?? null,
    text: first.text ?? `Opened: ${created.title}`,
    photo: first.photo ?? null,
    system: false,
  });
  await conn.insert(activity).values({
    actorId: first.authorUserId ?? null,
    action: "work.case_opened",
    module: "work",
    entityType: "case",
    entityId: created.id,
    after: { summary: `${first.authorName} opened a ${CASE_KIND_LABELS[created.kind] ?? created.kind} case: ${created.title}` },
  });
  return created;
}
