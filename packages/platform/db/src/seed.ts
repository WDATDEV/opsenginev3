import { config } from "dotenv";
import { resolve } from "node:path";
import { hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  activity,
  activityTypes,
  clientRecords,
  deviceCheckouts,
  devices,
  employees,
  gaylords,
  jobAssignees,
  jobs,
  loadCrew,
  loads,
  packEvents,
  pickEvents,
  rateCards,
  receiptLines,
  segments,
  shifts,
  stationSessions,
  shipmentWorkers,
  shipments,
  sortScans,
  tasks,
  users,
} from "./schema.js";

config({ path: resolve(process.cwd(), "../../../.env") });
config({ path: resolve(process.cwd(), ".env") });

const db = createDb();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const passwordHash = await hash(process.env.SEED_OWNER_PASSWORD ?? "OpsEngine!dev", 10);

const activityCatalog = [
  ["pack_orders", "Pack orders", "packing", true],
  ["pick_batch", "Pick batch", "picking", true],
  ["receive_shipment", "Count and receive", "receiving", true],
  ["inspect", "Inspect", "receiving", true],
  ["putaway", "Putaway", "receiving", true],
  ["unload_trailer", "Unload trailer", "unloading", true],
  ["sort_gaylord", "Sort to carrier", "sorting", true],
  ["kitting", "Kitting", "packing", true],
  ["labeling", "Labeling", "packing", true],
  ["returns", "Returns", "receiving", true],
  ["indirect", "Internal work", "indirect", false],
] as const;

for (const [code, name, department, billable] of activityCatalog) {
  const [existing] = await db.select().from(activityTypes).where(eq(activityTypes.code, code)).limit(1);
  if (!existing) await db.insert(activityTypes).values({ code, name, department, billable });
}

async function upsertClient(name: string, code: string) {
  const [existing] = await db.select().from(clientRecords).where(eq(clientRecords.code, code)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(clientRecords).values({ name, code }).returning();
  if (!created) throw new Error(`Could not seed ${name}`);
  return created;
}

async function upsertJob(clientId: string, reference: string, title: string, billBasis = "mixed") {
  const [existing] = await db.select().from(jobs).where(eq(jobs.reference, reference)).limit(1);
  if (existing) {
    if (existing.billBasis !== billBasis) {
      await db.update(jobs).set({ billBasis }).where(eq(jobs.id, existing.id));
    }
    return existing;
  }
  const [created] = await db.insert(jobs).values({ clientId, reference, title, status: "open", billBasis }).returning();
  if (!created) throw new Error(`Could not seed ${reference}`);
  return created;
}

async function upsertAccount(email: string, name: string, role: string, clientIds: string[] | null) {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!existing) {
    await db.insert(users).values({ email, name, role, passwordHash, clientIds });
    return;
  }
  if (clientIds) await db.update(users).set({ role, clientIds }).where(eq(users.id, existing.id));
}

async function upsertRate(clientId: string, activityCode: string, unit: string, rateCents: number, label: string) {
  const rows = await db.select().from(rateCards).where(eq(rateCards.clientId, clientId));
  const existing = rows.find((rate) => rate.activityCode === activityCode && rate.unit === unit);
  if (existing) return;
  await db.insert(rateCards).values({ clientId, activityCode, unit, rateCents, label });
}

async function ensureShipment(reference: string, clientId: string, jobId: string, carrier: string, expectedCartons: number) {
  const [existing] = await db.select().from(shipments).where(eq(shipments.reference, reference)).limit(1);
  if (existing) {
    if (!existing.jobId) {
      await db.update(shipments).set({ jobId, clientId }).where(eq(shipments.id, existing.id));
    }
    return;
  }
  await db.insert(shipments).values({
    reference,
    clientId,
    jobId,
    carrier,
    status: "expected",
    expectedCartons,
    receivedCartons: 0,
  });
}

async function ensureLoad(reference: string, clientId: string, jobId: string, dock: string) {
  const [existing] = await db.select().from(loads).where(eq(loads.reference, reference)).limit(1);
  if (existing) {
    if (!existing.jobId) {
      await db.update(loads).set({ jobId, clientId }).where(eq(loads.id, existing.id));
    }
    return;
  }
  await db.insert(loads).values({
    reference,
    clientId,
    jobId,
    kind: "truck",
    dock,
    status: "arrived",
  });
}

const northwind = await upsertClient("Northwind", "NW");
const brightline = await upsertClient("Brightline", "BL");
const icecartel = await upsertClient("IceCartel", "IC");
const jacob = await upsertClient("Jacob", "JB");

