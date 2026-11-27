import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  buildTimecard,
  clipSpans,
  DEFAULT_SETTINGS,
  isMissedCheckOut,
  isTimeZone,
  localDate,
  planShiftEdit,
  startOfLocalDay,
  weekRange,
  weekStartFor,
} from "./timecard.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

describe("weeks and days", () => {
  it("starts the week on the chosen day", () => {
    // 2026-11-27 is a Friday.
    assert.equal(weekStartFor("2026-11-27", 1), "2026-11-23");
    assert.equal(weekStartFor("2026-11-27", 0), "2026-11-22");
    assert.equal(weekStartFor("2026-11-23", 1), "2026-11-23");
    assert.equal(weekStartFor("2026-11-22", 1), "2026-11-16");
    assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  });

  it("finds midnight in the warehouse's zone, across a clock change", () => {
    assert.equal(startOfLocalDay("2026-11-23", LA).toISOString(), "2026-11-23T08:00:00.000Z");
    assert.equal(startOfLocalDay("2026-07-01", LA).toISOString(), "2026-07-01T07:00:00.000Z");
    // US clocks go back on 2026-11-01: that day is 25 hours long.
    assert.equal(startOfLocalDay("2026-11-02", LA).getTime() - startOfLocalDay("2026-11-01", LA).getTime(), 25 * 3600_000);
    const week = weekRange("2026-11-23", LA);
    assert.equal(week.to.getTime() - week.from.getTime(), 7 * 24 * 3600_000);
  });

  it("reads the local date of an instant", () => {
    assert.equal(localDate(at("2026-11-24T06:30:00Z"), LA), "2026-11-23");
    assert.equal(localDate(at("2026-11-24T08:30:00Z"), LA), "2026-11-24");
    assert.equal(isTimeZone(LA), true);
    assert.equal(isTimeZone("Not/AZone"), false);
  });
});

describe("timecard", () => {
  const settings = { ...DEFAULT_SETTINGS, timeZone: LA };

  it("pays the shift minus meals, and flags daily and weekly overtime", () => {
    const shifts = [0, 1, 2, 3, 4].map((day) => ({
      id: `s${day}`,
      // 7:00 to 17:30 local, with a 30 min meal: 10 h paid each day.
      clockIn: new Date(startOfLocalDay(addDays("2026-11-23", day), LA).getTime() + 7 * 3600_000),
      clockOut: new Date(startOfLocalDay(addDays("2026-11-23", day), LA).getTime() + 17.5 * 3600_000),
      source: "station",
    }));
    const meals = shifts.map((shift) => ({
      shiftId: shift.id,
      startedAt: new Date(shift.clockIn.getTime() + 4 * 3600_000),
      endedAt: new Date(shift.clockIn.getTime() + 4.5 * 3600_000),
    }));
    const card = buildTimecard({ weekStart: "2026-11-23", shifts, segments: [], meals, settings, now: at("2026-12-01T00:00:00Z") });
    assert.equal(card.days[0]?.paidMinutes, 600);
    assert.equal(card.days[0]?.mealMinutes, 30);
    assert.equal(card.days[0]?.overtimeMinutes, 120);
    assert.equal(card.paidMinutes, 3000);
    assert.equal(card.dailyOvertimeMinutes, 600);
    assert.equal(card.weeklyOvertimeMinutes, 600);
    assert.equal(card.days[5]?.shifts.length, 0);
  });

  it("uses the settings for the limits", () => {
    const clockIn = new Date(startOfLocalDay("2026-11-23", LA).getTime() + 8 * 3600_000);
    const shift = { id: "a", clockIn, clockOut: new Date(clockIn.getTime() + 7.5 * 3600_000), source: "station" };
    const card = buildTimecard({
      weekStart: "2026-11-23",
      shifts: [shift],
      segments: [],
      meals: [],
      settings: { ...settings, dailyOvertimeMinutes: 7 * 60, weeklyOvertimeMinutes: 7 * 60 },
      now: at("2026-12-01T00:00:00Z"),
    });
    assert.equal(card.dailyOvertimeMinutes, 30);
    assert.equal(card.weeklyOvertimeMinutes, 30);
  });

  it("flags a check-out that never happened", () => {
    const clockIn = new Date(startOfLocalDay("2026-11-23", LA).getTime() + 8 * 3600_000);
    const now = new Date(clockIn.getTime() + 15 * 3600_000);
    const card = buildTimecard({
      weekStart: "2026-11-23",
      shifts: [{ id: "a", clockIn, clockOut: null, source: "station" }],
      segments: [],
      meals: [],
      settings,
      now,
    });
    assert.equal(card.missedCheckOuts, 1);
    assert.equal(card.openShifts, 1);
    // Same day and short: still on shift, not missed.
    assert.equal(isMissedCheckOut({ clockIn, clockOut: null }, new Date(clockIn.getTime() + 3600_000), LA), false);
    // Started yesterday: missed even if under 14 h.
    assert.equal(isMissedCheckOut({ clockIn: new Date(startOfLocalDay("2026-11-23", LA).getTime() + 22 * 3600_000), clockOut: null }, new Date(startOfLocalDay("2026-11-24", LA).getTime() + 3 * 3600_000), LA), true);
  });
});

