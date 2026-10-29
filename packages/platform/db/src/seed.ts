import { config } from "dotenv";
import { resolve } from "node:path";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  activity,
  clientRecords,
  deviceCheckouts,
  devices,
  employees,
  gaylords,
  loadCrew,
  loads,
  packEvents,
  pickEvents,
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

const accounts = [
  { email: "owner@opsengine.local", name: "Owner", role: "owner" },
  { email: "nora@opsengine.local", name: "Nora Ellis", role: "warehouse_manager" },
  { email: "hr@opsengine.local", name: "Harper Quinn", role: "hr_finance" },
];

for (const account of accounts) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, account.email))
    .limit(1);
  if (!existing) {
    await db.insert(users).values({ ...account, passwordHash });
  }
}

const [already] = await db.select({ id: employees.id }).from(employees).limit(1);
if (already) {
  console.log("Tracking floor already seeded.");
  process.exit(0);
}

const [northwind] = await db
  .insert(clientRecords)
  .values({ name: "Northwind", code: "NW" })
  .returning();
const [brightline] = await db
  .insert(clientRecords)
  .values({ name: "Brightline", code: "BL" })
  .returning();

if (!northwind || !brightline) throw new Error("Could not seed clients.");

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
      "Luis Ortega packed WH-10002 on a shared station. Warehance did not store the packer.",
  },
});

console.log("Seeded the tracking floor.");
console.log("Supervisor  nora@opsengine.local  /  OpsEngine!dev");
console.log("Owner       owner@opsengine.local /  OpsEngine!dev");
console.log("Badges      B-10441 Amina (own Warehance login) through B-10449 Chris");
process.exit(0);
