import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jobWorkCodes, workFitsJob } from "./job-work.js";

describe("work a job is for", () => {
  it("reads the work from the job title", () => {
    assert.deepEqual(jobWorkCodes("Unload 20 pallets"), ["unload_trailer"]);
    assert.deepEqual(jobWorkCodes("Relabel 500 cartons"), ["labeling"]);
    assert.deepEqual(jobWorkCodes("Kit 300 boxes"), ["kitting"]);
  });

  it("keeps every kind of work a title names", () => {
    assert.deepEqual(jobWorkCodes("Unload and sort the truck"), ["unload_trailer", "sort_gaylord"]);
  });

  it("does not match part of a longer word", () => {
    assert.equal(jobWorkCodes("Packaging review for kitchen stock"), null);
  });

  it("adds the work on the job's tasks", () => {
    assert.deepEqual(jobWorkCodes("Unload 20 pallets", ["putaway", null]), ["unload_trailer", "putaway"]);
    assert.deepEqual(jobWorkCodes("Morning help", ["jb_kitting"]), ["jb_kitting"]);
  });

  it("allows only the job's work, or anything when the job does not say", () => {
    const codes = jobWorkCodes("Unload 20 pallets");
    assert.equal(workFitsJob("unload_trailer", codes), true);
    assert.equal(workFitsJob("pack_orders", codes), false);
    assert.equal(workFitsJob("pack_orders", jobWorkCodes("Wrap 10 pallets")), true);
  });
});
