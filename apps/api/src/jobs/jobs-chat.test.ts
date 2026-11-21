import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  historyContent,
  jobChatGate,
  jobChatKind,
  matchJob,
  matchOne,
  matchPeople,
  parseAssignPeople,
  parseCreateJob,
  recheckCard,
  requestText,
  takeProposed,
  trimHistory,
} from "./jobs-chat.js";

const clients = [
  { id: "c1", name: "Harbor Goods", code: "HG", enabledServices: ["jobs"] },
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

  it("matches a client code and a first name, not a substring", () => {
    const byCode = matchOne(clients, "HG", "client");
    assert.equal(byCode.ok, true);
    const last = matchPeople(people, ["Cole"]);
    assert.equal(last.ok, false);
    const job = matchJob(jobs, "100");
    assert.equal(job.ok, false);
    const spaced = matchJob(jobs, "HG 100");
    assert.equal(spaced.ok, true);
  });

  it("refuses a job reference that is already on file", () => {
    const made = parseCreateJob(
      { client_name: "Harbor Goods", reference: "HG-100", title: "Again" },
      { clients, people, jobs, now },
    );
    assert.equal(made.ok, false);
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

describe("jobs chat follows what was asked", () => {
  const made = (args: Record<string, unknown>, asked: string, extra: Record<string, unknown> = {}) =>
    parseCreateJob(args, { clients, people, jobs, now, asked, ...extra });

  it("keeps a typed reference, title, client, crew, and billing", () => {
    const result = made(
      { client_name: "Harbor Goods", reference: "HG-205", title: "Unload 20 pallets", bill_basis: "pallet", people: ["Ada Cole"] },
      "Open job HG-205 for Harbor Goods to unload 20 pallets, bill per pallet, assign Ada Cole",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.jobReference, "HG-205");
    assert.equal(result.card.billBasis, "pallet");
    assert.equal(result.card.people[0]?.employeeId, "p1");
  });

  it("numbers the job when no reference was typed, and refuses an invented one", () => {
    const numbered = made({ client_name: "Harbor Goods", title: "Inbound receiving" }, "Create an inbound receiving job for Harbor Goods");
    assert.equal(numbered.ok, true);
    if (numbered.ok) assert.equal(numbered.card.jobReference, "HG-1001");
    const invented = made({ client_name: "Harbor Goods", reference: "HG-777", title: "Inbound" }, "Create an inbound job for Harbor Goods");
    assert.equal(invented.ok, false);
  });

  it("does not read a work count as the billing method", () => {
    const result = made(
      { client_name: "Harbor Goods", title: "Unload 20 pallets", bill_basis: "pallet" },
      "Create a job for Harbor Goods to unload 20 pallets",
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.card.billBasis, "mixed");
  });

  it("understands hourly as billing by time", () => {
    const result = made({ client_name: "Harbor Goods", title: "Kitting", bill_basis: "hourly" }, "Kitting job for Harbor Goods, hourly");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.card.billBasis, "time");
  });

  it("refuses a made-up title, an unnamed person, and an unnamed client", () => {
    assert.equal(made({ client_name: "Harbor Goods", title: "Inbound freight" }, "Open a job for Harbor Goods").ok, false);
    assert.equal(made({ client_name: "Harbor Goods", title: "Packing", people: ["Ben Cole"] }, "Packing job for Harbor Goods with Ada").ok, false);
    assert.equal(made({ client_name: "Harbor Goods", title: "Packing" }, "Create a packing job").ok, false);
  });

  it("asks when a short name fits two clients or two people", () => {
    const twoClients = [...clients, { id: "c3", name: "Harbor Freight", code: "HF", enabledServices: ["jobs"] }];
    assert.equal(made({ client_name: "Harbor Goods", title: "Packing" }, "Packing job for Harbor", { clients: twoClients }).ok, false);
    const twoAdas = [...people, { id: "p4", name: "Ada Stone", clientId: "c1", active: true }];
    assert.equal(made({ client_name: "HG", title: "Packing", people: ["Ada Cole"] }, "Packing job for HG with Ada", { people: twoAdas }).ok, false);
  });

  it("carries over only a card that is still being changed", () => {
    const card = { jobReference: "HG-9", title: "Inbound", clientName: "Harbor Goods", billBasis: "mixed", people: [{ employeeId: "p1", name: "Ada Cole" }] };
    const waiting = requestText([
      { role: "user", content: "Open HG-9 inbound" },
      { role: "assistant", content: "Press Confirm", jobChange: { ...card, status: "proposed" } },
      { role: "user", content: "add Ben too" },
    ]);
    assert.match(waiting, /HG-9/);
    assert.match(waiting, /Ben/);
    const saved = requestText([
      { role: "user", content: "Open HG-9 inbound" },
      { role: "assistant", content: "Saved", jobChange: { ...card, status: "applied" } },
      { role: "user", content: "open another job" },
    ]);
    assert.doesNotMatch(saved, /HG-9|Ada/);
  });

  it("counts a suggested name only after the person agrees", () => {
    const question = { role: "assistant", content: "Did you mean Harbor Goods?" };
    assert.match(requestText([{ role: "user", content: "Job for Harbour" }, question, { role: "user", content: "yes" }]), /Harbor Goods/);
    assert.doesNotMatch(requestText([{ role: "user", content: "Job for Harbour" }, question, { role: "user", content: "no, Acme" }]), /Harbor Goods/);
  });

  it("starts trimmed history on a user message and shows card status", () => {
    const rows = Array.from({ length: 31 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index) }));
    assert.equal(trimHistory(rows, 24)[0]?.role, "user");
    const line = historyContent({
      role: "assistant",
      content: "Done",
      jobChange: { jobReference: "HG-9", title: "T", clientName: "Harbor Goods", billBasis: "time", people: [], status: "applied" },
    });
    assert.match(line, /Status: applied/);
  });

  it("confirms the exact person by id when two share a name", () => {
    const twins = [
      { id: "s1", name: "Sam", clientId: "c1", active: true },
      { id: "s2", name: "Sam", clientId: "c1", active: true },
    ];
    const card = { kind: "create_job" as const, clientId: "c1", jobId: null, jobReference: "HG-300", people: [{ employeeId: "s2", name: "Sam" }] };
    assert.equal(recheckCard(card, { clients, people: twins, jobs, references: ["HG-100"] }), null);
    assert.match(recheckCard({ ...card, jobReference: "HG 100" }, { clients, people: twins, jobs, references: ["HG-100"] }) ?? "", /already used/);
    assert.match(recheckCard(card, { clients, people: [twins[0]!], jobs, references: [] }) ?? "", /no longer/);
    assert.match(recheckCard(card, { clients, people: twins, jobs, references: [], scopedClientId: "c9" }) ?? "", /one client/);
  });

  it("keeps each client's conversation separate", () => {
    assert.equal(jobChatKind(null), "jobs");
    assert.notEqual(jobChatKind("c1"), jobChatKind("c2"));
  });
});
