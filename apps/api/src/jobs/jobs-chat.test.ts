import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  historyContent,
  jobChatGate,
  jobChatKind,
  matchJob,
  matchOne,
  matchPeople,
  parseAddTasks,
  parseAssignPeople,
  parseCreateJob,
  parseEditJob,
  recheckCard,
  requestText,
  reviseCard,
  sessionSummary,
  sessionTitle,
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

describe("editing jobs from chat", () => {
  const crewJob = {
    id: "j1",
    reference: "HG-100",
    title: "Unload 20 pallets",
    clientId: "c1",
    status: "open",
    billBasis: "mixed",
    crew: [{ employeeId: "p1", name: "Ada Cole" }],
  };
  const catalog = { clients, people, jobs: [crewJob], references: ["HG-100", "HG-200"], now };
  const asking = (asked: string) => ({ ...catalog, asked });

  it("changes only what was asked", () => {
    const out = parseEditJob({ job_reference: "HG-100", new_title: "Unload 30 pallets", bill_basis: "pallet" }, asking("change HG-100 to 30 pallets and bill per pallet"));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.card.kind, "edit_job");
    assert.equal(out.card.title, "Unload 30 pallets");
    assert.equal(out.card.billBasis, "pallet");
    assert.equal(out.card.jobReference, "HG-100");
    assert.deepEqual(out.card.before, { reference: "HG-100", title: "Unload 20 pallets", billBasis: "mixed" });
  });

  it("refuses words, billing, or a reference the person did not say", () => {
    assert.equal(parseEditJob({ job_reference: "HG-100", new_title: "Unload 40 pallets" }, asking("change HG-100 to 30 pallets")).ok, false);
    assert.equal(parseEditJob({ job_reference: "HG-100", bill_basis: "pallet" }, asking("change HG-100 to 30 pallets")).ok, false);
    assert.equal(parseEditJob({ job_reference: "HG-100", new_reference: "HG-999" }, asking("rename HG-100")).ok, false);
  });

  it("adds and removes only named people on the right client", () => {
    const swap = parseEditJob({ job_reference: "HG-100", add_people: ["Ben Cole"], remove_people: ["Ada Cole"] }, asking("swap Ada Cole for Ben Cole on HG-100"));
    assert.equal(swap.ok, true);
    if (swap.ok) {
      assert.deepEqual(swap.card.people.map((row) => row.name), ["Ben Cole"]);
      assert.deepEqual(swap.card.removePeople?.map((row) => row.name), ["Ada Cole"]);
    }
    assert.equal(parseEditJob({ job_reference: "HG-100", add_people: ["Other Brand"] }, asking("add Other Brand to HG-100")).ok, false);
    assert.equal(parseEditJob({ job_reference: "HG-100", remove_people: ["Ben Cole"] }, asking("remove Ben Cole from HG-100")).ok, false);
  });

  it("refuses a closed job, a used reference, and a change that changes nothing", () => {
    const closed = { ...catalog, jobs: [{ ...crewJob, status: "done" }] };
    assert.equal(parseEditJob({ job_reference: "HG-100", new_title: "New" }, closed).ok, false);
    assert.equal(parseEditJob({ job_reference: "HG-100", new_reference: "HG-200" }, catalog).ok, false);
    assert.equal(parseEditJob({ job_reference: "HG-100" }, catalog).ok, false);
  });

  it("lets a person edit a waiting create card", () => {
    const made = parseCreateJob({ client_name: "Harbor Goods", reference: "HG-400", title: "Inbound" }, { clients, people, references: ["HG-100"], now });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const out = reviseCard(made.card, { title: "Inbound truck", reference: "HG-500", billBasis: "time", employeeIds: ["p2"] }, { ...catalog, now: now + 60_000 });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.card.title, "Inbound truck");
    assert.equal(out.card.jobReference, "HG-500");
    assert.equal(out.card.billBasis, "time");
    assert.deepEqual(out.card.people.map((row) => row.name), ["Ben Cole"]);
    assert.ok(Date.parse(out.card.expiresAt) > Date.parse(made.card.expiresAt));
    assert.equal(reviseCard(made.card, { reference: "HG-200" }, catalog).ok, false);
    assert.equal(reviseCard(made.card, { employeeIds: ["p3"] }, catalog).ok, false);
  });

  it("turns crew checkboxes on an edit card into adds and removes", () => {
    const made = parseEditJob({ job_reference: "HG-100", new_title: "Unload 30 pallets" }, catalog);
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const out = reviseCard(made.card, { employeeIds: ["p2"] }, catalog);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.card.people.map((row) => row.employeeId), ["p2"]);
    assert.deepEqual(out.card.removePeople?.map((row) => row.employeeId), ["p1"]);
    assert.equal(out.card.title, "Unload 30 pallets");
  });

  it("refuses a reference taken before Confirm", () => {
    const made = parseEditJob({ job_reference: "HG-100", new_reference: "HG-300" }, catalog);
    assert.equal(made.ok, true);
    if (!made.ok) return;
    assert.match(recheckCard(made.card, { ...catalog, references: ["HG-100", "HG-300"] }) ?? "", /already used/);
    assert.equal(recheckCard(made.card, catalog), null);
  });
});