await upsertAccount("owner@opsengine.local", "Owner", "owner", null);
await upsertAccount("nora@opsengine.local", "Nora Ellis", "warehouse_manager", null);
await upsertAccount("hr@opsengine.local", "Harper Quinn", "hr_finance", null);
await upsertAccount("lina@opsengine.local", "Lina Shah", "client_services", [icecartel.id]);
await upsertAccount("owen@opsengine.local", "Owen Blake", "client_services", [jacob.id]);
await upsertAccount("ice@opsengine.local", "IceCartel Ops", "external_customer", [icecartel.id]);
await upsertAccount("jacob@opsengine.local", "Jacob Ops", "external_customer", [jacob.id]);

await db.update(clientRecords).set({ enabledServices: ["jobs", "receiving", "unloading", "packing", "activities", "equipment", "people", "checkin", "reports", "invoices"] }).where(eq(clientRecords.id, icecartel.id));
await db.update(clientRecords).set({ enabledServices: ["jobs", "receiving", "unloading", "picking", "activities", "people", "checkin"] }).where(eq(clientRecords.id, jacob.id));

async function upsertOwnedActivity(clientId: string, code: string, name: string, department: string, billable: boolean) {
  const [existing] = await db
    .select()
    .from(activityTypes)
    .where(and(eq(activityTypes.code, code), eq(activityTypes.clientId, clientId)))
    .limit(1);
  if (!existing) {
    await db.insert(activityTypes).values({ code, name, department, billable, clientId, active: true });
  }
}

async function upsertOwnedPerson(clientId: string, name: string, badgeCode: string, departmentHome: string) {
  const [existing] = await db.select().from(employees).where(eq(employees.badgeCode, badgeCode)).limit(1);
  if (existing) {
    if (existing.clientId !== clientId) {
      await db.update(employees).set({ clientId }).where(eq(employees.id, existing.id));
    }
    return;
  }
  await db.insert(employees).values({ name, badgeCode, departmentHome, clientId, employmentType: "employee" });
}

async function upsertOwnedDevice(clientId: string, code: string, label: string, location: string) {
  const [existing] = await db.select().from(devices).where(eq(devices.code, code)).limit(1);
  if (existing) {
    if (existing.clientId !== clientId) {
      await db.update(devices).set({ clientId }).where(eq(devices.id, existing.id));
    }
    return;
  }
  await db.insert(devices).values({
    code,
    label,
    kind: "barcode_scanner",
    ownership: "shared_pool",
    warehanceLoginMode: "none",
    location,
    clientId,
    status: "available",
  });
}

await upsertOwnedActivity(icecartel.id, "ic_relabel", "Relabel cartons", "packing", true);
await upsertOwnedActivity(jacob.id, "jb_kitting", "Kit Jacob orders", "packing", true);
await upsertOwnedPerson(icecartel.id, "Nina Frost", "B-IC-01", "packing");
await upsertOwnedPerson(jacob.id, "Evan Cole", "B-JB-01", "picking");
await upsertOwnedDevice(icecartel.id, "IC-SCN-1", "IceCartel scanner", "IceCartel bench");
await db.update(clientRecords).set({ enabledServices: ["jobs", "receiving", "unloading"] }).where(eq(clientRecords.id, northwind.id));
await db.update(clientRecords).set({ enabledServices: ["jobs"] }).where(eq(clientRecords.id, brightline.id));

const iceJob = await upsertJob(icecartel.id, "IC-1001", "Five pallets inbound", "mixed");
await upsertJob(icecartel.id, "IC-1002", "Unload one carton", "carton");
const jacobJob = await upsertJob(jacob.id, "JB-2001", "Two pallets inbound");
const northwindJob = await upsertJob(northwind.id, "NW-4401", "Northwind inbound");

async function seedPlan() {
  const [mei] = await db.select().from(employees).where(eq(employees.badgeCode, "B-10445")).limit(1);
  if (!mei) return;
  const [assigned] = await db
    .select()
    .from(jobAssignees)
    .where(and(eq(jobAssignees.jobId, iceJob.id), eq(jobAssignees.employeeId, mei.id)))
    .limit(1);
  if (!assigned) await db.insert(jobAssignees).values({ jobId: iceJob.id, employeeId: mei.id });
  const existingTasks = await db.select().from(tasks).where(eq(tasks.jobId, iceJob.id));
  let count = existingTasks.find((task) => task.title === "Count IceCartel pallets");
  if (!count) {
    const [created] = await db
      .insert(tasks)
      .values({
        title: "Count IceCartel pallets",
        details: "Count the five pallets before putaway.",
        status: "open",
        clientId: icecartel.id,
        jobId: iceJob.id,
        assigneeId: mei.id,
        dueOn: "2026-11-02",
      })
      .returning();
    count = created;
  }
  if (count && !existingTasks.some((task) => task.title === "Put away IceCartel pallets")) {
    await db.insert(tasks).values({
      title: "Put away IceCartel pallets",
      details: "Putaway starts after the count is closed.",
      status: "open",
      clientId: icecartel.id,
      jobId: iceJob.id,
      assigneeId: mei.id,
      dueOn: "2026-11-04",
      dependsOnId: count.id,
    });
  }
}

