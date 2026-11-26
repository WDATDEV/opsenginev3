type Span = { startedAt: Date; endedAt: Date | null };
type Segment = Span & { pauseReason?: string | null };
type Part = [number, number];

export type ShiftTime = {
  totalSeconds: number;
  taskSeconds: number;
  mealSeconds: number;
  /** Paused with a reason given at the station. */
  pausedSeconds: number;
  pauses: { reason: string; seconds: number }[];
  /** Checked in, not on a task, a meal, or a pause with a reason: dead time. */
  unaccountedSeconds: number;
};

// Clips spans to the shift and merges overlaps, so no second is counted twice.
function merged(spans: Span[], from: number, to: number): Part[] {
  const parts = spans
    .map((span) => [Math.max(from, span.startedAt.getTime()), Math.min(to, span.endedAt?.getTime() ?? to)] as Part)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const out: Part[] = [];
  for (const [start, end] of parts) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function length(parts: Part[]) {
  return parts.reduce((sum, [start, end]) => sum + (end - start), 0);
}

function overlap(a: Part[], b: Part[]) {
  let total = 0;
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) total += Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }
  return total;
}

// A pause runs from when the task was paused until the next task starts, a meal starts, or the shift ends.
function pauseSpans(segments: Segment[], meals: Span[], to: number) {
  const starts = [...segments.map((row) => row.startedAt.getTime()), ...meals.map((row) => row.startedAt.getTime())];
  return segments
    .filter((row) => row.pauseReason && row.endedAt)
    .map((row) => {
      const from = row.endedAt!.getTime();
      const next = Math.min(to, ...starts.filter((at) => at >= from && at !== row.startedAt.getTime()));
      return { reason: row.pauseReason!, startedAt: new Date(from), endedAt: new Date(Math.max(from, next)) };
    });
}

/** Splits a shift (check-in to check-out, or to now) into task, meal, paused, and unaccounted time. */
export function shiftTime(shift: { clockIn: Date; clockOut: Date | null }, tasks: Segment[], meals: Span[], now = new Date()): ShiftTime {
  const from = shift.clockIn.getTime();
  const to = Math.max(from, (shift.clockOut ?? now).getTime());
  const mealParts = merged(meals, from, to);
  const taskParts = merged(tasks, from, to);
  const mealMs = length(mealParts);
  // A task left running over a meal does not count twice; the meal wins.
  const taskMs = Math.max(0, length(taskParts) - overlap(taskParts, mealParts));

  const pauses = pauseSpans(tasks, meals, to);
  const byReason = new Map<string, number>();
  let pausedMs = 0;
  for (const pause of pauses) {
    const parts = merged([pause], from, to);
    const ms = Math.max(0, length(parts) - overlap(parts, mealParts) - overlap(parts, taskParts));
    if (ms <= 0) continue;
    pausedMs += ms;
    byReason.set(pause.reason, (byReason.get(pause.reason) ?? 0) + ms);
  }

  const seconds = (ms: number) => Math.round(ms / 1000);
  const totalSeconds = seconds(to - from);
  const taskSeconds = seconds(taskMs);
  const mealSeconds = seconds(mealMs);
  const pausedSeconds = seconds(pausedMs);
  return {
    totalSeconds,
    taskSeconds,
    mealSeconds,
    pausedSeconds,
    pauses: [...byReason.entries()]
      .map(([reason, ms]) => ({ reason, seconds: seconds(ms) }))
      .sort((a, b) => b.seconds - a.seconds),
    unaccountedSeconds: Math.max(0, totalSeconds - taskSeconds - mealSeconds - pausedSeconds),
  };
}
