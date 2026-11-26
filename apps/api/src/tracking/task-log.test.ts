import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskLog } from "./task-log.js";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 8, minute));
const seg = (id: string, from: number, to: number | null, extra: Partial<{ endReason: string; pauseReason: string; note: string }> = {}) => ({
  id,
  shiftId: "s1",
  startedAt: at(from),
  endedAt: to == null ? null : at(to),
  endReason: extra.endReason ?? null,
  pauseReason: extra.pauseReason ?? null,
  note: extra.note ?? "task-1",
});

describe("task log", () => {
  it("lists work, a pause with its reason, a meal, and the totals in order", () => {
    const mine = [
      seg("a", 0, 20, { endReason: "pause", pauseReason: "Waiting for work" }),
      seg("b", 30, 60, { endReason: "meal" }),
      seg("c", 90, 120, { endReason: "complete" }),
    ];
    const log = taskLog({
      taskSegments: mine,
      allSegments: mine,
      meals: [{ shiftId: "s1", startedAt: at(60), endedAt: at(90) }],
      shifts: [{ id: "s1", clockOut: at(130) }],
      now: at(200),
    });
    assert.deepEqual(
      log.entries.map((item) => [item.kind, item.seconds / 60, item.kind === "pause" ? item.reason : item.kind === "work" ? item.ended : null]),
      [
        ["work", 20, "Paused"],
        ["pause", 10, "Waiting for work"],
        ["work", 30, "Meal break"],
        ["meal", 30, null],
        ["work", 30, "Finished"],
      ],
    );
    assert.equal(log.totals.workSeconds / 60, 80);
    assert.equal(log.totals.pausedSeconds / 60, 10);
    assert.equal(log.totals.mealSeconds / 60, 30);
    assert.equal(log.totals.sessions, 3);
    assert.equal(log.totals.now, null);
    assert.deepEqual(log.totals.lastEnd, at(120));
  });

  it("ends a pause when the person starts other work, and keeps an open pause running", () => {
    const mine = [seg("a", 0, 10, { endReason: "pause", pauseReason: "Restroom" }), seg("b", 40, 50, { endReason: "pause", pauseReason: "Short break" })];
    const other = seg("x", 25, 35, { endReason: "switch", note: "task-2" });
    const log = taskLog({ taskSegments: mine, allSegments: [...mine, other], meals: [], shifts: [{ id: "s1", clockOut: null }], now: at(70) });
    const pauses = log.entries.filter((item) => item.kind === "pause");
    assert.deepEqual(pauses.map((item) => item.seconds / 60), [15, 20]);
    assert.equal(pauses[1]?.endedAt, null);
    assert.equal(log.totals.now, "paused");
    assert.deepEqual(log.totals.pauses, [
      { reason: "Short break", seconds: 1200 },
      { reason: "Restroom", seconds: 900 },
    ]);
  });

  it("ends a pause at check-out and marks manager-added time", () => {
    const mine = [seg("a", 0, 30, { endReason: "pause", pauseReason: "Equipment or scanner problem" }), seg("m", 100, 110, { endReason: "complete", note: "Added by a manager for Pack" })];
    const log = taskLog({ taskSegments: mine, allSegments: mine, meals: [], shifts: [{ id: "s1", clockOut: at(45) }], now: at(200) });
    assert.equal(log.entries[1]?.seconds, 15 * 60);
    assert.equal(log.entries[2]?.kind === "work" && log.entries[2].addedByManager, true);
  });

  it("shows someone still working with no end", () => {
    const mine = [seg("a", 0, null)];
    const log = taskLog({ taskSegments: mine, allSegments: mine, meals: [], shifts: [{ id: "s1", clockOut: null }], now: at(25) });
    assert.equal(log.totals.now, "working");
    assert.equal(log.totals.workSeconds, 25 * 60);
    assert.equal(log.totals.lastEnd, null);
  });
});
