import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listPageArgs, nextListPage, recordsOf } from "./warehance-pages.js";

describe("Warehance list pages", () => {
  it("reads clients as well as records", () => {
    assert.equal(recordsOf({ clients: [{ id: 1 }] }).length, 1);
    assert.equal(recordsOf({ data: { records: [{ id: 2 }] } }).length, 1);
  });

  it("follows a numeric or nested next_cursor", () => {
    assert.deepEqual(nextListPage({ next_cursor: 50 }, 50, 50, 0), { cursor: "50" });
    assert.deepEqual(nextListPage({ data: { next_cursor: "abc" } }, 10, 50, 0), { cursor: "abc" });
  });

  it("asks for the next offset when a full page has no cursor", () => {
    assert.deepEqual(nextListPage({ records: [] }, 100, 100, 0), { offset: 100 });
    assert.equal(nextListPage({ records: [] }, 3, 100, 0), null);
  });

  it("sends a numeric cursor as a number", () => {
    assert.deepEqual(listPageArgs(100, "50"), { limit: 100, cursor: 50 });
    assert.deepEqual(listPageArgs(100, "abc"), { limit: 100, cursor: "abc" });
    assert.deepEqual(listPageArgs(100, undefined, 100), { limit: 100, offset: 100 });
  });
});
