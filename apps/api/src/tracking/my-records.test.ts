import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shiftWork } from "./my-records.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 8, minutes));
const titles = { task: new Map([["t1", "Unload truck"]]), activity: new Map([["PACK", "Packing"]]) };

describe("shiftWork", () => {
  it("adds up each task across pauses and names it", () => {
    const work = shiftWork(
      [
        { note: "t1", taskCode: "UNLOAD", startedAt: at(0), endedAt: at(20) },
        { note: null, taskCode: "PACK", startedAt: at(25), endedAt: at(35) },
        { note: "t1", taskCode: "UNLOAD", startedAt: at(40), endedAt: at(50) },
      ],
      titles,
      at(60),
    );
    assert.deepEqual(work, [
      { title: "Unload truck", seconds: 30 * 60 },
      { title: "Packing", seconds: 10 * 60 },
    ]);
  });

  it("counts a running task up to now and names manager-added time", () => {
    const work = shiftWork(
      [
        { note: "Added by a manager for Sort mail", taskCode: "SORT", startedAt: at(0), endedAt: at(5) },
        { note: null, taskCode: "ODD", startedAt: at(10), endedAt: null },
      ],
      titles,
      at(30),
    );
    assert.deepEqual(work, [
      { title: "ODD", seconds: 20 * 60 },
      { title: "Sort mail", seconds: 5 * 60 },
    ]);
  });
});