await seedPlan();

await upsertRate(icecartel.id, "unload_trailer", "hour", 4500, "Unload labor");
await upsertRate(icecartel.id, "unload_trailer", "pallet", 1200, "Pallet unload");
await upsertRate(icecartel.id, "receive_shipment", "hour", 4000, "Receiving labor");
await upsertRate(icecartel.id, "unload_trailer", "carton", 250, "Carton unload");
await upsertRate(jacob.id, "unload_trailer", "hour", 3800, "Unload labor");
await upsertRate(jacob.id, "unload_trailer", "carton", 150, "Carton unload");
await upsertRate(jacob.id, "receive_shipment", "hour", 3600, "Receiving labor");

await ensureShipment("ASN-IC-1001", icecartel.id, iceJob.id, "XPO", 5);
await ensureLoad("TRL-IC-1001", icecartel.id, iceJob.id, "Dock 1");
await ensureShipment("ASN-JB-2001", jacob.id, jacobJob.id, "Estes", 2);
await ensureLoad("TRL-JB-2001", jacob.id, jacobJob.id, "Dock 4");

const [existingNorthwindShipment] = await db.select().from(shipments).where(eq(shipments.reference, "ASN-4401")).limit(1);
if (existingNorthwindShipment && !existingNorthwindShipment.jobId) {
  await db.update(shipments).set({ jobId: northwindJob.id, clientId: northwind.id }).where(eq(shipments.id, existingNorthwindShipment.id));
}
const [existingNorthwindLoad] = await db.select().from(loads).where(eq(loads.reference, "TRL-881")).limit(1);
if (existingNorthwindLoad && !existingNorthwindLoad.jobId) {
  await db.update(loads).set({ jobId: northwindJob.id, clientId: northwind.id }).where(eq(loads.id, existingNorthwindLoad.id));
}

const [already] = await db.select({ id: employees.id }).from(employees).limit(1);
if (already) {
  console.log("Tracking floor already seeded. Client jobs are ready.");
  console.log("IceCartel manager  lina@opsengine.local / OpsEngine!dev");
  console.log("IceCartel client   ice@opsengine.local  / OpsEngine!dev");
  console.log("Jacob manager      owen@opsengine.local / OpsEngine!dev");
  console.log("Jacob client       jacob@opsengine.local / OpsEngine!dev");
  process.exit(0);
}

const roster = [
  ["Amina Cole", "B-10441", "packing", "WH-AMINA"],
  ["Luis Ortega", "B-10442", "packing", null],
  ["Priya Shah", "B-10443", "picking", null],
  ["Jonah Blake", "B-10444", "picking", null],
  ["Mei Chen", "B-10445", "receiving", null],
  ["Andre Brooks", "B-10446", "receiving", null],
  ["Rosa Diaz", "B-10447", "unloading", null],
  ["Sam Patel", "B-10448", "unloading", null],
  ["Chris Nguyen", "B-10449", "sorting", null],
] as const;

const people = new Map<string, { id: string; name: string }>();
for (const [name, badgeCode, departmentHome, warehanceUserId] of roster) {
  const [row] = await db
    .insert(employees)
    .values({ name, badgeCode, departmentHome, warehanceUserId })
    .returning();
  if (!row) throw new Error(`Could not seed ${name}`);
  people.set(badgeCode, row);
}

const id = (badge: string) => {
  const person = people.get(badge);
  if (!person) throw new Error(`Missing ${badge}`);
  return person.id;
};

const deviceRows = [
  ["PC-PACK-1", "packing_computer", "Bench 1", "personal", "individual", "Bench 1", id("B-10441")],
  ["PC-PACK-2", "packing_computer", "Bench 2", "shared_pool", "shared", "Bench 2", null],
  ["SCN-04", "barcode_scanner", "Priya scanner", "personal", "none", "Pick aisle", id("B-10443")],
  ["HH-02", "handheld", "Pool handheld 2", "shared_pool", "none", "Pick aisle", null],
  ["SCN-DOCK-1", "barcode_scanner", "Dock scanner", "shared_pool", "none", "Dock 2", null],
] as const;

