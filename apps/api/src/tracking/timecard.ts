/**
 * Weekly timecards: which days a week covers in the warehouse's time zone, paid time per day,
 * overtime warnings, missed check-outs, and the rules for correcting a punch. Pure, so it is tested without a database.
 */
import { shiftTime } from "./shift-time.js";

export type TimekeepingSettings = {
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartsOn: number;
  timeZone: string;
};

export const DEFAULT_SETTINGS: TimekeepingSettings = {
  dailyOvertimeMinutes: 8 * 60,
  weeklyOvertimeMinutes: 40 * 60,
  weekStartsOn: 1,
  timeZone: "UTC",
};

/** An open shift older than this is shown as a missed check-out. Matches the Floor board warning. */
export const MISSED_CHECKOUT_MS = 14 * 60 * 60 * 1000;
/** One shift may not run longer than this, after a correction. */
export const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parts(instant: Date, timeZone: string) {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(fields.find((item) => item.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far the zone is ahead of UTC at that instant, in ms. */
function offsetMs(instant: Date, timeZone: string) {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar date (YYYY-MM-DD) of an instant in the zone. */
export function localDate(instant: Date, timeZone: string) {
  const p = parts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant a calendar date starts in the zone, daylight saving included. */
export function startOfLocalDay(date: string, timeZone: string) {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = guess - offsetMs(new Date(guess), timeZone);
  // The offset can differ at the guessed instant and at the real one around a clock change.
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

export function addDays(date: string, days: number) {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * DAY_MS);
  return next.toISOString().slice(0, 10);
}

function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The first day of the week holding this date. */
export function weekStartFor(date: string, weekStartsOn: number) {
  const back = (weekday(date) - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

export function weekDays(weekStart: string) {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** The instants a week covers: from the first day's start to the day after the last. */
export function weekRange(weekStart: string, timeZone: string) {
  return { from: startOfLocalDay(weekStart, timeZone), to: startOfLocalDay(addDays(weekStart, 7), timeZone) };
}

type Span = { startedAt: Date; endedAt: Date | null };
export type CardShift = { id: string; clockIn: Date; clockOut: Date | null; source: string; edited?: boolean };
export type CardSegment = Span & { shiftId: string; pauseReason?: string | null };
export type CardMeal = Span & { shiftId: string };

export type TimecardDay = {
  date: string;
  shifts: {
    id: string;
    clockIn: Date;
    clockOut: Date | null;
    source: string;
    edited: boolean;
    paidMinutes: number;
    mealMinutes: number;
    missedCheckOut: boolean;
  }[];
  paidMinutes: number;
  mealMinutes: number;
  overtimeMinutes: number;
};

export type Timecard = {
  weekStart: string;
  days: TimecardDay[];
  paidMinutes: number;
  mealMinutes: number;
  /** Over the daily limit, summed across the days. */
  dailyOvertimeMinutes: number;
  /** Over the weekly limit. */
  weeklyOvertimeMinutes: number;
  missedCheckOuts: number;
  openShifts: number;
};

/** A shift that is still open but should not be: older than 14 h, or started on an earlier day. */
export function isMissedCheckOut(shift: { clockIn: Date; clockOut: Date | null }, now: Date, timeZone: string) {
  if (shift.clockOut) return false;
  if (now.getTime() - shift.clockIn.getTime() > MISSED_CHECKOUT_MS) return true;
  return localDate(shift.clockIn, timeZone) < localDate(now, timeZone);
}

/**
 * One person's week. A shift counts on the day it started. Paid time is the shift minus meal breaks;
 * pauses stay paid because the person is still on the clock.
 */
export function buildTimecard(input: {
  weekStart: string;
  shifts: CardShift[];
  segments: CardSegment[];
  meals: CardMeal[];
  settings: TimekeepingSettings;
  now: Date;
}): Timecard {
  const { settings, now } = input;
  const days: TimecardDay[] = weekDays(input.weekStart).map((date) => ({ date, shifts: [], paidMinutes: 0, mealMinutes: 0, overtimeMinutes: 0 }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const sorted = [...input.shifts].sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
  let missedCheckOuts = 0;
  let openShifts = 0;
  for (const shift of sorted) {
    const day = byDate.get(localDate(shift.clockIn, settings.timeZone));
    if (!day) continue;
    const meals = input.meals.filter((row) => row.shiftId === shift.id);
    const time = shiftTime(shift, input.segments.filter((row) => row.shiftId === shift.id), meals, now);
    const paidMinutes = Math.round((time.totalSeconds - time.mealSeconds) / 60);
    const mealMinutes = Math.round(time.mealSeconds / 60);
    const missed = isMissedCheckOut(shift, now, settings.timeZone);
    if (missed) missedCheckOuts += 1;
    if (!shift.clockOut) openShifts += 1;
    day.shifts.push({
      id: shift.id,
      clockIn: shift.clockIn,
      clockOut: shift.clockOut,
      source: shift.source,
      edited: Boolean(shift.edited),
      paidMinutes,
      mealMinutes,
      missedCheckOut: missed,
    });
    day.paidMinutes += paidMinutes;
    day.mealMinutes += mealMinutes;
  }
  for (const day of days) day.overtimeMinutes = Math.max(0, day.paidMinutes - settings.dailyOvertimeMinutes);
  const paidMinutes = days.reduce((sum, day) => sum + day.paidMinutes, 0);
  return {
    weekStart: input.weekStart,
    days,
    paidMinutes,
    mealMinutes: days.reduce((sum, day) => sum + day.mealMinutes, 0),
    dailyOvertimeMinutes: days.reduce((sum, day) => sum + day.overtimeMinutes, 0),
    weeklyOvertimeMinutes: Math.max(0, paidMinutes - settings.weeklyOvertimeMinutes),
    missedCheckOuts,
    openShifts,
  };
}

export type ShiftEditPlan = { ok: true; clockIn: Date; clockOut: Date | null } | { ok: false; reason: string };

/**
 * Checks a manager's correction to one shift. The shift may stay open only if it was open and is the person's latest.
 * It may not end before it starts, sit in the future, run over 24 h, or overlap another of the person's shifts.
 */
export function planShiftEdit(input: {
  shift: { id: string; clockIn: Date; clockOut: Date | null };
  clockIn: Date;
  clockOut: Date | null;
  others: { id: string; clockIn: Date; clockOut: Date | null }[];
  now: Date;
}): ShiftEditPlan {
  const { clockIn, clockOut, now } = input;
  const soon = now.getTime() + 60_000;
  if (Number.isNaN(clockIn.getTime()) || (clockOut && Number.isNaN(clockOut.getTime()))) return { ok: false, reason: "Enter a real date and time." };
  if (clockIn.getTime() > soon) return { ok: false, reason: "Check-in cannot be in the future." };
  if (clockOut && clockOut.getTime() > soon) return { ok: false, reason: "Check-out cannot be in the future." };
  if (clockOut && clockOut.getTime() <= clockIn.getTime()) return { ok: false, reason: "Check-out must be after check-in." };
  if ((clockOut ?? now).getTime() - clockIn.getTime() > MAX_SHIFT_MS) {
    return { ok: false, reason: clockOut ? "One shift can be at most 24 hours." : "This shift would be open over 24 hours. Enter the check-out time." };
  }
  if (!clockOut) {
    if (input.shift.clockOut) return { ok: false, reason: "Enter the check-out time. A finished shift cannot be reopened." };
    if (input.others.some((other) => other.clockIn.getTime() > clockIn.getTime())) {
      return { ok: false, reason: "Only the latest shift can stay open. Enter the check-out time." };
    }
  }
  const end = (clockOut ?? now).getTime();
  for (const other of input.others) {
    if (other.id === input.shift.id) continue;
    const otherEnd = (other.clockOut ?? now).getTime();
    if (clockIn.getTime() < otherEnd && other.clockIn.getTime() < end) {
      return { ok: false, reason: "This overlaps another shift for the same person. Fix that one first." };
    }
  }
  return { ok: true, clockIn, clockOut };
}

export type SpanChange = { id: string; action: "keep" | "update" | "delete"; startedAt: Date; endedAt: Date | null };

/**
 * Keeps task and meal time inside a corrected shift. Time that ends up wholly outside is removed
 * (the edit history keeps a copy); time cut by the new edges is shortened; anything still running ends at check-out.
 */
export function clipSpans(spans: (Span & { id: string })[], clockIn: Date, clockOut: Date | null): SpanChange[] {
  const from = clockIn.getTime();
  const to = clockOut?.getTime() ?? Number.POSITIVE_INFINITY;
  return spans.map((span) => {
    const start = span.startedAt.getTime();
    const end = span.endedAt?.getTime() ?? (clockOut ? to : null);
    const nextStart = Math.max(start, from);
    const nextEnd = end === null ? null : Math.min(end, to);
    if (nextEnd !== null && nextEnd <= nextStart) return { id: span.id, action: "delete", startedAt: span.startedAt, endedAt: span.endedAt };
    const changed = nextStart !== start || (nextEnd ?? null) !== (span.endedAt?.getTime() ?? null);
    return {
      id: span.id,
      action: changed ? "update" : "keep",
      startedAt: new Date(nextStart),
      endedAt: nextEnd === null ? null : new Date(nextEnd),
    };
  });
}