describe("jobs chat sessions", () => {
  const thread = { id: "t1", title: "New chat", updatedAt: new Date(now), hiddenAt: null };
  const row = (role: string, content: string, extra = {}) => ({ role, content, status: "done", createdAt: new Date(now), ...extra });

  it("names a chat after the first thing asked", () => {
    assert.equal(sessionTitle("New chat", "  Open a job\nfor Harbor "), "Open a job for Harbor");
    assert.equal(sessionTitle("Jobs", null), "New chat");
    assert.equal(sessionTitle("Jobs", "x".repeat(80)).length, 48);
  });

  it("counts only cards that can still be confirmed", () => {
    const live = { status: "proposed", expiresAt: new Date(now + 1000).toISOString() };
    const old = { status: "proposed", expiresAt: new Date(now - 1000).toISOString() };
    const saved = { status: "applied", expiresAt: new Date(now + 1000).toISOString() };
    const out = sessionSummary(thread, [row("user", "Open"), row("assistant", "a", { jobChange: live }), row("assistant", "b", { jobChange: old }), row("assistant", "c", { jobChange: saved })], now, 60_000);
    assert.equal(out.waiting, 1);
    assert.equal(out.title, "Open");
  });

  it("does not show a stuck answer as still working", () => {
    const stuck = row("assistant", "", { status: "working", createdAt: new Date(now - 120_000) });
    assert.equal(sessionSummary(thread, [stuck], now, 60_000).working, false);
    assert.equal(sessionSummary(thread, [{ ...stuck, createdAt: new Date(now) }], now, 60_000).working, true);
  });
});