const deviceIds = new Map<string, string>();
for (const [code, kind, label, ownership, warehanceLoginMode, location, assignedEmployeeId] of deviceRows) {
  const [row] = await db
    .insert(devices)
    .values({
      code,
      kind,
      label,
      ownership,
      warehanceLoginMode,
      location,
      assignedEmployeeId,
      status: "available",
    })
    .returning();
  if (!row) throw new Error(`Could not seed ${code}`);
  deviceIds.set(code, row.id);
}

const device = (code: string) => {
  const found = deviceIds.get(code);
  if (!found) throw new Error(`Missing ${code}`);
  return found;
};

const clocked = [
  "B-10441",
  "B-10442",
  "B-10443",
  "B-10444",
  "B-10445",
  "B-10446",
  "B-10447",
  "B-10448",
  "B-10449",
];

const shiftIds = new Map<string, string>();
for (const badge of clocked) {
  const [shift] = await db
    .insert(shifts)
    .values({ employeeId: id(badge), clockIn: ago(180), source: "kiosk" })
    .returning();
  if (!shift) throw new Error("Could not seed shift");
  shiftIds.set(badge, shift.id);
}

const shift = (badge: string) => {
  const found = shiftIds.get(badge);
  if (!found) throw new Error(`Missing shift ${badge}`);
  return found;
};

const [aminaPast] = await db
  .insert(segments)
  .values({
    employeeId: id("B-10441"),
    shiftId: shift("B-10441"),
    department: "packing",
    taskCode: "pack_orders",
    startedAt: ago(100),
    endedAt: ago(80),
    deviceId: device("PC-PACK-1"),
  })
  .returning();

const [luisPast] = await db
  .insert(segments)
  .values({
    employeeId: id("B-10442"),
    shiftId: shift("B-10442"),
    department: "packing",
    taskCode: "pack_orders",
    startedAt: ago(85),
    endedAt: ago(60),
    deviceId: device("PC-PACK-2"),
  })
  .returning();

await db.insert(segments).values([
  {
    employeeId: id("B-10441"),
    shiftId: shift("B-10441"),
    department: "packing",
    taskCode: "pack_orders",
    startedAt: ago(40),
    deviceId: device("PC-PACK-1"),
  },
  {
    employeeId: id("B-10443"),
    shiftId: shift("B-10443"),
    department: "picking",
    taskCode: "pick_batch",
    startedAt: ago(25),
    deviceId: device("SCN-04"),
  },
  {
    employeeId: id("B-10444"),
    shiftId: shift("B-10444"),
    department: "picking",
    taskCode: "pick_batch",
    startedAt: ago(20),
    deviceId: device("HH-02"),
  },
  {
    employeeId: id("B-10445"),
    shiftId: shift("B-10445"),
    department: "receiving",
    taskCode: "receive_shipment",
    startedAt: ago(50),
  },
  {
    employeeId: id("B-10446"),
    shiftId: shift("B-10446"),
    department: "receiving",
    taskCode: "receive_shipment",
    startedAt: ago(30),
  },
  {
    employeeId: id("B-10447"),
    shiftId: shift("B-10447"),
    department: "unloading",
    taskCode: "unload_trailer",
    startedAt: ago(45),
  },
  {
    employeeId: id("B-10449"),
    shiftId: shift("B-10449"),
    department: "sorting",
    taskCode: "sort_gaylord",
    startedAt: ago(15),
  },
]);

await db.insert(stationSessions).values({
  deviceId: device("PC-PACK-2"),
  employeeId: id("B-10442"),
  startedAt: ago(85),
  endedAt: ago(60),
});

await db.insert(deviceCheckouts).values({
  deviceId: device("HH-02"),
  employeeId: id("B-10444"),
  startedAt: ago(20),
});

await db.insert(packEvents).values([
  {
    orderNumber: "WH-10001",
    clientId: northwind.id,
    employeeId: id("B-10441"),
    deviceId: device("PC-PACK-1"),
    attribution: "warehance_user",
    warehanceUserId: "WH-AMINA",
    warehanceRecorded: true,
    loginMismatch: false,
    units: 3,
    packedAt: ago(90),
    segmentId: aminaPast?.id,
  },
  {
    orderNumber: "WH-10002",
    clientId: brightline.id,
    employeeId: id("B-10442"),
    deviceId: device("PC-PACK-2"),
    attribution: "station_badge",
    warehanceUserId: null,
    warehanceRecorded: false,
    loginMismatch: false,
    units: 2,
    packedAt: ago(70),
    segmentId: luisPast?.id,
  },
]);

