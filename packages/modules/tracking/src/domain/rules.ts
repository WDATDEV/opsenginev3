export type LoginMode = "individual" | "shared" | "none";
export type DeviceKind = "packing_computer" | "barcode_scanner" | "handheld";
export type Ownership = "personal" | "shared_pool";
export type Department =
  | "packing"
  | "picking"
  | "receiving"
  | "unloading"
  | "sorting"
  | "indirect";

export type PackAttribution = "warehance_user" | "station_badge" | "manual";

export type RuleFailure = { ok: false; reason: string };
export type RuleSuccess<T> = { ok: true } & T;

export class TrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingError";
  }
}

function fail(reason: string): RuleFailure {
  return { ok: false, reason };
}

export const trackingPolicy = [
  {
    id: "packing-login",
    area: "Packing",
    question: "Does each packer have their own station, or do employees share computers?",
    answer:
      "Both happen on this floor. Each packing computer is marked individual or shared. An individual computer belongs to one person. A shared computer stays on a station login, and the packer badges in.",
  },
  {
    id: "packing-attribution",
    area: "Packing",
    question: "When an employee finishes packing, who is recorded as the packer?",
    answer:
      "Ops Engine stores the packer. On an individual computer, that person is the packer. On a shared computer, the badge or the open station session is the record.",
  },
  {
    id: "picking-devices",
    area: "Picking",
    question: "Does each picker use their own barcode scanner or handheld device?",
    answer:
      "Both. A personal scanner is assigned to one picker. A shared handheld must be checked out, or the picker badges at the moment of the scan.",
  },
  {
    id: "receiving-concurrent",
    area: "Receiving",
    question: "Can several employees work on the same shipment at the same time?",
    answer:
      "Yes. A shipment stays open for everyone who joins. Each count is stored against the person who entered it, and their time on the shipment can overlap.",
  },
  {
    id: "unloading-crew",
    area: "Unloading",
    question: "How do you currently record which employees worked on each truck or container?",
    answer:
      "Three ways, on the load itself: a badge scan onto the truck, a lead adding a name, or a paper crew list entered by a supervisor. Each person has a start and an end.",
  },
  {
    id: "sorting-scan",
    area: "Sorting",
    question: "Are packages scanned when placed into USPS, UPS, or other carrier gaylords?",
    answer:
      "Yes. A package is scanned into an open gaylord for USPS, UPS, FedEx, DHL, or another carrier. Placing one without a scan requires a reason.",
  },
  {
    id: "task-changes",
    area: "All departments",
    question: "How often do employees change tasks during a shift?",
    answer:
      "Whenever the work changes. Starting a new task closes the previous one immediately. There is no minimum time on a task, and home department is not a lock.",
  },
  {
    id: "equipment",
    area: "Equipment",
    question: "What scanners, packing computers, and handheld devices are already available?",
    answer:
      "They live in the equipment register: packing computers, barcode scanners, and handhelds. Each one is personal or shared, has a location, and shows whether someone is on it now.",
  },
] as const;