describe("jobs chat tasks", () => {
  const work = [
    { code: "unload_trailer", name: "Unload trailer", department: "unloading", clientId: null },
    { code: "pack_orders", name: "Pack orders", department: "packing", clientId: null },
    { code: "pick_batch", name: "Pick batch", department: "picking", clientId: null },
    { code: "other_kit", name: "Other kit", department: "packing", clientId: "c2" },
  ];
  const taskClients = [{ id: "c1", name: "Harbor Goods", code: "HG", enabledServices: ["jobs", "unloading", "packing"] }];
  const base = { clients: taskClients, people, references: ["HG-100"], jobs, work, now };

  it("creates one task per person with the right work", () => {
    const asked = "Open a job for Harbor Goods to unload 20 pallets and pack 50 orders. Ada Cole unloads, Ben Cole packs";
    const out = parseCreateJob(
      {
        client_name: "Harbor Goods",
        title: "Unload and pack",
        tasks: [
          { title: "Unload 20 pallets", work_type: "Unload trailer", people: ["Ada Cole"] },
          { title: "Pack 50 orders", work_type: "Pack orders", people: ["Ben Cole"] },
        ],
      },
      { ...base, asked },
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.card.tasks?.map((task) => [task.title, task.activityCode, task.name]), [
      ["Unload 20 pallets", "unload_trailer", "Ada Cole"],
      ["Pack 50 orders", "pack_orders", "Ben Cole"],
    ]);
    assert.deepEqual(out.card.people.map((person) => person.name), ["Ada Cole", "Ben Cole"]);
  });

  it("makes the job title the task when none is listed", () => {
    const out = parseCreateJob({ client_name: "Harbor Goods", title: "Unload 20 pallets", people: ["Ada Cole", "Ben Cole"] }, { ...base, asked: "Harbor Goods unload 20 pallets with Ada Cole and Ben Cole" });
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.card.tasks?.map((task) => [task.title, task.name]), [["Unload 20 pallets", "Ada Cole"], ["Unload 20 pallets", "Ben Cole"]]);
  });

  it("asks instead of guessing the work or the person", () => {
    assert.match(String((parseCreateJob({ client_name: "Harbor Goods", title: "Wrap 10 pallets" }, { ...base, asked: "Harbor Goods wrap 10 pallets" }) as { error: string }).error), /what kind of work/);
    assert.match(String((parseCreateJob({ client_name: "Harbor Goods", title: "Unload 10 pallets", tasks: [{ title: "Unload 10 pallets", work_type: "Pack orders" }] }, { ...base, asked: "Harbor Goods unload 10 pallets" }) as { error: string }).error), /does not say/);
    assert.match(String((parseCreateJob({ client_name: "Harbor Goods", title: "Unload and pack", people: ["Ada Cole"], tasks: [{ title: "Unload it", work_type: "Unload trailer" }, { title: "Pack it", work_type: "Pack orders" }] }, { ...base, asked: "Harbor Goods unload it and pack it with Ada Cole" }) as { error: string }).error), /who does/);
  });

  it("refuses work the client has turned off or another client owns", () => {
    assert.equal(parseCreateJob({ client_name: "Harbor Goods", title: "Pick 5 orders", tasks: [{ title: "Pick 5 orders", work_type: "Pick batch" }] }, { ...base, asked: "Harbor Goods pick 5 orders" }).ok, false);
    assert.equal(parseCreateJob({ client_name: "Harbor Goods", title: "Other kit", tasks: [{ title: "Other kit", work_type: "Other kit" }] }, { ...base, asked: "Harbor Goods other kit" }).ok, false);
  });

  it("adds tasks to an existing job and refuses a repeat", () => {
    const withTask = [{ ...jobs[0]!, tasks: [{ title: "Pack 50 orders", status: "open", assigneeId: "p2" }] }];
    const added = parseAddTasks({ job_reference: "HG-100", tasks: [{ title: "Unload the truck", work_type: "Unload trailer", people: ["Ada Cole"] }] }, { ...base, jobs: withTask, asked: "Add a task on HG-100 for Ada Cole to unload the truck" });
    assert.equal(added.ok, true);
    if (added.ok) assert.equal(added.card.kind, "add_tasks");
    assert.equal(parseAddTasks({ job_reference: "HG-100", tasks: [{ title: "Pack 50 orders", work_type: "Pack orders", people: ["Ben Cole"] }] }, { ...base, jobs: withTask, asked: "Ben Cole pack 50 orders on HG-100" }).ok, false);
  });

  it("lets a person edit tasks on a waiting card", () => {
    const made = parseCreateJob({ client_name: "Harbor Goods", title: "Unload 20 pallets", people: ["Ada Cole"] }, { ...base, asked: "Harbor Goods unload 20 pallets with Ada Cole" });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const out = reviseCard(made.card, { tasks: [{ title: "Pack 9 orders", activityCode: "pack_orders", employeeId: "p2" }] }, { ...base, now });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.card.tasks?.[0]?.activityName, "Pack orders");
      assert.deepEqual(out.card.people.map((person) => person.name), ["Ben Cole"]);
    }
    assert.equal(reviseCard(made.card, { tasks: [] }, { ...base, now }).ok, false);
    assert.equal(reviseCard(made.card, { tasks: [{ title: "X", activityCode: "pick_batch", employeeId: null }] }, { ...base, now }).ok, false);
    assert.equal(reviseCard(made.card, { tasks: [{ title: "X", activityCode: "pack_orders", employeeId: "p3" }] }, { ...base, now }).ok, false);
  });
});