describe("correcting a punch", () => {
  const now = at("2026-11-27T20:00:00Z");
  const shift = { id: "s1", clockIn: at("2026-11-27T15:00:00Z"), clockOut: null };

  it("closes a missed check-out", () => {
    const plan = planShiftEdit({ shift, clockIn: shift.clockIn, clockOut: at("2026-11-27T19:00:00Z"), others: [], now });
    assert.equal(plan.ok, true);
  });

  it("refuses times that make no sense", () => {
    const bad = (clockIn: string, clockOut: string | null, others: { id: string; clockIn: Date; clockOut: Date | null }[] = []) =>
      planShiftEdit({ shift, clockIn: at(clockIn), clockOut: clockOut ? at(clockOut) : null, others, now });
    assert.match((bad("2026-11-27T15:00:00Z", "2026-11-27T14:00:00Z") as { reason: string }).reason, /after check-in/);
    assert.match((bad("2026-11-27T15:00:00Z", "2026-11-27T23:00:00Z") as { reason: string }).reason, /future/);
    assert.match((bad("2026-11-25T15:00:00Z", "2026-11-26T16:00:00Z") as { reason: string }).reason, /24 hours/);
    const other = { id: "s0", clockIn: at("2026-11-27T10:00:00Z"), clockOut: at("2026-11-27T15:30:00Z") };
    assert.match((bad("2026-11-27T15:00:00Z", "2026-11-27T18:00:00Z", [other]) as { reason: string }).reason, /overlaps/);
    // Touching end to start is fine.
    assert.equal(bad("2026-11-27T15:30:00Z", "2026-11-27T18:00:00Z", [other]).ok, true);
  });

  it("keeps a shift open only if it was open and is the latest", () => {
    const closed = { ...shift, clockOut: at("2026-11-27T18:00:00Z") };
    assert.equal(planShiftEdit({ shift: closed, clockIn: closed.clockIn, clockOut: null, others: [], now }).ok, false);
    const later = { id: "s2", clockIn: at("2026-11-27T19:00:00Z"), clockOut: null };
    assert.equal(planShiftEdit({ shift, clockIn: shift.clockIn, clockOut: null, others: [later], now }).ok, false);
    assert.equal(planShiftEdit({ shift, clockIn: at("2026-11-27T14:00:00Z"), clockOut: null, others: [], now }).ok, true);
  });

  it("keeps task and meal time inside the corrected shift", () => {
    const spans = [
      { id: "a", startedAt: at("2026-11-27T15:00:00Z"), endedAt: at("2026-11-27T16:00:00Z") },
      { id: "b", startedAt: at("2026-11-27T16:00:00Z"), endedAt: at("2026-11-27T18:00:00Z") },
      { id: "c", startedAt: at("2026-11-27T18:30:00Z"), endedAt: null },
    ];
    const changes = clipSpans(spans, at("2026-11-27T15:30:00Z"), at("2026-11-27T17:00:00Z"));
    assert.deepEqual(
      changes.map((row) => [row.id, row.action, row.startedAt.toISOString(), row.endedAt?.toISOString() ?? null]),
      [
        ["a", "update", "2026-11-27T15:30:00.000Z", "2026-11-27T16:00:00.000Z"],
        ["b", "update", "2026-11-27T16:00:00.000Z", "2026-11-27T17:00:00.000Z"],
        ["c", "delete", "2026-11-27T18:30:00.000Z", null],
      ],
    );
    // A running task ends at the new check-out.
    const running = clipSpans([{ id: "r", startedAt: at("2026-11-27T15:00:00Z"), endedAt: null }], at("2026-11-27T15:00:00Z"), at("2026-11-27T19:00:00Z"));
    assert.equal(running[0]?.action, "update");
    assert.equal(running[0]?.endedAt?.toISOString(), "2026-11-27T19:00:00.000Z");
    // Nothing moves when nothing is cut.
    assert.equal(clipSpans([spans[0]!], at("2026-11-27T14:00:00Z"), null)[0]?.action, "keep");
  });
});