export function resolvePacker(input: {
  loginMode: LoginMode;
  badgeEmployeeId?: string | null;
  stationSessionEmployeeId?: string | null;
  warehanceMappedEmployeeId?: string | null;
  manualEmployeeId?: string | null;
}): RuleSuccess<{
  employeeId: string;
  attribution: PackAttribution;
  loginMismatch: boolean;
}> | RuleFailure {
  const badge = input.badgeEmployeeId ?? null;
  const session = input.stationSessionEmployeeId ?? null;
  const mapped = input.warehanceMappedEmployeeId ?? null;
  const manual = input.manualEmployeeId ?? null;

  if (input.loginMode === "shared") {
    const employeeId = badge ?? session ?? manual;
    if (!employeeId) {
      return fail(
        "This packing computer uses a shared station login. Scan the packer's badge so we record who packed the order.",
      );
    }
    return {
      ok: true,
      employeeId,
      attribution: !badge && !session && manual ? "manual" : "station_badge",
      loginMismatch: false,
    };
  }

  if (input.loginMode !== "individual") {
    return fail("Packing is recorded on a packing computer.");
  }

  if (badge && mapped && badge !== mapped) {
    return {
      ok: true,
      employeeId: badge,
      attribution: "station_badge",
      loginMismatch: true,
    };
  }

  if (badge) {
    return {
      ok: true,
      employeeId: badge,
      attribution: mapped === badge ? "warehance_user" : "station_badge",
      loginMismatch: false,
    };
  }

  if (session) {
    return {
      ok: true,
      employeeId: session,
      attribution: mapped === session ? "warehance_user" : "station_badge",
      loginMismatch: Boolean(mapped && mapped !== session),
    };
  }

  if (mapped) {
    return {
      ok: true,
      employeeId: mapped,
      attribution: "warehance_user",
      loginMismatch: false,
    };
  }

  if (manual) {
    return { ok: true, employeeId: manual, attribution: "manual", loginMismatch: false };
  }

  return fail(
    "No packer on this order. Nobody is assigned to this computer, and nobody has badged in.",
  );
}

export function resolvePicker(input: {
  kind: DeviceKind;
  ownership: Ownership;
  assignedEmployeeId?: string | null;
  checkoutEmployeeId?: string | null;
  badgeEmployeeId?: string | null;
}): RuleSuccess<{ employeeId: string; via: "personal_device" | "shared_device" }> | RuleFailure {
  if (input.kind !== "barcode_scanner" && input.kind !== "handheld") {
    return fail("Picks are recorded from a barcode scanner or handheld, not a packing computer.");
  }

  const assigned = input.assignedEmployeeId ?? null;
  const checkout = input.checkoutEmployeeId ?? null;
  const badge = input.badgeEmployeeId ?? null;

  if (input.ownership === "personal") {
    if (!assigned) {
      return fail("Assign this personal scanner to an employee before picks can count.");
    }
    if (badge && badge !== assigned) {
      return fail(
        "This scanner is assigned to someone else. Use your own device or check out a shared handheld.",
      );
    }
    return { ok: true, employeeId: assigned, via: "personal_device" };
  }

  const employeeId = badge ?? checkout;
  if (!employeeId) {
    return fail("This is a shared device. Scan your badge or check it out before picking.");
  }
  if (checkout && badge && checkout !== badge) {
    return fail("This handheld is checked out to someone else.");
  }
  return { ok: true, employeeId, via: "shared_device" };
}

export function assertCanJoinShipment(input: {
  status: "expected" | "receiving" | "closed";
  activeWorkerIds: string[];
  employeeId: string;
}): RuleSuccess<{ concurrent: boolean }> | RuleFailure {
  if (input.status === "closed") return fail("This shipment is already closed.");
  if (input.activeWorkerIds.includes(input.employeeId)) {
    return fail("You are already working this shipment.");
  }
  return { ok: true, concurrent: input.activeWorkerIds.length > 0 };
}

export function assertCrewSource(input: {
  source: "badge" | "lead_added" | "paper";
  actorCanManage: boolean;
}): RuleSuccess<{ source: "badge" | "lead_added" | "paper" }> | RuleFailure {
  if (input.source !== "badge" && !input.actorCanManage) {
    return fail("A signed-in lead has to add a name from the crew sheet.");
  }
  return { ok: true, source: input.source };
}

export function assertSortPlacement(input: {
  method: "scan" | "manual_place";
  reason?: string | null;
  gaylordStatus: "open" | "closed";
  duplicateGaylordCode?: string | null;
}): { ok: true } | RuleFailure {
  if (input.gaylordStatus !== "open") return fail("That gaylord is closed.");
  if (input.duplicateGaylordCode) {
    return fail(`Already scanned into ${input.duplicateGaylordCode}.`);
  }
  if (input.method === "manual_place" && !input.reason?.trim()) {
    return fail("Say why this package was placed without a scan.");
  }
  return { ok: true };
}

