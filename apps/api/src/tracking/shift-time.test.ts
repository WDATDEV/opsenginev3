import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shiftTime } from "./shift-time.js";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 8, minute));
const split = (result: ReturnType<typeof shiftTime>) => ({
  total: result.totalSeconds / 60,
  task: result.taskSeconds / 60,
  meal: result.mealSeconds / 60,
  paused: result.pausedSeconds / 60,
  unaccounted: result.unaccountedSeconds / 60,
});

describe("shift time", () => {
  it("splits a finished shift into task, meal, and unaccounted time", () => {
    const result = shiftTime(
      { clockIn: at(0), clockOut: at(120) },
      [
        { startedAt: at(10), endedAt: at(50) },
        { startedAt: at(80), endedAt: at(110) },
      ],
      [{ startedAt: at(50), endedAt: at(80) }],
    );
    assert.deepEqual(split(result), { total: 120, task: 70, meal: 30, paused: 0, unaccounted: 20 });
  });

  it("counts an open shift and an open task up to now", () => {
    const result = shiftTime({ clockIn: at(0), clockOut: null }, [{ startedAt: at(15), endedAt: null }], [], at(60));
    assert.deepEqual(split(result), { total: 60, task: 45, meal: 0, paused: 0, unaccounted: 15 });
  });

  it("never counts time outside the shift, overlaps twice, or a task during a meal", () => {
    const result = shiftTime(
      { clockIn: at(10), clockOut: at(70) },
      [
        { startedAt: at(0), endedAt: at(30) },
        { startedAt: at(20), endedAt: at(40) },
        { startedAt: at(60), endedAt: at(90) },
      ],
      [{ startedAt: at(35), endedAt: at(45) }],
    );
    // Tasks 10–40 and 60–70 = 40 min, minus 5 min that fall inside the meal.
    assert.deepEqual(split(result), { total: 60, task: 35, meal: 10, paused: 0, unaccounted: 15 });
  });

  it("is all unaccounted when someone is checked in with no tasks", () => {
    const result = shiftTime({ clockIn: at(0), clockOut: at(30) }, [], []);
    assert.deepEqual(split(result), { total: 30, task: 0, meal: 0, paused: 0, unaccounted: 30 });
  });

  it("counts a pause with a reason until the next task starts", () => {
    const result = shiftTime(
      { clockIn: at(0), clockOut: at(60) },
      [
        { startedAt: at(0), endedAt: at(20), pauseReason: "Waiting for work" },
        { startedAt: at(30), endedAt: at(50) },
      ],
      [],
    );
    assert.deepEqual(split(result), { total: 60, task: 40, meal: 0, paused: 10, unaccounted: 10 });
    assert.deepEqual(result.pauses, [{ reason: "Waiting for work", seconds: 600 }]);
  });

  it("ends a pause at a meal or at check-out, and adds up the same reason", () => {
    const result = shiftTime(
      { clockIn: at(0), clockOut: at(100) },
      [
        { startedAt: at(0), endedAt: at(10), pauseReason: "Restroom" },
        { startedAt: at(15), endedAt: at(30), pauseReason: "Equipment or scanner problem" },
        { startedAt: at(70), endedAt: at(80), pauseReason: "Restroom" },
      ],
      [{ startedAt: at(40), endedAt: at(70) }],
    );
    // Restroom 10–15 and 80–100 (check-out); scanner 30–40 (meal starts).
    assert.deepEqual(split(result), { total: 100, task: 35, meal: 30, paused: 35, unaccounted: 0 });
    assert.deepEqual(result.pauses, [
      { reason: "Restroom", seconds: 1500 },
      { reason: "Equipment or scanner problem", seconds: 600 },
    ]);
  });

  it("keeps a pause running up to now while the shift is open", () => {
    const result = shiftTime({ clockIn: at(0), clockOut: null }, [{ startedAt: at(0), endedAt: at(30), pauseReason: "Short break" }], [], at(45));
    assert.deepEqual(split(result), { total: 45, task: 30, meal: 0, paused: 15, unaccounted: 0 });
  });
});
