import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planLaborLines, type ExistingCharge, type LaborSegment } from "./labor-lines.js";

const MIN = 60_000;
const seg = (id: string, ms: number, groupKey = "unload"): LaborSegment => ({
  id,
  ms,
  groupKey,
  label: groupKey === "unload" ? "Unload trailer" : "Sort to carrier",
  rate: { id: "r", rateCents: 2000 },
});
const charge = (id: string, sourceId: string, status = "draft", sourceType = "segment"): ExistingCharge => ({
  id,
  status,
  invoiceId: null,
  sourceType,
  sourceId,
});

describe("labor charges", () => {
  it("puts a pause and resume on one line", () => {
    const plan = planLaborLines([seg("a", 10 * MIN), seg("b", 5 * MIN)], []);
    assert.equal(plan.lines.length, 1);
    assert.equal(plan.lines[0]!.description, "Unload trailer, 15 min");
    assert.equal(plan.lines[0]!.amountCents, 500);
  });

  it("rounds the total, not each short stint", () => {
    const plan = planLaborLines([seg("a", 20_000), seg("b", 20_000)], []);
    assert.equal(plan.lines[0]!.quantity, 1);
    assert.equal(plan.lines[0]!.amountCents, 33);
  });

  it("keeps different work on separate lines", () => {
    assert.equal(planLaborLines([seg("a", MIN), seg("b", MIN, "sort")], []).lines.length, 2);
  });

  it("combines duplicate drafts that already exist", () => {
    const plan = planLaborLines([seg("a", 20_000), seg("b", 20_000)], [charge("c1", "a"), charge("c2", "b")]);
    assert.deepEqual(plan.replace.sort(), ["c1", "c2"]);
    assert.equal(plan.lines.length, 1);
  });

  it("adds new time to the open draft", () => {
    const plan = planLaborLines([seg("a", 5 * MIN), seg("b", 5 * MIN)], [charge("c1", "a", "draft", "labor")]);
    assert.deepEqual(plan.replace, ["c1"]);
    assert.equal(plan.lines[0]!.quantity, 10);
  });

  it("changes nothing when run again", () => {
    const plan = planLaborLines([seg("a", MIN), seg("b", MIN)], [charge("c1", "a,b", "draft", "labor")]);
    assert.deepEqual(plan, { replace: [], lines: [] });
  });

  it("never changes or recharges approved or invoiced time", () => {
    const approved = planLaborLines([seg("a", MIN), seg("b", 2 * MIN)], [charge("c1", "a", "approved")]);
    assert.deepEqual(approved.replace, []);
    assert.equal(approved.lines[0]!.sourceId, "b");
    const invoiced = planLaborLines([seg("a", MIN)], [{ ...charge("c1", "a"), invoiceId: "inv" }]);
    assert.deepEqual(invoiced, { replace: [], lines: [] });
  });
});
