// Shapes and formatting shared by the Timecards page, the print page, and the floor phone.

export type TimecardSettings = {
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  weekStartsOn: number;
  timeZone: string;
  timeZoneSet: boolean;
};

export type Approval = { approvedAt: string | null; managerName: string | null; employeeConfirmedAt: string | null } | null;

export type CardPerson = {
  id: string;
  name: string;
  badgeCode: string;
  employmentType: string;
  agency: string | null;
  clientId: string | null;
  active: boolean;
};

export type CardShift = {
  id: string;
  clockIn: string;
  clockOut: string | null;
  source: string;
  edited: boolean;
  paidMinutes: number;
  mealMinutes: number;
  missedCheckOut: boolean;
};

export type CardDay = { date: string; shifts: CardShift[]; paidMinutes: number; mealMinutes: number; overtimeMinutes: number };

export type Card = {
  weekStart: string;
  days: CardDay[];
  paidMinutes: number;
  mealMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  missedCheckOuts: number;
  openShifts: number;
};

export const WEEK_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function browserZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today's date in this browser, as YYYY-MM-DD. */
export function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** 7:30 for seven and a half hours. */
export function hm(minutes: number) {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** 7.50 for seven and a half hours, as agencies usually want it. */
export function decimalHours(minutes: number) {
  return (minutes / 60).toFixed(2);
}

export function dayLabel(date: string, style: "short" | "long" = "short") {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: style === "long" ? "long" : "short",
    month: "short",
    day: "numeric",
  });
}

export function weekLabel(weekStart: string) {
  return `${dayLabel(weekStart)} – ${dayLabel(addDays(weekStart, 6))}`;
}

export function timeLabel(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });
}

export function dateTimeLabel(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

/** An instant as the value of an <input type="datetime-local"> in this browser's zone. */
export function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  return value ? new Date(value).toISOString() : null;
}
