type Segment = {
  id: string;
  shiftId: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  pauseReason: string | null;
  note: string | null;
};
type Meal = { shiftId: string; startedAt: Date; endedAt: Date | null };
type Shift = { id: string; clockOut: Date | null };

export type TaskLogEntry =
  | { kind: "work"; startedAt: Date; endedAt: Date | null; seconds: number; ended: string | null; addedByManager: boolean }
  | { kind: "pause"; startedAt: Date; endedAt: Date | null; seconds: number; reason: string }
  | { kind: "meal"; startedAt: Date; endedAt: Date | null; seconds: number };

export type TaskLog = {
  entries: TaskLogEntry[];
  totals: {
    workSeconds: number;
    pausedSeconds: number;
    mealSeconds: number;
    pauses: { reason: string; seconds: number }[];
    sessions: number;
    firstStart: Date | null;
    lastEnd: Date | null;
    now: "working" | "paused" | "meal" | null;
  };
};

const ENDED: Record<string, string> = {
  complete: "Finished",
  pause: "Paused",
  meal: "Meal break",
  switch: "Switched to other work",
  clock_out: "Checked out",
};

// Meals that a work stretch ran into: the break in the same shift that starts when the stretch ends.
const NEAR_MS = 2 * 60_000;

/**
 * One person's timeline on one task: each stretch of work, each pause with its reason, and meal breaks.
 * `taskSegments` are the task's own stretches; `allSegments` are all of that person's stretches, used to see
 * when a pause ended (the next thing they started).
 */
export function taskLog(input: {
  taskSegments: Segment[];
  allSegments: Segment[];
  meals: Meal[];
  shifts: Shift[];
  now?: Date;
}): TaskLog {
  const now = input.now ?? new Date();
  const shiftEnd = new Map(input.shifts.map((row) => [row.id, row.clockOut]));
  const starts = [
    ...input.allSegments.map((row) => row.startedAt.getTime()),
    ...input.meals.map((row) => row.startedAt.getTime()),
  ];
  const seconds = (from: Date, to: Date | null) => Math.max(0, Math.round(((to ?? now).getTime() - from.getTime()) / 1000));
  const entries: TaskLogEntry[] = [];
  const sorted = [...input.taskSegments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  for (const row of sorted) {
    entries.push({
      kind: "work",
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      seconds: seconds(row.startedAt, row.endedAt),
      ended: row.endedAt ? ENDED[row.endReason ?? ""] ?? "Stopped" : null,
      addedByManager: Boolean(row.note?.startsWith("Added by a manager")),
    });
    if (!row.endedAt) continue;
    const from = row.endedAt.getTime();

    if (row.pauseReason) {
      const after = starts.filter((at) => at >= from && at !== row.startedAt.getTime());
      const out = shiftEnd.get(row.shiftId);
      const until = Math.min(...after, out ? out.getTime() : Infinity);
      const endedAt = Number.isFinite(until) ? new Date(Math.max(from, until)) : null;
      entries.push({ kind: "pause", startedAt: row.endedAt, endedAt, seconds: seconds(row.endedAt, endedAt), reason: row.pauseReason });
    } else if (row.endReason === "meal") {
      const meal = input.meals.find((item) => item.shiftId === row.shiftId && Math.abs(item.startedAt.getTime() - from) <= NEAR_MS);
      if (meal) entries.push({ kind: "meal", startedAt: meal.startedAt, endedAt: meal.endedAt, seconds: seconds(meal.startedAt, meal.endedAt) });
    }
  }

  const work = entries.filter((item) => item.kind === "work");
  const pauses = entries.filter((item): item is Extract<TaskLogEntry, { kind: "pause" }> => item.kind === "pause");
  const meals = entries.filter((item) => item.kind === "meal");
  const byReason = new Map<string, number>();
  for (const pause of pauses) byReason.set(pause.reason, (byReason.get(pause.reason) ?? 0) + pause.seconds);
  const last = entries[entries.length - 1];
  const ends = entries.map((item) => item.endedAt).filter((at): at is Date => Boolean(at));

  return {
    entries,
    totals: {
      workSeconds: work.reduce((sum, item) => sum + item.seconds, 0),
      pausedSeconds: pauses.reduce((sum, item) => sum + item.seconds, 0),
      mealSeconds: meals.reduce((sum, item) => sum + item.seconds, 0),
      pauses: [...byReason.entries()].map(([reason, total]) => ({ reason, seconds: total })).sort((a, b) => b.seconds - a.seconds),
      sessions: work.length,
      firstStart: entries[0]?.startedAt ?? null,
      lastEnd: last && !last.endedAt ? null : ends.length ? new Date(Math.max(...ends.map((at) => at.getTime()))) : null,
      now: last && !last.endedAt ? (last.kind === "work" ? "working" : last.kind === "pause" ? "paused" : "meal") : null,
    },
  };
}