await db.insert(pickEvents).values([
  {
    batchCode: "BATCH-17",
    orderNumber: "WH-10008",
    sku: "SKU-TEE",
    qty: 2,
    employeeId: id("B-10443"),
    deviceId: device("SCN-04"),
    via: "personal_device",
    pickedAt: ago(18),
  },
  {
    batchCode: "BATCH-18",
    orderNumber: "WH-10009",
    sku: "SKU-MUG",
    qty: 1,
    employeeId: id("B-10444"),
    deviceId: device("HH-02"),
    via: "shared_device",
    pickedAt: ago(12),
  },
]);

const [shipment] = await db
  .insert(shipments)
  .values({
    reference: "ASN-4401",
    clientId: northwind.id,
    jobId: northwindJob.id,
    carrier: "XPO",
    status: "receiving",
    expectedCartons: 18,
    receivedCartons: 16,
    createdAt: ago(80),
  })
  .returning();
if (!shipment) throw new Error("Could not seed shipment");

await db.insert(shipmentWorkers).values([
  {
    shipmentId: shipment.id,
    employeeId: id("B-10445"),
    role: "lead",
    joinedAt: ago(50),
  },
  {
    shipmentId: shipment.id,
    employeeId: id("B-10446"),
    role: "counter",
    joinedAt: ago(30),
  },
]);

await db.insert(receiptLines).values([
  {
    shipmentId: shipment.id,
    employeeId: id("B-10445"),
    sku: "SKU-TEE",
    expectedQty: 10,
    receivedQty: 10,
    recordedAt: ago(40),
  },
  {
    shipmentId: shipment.id,
    employeeId: id("B-10446"),
    sku: "SKU-HAT",
    expectedQty: 8,
    receivedQty: 6,
    recordedAt: ago(20),
  },
]);

await db.insert(tasks).values({
  title: "Check SKU-HAT on ASN-4401",
  details: "Andre Brooks counted 6 against 8 expected.",
  status: "open",
  clientId: northwind.id,
  relatedType: "inbound_shipment",
  relatedId: shipment.id,
});

const [load] = await db
  .insert(loads)
  .values({
    reference: "TRL-881",
    clientId: northwind.id,
    jobId: northwindJob.id,
    kind: "truck",
    dock: "Dock 2",
    status: "unloading",
    arrivalAt: ago(120),
    unloadStartedAt: ago(45),
    seal: "SL-2291",
  })
  .returning();
if (!load) throw new Error("Could not seed load");

await db.insert(loadCrew).values({
  loadId: load.id,
  employeeId: id("B-10447"),
  source: "badge",
  startedAt: ago(45),
});

const [usps] = await db
  .insert(gaylords)
  .values({ code: "GL-USPS-1", carrier: "usps", status: "open", openedAt: ago(60) })
  .returning();
await db.insert(gaylords).values({
  code: "GL-UPS-1",
  carrier: "ups",
  status: "open",
  openedAt: ago(60),
});
if (!usps) throw new Error("Could not seed gaylord");

await db.insert(sortScans).values({
  gaylordId: usps.id,
  trackingNumber: "9400111899223456789012",
  employeeId: id("B-10449"),
  deviceId: device("SCN-DOCK-1"),
  method: "scan",
  scannedAt: ago(10),
});

await db.insert(activity).values({
  actorId: id("B-10442"),
  action: "tracking.pack_recorded",
  module: "tracking",
  entityType: "pack_event",
  entityId: "WH-10002",
  after: {
    summary:
      "Luis Ortega packed WH-10002 by badging onto a shared station.",
  },
});

await seedPlan();
console.log("Seeded the tracking floor.");
console.log("Supervisor  nora@opsengine.local  /  OpsEngine!dev");
console.log("IceCartel   lina@opsengine.local  /  OpsEngine!dev");
console.log("IceCartel   ice@opsengine.local   /  OpsEngine!dev");
console.log("Jacob       owen@opsengine.local  /  OpsEngine!dev");
console.log("Jacob       jacob@opsengine.local /  OpsEngine!dev");
console.log("Owner       owner@opsengine.local /  OpsEngine!dev");
console.log("Badges      B-10441 Amina (own packing station) through B-10449 Chris");
process.exit(0);