export function planTaskSwitch(input: {
  open: { id: string; department: Department; taskCode: string; jobId?: string | null } | null;
  next: { department: Department; taskCode: string; jobId?: string | null };
}): { closeId: string | null; start: boolean } {
  if (
    input.open &&
    input.open.department === input.next.department &&
    input.open.taskCode === input.next.taskCode &&
    (input.open.jobId ?? null) === (input.next.jobId ?? null)
  ) {
    return { closeId: null, start: false };
  }
  return { closeId: input.open?.id ?? null, start: true };
}

export function assertBillableJob(input: {
  billable: boolean;
  jobId?: string | null;
}): RuleSuccess<{ jobId: string | null }> | RuleFailure {
  if (input.billable && !input.jobId) {
    return fail("Choose the client job before starting this activity.");
  }
  return { ok: true, jobId: input.jobId ?? null };
}

export function planPause(input: {
  open: { id: string } | null;
}): RuleSuccess<{ closeId: string }> | RuleFailure {
  if (!input.open) return fail("Nothing is running to pause.");
  return { ok: true, closeId: input.open.id };
}

export function taskFor(department: Department): string {
  switch (department) {
    case "packing":
      return "pack_orders";
    case "picking":
      return "pick_batch";
    case "receiving":
      return "receive_shipment";
    case "unloading":
      return "unload_trailer";
    case "sorting":
      return "sort_gaylord";
    default:
      return "indirect";
  }
}

export function normalizeDevice(input: {
  kind: DeviceKind;
  ownership: Ownership;
  warehanceLoginMode: LoginMode;
  assignedEmployeeId?: string | null;
}): { ok: true } | RuleFailure {
  const assigned = input.assignedEmployeeId ?? null;

  if (input.warehanceLoginMode === "shared" && input.ownership === "personal") {
    return fail("A shared station login is a station device, not a personal one.");
  }

  if (input.kind === "packing_computer") {
    if (input.warehanceLoginMode === "none") {
      return fail(
        "A packing computer is either an individual login or a shared station login.",
      );
    }
    if (input.warehanceLoginMode === "individual" && !assigned) {
      return fail("An individual packing computer has to be assigned to that person.");
    }
    return { ok: true };
  }

  if (input.warehanceLoginMode !== "none") {
    return fail("Only packing computers carry a station login.");
  }

  if (input.ownership === "personal" && !assigned) {
    return fail("A personal scanner or handheld has to be assigned to one employee.");
  }

  return { ok: true };
}

export const LOCATION_MAX_ACCURACY_M = 300;
export const LOCATION_MAX_AGE_MS = 30_000;

export function assertDeviceLocation(input: {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  capturedAt?: number;
  now: number;
  site: { latitude: number; longitude: number; radiusMeters: number } | null;
}): RuleSuccess<{ distanceMeters: number }> | (RuleFailure & { distanceMeters?: number }) {
  if (!input.site) {
    return fail("The warehouse location is not set, so this gate cannot confirm the device.");
  }
  if (input.latitude == null || input.longitude == null || input.accuracy == null || input.capturedAt == null) {
    return fail("This device did not share its location. The scan was not recorded.");
  }
  const age = input.now - input.capturedAt;
  if (age < -5_000 || age > LOCATION_MAX_AGE_MS) {
    return fail("This location reading is too old to trust. The scan was not recorded.");
  }
  if (!(input.accuracy > 0) || input.accuracy > LOCATION_MAX_ACCURACY_M) {
    return fail("This location is too vague to trust. The scan was not recorded.");
  }
  const distanceMeters = distanceMetersBetween(
    input.latitude,
    input.longitude,
    input.site.latitude,
    input.site.longitude,
  );
  if (distanceMeters > input.site.radiusMeters) {
    return { ok: false, reason: "This device is not at the warehouse. The scan was not recorded.", distanceMeters };
  }
  return { ok: true, distanceMeters };
}

function distanceMetersBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  const earth = 6_371_000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function throwIfRejected(result: RuleSuccess<unknown> | RuleFailure): asserts result is RuleSuccess<unknown> {
  if (!result.ok) throw new TrackingError(result.reason);
}
