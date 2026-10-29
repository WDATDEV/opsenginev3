import { z } from "zod";

export const roles = [
  "owner",
  "warehouse_manager",
  "warehouse_employee",
  "client_services",
  "hr_finance",
  "external_customer",
] as const;

export type Role = (typeof roles)[number];

export const permissions = [
  "tracking.read",
  "tracking.record",
  "tracking.manage",
  "tracking.clock",
  "client.read",
  "job.read",
  "job.manage",
  "billing.read",
  "billing.approve",
  "task.read",
  "task.update",
  "audit.read",
] as const;

export type Permission = (typeof permissions)[number];

const floor = [
  "tracking.read",
  "tracking.record",
  "tracking.clock",
  "task.read",
] as const satisfies readonly Permission[];

const manage = [
  "tracking.read",
  "tracking.record",
  "tracking.manage",
  "tracking.clock",
  "client.read",
  "job.read",
  "job.manage",
  "billing.read",
  "billing.approve",
  "task.read",
  "task.update",
  "audit.read",
] as const satisfies readonly Permission[];

export const rolePermissions: Record<Role, Permission[]> = {
  owner: [...manage],
  warehouse_manager: [...manage],
  warehouse_employee: [...floor],
  client_services: ["client.read", "job.read", "job.manage", "billing.read", "task.read"],
  hr_finance: ["tracking.read", "client.read", "task.read", "audit.read", "job.read", "billing.read", "billing.approve"],
  external_customer: ["client.read", "job.read", "billing.read"],
};

export const departments = [
  "packing",
  "picking",
  "receiving",
  "unloading",
  "sorting",
  "indirect",
] as const;

export type Department = (typeof departments)[number];

export const deviceKinds = ["packing_computer", "barcode_scanner", "handheld"] as const;

export type DeviceKind = (typeof deviceKinds)[number];

export const loginModes = ["individual", "shared", "none"] as const;
export type LoginMode = (typeof loginModes)[number];

export const ownerships = ["personal", "shared_pool"] as const;
export type Ownership = (typeof ownerships)[number];

export const billingUnits = ["hour", "pallet", "carton", "unit", "sku", "flat"] as const;
export type BillingUnit = (typeof billingUnits)[number];

export const carriers = ["usps", "ups", "fedex", "dhl", "other"] as const;
export type Carrier = (typeof carriers)[number];

export const crewSources = ["badge", "lead_added", "paper"] as const;
export type CrewSource = (typeof crewSources)[number];

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const code = z.string().trim().min(1).max(40);
const optionalText = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((value) => (value ? value : undefined));

export const clockSchema = z.object({
  badge: code,
  action: z.enum(["in", "out", "meal_start", "meal_end"]),
  source: z.enum(["kiosk", "qr"]).default("kiosk"),
  place: z.string().trim().min(1).max(80).optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  accuracy: z.number().positive().max(100_000).optional(),
  capturedAt: z.number().int().optional(),
});

export const siteSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  radiusMeters: z.number().int().min(50).max(2000).default(250),
});

export const badgeSchema = z.object({
  badge: code,
});

export const claimStationSchema = z.object({
  badge: code,
  deviceCode: code,
});

export const completePackSchema = z.object({
  orderNumber: z.string().trim().min(1).max(80),
  deviceCode: code,
  badge: optionalText,
  units: z.number().int().min(1).max(10000).default(1),
  warehanceRecorded: z.boolean().optional(),
  warehanceUserId: optionalText,
  clientId: z.string().uuid().optional(),
});

export const recordPickSchema = z.object({
  deviceCode: code,
  badge: optionalText,
  batchCode: z.string().trim().min(1).max(80),
  sku: z.string().trim().min(1).max(80),
  qty: z.number().int().min(1).max(100000).default(1),
  orderNumber: optionalText,
});

export const checkoutSchema = z.object({
  badge: code,
  deviceCode: code,
});

export const createEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  badgeCode: code,
  departmentHome: z.enum(departments),
  employmentType: z.enum(["employee", "temp"]).default("employee"),
  warehanceUserId: optionalText,
});

export const createDeviceSchema = z.object({
  code,
  label: z.string().trim().min(1).max(80),
  kind: z.enum(deviceKinds),
  ownership: z.enum(ownerships),
  warehanceLoginMode: z.enum(loginModes),
  location: z.string().trim().min(1).max(80),
  assignedBadge: optionalText,
});

export const createShipmentSchema = z.object({
  reference: code,
  jobId: z.string().uuid(),
  carrier: z.string().trim().min(1).max(40),
  expectedCartons: z.number().int().min(0).max(100000),
});

export const joinShipmentSchema = z.object({
  badge: code,
  role: z.enum(["lead", "counter"]).default("counter"),
});

export const receiptLineSchema = z.object({
  badge: code,
  sku: z.string().trim().min(1).max(80),
  expectedQty: z.number().int().min(0).max(1000000),
  receivedQty: z.number().int().min(0).max(1000000),
});

export const createLoadSchema = z.object({
  reference: code,
  jobId: z.string().uuid(),
  kind: z.enum(["truck", "container"]),
  dock: z.string().trim().min(1).max(40),
  seal: optionalText,
});

export const addCrewSchema = z.object({
  source: z.enum(crewSources),
  badge: optionalText,
  employeeId: z.string().uuid().optional(),
});

export const finishLoadSchema = z.object({
  palletCount: z.number().int().min(0).max(100000),
  cartonCount: z.number().int().min(0).max(1000000),
});

export const createGaylordSchema = z.object({
  code,
  carrier: z.enum(carriers),
});

export const sortScanSchema = z.object({
  gaylordCode: code,
  trackingNumber: z.string().trim().min(1).max(80),
  badge: code,
  deviceCode: optionalText,
  method: z.enum(["scan", "manual_place"]).default("scan"),
  reason: optionalText,
});

export const switchTaskSchema = z
  .object({
    badge: code,
    department: z.enum(departments).optional(),
    activityCode: z.string().trim().min(1).max(40).optional(),
    jobId: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.department || value.activityCode), {
    message: "Choose an activity.",
  });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date.");

export const createJobSchema = z.object({
  clientId: z.string().uuid(),
  reference: code,
  title: z.string().trim().min(1).max(120),
});

export const assignEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
});

export const createJobTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(400).optional(),
  assigneeId: z.string().uuid().optional(),
  dueOn: day.optional(),
  dependsOnId: z.string().uuid().optional(),
});

export const createActivitySchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase code such as wrap_pallets."),
  name: z.string().trim().min(1).max(80),
  department: z.enum(departments),
  billable: z.boolean().default(true),
});

export const createRateSchema = z.object({
  activityCode: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .transform((value) => (value ? value : undefined)),
  unit: z.enum(billingUnits),
  rateCents: z.number().int().min(0).max(10_000_000),
  label: z.string().trim().min(1).max(80),
});
