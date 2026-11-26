/** What one shift was spent on, for the person's own past records. Pure, so it is tested without a database. */

type Segment = { note: string | null; taskCode: string; startedAt: Date; endedAt: Date | null };

const MANUAL = "Added by a manager for ";

/** Time per task in one shift, longest first. Time a manager added is named after its task. */
export function shiftWork(rows: Segment[], titles: { task: Map<string, string>; activity: Map<string, string> }, now: Date) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const title = row.note?.startsWith(MANUAL)
      ? row.note.slice(MANUAL.length)
      : (row.note ? titles.task.get(row.note) : null) ?? titles.activity.get(row.taskCode) ?? row.taskCode;
    const seconds = Math.max(0, Math.round(((row.endedAt ?? now).getTime() - row.startedAt.getTime()) / 1000));
    totals.set(title, (totals.get(title) ?? 0) + seconds);
  }
  return [...totals.entries()].map(([title, seconds]) => ({ title, seconds })).sort((a, b) => b.seconds - a.seconds);
}
