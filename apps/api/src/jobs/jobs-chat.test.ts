import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jobChatGate, matchPeople, parseAssignPeople, parseCreateJob, takeProposed } from "./jobs-chat.js";

const clients = [
  { id: "c1", name: "Harbor Goods", enabledServices: ["jobs"] },
  { id: "c2", name: "Hidden Co", hidden: true, enabledServices: ["jobs"] },
];
const people = [
  { id: "p1", name: "Ada Cole", clientId: "c1", active: true },
  { id: "p2", name: "Ben Cole", clientId: "c1", active: true },
  { id: "p3", name: "Other Brand", clientId: "c2", active: true },
];
const jobs = [{ id: "j1", reference: "HG-100", title: "Inbound", clientId: "c1", status: "open" }];
const now = Date.parse("2026-11-16T12:00:00.000Z");

describe("jobs chat cards", () => {
  it("refuses an unknown client, empty job, and a person from another brand", () => {
    const miss = parseCreateJob({ client_name: "Nope", reference: "A", title: "T" }, { clients, people, now });
    assert.equal(miss.ok, false);
    const empty = parseCreateJob({ client_name: "Harbor Goods" }, { clients, people, now });
    assert.equal(empty.ok, false);
    const other = parseCreateJob(
      { client_name: "Harbor Goods", reference: "A1", title: "T", people: ["Other Brand"] },
      { clients, people, now },
    );
    assert.equal(other.ok, false);
  });

  it("builds a create card with crew for a Time tracking client", () => {
    const made = parseCreateJob(
      { client_name: "harbor goods", reference: "HG-9", title: "Five pallets", people: ["Ada"] },
      { clients, people, now },
    );
    assert.equal(made.ok, true);
    if (!made.ok) return;
    assert.equal(made.card.kind, "create_job");
    assert.equal(made.card.clientId, "c1");
    assert.equal(made.card.people[0]?.employeeId, "p1");
    assert.match(made.card.summary, /HG-9/);
  });

  it("refuses a scoped chat that names another client", () => {
    const made = parseCreateJob(
      { client_name: "Harbor Goods", reference: "X", title: "T" },
      { clients, people, now, scopedClientId: "other" },
    );
    assert.equal(made.ok, false);
  });

  it("assigns people to an open job and not a missing one", () => {
    const bad = parseAssignPeople({ job_reference: "NOPE", people: ["Ada"] }, { jobs, people, clients, now });
    assert.equal(bad.ok, false);
    const made = parseAssignPeople({ job_reference: "HG-100", people: ["Ada Cole", "Ben"] }, { jobs, people, clients, now });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    assert.equal(made.card.kind, "assign_people");
    assert.equal(made.card.jobId, "j1");
    assert.equal(made.card.people.length, 2);
  });

  it("does not assign when two people share the name", () => {
    const clash = matchPeople(
      [
        { id: "a", name: "Sam", clientId: "c1" },
        { id: "b", name: "Sam", clientId: "c1" },
      ],
      ["Sam"],
    );
    assert.equal(clash.ok, false);
  });

  it("lets only the first confirm claim the card", () => {
    const box = { status: "proposed" };
    assert.equal(takeProposed(box), true);
    assert.equal(takeProposed(box), false);
  });

  it("blocks a non-manager, expired, or already applied card", () => {
    assert.match(
      jobChatGate({ canManage: false, actorId: "o", threadOwnerId: "o", status: "proposed", expiresAt: new Date(now + 1000).toISOString(), now }) ?? "",
      /manage jobs/,
    );
    assert.match(
      jobChatGate({
        canManage: true,
        actorId: "x",
        threadOwnerId: "o",
        status: "proposed",
        expiresAt: new Date(now + 1000).toISOString(),
        now,
      }) ?? "",
      /someone else/,
    );
    assert.match(
      jobChatGate({ canManage: true, actorId: "o", threadOwnerId: "o", status: "applied", expiresAt: new Date(now + 1000).toISOString(), now }) ?? "",
      /waiting/,
    );
    assert.match(
      jobChatGate({ canManage: true, actorId: "o", threadOwnerId: "o", status: "proposed", expiresAt: new Date(now - 1).toISOString(), now }) ?? "",
      /expired/,
    );
    assert.equal(
      jobChatGate({
        canManage: true,
        actorId: "o",
        threadOwnerId: "o",
        status: "proposed",
        expiresAt: new Date(now + 1000).toISOString(),
        now,
      }),
      null,
    );
  });
});
