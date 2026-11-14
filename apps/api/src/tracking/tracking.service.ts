import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Principal } from "@opsengine/kernel";
import { can } from "@opsengine/kernel";
import type { Database } from "@opsengine/db";
import {
  activity,
  activityTypes,
  breaks,
  clientRecords,
  deviceCheckouts,
  devices,
  employees,
  gateConfig,
  gatePlaces,
  gaylords,
  jobAssignees,
  jobs,
  loadCrew,
  loads,
  packEvents,
  pickEvents,
  receiptLines,
  segments,
  shifts,
  shipmentWorkers,
  shipments,
  site,
  sortScans,
  stationSessions,
  tasks,
} from "@opsengine/db";
import {
  TrackingError,
  assertBillableJob,
  assertCanJoinShipment,
  assertDeviceLocation,
  assertCrewSource,
  assertSortPlacement,
  normalizeDevice,
  planPause,
  planTaskSwitch,
  resolvePacker,
  resolvePicker,
  taskFor,
  trackingPolicy,
  type Department,
  type DeviceKind,
  type LoginMode,
  type Ownership,
} from "@opsengine/tracking";
import type { ClientService, GateMode } from "@opsengine/contracts";
import { assertClientService, enabledServiceList } from "../clients/access.js";
import { DbService } from "../db.service.js";

type Conn = Database;
type Employee = typeof employees.$inferSelect;
type Device = typeof devices.$inferSelect;

const SCHEDULE_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_GATE_PLACES = ["Front gate", "Dock", "Packing", "Picking", "Receiving", "Unloading", "Sorting"];

function stintDisplayStart(
  rows: { jobId: string | null; taskCode: string; startedAt: Date; endedAt: Date | null; endReason: string | null }[],
  current: { jobId: string | null; taskCode: string },
  now: Date,
) {
  let ms = 0;
  for (const row of rows) {
    const same = (row.jobId ?? null) === (current.jobId ?? null) && row.taskCode === current.taskCode;
    if (!same) break;
    if (row.endedAt && row.endReason !== "pause" && row.endReason !== "meal") break;
    ms += Math.max(0, (row.endedAt ?? now).getTime() - row.startedAt.getTime());
  }
  return new Date(now.getTime() - ms);
}

function isUnique(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("code" in err && err.code === "23505") return true;
  return "cause" in err && isUnique(err.cause);
}

function clean(value: string) {
  return value.trim().toUpperCase();
}

function asDepartment(value: string): Department {
  if (
    value === "packing" ||
    value === "picking" ||
    value === "receiving" ||
    value === "unloading" ||
    value === "sorting" ||
    value === "indirect"
  ) {
    return value;
  }
  return "indirect";
}

function asKind(value: string): DeviceKind {
  if (
    value === "packing_computer" ||
    value === "barcode_scanner" ||
    value === "handheld"
  ) {
    return value;
  }
  throw new TrackingError("That device type is not registered.");
}

function asMode(value: string): LoginMode {
  if (value === "individual" || value === "shared" || value === "none") return value;
  return "none";
}

function asOwnership(value: string): Ownership {
  return value === "personal" ? "personal" : "shared_pool";
}

function packSentence(input: {
  name: string;
  orderNumber: string;
  attribution: string;
  loginMismatch: boolean;
}) {
  if (input.loginMismatch) {
    return `${input.name} packed ${input.orderNumber}. The badge did not match the station login, so the badge is the packer of record.`;
  }
  if (input.attribution === "warehance_user") {
    return `${input.name} packed ${input.orderNumber} on their own station.`;
  }
  if (input.attribution === "manual") {
    return `${input.name} was entered as the packer of ${input.orderNumber} by a supervisor.`;
  }
  return `${input.name} packed ${input.orderNumber} by badging onto a shared station.`;
}

@Injectable()
export class TrackingService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  policy() {
    return trackingPolicy;
  }

  async listActivities() {
    const rows = await this.db.db.select().from(activityTypes);
    return rows
      .filter((row) => row.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        department: row.department,
        billable: row.billable,
        clientId: row.clientId,
      }));
  }

  async createActivity(input: { code: string; name: string; department: Department; billable: boolean; clientId?: string }) {
    const owner = input.clientId ? await assertClientService(this.db.db, input.clientId, "activities") : null;
    try {
      const [created] = await this.db.db
        .insert(activityTypes)
        .values({
          code: input.code.trim(),
          name: input.name.trim(),
          department: input.department,
          billable: input.billable,
          active: true,
          clientId: owner?.id ?? null,
        })
        .returning();
      if (!created) throw new TrackingError("Could not add that activity.");
      return { message: owner ? `${created.name} is on ${owner.name}.` : `${created.name} is available on the floor.` };
    } catch (err) {
      if (isUnique(err)) throw new TrackingError("That activity code is already used.");
      throw err;
    }
  }

  async floor() {
    const orm = this.db.db;
    const [people, openShifts, openBreaks, openSegments, deviceRows, sessionRows, checkoutRows, packs, picks, lines, crews, scans, shipmentRows, loadRows, gaylordRows, jobRows, clientRows] =
      await Promise.all([
        orm.select().from(employees),
        orm.select().from(shifts).where(isNull(shifts.clockOut)),
        orm.select().from(breaks).where(isNull(breaks.endedAt)),
        orm.select().from(segments).where(isNull(segments.endedAt)),
        orm.select().from(devices),
        orm.select().from(stationSessions).where(isNull(stationSessions.endedAt)),
        orm.select().from(deviceCheckouts).where(isNull(deviceCheckouts.endedAt)),
        orm.select().from(packEvents),
        orm.select().from(pickEvents),
        orm.select().from(receiptLines),
        orm.select().from(loadCrew),
        orm.select().from(sortScans),
        orm.select().from(shipments),
        orm.select().from(loads),
        orm.select().from(gaylords),
        orm.select().from(jobs),
        orm.select().from(clientRecords),
      ]);

    const byId = new Map(people.map((person) => [person.id, person]));
    const deviceById = new Map(deviceRows.map((device) => [device.id, device]));
    const shipmentById = new Map(shipmentRows.map((row) => [row.id, row]));
    const loadById = new Map(loadRows.map((row) => [row.id, row]));
    const gaylordById = new Map(gaylordRows.map((row) => [row.id, row]));
    const jobById = new Map(jobRows.map((row) => [row.id, row]));
    const clientNameById = new Map(clientRows.map((row) => [row.id, row.name]));
    const shiftByEmployee = new Map(openShifts.map((shift) => [shift.employeeId, shift]));
    const mealShiftIds = new Set(openBreaks.map((row) => row.shiftId));
    const segmentByEmployee = new Map(
      [...openSegments]
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map((row) => [row.employeeId, row]),
    );

    const counts: Record<Department, number> = {
      packing: 0,
      picking: 0,
      receiving: 0,
      unloading: 0,
      sorting: 0,
      indirect: 0,
    };

    const roster = people
      .filter((person) => person.active)
      .map((person) => {
        const shift = shiftByEmployee.get(person.id) ?? null;
        const segment = segmentByEmployee.get(person.id) ?? null;
        const onMeal = Boolean(shift && mealShiftIds.has(shift.id));
        if (segment && !onMeal) counts[asDepartment(segment.department)] += 1;
        const session = sessionRows.find((row) => row.employeeId === person.id);
        const checkout = checkoutRows.find((row) => row.employeeId === person.id);
        const place =
          (session && deviceById.get(session.deviceId)?.code) ||
          (checkout && deviceById.get(checkout.deviceId)?.code) ||
          (segment?.deviceId && deviceById.get(segment.deviceId)?.code) ||
          null;
        return {
          id: person.id,
          name: person.name,
          badgeCode: person.badgeCode,
          departmentHome: person.departmentHome,
          warehanceUserId: person.warehanceUserId,
          clockedIn: Boolean(shift),
          onMeal,
          entry: shift?.source ?? null,
          entryPlace: shift?.clockInPlace ?? null,
          place,
          task: segment
            ? {
                department: segment.department,
                taskCode: segment.taskCode,
                startedAt: segment.startedAt,
                jobReference: segment.jobId ? jobById.get(segment.jobId)?.reference ?? null : null,
                clientName: segment.jobId
                  ? clientNameById.get(jobById.get(segment.jobId)?.clientId ?? "") ?? null
                  : null,
              }
            : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const name = (employeeId: string) => byId.get(employeeId)?.name ?? "Someone";
    const feed = [
      ...packs.map((row) => ({
        at: row.packedAt,
        text: packSentence({
          name: name(row.employeeId),
          orderNumber: row.orderNumber,
          attribution: row.attribution,
          loginMismatch: row.loginMismatch,
        }),
      })),
      ...picks.map((row) => ({
        at: row.pickedAt,
        text: `${name(row.employeeId)} picked ${row.qty} × ${row.sku} on ${deviceById.get(row.deviceId)?.code ?? "a scanner"}.`,
      })),
      ...lines.map((row) => ({
        at: row.recordedAt,
        text: `${name(row.employeeId)} counted ${row.sku} ${row.receivedQty}/${row.expectedQty} on ${shipmentById.get(row.shipmentId)?.reference ?? "a shipment"}.`,
      })),
      ...crews.map((row) => ({
        at: row.startedAt,
        text: `${name(row.employeeId)} joined ${loadById.get(row.loadId)?.reference ?? "a load"} (${row.source.replaceAll("_", " ")}).`,
      })),
      ...scans.map((row) => ({
        at: row.scannedAt,
        text: `${name(row.employeeId)} ${row.method === "scan" ? "scanned" : "placed"} ${row.trackingNumber} into ${gaylordById.get(row.gaylordId)?.code ?? "a gaylord"}.`,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 30);

    return {
      policy: trackingPolicy,
      counts,
      people: roster,
      feed,
      totals: {
        packed: packs.length,
        picks: picks.length,
        openShipments: shipmentRows.filter((row) => row.status !== "closed").length,
        openLoads: loadRows.filter((row) => row.status !== "done").length,
        openGaylords: gaylordRows.filter((row) => row.status === "open").length,
      },
    };
  }

  async badgeContext(badge: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.openShift(tx, employee.id);
      const segment = await this.openSegment(tx, employee.id);
      const meal = shift ? await this.openBreak(tx, shift.id) : null;
      const session = await this.openSessionForEmployee(tx, employee.id);
      const checkout = await this.openCheckoutForEmployee(tx, employee.id);
      const deviceRows = await tx.select().from(devices);
      const deviceById = new Map(deviceRows.map((row) => [row.id, row]));
      const openSessions = await tx
        .select()
        .from(stationSessions)
        .where(isNull(stationSessions.endedAt));
      const openCheckouts = await tx
        .select()
        .from(deviceCheckouts)
        .where(isNull(deviceCheckouts.endedAt));
      const people = await tx.select().from(employees);
      const nameById = new Map(people.map((person) => [person.id, person.name]));

      const shipmentRows = await tx.select().from(shipments);
      const workers = await tx.select().from(shipmentWorkers);
      const loadRows = await tx.select().from(loads);
      const crew = await tx.select().from(loadCrew);
      const gaylordRows = await tx.select().from(gaylords);
      const jobRows = await tx.select().from(jobs);
      const clientRows = await tx.select().from(clientRecords);
      const activities = await tx.select().from(activityTypes);
      const clientNameById = new Map(clientRows.map((row) => [row.id, row.name]));
      const jobById = new Map(jobRows.map((row) => [row.id, row]));
      const activityName = new Map(activities.map((row) => [row.code, row.name]));
      const employeeSegments = await tx
        .select()
        .from(segments)
        .where(eq(segments.employeeId, employee.id))
        .orderBy(desc(segments.startedAt));
      const lastSegment = segment ? null : employeeSegments[0] ?? null;
      const paused = lastSegment && (lastSegment.endReason === "pause" || lastSegment.endReason === "meal") ? lastSegment : null;
      const now = new Date();
      const taskRows = await tx.select().from(tasks).where(eq(tasks.assigneeId, employee.id));
      const taskTitleById = new Map(taskRows.map((row) => [row.id, row.title]));
      const describe = (row: {
        taskCode: string;
        jobId: string | null;
        department: string;
        startedAt: Date;
        note?: string | null;
      }) => {
        const job = row.jobId ? jobById.get(row.jobId) : null;
        return {
          department: row.department,
          taskCode: row.taskCode,
          activityName: (row.note ? taskTitleById.get(row.note) : null) ?? activityName.get(row.taskCode) ?? row.taskCode,
          startedAt: stintDisplayStart(employeeSegments, row, now),
          jobId: row.jobId,
          jobReference: job?.reference ?? null,
          clientName: job ? clientNameById.get(job.clientId) ?? null : null,
        };
      };
      const completedCodesByJob = new Map<string, Set<string>>();
      const markDone = (jobId: string | null, code: string | null) => {
        if (!jobId || !code) return;
        const set = completedCodesByJob.get(jobId) ?? new Set<string>();
        set.add(code);
        completedCodesByJob.set(jobId, set);
      };
      for (const row of taskRows) {
        if (row.status === "done") markDone(row.jobId, row.activityCode);
      }
      for (const row of employeeSegments) {
        if (row.endReason === "complete") markDone(row.jobId, row.taskCode);
      }
      const assignments = await tx.select().from(jobAssignees).where(eq(jobAssignees.employeeId, employee.id));
      const assigned = new Set(assignments.map((row) => row.jobId));
      const assignmentByJob = new Map(assignments.map((row) => [row.jobId, row]));
      const owned = (clientId: string | null) => !employee.clientId || clientId === employee.clientId;
      const gear = (clientId: string | null) => owned(clientId) || clientId == null;
      const mine = (jobId: string | null) => Boolean(jobId && assigned.has(jobId));

      return {
        employee: {
          id: employee.id,
          name: employee.name,
          badgeCode: employee.badgeCode,
          departmentHome: employee.departmentHome,
          departments: employee.departments?.length ? employee.departments : null,
          clientId: employee.clientId,
          warehanceUserId: employee.warehanceUserId,
          clockedIn: Boolean(shift),
          onMeal: Boolean(meal),
        },
        task: segment ? describe(segment) : null,
        paused: paused ? describe(paused) : null,
        tasks: taskRows
          .filter((row) => row.status !== "done" && row.jobId && mine(row.jobId) && jobById.get(row.jobId)?.status !== "done")
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .map((row) => ({
            id: row.id,
            title: row.title,
            jobId: row.jobId,
            jobReference: row.jobId ? jobById.get(row.jobId)?.reference ?? null : null,
            activityCode: row.activityCode,
            activityName: row.activityCode ? activityName.get(row.activityCode) ?? row.activityCode : null,
            startAt: row.startAt,
            dueOn: row.dueOn,
            blocked: Boolean(row.dependsOnId && taskRows.find((item) => item.id === row.dependsOnId)?.status !== "done"),
          })),
        jobs: jobRows
          .filter((row) => row.status !== "done" && mine(row.id))
          .map((row) => {
            const client = clientRows.find((item) => item.id === row.clientId);
            const services = Array.isArray(client?.enabledServices)
              ? client.enabledServices.filter((item): item is string => typeof item === "string")
              : [];
            return {
              id: row.id,
              reference: row.reference,
              title: row.title,
              status: row.status,
              billBasis: row.billBasis,
              clientId: row.clientId,
              startAt: assignmentByJob.get(row.id)?.startAt ?? null,
              startActivity: assignmentByJob.get(row.id)?.activityCode ?? null,
              startedAuto: Boolean(assignmentByJob.get(row.id)?.autoStartedAt),
              clientName: client?.name ?? "Client",
              clientCode: client?.code ?? "",
              enabledServices: services,
              completedCodes: [...(completedCodesByJob.get(row.id) ?? [])],
            };
          }),
        activities: activities
          .filter(
            (row) =>
              row.active && (!employee.clientId || row.clientId == null || row.clientId === employee.clientId),
          )
          .map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
            department: row.department,
            billable: row.billable,
          })),
        station: session ? deviceById.get(session.deviceId)?.code ?? null : null,
        checkout: checkout ? deviceById.get(checkout.deviceId)?.code ?? null : null,
        stations: deviceRows
          .filter((row) => row.kind === "packing_computer" && gear(row.clientId))
          .map((row) => {
            const claimed = openSessions.find((item) => item.deviceId === row.id);
            return {
              code: row.code,
              label: row.label,
              loginMode: row.warehanceLoginMode,
              claimedBy: claimed ? nameById.get(claimed.employeeId) ?? null : null,
              assignedTo: row.assignedEmployeeId
                ? nameById.get(row.assignedEmployeeId) ?? null
                : null,
            };
          }),
        scanners: deviceRows
          .filter((row) => (row.kind === "barcode_scanner" || row.kind === "handheld") && gear(row.clientId))
          .map((row) => {
            const held = openCheckouts.find((item) => item.deviceId === row.id);
            return {
              code: row.code,
              label: row.label,
              kind: row.kind,
              ownership: row.ownership,
              assignedTo: row.assignedEmployeeId
                ? nameById.get(row.assignedEmployeeId) ?? null
                : null,
              checkedOutTo: held ? nameById.get(held.employeeId) ?? null : null,
            };
          }),
        shipments: shipmentRows
          .filter((row) => row.status !== "closed" && mine(row.jobId))
          .map((row) => ({
            id: row.id,
            jobId: row.jobId,
            reference: row.reference,
            status: row.status,
            coworkers: workers
              .filter((worker) => worker.shipmentId === row.id && !worker.leftAt)
              .map((worker) => nameById.get(worker.employeeId) ?? "Someone"),
          })),
        loads: loadRows
          .filter((row) => row.status !== "done" && mine(row.jobId))
          .map((row) => ({
            id: row.id,
            jobId: row.jobId,
            reference: row.reference,
            kind: row.kind,
            dock: row.dock,
            crew: crew
              .filter((member) => member.loadId === row.id && !member.endedAt)
              .map((member) => nameById.get(member.employeeId) ?? "Someone"),
          })),
        gaylords: gaylordRows
          .filter((row) => row.status === "open" && owned(row.clientId))
          .map((row) => ({ id: row.id, code: row.code, carrier: row.carrier })),
      };
    });
  }

  async checkins() {
    const orm = this.db.db;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await orm
      .select({
        id: shifts.id,
        name: employees.name,
        badgeCode: employees.badgeCode,
        departmentHome: employees.departmentHome,
        clockIn: shifts.clockIn,
        clockOut: shifts.clockOut,
        source: shifts.source,
        clockInPlace: shifts.clockInPlace,
        clockInLat: shifts.clockInLat,
        clockInLng: shifts.clockInLng,
        clockOutPlace: shifts.clockOutPlace,
        clockOutLat: shifts.clockOutLat,
        clockOutLng: shifts.clockOutLng,
        clientId: employees.clientId,
      })
      .from(shifts)
      .innerJoin(employees, eq(employees.id, shifts.employeeId))
      .where(or(isNull(shifts.clockOut), gte(shifts.clockIn, start), gte(shifts.clockOut, start)))
      .orderBy(desc(shifts.clockIn));
    const refusedRows = await orm
      .select()
      .from(activity)
      .where(eq(activity.action, "tracking.location_refused"))
      .orderBy(desc(activity.createdAt))
      .limit(20);
    return {
      visits: rows,
      refused: refusedRows.map((row) => ({
        at: row.createdAt,
        text:
          row.after && typeof row.after === "object" && "summary" in row.after && typeof row.after.summary === "string"
            ? row.after.summary
            : "A location check was refused.",
      })),
    };
  }

  private async gateMode(): Promise<GateMode> {
    const [row] = await this.db.db.select().from(gateConfig).limit(1);
    return row?.mode === "qr_gate" ? "qr_gate" : "location";
  }

  private async gatePlaceNames() {
    const orm = this.db.db;
    let rows = await orm.select().from(gatePlaces).orderBy(asc(gatePlaces.createdAt), asc(gatePlaces.name));
    if (rows.length === 0) {
      const base = Date.now();
      await orm
        .insert(gatePlaces)
        .values(DEFAULT_GATE_PLACES.map((name, index) => ({ name, createdAt: new Date(base + index) })))
        .onConflictDoNothing();
      rows = await orm.select().from(gatePlaces).orderBy(asc(gatePlaces.createdAt), asc(gatePlaces.name));
    }
    return rows;
  }

  async gateStatus() {
    const mode = await this.gateMode();
    const [row] = await this.db.db.select({ id: site.id }).from(site).limit(1);
    const places = await this.gatePlaceNames();
    return {
      mode,
      ready: mode === "qr_gate" || Boolean(row),
      locationCheck: mode === "location" ? ("on" as const) : ("off" as const),
      places: places.map((place) => ({ id: place.id, name: place.name })),
    };
  }

  async setGateMode(mode: GateMode) {
    await this.inTx(async (tx) => {
      await tx
        .insert(gateConfig)
        .values({ id: 1, mode })
        .onConflictDoUpdate({ target: gateConfig.id, set: { mode, updatedAt: new Date() } });
      await this.audit(
        tx,
        null,
        "tracking.gate_mode",
        "gate",
        "gate",
        mode === "qr_gate"
          ? "Check-in method set to the QR gate. The floor phone only checks that a person is checked in."
          : "Check-in method set to location. Devices must be at the warehouse.",
      );
    });
    return this.gateStatus();
  }

  async addGatePlace(name: string) {
    const label = name.trim().replace(/\s+/g, " ");
    const existing = await this.gatePlaceNames();
    if (existing.some((place) => place.name.toLowerCase() === label.toLowerCase())) {
      throw new TrackingError(`"${label}" is already a gate location.`);
    }
    await this.db.db.insert(gatePlaces).values({ name: label });
    return this.gateStatus();
  }

  async removeGatePlace(id: string) {
    const existing = await this.gatePlaceNames();
    if (!existing.some((place) => place.id === id)) throw new TrackingError("That gate location is not on the list.");
    if (existing.length <= 1) throw new TrackingError("Keep at least one gate location.");
    await this.db.db.delete(gatePlaces).where(eq(gatePlaces.id, id));
    return this.gateStatus();
  }

  /**
   * Floor phone entry. In location mode the device must be at the warehouse, and that
   * also checks the person in. In QR gate mode nothing is checked here: the person
   * must already be checked in at the gate.
   */
  async phoneArrive(input: {
    badge: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    capturedAt?: number;
  }) {
    const mode = await this.gateMode();
    const orm = this.db.db;
    const [employee] = await orm
      .select()
      .from(employees)
      .where(eq(employees.badgeCode, clean(input.badge)))
      .limit(1);
    if (!employee || !employee.active) throw new TrackingError("That badge is not on the floor.");
    const open = await this.openShift(orm, employee.id);
    // A client with the Check-in service turned off has no gate and no location check.
    let checkinOff = false;
    if (employee.clientId) {
      const [client] = await orm
        .select({ enabledServices: clientRecords.enabledServices })
        .from(clientRecords)
        .where(eq(clientRecords.id, employee.clientId))
        .limit(1);
      checkinOff = Boolean(client) && !(client?.enabledServices ?? []).includes("checkin");
    }
    if (checkinOff) {
      if (open) return { mode, checkedIn: true, needsLocation: false, message: `${employee.name} is on the clock.` };
      const result = await this.clock(input.badge, "in", "kiosk", { place: "Floor phone" });
      return { mode, checkedIn: true, needsLocation: false, message: result.message };
    }
    if (mode === "qr_gate") {
      return {
        mode,
        checkedIn: Boolean(open),
        needsLocation: false,
        message: open ? `${employee.name} is checked in.` : `${employee.name} is not checked in. Use the QR gate first.`,
      };
    }
    // Location mode. With no position yet, tell the phone to read one and ask again.
    if (input.latitude == null && input.longitude == null && input.accuracy == null && input.capturedAt == null) {
      return { mode, checkedIn: Boolean(open), needsLocation: true, message: "This device must share its location." };
    }
    await this.requireDeviceAtWarehouse(input.badge, "in", input, "floor phone");
    if (open) return { mode, checkedIn: true, needsLocation: false, message: `${employee.name} is checked in.` };
    const result = await this.clock(input.badge, "in", "kiosk", { ...input, place: "Floor phone" });
    return { mode, checkedIn: true, needsLocation: false, message: result.message };
  }

  async readSite() {
    const [row] = await this.db.db.select().from(site).limit(1);
    if (!row) return { site: null };
    return {
      site: {
        latitude: row.latitude,
        longitude: row.longitude,
        radiusMeters: row.radiusMeters,
        updatedAt: row.updatedAt,
      },
    };
  }

  async saveSite(input: { latitude: number; longitude: number; radiusMeters: number }) {
    return this.inTx(async (tx) => {
      await tx.delete(site);
      const [row] = await tx
        .insert(site)
        .values({
          latitude: input.latitude,
          longitude: input.longitude,
          radiusMeters: input.radiusMeters,
        })
        .returning();
      if (!row) throw new TrackingError("Could not save the warehouse location.");
      await this.audit(tx, null, "tracking.site_set", "site", row.id, "The warehouse location check was set.");
      return {
        site: {
          latitude: row.latitude,
          longitude: row.longitude,
          radiusMeters: row.radiusMeters,
          updatedAt: row.updatedAt,
        },
      };
    });
  }

  async clock(
    badge: string,
    action: "in" | "out" | "meal_start" | "meal_end",
    source: "kiosk" | "qr" = "kiosk",
    where?: {
      place?: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      capturedAt?: number;
    },
  ) {
    if (source === "qr" && (action === "in" || action === "out")) {
      const places = await this.gatePlaceNames();
      const place = where?.place?.trim();
      if (place && !places.some((item) => item.name === place)) {
        throw new TrackingError("Choose a gate location from the list.");
      }
      if ((await this.gateMode()) === "location") {
        await this.requireDeviceAtWarehouse(badge, action, where, "QR");
      }
    }
    const result = await this.clockInTx(badge, action, source, where);
    if (action === "in" || action === "meal_end") {
      const employee = await this.db.db.select().from(employees).where(eq(employees.badgeCode, clean(badge))).limit(1);
      if (employee[0]) await this.startScheduled(employee[0].id);
    }
    return result;
  }

  private async clockInTx(
    badge: string,
    action: "in" | "out" | "meal_start" | "meal_end",
    source: "kiosk" | "qr",
    where?: {
      place?: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      capturedAt?: number;
    },
  ) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.openShift(tx, employee.id);
      const now = new Date();
      const arrived = source === "qr" ? "checked in" : "clocked in";
      const left = source === "qr" ? "checked out" : "clocked out";
      const place = where?.place?.trim();
      const latitude = where?.latitude;
      const longitude = where?.longitude;
      const accuracy = where?.accuracy;
      if (source === "qr" && (action === "in" || action === "out") && !place) {
        throw new TrackingError("Choose the gate location before scanning.");
      }
      if ((latitude == null) !== (longitude == null)) {
        throw new TrackingError("A map position needs both latitude and longitude.");
      }
      const at = place ? ` at ${place}` : "";

      if (action === "in") {
        if (shift) throw new TrackingError(`${employee.name} is already ${arrived}.`);
        await tx.insert(shifts).values({
          employeeId: employee.id,
          clockIn: now,
          source,
          clockInPlace: place ?? null,
          clockInLat: latitude ?? null,
          clockInLng: longitude ?? null,
          clockInAccuracy: accuracy ?? null,
        });
        await this.audit(
          tx,
          employee.id,
          "tracking.clock_in",
          "employee",
          employee.id,
          source === "qr" ? `${employee.name} checked in by QR${at}.` : `${employee.name} clocked in${at}.`,
        );
        return {
          message: `${employee.name} is ${arrived}${at}.`,
          name: employee.name,
          badgeCode: employee.badgeCode,
          action,
          place: place ?? null,
        };
      }

      if (!shift) {
        throw new TrackingError(
          `${employee.name} is not ${source === "qr" ? "checked in" : "clocked in"}.`,
        );
      }

      if (action === "out") {
        const meal = await this.openBreak(tx, shift.id);
        if (meal) {
          await tx.update(breaks).set({ endedAt: now }).where(eq(breaks.id, meal.id));
        }
        await tx.update(shifts).set({
          clockOut: now,
          clockOutPlace: place ?? null,
          clockOutLat: latitude ?? null,
          clockOutLng: longitude ?? null,
          clockOutAccuracy: accuracy ?? null,
        }).where(eq(shifts.id, shift.id));
        await this.closeOpenWork(tx, employee.id, now);
        await this.audit(
          tx,
          employee.id,
          "tracking.clock_out",
          "employee",
          employee.id,
          source === "qr" ? `${employee.name} checked out by QR${at}.` : `${employee.name} clocked out${at}.`,
        );
        return {
          message: `${employee.name} is ${left}${at}.`,
          name: employee.name,
          badgeCode: employee.badgeCode,
          action,
          place: place ?? null,
        };
      }

      const meal = await this.openBreak(tx, shift.id);
      if (action === "meal_start") {
        if (meal) throw new TrackingError(`${employee.name} is already on a meal break.`);
        await tx.insert(breaks).values({ shiftId: shift.id, kind: "meal", startedAt: now });
        const open = await this.openSegment(tx, employee.id);
        if (open) {
          await tx.update(segments).set({ endedAt: now, endReason: "meal" }).where(eq(segments.id, open.id));
        }
        const message = open
          ? `${employee.name} started a meal break. ${open.taskCode} is paused.`
          : `${employee.name} started a meal break.`;
        await this.audit(tx, employee.id, "tracking.meal_start", "employee", employee.id, message);
        return { message };
      }

      if (!meal) throw new TrackingError(`${employee.name} is not on a meal break.`);
      await tx.update(breaks).set({ endedAt: now }).where(eq(breaks.id, meal.id));
      await this.audit(tx, employee.id, "tracking.meal_end", "employee", employee.id, `${employee.name} ended a meal break.`);
      return { message: `${employee.name} is back from meal.` };
    });
  }

  async switchTask(
    badge: string,
    input: { department?: Department; activityCode?: string; jobId?: string; taskId?: string },
  ) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.requireReady(tx, employee);
      const assigned = input.taskId ? await this.assignedOpenTask(tx, employee, input.taskId) : null;
      const jobId = assigned?.jobId ?? input.jobId ?? null;
      let activity = (assigned?.activityCode ?? input.activityCode)
        ? await this.activityByCode(tx, assigned?.activityCode ?? input.activityCode ?? "")
        : null;
      if (!activity && assigned?.jobId) {
        activity = await this.billableActivityForJob(tx, employee, assigned.jobId);
      }
      const department = activity ? asDepartment(activity.department) : input.department;
      if (!department) throw new TrackingError("Choose an activity.");
      const taskCode = activity?.code ?? taskFor(department);
      const billable = activity ? activity.billable : taskCode !== "indirect";
      if (
        !assigned &&
        employee.departments?.length &&
        department !== "indirect" &&
        !employee.departments.includes(department)
      ) {
        throw new TrackingError(`${employee.name} is not set up for ${department}. Ask a manager to add it.`);
      }
      const jobCheck = assertBillableJob({ billable, jobId });
      if (!jobCheck.ok) throw new TrackingError(jobCheck.reason);
      const job = jobCheck.jobId ? await this.jobForEmployee(tx, employee, jobCheck.jobId, department) : null;
      const segmentId = await this.touchSegment(tx, employee, shift.id, department, null, {
        jobId: job?.id ?? null,
        activityId: activity?.id ?? null,
        taskCode,
        note: assigned?.id,
      });
      const label = assigned?.title ?? activity?.name ?? department;
      const where = job ? ` on ${job.reference}` : "";
      await this.audit(
        tx,
        employee.id,
        "tracking.task_switched",
        "activity_segment",
        segmentId,
        `${employee.name} switched to ${label}${where}.`,
      );
      return { message: `${employee.name} is on ${label}${where}.` };
    });
  }

  async pauseTask(badge: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      await this.requireReady(tx, employee);
      const open = await this.openSegment(tx, employee.id);
      const plan = planPause({ open: open ? { id: open.id } : null });
      if (!plan.ok) throw new TrackingError(plan.reason);
      const now = new Date();
      await tx.update(segments).set({ endedAt: now, endReason: "pause" }).where(eq(segments.id, plan.closeId));
      await this.audit(
        tx,
        employee.id,
        "tracking.task_paused",
        "activity_segment",
        plan.closeId,
        `${employee.name} paused ${open?.taskCode ?? "the current task"}.`,
      );
      return { message: `${employee.name} paused. The time already recorded stays on the job.` };
    });
  }

  async stopTask(badge: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      await this.requireReady(tx, employee);
      const open = await this.openSegment(tx, employee.id);
      const [last] = open
        ? []
        : await tx
            .select()
            .from(segments)
            .where(eq(segments.employeeId, employee.id))
            .orderBy(desc(segments.startedAt))
            .limit(1);
      const target =
        open ?? (last && (last.endReason === "pause" || last.endReason === "meal") ? last : null);
      if (!target) throw new TrackingError(`${employee.name} has nothing running to finish.`);
      const now = new Date();
      await tx.update(segments).set({ endedAt: target.endedAt ?? now, endReason: "complete" }).where(eq(segments.id, target.id));
      const minutes = Math.max(0, Math.round(((target.endedAt ?? now).getTime() - target.startedAt.getTime()) / 60_000));
      const span = minutes === 0 ? "less than a minute" : `${minutes} min`;
      const job = target.jobId ? await this.jobById(tx, target.jobId) : null;
      const message = job
        ? `${employee.name} finished. ${span} is on ${job.reference}.`
        : `${employee.name} finished. ${span} recorded.`;
      await this.audit(tx, employee.id, "tracking.task_stopped", "activity_segment", target.id, message);
      if (target.note) await this.completeTaskById(tx, employee.id, target.note);
      else if (target.jobId) await this.completeMatchingTask(tx, employee.id, target.jobId, target.taskCode);
      return { message };
    });
  }

  private async completeTaskById(tx: Conn, employeeId: string, taskId: string) {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.assigneeId, employeeId), eq(tasks.status, "open")))
      .limit(1);
    if (row) await tx.update(tasks).set({ status: "done" }).where(eq(tasks.id, row.id));
  }

  private async completeMatchingTask(tx: Conn, employeeId: string, jobId: string, taskCode: string) {
    const rows = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.jobId, jobId),
          eq(tasks.assigneeId, employeeId),
          eq(tasks.activityCode, taskCode),
          eq(tasks.status, "open"),
        ),
      )
      .orderBy(asc(tasks.createdAt));
    const byId = new Map((await tx.select().from(tasks).where(eq(tasks.jobId, jobId))).map((row) => [row.id, row]));
    const next = rows.find((row) => !row.dependsOnId || byId.get(row.dependsOnId)?.status === "done");
    if (next) await tx.update(tasks).set({ status: "done" }).where(eq(tasks.id, next.id));
  }

  async resumeTask(badge: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.requireReady(tx, employee);
      const open = await this.openSegment(tx, employee.id);
      if (open) throw new TrackingError(`${employee.name} is already on ${open.taskCode}.`);
      const [last] = await tx
        .select()
        .from(segments)
        .where(eq(segments.employeeId, employee.id))
        .orderBy(desc(segments.startedAt))
        .limit(1);
      if (!last || (last.endReason !== "pause" && last.endReason !== "meal")) {
        throw new TrackingError("Nothing is paused.");
      }
      if (last.jobId) await this.jobForEmployee(tx, employee, last.jobId, asDepartment(last.department));
      await this.touchSegment(tx, employee, shift.id, asDepartment(last.department), last.deviceId, {
        jobId: last.jobId,
        activityId: last.activityId,
        taskCode: last.taskCode,
        note: last.note,
      });
      const named = await tx.select().from(activityTypes).where(eq(activityTypes.code, last.taskCode));
      const activity = named.find((row) => row.clientId == null) ?? named[0];
      return { message: `${employee.name} resumed ${activity?.name ?? last.taskCode}.` };
    });
  }

  async claimStation(badge: string, deviceCode: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.requireReady(tx, employee);
      const device = await this.deviceByCode(tx, deviceCode);
      if (device.kind !== "packing_computer") {
        throw new TrackingError("Badge onto a packing computer.");
      }
      if (
        device.warehanceLoginMode === "individual" &&
        device.assignedEmployeeId &&
        device.assignedEmployeeId !== employee.id
      ) {
        const owner = await this.employeeById(tx, device.assignedEmployeeId);
        throw new TrackingError(`This computer is ${owner.name}'s station.`);
      }

      const now = new Date();
      const [occupied] = await tx
        .select()
        .from(stationSessions)
        .where(and(eq(stationSessions.deviceId, device.id), isNull(stationSessions.endedAt)))
        .limit(1);
      if (occupied && occupied.employeeId !== employee.id) {
        await tx.update(stationSessions).set({ endedAt: now }).where(eq(stationSessions.id, occupied.id));
        await this.endSegmentOnDevice(tx, occupied.employeeId, device.id, now);
      }

      const mine = await this.openSessionForEmployee(tx, employee.id);
      if (mine && mine.deviceId !== device.id) {
        await tx.update(stationSessions).set({ endedAt: now }).where(eq(stationSessions.id, mine.id));
      }
      if (!occupied || occupied.employeeId !== employee.id) {
        if (!mine || mine.deviceId !== device.id) {
          await tx.insert(stationSessions).values({
            deviceId: device.id,
            employeeId: employee.id,
            startedAt: now,
          });
        }
      }

      await this.touchSegment(tx, employee, shift.id, "packing", device.id);
      const shared = device.warehanceLoginMode === "shared";
      return {
        message: shared
          ? `${employee.name} claimed ${device.code}. This station is shared, so this badge is the packer.`
          : `${employee.name} is at ${device.code} on their own station.`,
      };
    });
  }

  async releaseStation(badge: string, deviceCode: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const device = await this.deviceByCode(tx, deviceCode);
      const session = await this.openSessionForEmployee(tx, employee.id);
      if (!session || session.deviceId !== device.id) {
        throw new TrackingError(`${employee.name} is not on ${device.code}.`);
      }
      const now = new Date();
      await tx.update(stationSessions).set({ endedAt: now }).where(eq(stationSessions.id, session.id));
      await this.endSegmentOnDevice(tx, employee.id, device.id, now);
      return { message: `${employee.name} left ${device.code}.` };
    });
  }

  async completePack(
    input: {
      orderNumber: string;
      deviceCode: string;
      badge?: string;
      units: number;
      warehanceRecorded?: boolean;
      warehanceUserId?: string;
      clientId?: string;
    },
    principal: Principal | null,
  ) {
    return this.inTx(async (tx) => {
      const device = await this.deviceByCode(tx, input.deviceCode);
      if (device.kind !== "packing_computer") {
        throw new TrackingError("Finish packing on a packing computer.");
      }
      const orderNumber = clean(input.orderNumber);
      const [existing] = await tx
        .select()
        .from(packEvents)
        .where(eq(packEvents.orderNumber, orderNumber))
        .limit(1);
      if (existing) {
        const packer = await this.employeeById(tx, existing.employeeId);
        throw new TrackingError(`${orderNumber} was already packed by ${packer.name}.`);
      }

      const badgeEmployee = input.badge ? await this.employeeByBadge(tx, input.badge) : null;
      const session = await this.openSessionForDevice(tx, device.id);
      let mapped: Employee | null = null;
      if (device.warehanceLoginMode === "individual") {
        if (input.warehanceUserId) {
          mapped = await this.employeeByWarehance(tx, input.warehanceUserId);
        } else if (device.assignedEmployeeId) {
          mapped = await this.employeeById(tx, device.assignedEmployeeId);
        }
      }

      const resolved = resolvePacker({
        loginMode: asMode(device.warehanceLoginMode),
        badgeEmployeeId: badgeEmployee?.id,
        stationSessionEmployeeId: session?.employeeId,
        warehanceMappedEmployeeId: mapped?.id,
      });
      if (!resolved.ok) throw new TrackingError(resolved.reason);

      const employee = await this.employeeById(tx, resolved.employeeId);
      if (principal && !can(principal, "tracking.manage") && !can(principal, "tracking.record")) {
        throw new TrackingError("You cannot record packing.");
      }
      if (input.clientId) await assertClientService(this.db.db, input.clientId, "packing");
      const shift = await this.requireReady(tx, employee);
      const segmentId = await this.touchSegment(tx, employee, shift.id, "packing", device.id);
      const warehanceRecorded = input.warehanceRecorded ?? false;
      const now = new Date();
      const [created] = await tx
        .insert(packEvents)
        .values({
          orderNumber,
          clientId: input.clientId ?? null,
          employeeId: employee.id,
          deviceId: device.id,
          attribution: resolved.attribution,
          warehanceUserId: mapped?.warehanceUserId ?? input.warehanceUserId ?? null,
          warehanceRecorded,
          loginMismatch: resolved.loginMismatch,
          units: input.units,
          packedAt: now,
          segmentId,
        })
        .returning();
      if (!created) throw new TrackingError("Could not record that pack.");

      const message = packSentence({
        name: employee.name,
        orderNumber,
        attribution: resolved.attribution,
        loginMismatch: resolved.loginMismatch,
      });
      await this.audit(tx, principal?.id ?? employee.id, "tracking.pack_recorded", "pack_event", created.id, message);
      return { message, orderNumber, employeeName: employee.name, warehanceRecorded };
    });
  }

  async checkout(badge: string, deviceCode: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      await this.requireReady(tx, employee);
      const device = await this.deviceByCode(tx, deviceCode);
      if (device.kind !== "barcode_scanner" && device.kind !== "handheld") {
        throw new TrackingError("Check out a scanner or handheld.");
      }
      if (device.ownership === "personal") {
        throw new TrackingError("This scanner stays with its assigned picker. No checkout needed.");
      }
      const [held] = await tx
        .select()
        .from(deviceCheckouts)
        .where(and(eq(deviceCheckouts.deviceId, device.id), isNull(deviceCheckouts.endedAt)))
        .limit(1);
      if (held?.employeeId === employee.id) {
        return { message: `${employee.name} already has ${device.code}.` };
      }
      if (held) {
        const holder = await this.employeeById(tx, held.employeeId);
        throw new TrackingError(`${device.code} is checked out to ${holder.name}.`);
      }
      const mine = await this.openCheckoutForEmployee(tx, employee.id);
      const now = new Date();
      if (mine) {
        await tx.update(deviceCheckouts).set({ endedAt: now }).where(eq(deviceCheckouts.id, mine.id));
      }
      await tx.insert(deviceCheckouts).values({
        deviceId: device.id,
        employeeId: employee.id,
        startedAt: now,
      });
      return { message: `${employee.name} checked out ${device.code}.` };
    });
  }

  async checkin(badge: string, deviceCode: string) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const device = await this.deviceByCode(tx, deviceCode);
      const [held] = await tx
        .select()
        .from(deviceCheckouts)
        .where(and(eq(deviceCheckouts.deviceId, device.id), isNull(deviceCheckouts.endedAt)))
        .limit(1);
      if (!held) throw new TrackingError(`${device.code} is already in the pool.`);
      if (held.employeeId !== employee.id) {
        throw new TrackingError("Only the person holding that device can check it in from the floor.");
      }
      await tx.update(deviceCheckouts).set({ endedAt: new Date() }).where(eq(deviceCheckouts.id, held.id));
      return { message: `${device.code} is back in the pool.` };
    });
  }

  async recordPick(
    input: {
      deviceCode: string;
      badge?: string;
      batchCode: string;
      sku: string;
      qty: number;
      orderNumber?: string;
      clientId?: string;
    },
    principal: Principal | null,
  ) {
    return this.inTx(async (tx) => {
      const device = await this.deviceByCode(tx, input.deviceCode);
      const badgeEmployee = input.badge ? await this.employeeByBadge(tx, input.badge) : null;
      const checkout = await this.openCheckoutForDevice(tx, device.id);
      const resolved = resolvePicker({
        kind: asKind(device.kind),
        ownership: asOwnership(device.ownership),
        assignedEmployeeId: device.assignedEmployeeId,
        checkoutEmployeeId: checkout?.employeeId,
        badgeEmployeeId: badgeEmployee?.id,
      });
      if (!resolved.ok) throw new TrackingError(resolved.reason);
      const employee = await this.employeeById(tx, resolved.employeeId);
      if (principal && !can(principal, "tracking.record") && !can(principal, "tracking.manage")) {
        throw new TrackingError("You cannot record picks.");
      }
      if (input.clientId) await assertClientService(this.db.db, input.clientId, "picking");
      const shift = await this.requireReady(tx, employee);
      const segmentId = await this.touchSegment(tx, employee, shift.id, "picking", device.id);
      const now = new Date();
      const [created] = await tx
        .insert(pickEvents)
        .values({
          batchCode: clean(input.batchCode),
          orderNumber: input.orderNumber ? clean(input.orderNumber) : null,
          sku: clean(input.sku),
          qty: input.qty,
          clientId: input.clientId ?? null,
          employeeId: employee.id,
          deviceId: device.id,
          via: resolved.via,
          pickedAt: now,
          segmentId,
        })
        .returning();
      if (!created) throw new TrackingError("Could not record that pick.");
      const via =
        resolved.via === "personal_device" ? "personal scanner" : "shared handheld";
      const message = `${employee.name} picked ${input.qty} × ${clean(input.sku)} on ${device.code} (${via}).`;
      await this.audit(tx, principal?.id ?? employee.id, "tracking.pick_recorded", "pick_event", created.id, message);
      return { message };
    });
  }

  async packingBoard() {
    const orm = this.db.db;
    const [deviceRows, people, sessions, events] = await Promise.all([
      orm.select().from(devices),
      orm.select().from(employees),
      orm.select().from(stationSessions).where(isNull(stationSessions.endedAt)),
      orm.select().from(packEvents),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    return {
      stations: deviceRows
        .filter((row) => row.kind === "packing_computer")
        .map((row) => {
          const session = sessions.find((item) => item.deviceId === row.id);
          return {
            code: row.code,
            label: row.label,
            location: row.location,
            loginMode: row.warehanceLoginMode,
            assignedTo: row.assignedEmployeeId ? names.get(row.assignedEmployeeId) ?? null : null,
            claimedBy: session ? names.get(session.employeeId) ?? null : null,
          };
        }),
      events: events
        .sort((a, b) => b.packedAt.getTime() - a.packedAt.getTime())
        .map((row) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          employeeName: names.get(row.employeeId) ?? "Someone",
          deviceCode: deviceRows.find((device) => device.id === row.deviceId)?.code ?? "",
          attribution: row.attribution,
          warehanceRecorded: row.warehanceRecorded,
          loginMismatch: row.loginMismatch,
          units: row.units,
          clientId: row.clientId,
          packedAt: row.packedAt,
          sentence: packSentence({
            name: names.get(row.employeeId) ?? "Someone",
            orderNumber: row.orderNumber,
            attribution: row.attribution,
            loginMismatch: row.loginMismatch,
          }),
        })),
    };
  }

  async pickingBoard() {
    const orm = this.db.db;
    const [deviceRows, people, checkouts, events] = await Promise.all([
      orm.select().from(devices),
      orm.select().from(employees),
      orm.select().from(deviceCheckouts).where(isNull(deviceCheckouts.endedAt)),
      orm.select().from(pickEvents),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    return {
      devices: deviceRows
        .filter((row) => row.kind === "barcode_scanner" || row.kind === "handheld")
        .map((row) => {
          const held = checkouts.find((item) => item.deviceId === row.id);
          return {
            code: row.code,
            label: row.label,
            kind: row.kind,
            ownership: row.ownership,
            location: row.location,
            assignedTo: row.assignedEmployeeId ? names.get(row.assignedEmployeeId) ?? null : null,
            checkedOutTo: held ? names.get(held.employeeId) ?? null : null,
          };
        }),
      events: events
        .sort((a, b) => b.pickedAt.getTime() - a.pickedAt.getTime())
        .map((row) => ({
          id: row.id,
          batchCode: row.batchCode,
          sku: row.sku,
          qty: row.qty,
          clientId: row.clientId,
          orderNumber: row.orderNumber,
          via: row.via,
          pickedAt: row.pickedAt,
          employeeName: names.get(row.employeeId) ?? "Someone",
          deviceCode: deviceRows.find((device) => device.id === row.deviceId)?.code ?? "",
        })),
    };
  }

  async listEmployees() {
    return this.db.db.select().from(employees);
  }

  async createEmployee(input: {
    name: string;
    badgeCode: string;
    departmentHome?: Department;
    departments?: Department[];
    employmentType: "employee" | "temp";
    warehanceUserId?: string;
    clientId?: string;
  }) {
    const owner = input.clientId ? await assertClientService(this.db.db, input.clientId, "people") : null;
    const allowed = [...new Set(input.departments?.length ? input.departments : input.departmentHome ? [input.departmentHome] : [])];
    if (allowed.length === 0) throw new TrackingError("Choose at least one kind of work.");
    if (input.clientId) {
      for (const department of allowed) {
        if (department !== "indirect") await assertClientService(this.db.db, input.clientId, department);
      }
    }
    return this.inTx(async (tx) => {
      const [created] = await tx
        .insert(employees)
        .values({
          name: input.name.trim(),
          badgeCode: clean(input.badgeCode),
          departmentHome: allowed[0] ?? "packing",
          departments: allowed,
          employmentType: input.employmentType,
          warehanceUserId: input.warehanceUserId ? clean(input.warehanceUserId) : null,
          clientId: owner?.id ?? null,
        })
        .returning();
      if (!created) throw new TrackingError("Could not add that employee.");
      return created;
    });
  }

  async listDevices() {
    const orm = this.db.db;
    const [deviceRows, people, sessions, checkouts] = await Promise.all([
      orm.select().from(devices),
      orm.select().from(employees),
      orm.select().from(stationSessions).where(isNull(stationSessions.endedAt)),
      orm.select().from(deviceCheckouts).where(isNull(deviceCheckouts.endedAt)),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    return deviceRows.map((row) => {
      const session = sessions.find((item) => item.deviceId === row.id);
      const checkout = checkouts.find((item) => item.deviceId === row.id);
      const live = session || checkout ? "in_use" : "available";
      return {
        ...row,
        assignedTo: row.assignedEmployeeId ? names.get(row.assignedEmployeeId) ?? null : null,
        heldBy: session
          ? names.get(session.employeeId) ?? null
          : checkout
            ? names.get(checkout.employeeId) ?? null
            : null,
        liveStatus: row.status === "maintenance" ? "maintenance" : live,
      };
    });
  }

  async createDevice(
    input: {
      code: string;
      label: string;
      kind: DeviceKind;
      ownership: Ownership;
      warehanceLoginMode: LoginMode;
      location: string;
      assignedBadge?: string;
      clientId?: string;
    },
    principal: Principal,
  ) {
    const owner = input.clientId ? await assertClientService(this.db.db, input.clientId, "equipment") : null;
    return this.inTx(async (tx) => {
      const assigned = input.assignedBadge
        ? await this.employeeByBadge(tx, input.assignedBadge)
        : null;
      const check = normalizeDevice({
        kind: input.kind,
        ownership: input.ownership,
        warehanceLoginMode: input.warehanceLoginMode,
        assignedEmployeeId: assigned?.id,
      });
      if (!check.ok) throw new TrackingError(check.reason);
      const [created] = await tx
        .insert(devices)
        .values({
          code: clean(input.code),
          label: input.label.trim(),
          kind: input.kind,
          ownership: input.ownership,
          warehanceLoginMode: input.warehanceLoginMode,
          location: input.location.trim(),
          assignedEmployeeId: assigned?.id ?? null,
          clientId: owner?.id ?? null,
          status: "available",
        })
        .returning();
      if (!created) throw new TrackingError("Could not register that device.");
      await this.audit(
        tx,
        principal.id,
        "tracking.device_registered",
        "device",
        created.id,
        `${created.code} added to the equipment register.`,
      );
      return created;
    });
  }

  async receivingBoard() {
    const orm = this.db.db;
    const [shipmentRows, workers, lines, people, clientRows, jobRows] = await Promise.all([
      orm.select().from(shipments),
      orm.select().from(shipmentWorkers),
      orm.select().from(receiptLines),
      orm.select().from(employees),
      orm.select().from(clientRecords),
      orm.select().from(jobs),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    const clientNames = new Map(clientRows.map((client) => [client.id, client.name]));
    const jobRefs = new Map(jobRows.map((job) => [job.id, job.reference]));
    return shipmentRows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        ...row,
        clientName: clientNames.get(row.clientId) ?? null,
        jobReference: row.jobId ? jobRefs.get(row.jobId) ?? null : null,
        workers: workers
          .filter((worker) => worker.shipmentId === row.id)
          .map((worker) => ({
            name: names.get(worker.employeeId) ?? "Someone",
            role: worker.role,
            joinedAt: worker.joinedAt,
            leftAt: worker.leftAt,
            active: !worker.leftAt,
          })),
        lines: lines
          .filter((line) => line.shipmentId === row.id)
          .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
          .map((line) => ({
            ...line,
            employeeName: names.get(line.employeeId) ?? "Someone",
            variance: line.receivedQty - line.expectedQty,
          })),
      }));
  }

  async createShipment(input: {
    reference: string;
    jobId: string;
    carrier: string;
    expectedCartons: number;
  }) {
    return this.inTx(async (tx) => {
      const job = await this.claimJob(tx, input.jobId);
      await assertClientService(this.db.db, job.clientId, "receiving");
      const [created] = await tx
        .insert(shipments)
        .values({
          reference: clean(input.reference),
          clientId: job.clientId,
          jobId: job.id,
          carrier: input.carrier.trim(),
          expectedCartons: input.expectedCartons,
          status: "expected",
        })
        .returning();
      if (!created) throw new TrackingError("Could not open that shipment.");
      return created;
    });
  }

  async joinShipment(shipmentId: string, badge: string, role: "lead" | "counter") {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, badge);
      const shift = await this.requireReady(tx, employee);
      const shipment = await this.shipmentById(tx, shipmentId);
      const active = await tx
        .select()
        .from(shipmentWorkers)
        .where(and(eq(shipmentWorkers.shipmentId, shipment.id), isNull(shipmentWorkers.leftAt)));
      const check = assertCanJoinShipment({
        status: shipment.status === "closed" ? "closed" : shipment.status === "receiving" ? "receiving" : "expected",
        activeWorkerIds: active.map((worker) => worker.employeeId),
        employeeId: employee.id,
      });
      if (!check.ok) throw new TrackingError(check.reason);
      const now = new Date();
      await tx.insert(shipmentWorkers).values({
        shipmentId: shipment.id,
        employeeId: employee.id,
        role,
        joinedAt: now,
      });
      if (shipment.status === "expected") {
        await tx.update(shipments).set({ status: "receiving" }).where(eq(shipments.id, shipment.id));
      }
      await this.touchSegment(tx, employee, shift.id, "receiving", null, {
        jobId: shipment.jobId,
        taskCode: "receive_shipment",
      });
      const message = check.concurrent
        ? `${employee.name} joined ${shipment.reference}. Other people are already on this shipment.`
        : `${employee.name} joined ${shipment.reference}.`;
      await this.audit(tx, employee.id, "tracking.shipment_joined", "inbound_shipment", shipment.id, message);
      return { message };
    });
  }

  async addReceiptLine(
    shipmentId: string,
    input: { badge: string; sku: string; expectedQty: number; receivedQty: number },
    principal: Principal | null,
  ) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, input.badge);
      const shift = await this.requireReady(tx, employee);
      const shipment = await this.shipmentById(tx, shipmentId);
      if (shipment.status === "closed") throw new TrackingError("This shipment is already closed.");
      const [worker] = await tx
        .select()
        .from(shipmentWorkers)
        .where(
          and(
            eq(shipmentWorkers.shipmentId, shipment.id),
            eq(shipmentWorkers.employeeId, employee.id),
            isNull(shipmentWorkers.leftAt),
          ),
        )
        .limit(1);
      if (!worker) throw new TrackingError(`${employee.name} needs to join ${shipment.reference} before counting.`);
      const now = new Date();
      const segmentId = await this.touchSegment(tx, employee, shift.id, "receiving", null, {
        jobId: shipment.jobId,
        taskCode: "receive_shipment",
      });
      const [line] = await tx
        .insert(receiptLines)
        .values({
          shipmentId: shipment.id,
          employeeId: employee.id,
          sku: clean(input.sku),
          expectedQty: input.expectedQty,
          receivedQty: input.receivedQty,
          recordedAt: now,
          segmentId,
        })
        .returning();
      if (!line) throw new TrackingError("Could not record that count.");
      await tx
        .update(shipments)
        .set({
          status: "receiving",
          receivedCartons: shipment.receivedCartons + input.receivedQty,
        })
        .where(eq(shipments.id, shipment.id));
      if (input.expectedQty !== input.receivedQty) {
        await tx.insert(tasks).values({
          title: `Check ${clean(input.sku)} on ${shipment.reference}`,
          details: `${employee.name} counted ${input.receivedQty} against ${input.expectedQty} expected.`,
          status: "open",
          clientId: shipment.clientId,
          requestorId: principal?.id ?? null,
          relatedType: "inbound_shipment",
          relatedId: shipment.id,
        });
      }
      const variance = input.receivedQty - input.expectedQty;
      const message =
        variance === 0
          ? `${employee.name} counted ${clean(input.sku)} on ${shipment.reference}. It matches.`
          : `${employee.name} counted ${clean(input.sku)} on ${shipment.reference}. Off by ${variance}. A follow-up is open.`;
      await this.audit(tx, principal?.id ?? employee.id, "tracking.receipt_line", "receipt_line", line.id, message);
      return { message };
    });
  }

  async closeShipment(shipmentId: string) {
    return this.inTx(async (tx) => {
      const shipment = await this.shipmentById(tx, shipmentId);
      if (shipment.status === "closed") throw new TrackingError("This shipment is already closed.");
      const now = new Date();
      await tx
        .update(shipmentWorkers)
        .set({ leftAt: now })
        .where(and(eq(shipmentWorkers.shipmentId, shipment.id), isNull(shipmentWorkers.leftAt)));
      await tx.update(shipments).set({ status: "closed" }).where(eq(shipments.id, shipment.id));
      return { message: `${shipment.reference} is closed.` };
    });
  }

  async unloadingBoard() {
    const orm = this.db.db;
    const [loadRows, crew, people, clientRows, jobRows, assigneeRows] = await Promise.all([
      orm.select().from(loads),
      orm.select().from(loadCrew),
      orm.select().from(employees),
      orm.select().from(clientRecords),
      orm.select().from(jobs),
      orm.select().from(jobAssignees),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    const clientNames = new Map(clientRows.map((client) => [client.id, client.name]));
    const jobRefs = new Map(jobRows.map((job) => [job.id, job.reference]));
    return {
      loads: loadRows
        .sort((a, b) => b.arrivalAt.getTime() - a.arrivalAt.getTime())
        .map((row) => ({
          ...row,
          clientName: row.clientId ? clientNames.get(row.clientId) ?? null : null,
          jobReference: row.jobId ? jobRefs.get(row.jobId) ?? null : null,
          assigned: assigneeRows
            .filter((item) => item.jobId === row.jobId)
            .map((item) => ({ employeeId: item.employeeId, name: names.get(item.employeeId) ?? "Someone" })),
          crew: crew
            .filter((member) => member.loadId === row.id)
            .map((member) => ({
              employeeId: member.employeeId,
              name: names.get(member.employeeId) ?? "Someone",
              source: member.source,
              startedAt: member.startedAt,
              endedAt: member.endedAt,
              active: !member.endedAt,
            })),
        })),
      people: people.filter((person) => person.active).map((person) => ({ id: person.id, name: person.name })),
    };
  }

  async createLoad(input: {
    reference: string;
    jobId: string;
    kind: "truck" | "container";
    dock: string;
    seal?: string;
  }) {
    return this.inTx(async (tx) => {
      const job = await this.claimJob(tx, input.jobId);
      await assertClientService(this.db.db, job.clientId, "unloading");
      const [created] = await tx
        .insert(loads)
        .values({
          reference: clean(input.reference),
          jobId: job.id,
          clientId: job.clientId,
          kind: input.kind,
          dock: input.dock.trim(),
          seal: input.seal ?? null,
          status: "arrived",
          arrivalAt: new Date(),
        })
        .returning();
      if (!created) throw new TrackingError("Could not open that load.");
      return { id: created.id, message: `${created.reference} has arrived.` };
    });
  }

  async addCrew(
    loadId: string,
    input: { source: "badge" | "lead_added" | "paper"; badge?: string; employeeId?: string },
    principal: Principal | null,
  ) {
    return this.inTx(async (tx) => {
      const allowed = assertCrewSource({
        source: input.source,
        actorCanManage: Boolean(principal && can(principal, "tracking.manage")),
      });
      if (!allowed.ok) throw new TrackingError(allowed.reason);
      const load = await this.loadById(tx, loadId);
      if (load.status === "done") throw new TrackingError("That load is already finished.");
      const employee = input.badge
        ? await this.employeeByBadge(tx, input.badge)
        : input.employeeId
          ? await this.employeeById(tx, input.employeeId)
          : null;
      if (!employee) throw new TrackingError("Choose the employee who worked this load.");
      const shift = await this.requireReady(tx, employee);
      const [active] = await tx
        .select()
        .from(loadCrew)
        .where(and(eq(loadCrew.loadId, load.id), eq(loadCrew.employeeId, employee.id), isNull(loadCrew.endedAt)))
        .limit(1);
      if (active) throw new TrackingError(`${employee.name} is already on ${load.reference}.`);
      const now = new Date();
      await tx.insert(loadCrew).values({
        loadId: load.id,
        employeeId: employee.id,
        source: input.source,
        startedAt: now,
      });
      if (!load.unloadStartedAt) {
        await tx
          .update(loads)
          .set({ status: "unloading", unloadStartedAt: now })
          .where(eq(loads.id, load.id));
      }
      await this.touchSegment(tx, employee, shift.id, "unloading", null, {
        jobId: load.jobId,
        taskCode: "unload_trailer",
      });
      const how =
        input.source === "badge"
          ? "badged onto the load"
          : input.source === "paper"
            ? "was added from the paper crew list"
            : "was added by a lead";
      const message = `${employee.name} ${how} for ${load.reference}.`;
      await this.audit(tx, principal?.id ?? employee.id, "tracking.crew_joined", "inbound_load", load.id, message);
      return { message };
    });
  }

  async finishLoad(loadId: string, input: { palletCount: number; cartonCount: number }) {
    return this.inTx(async (tx) => {
      const load = await this.loadById(tx, loadId);
      if (load.status === "done") throw new TrackingError("That load is already finished.");
      const crew = await tx.select().from(loadCrew).where(eq(loadCrew.loadId, load.id));
      if (crew.length === 0) {
        throw new TrackingError("Add the crew before finishing the load. A truck with no names is not a record.");
      }
      const now = new Date();
      await tx
        .update(loadCrew)
        .set({ endedAt: now })
        .where(and(eq(loadCrew.loadId, load.id), isNull(loadCrew.endedAt)));
      await tx
        .update(loads)
        .set({
          status: "done",
          unloadEndedAt: now,
          palletCount: input.palletCount,
          cartonCount: input.cartonCount,
        })
        .where(eq(loads.id, load.id));
      for (const member of crew) {
        await this.endDepartmentSegment(tx, member.employeeId, "unloading", now);
      }
      return { message: `${load.reference} is unloaded. ${crew.length} people are on the crew.` };
    });
  }

  async sortingBoard() {
    const orm = this.db.db;
    const [gaylordRows, scans, people, deviceRows] = await Promise.all([
      orm.select().from(gaylords),
      orm.select().from(sortScans),
      orm.select().from(employees),
      orm.select().from(devices),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    const deviceCodes = new Map(deviceRows.map((row) => [row.id, row.code]));
    return gaylordRows
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .map((row) => ({
        ...row,
        scans: scans
          .filter((scan) => scan.gaylordId === row.id)
          .sort((a, b) => b.scannedAt.getTime() - a.scannedAt.getTime())
          .map((scan) => ({
            trackingNumber: scan.trackingNumber,
            method: scan.method,
            reason: scan.reason,
            scannedAt: scan.scannedAt,
            employeeName: names.get(scan.employeeId) ?? "Someone",
            deviceCode: scan.deviceId ? deviceCodes.get(scan.deviceId) ?? null : null,
          })),
      }));
  }

  async createGaylord(input: { code: string; carrier: "usps" | "ups" | "fedex" | "dhl" | "other"; clientId?: string }) {
    return this.inTx(async (tx) => {
      if (input.clientId) await assertClientService(this.db.db, input.clientId, "sorting");
      const [created] = await tx
        .insert(gaylords)
        .values({
          code: clean(input.code),
          carrier: input.carrier,
          clientId: input.clientId ?? null,
          status: "open",
          openedAt: new Date(),
        })
        .returning();
      if (!created) throw new TrackingError("Could not open that gaylord.");
      return created;
    });
  }

  async sortScan(input: {
    gaylordCode: string;
    trackingNumber: string;
    badge: string;
    deviceCode?: string;
    method: "scan" | "manual_place";
    reason?: string;
  }) {
    return this.inTx(async (tx) => {
      const employee = await this.employeeByBadge(tx, input.badge);
      const shift = await this.requireReady(tx, employee);
      const code = clean(input.gaylordCode);
      const [gaylord] = await tx.select().from(gaylords).where(eq(gaylords.code, code)).limit(1);
      if (!gaylord) throw new TrackingError("That gaylord is not open on the floor.");
      const trackingNumber = clean(input.trackingNumber);
      const [duplicate] = await tx
        .select()
        .from(sortScans)
        .where(eq(sortScans.trackingNumber, trackingNumber))
        .limit(1);
      let duplicateCode: string | null = null;
      if (duplicate) {
        const [previous] = await tx
          .select()
          .from(gaylords)
          .where(eq(gaylords.id, duplicate.gaylordId))
          .limit(1);
        duplicateCode = previous?.code ?? "another gaylord";
      }
      const check = assertSortPlacement({
        method: input.method,
        reason: input.reason,
        gaylordStatus: gaylord.status === "open" ? "open" : "closed",
        duplicateGaylordCode: duplicateCode,
      });
      if (!check.ok) throw new TrackingError(check.reason);
      let deviceId: string | null = null;
      if (input.deviceCode) {
        const device = await this.deviceByCode(tx, input.deviceCode);
        if (device.kind !== "barcode_scanner" && device.kind !== "handheld") {
          throw new TrackingError("Sort scans use a scanner or handheld.");
        }
        deviceId = device.id;
      }
      const now = new Date();
      const [created] = await tx
        .insert(sortScans)
        .values({
          gaylordId: gaylord.id,
          trackingNumber,
          employeeId: employee.id,
          deviceId,
          method: input.method,
          reason: input.reason ?? null,
          scannedAt: now,
        })
        .returning();
      if (!created) throw new TrackingError("Could not record that scan.");
      const segmentId = await this.touchSegment(tx, employee, shift.id, "sorting", deviceId);
      void segmentId;
      const message =
        input.method === "scan"
          ? `${employee.name} scanned ${trackingNumber} into ${gaylord.code} (${gaylord.carrier.toUpperCase()}).`
          : `${employee.name} placed ${trackingNumber} into ${gaylord.code} without a scan. ${input.reason}`;
      await this.audit(tx, employee.id, "tracking.sort_scanned", "sort_scan", created.id, message);
      return { message };
    });
  }

  async closeGaylord(gaylordId: string) {
    return this.inTx(async (tx) => {
      const [gaylord] = await tx.select().from(gaylords).where(eq(gaylords.id, gaylordId)).limit(1);
      if (!gaylord) throw new TrackingError("That gaylord is not on the floor.");
      if (gaylord.status !== "open") throw new TrackingError("That gaylord is already closed.");
      await tx
        .update(gaylords)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(gaylords.id, gaylord.id));
      return { message: `${gaylord.code} is closed.` };
    });
  }

  async startScheduled(employeeId?: string) {
    const now = new Date();
    const earliest = new Date(now.getTime() - SCHEDULE_WINDOW_MS);
    const due = (
      await this.db.db
        .select()
        .from(jobAssignees)
        .where(and(isNull(jobAssignees.autoStartedAt), lte(jobAssignees.startAt, now), gte(jobAssignees.startAt, earliest)))
    ).filter((row) => !employeeId || row.employeeId === employeeId);
    let started = 0;
    for (const row of due) {
      const done = await this.inTx(async (tx) => {
        const [claim] = await tx
          .select()
          .from(jobAssignees)
          .where(and(eq(jobAssignees.id, row.id), isNull(jobAssignees.autoStartedAt)))
          .limit(1);
        if (!claim || !claim.startAt || !claim.activityCode) return false;
        const employee = await this.employeeById(tx, claim.employeeId);
        const shift = await this.openShift(tx, employee.id);
        if (!shift || !employee.active) return false;
        if (await this.openBreak(tx, shift.id)) return false;
        const job = await this.jobById(tx, claim.jobId);
        if (job.status === "done") return false;
        const activity = await this.activityByCode(tx, claim.activityCode);
        const department = asDepartment(activity.department);
        const open = await this.openSegment(tx, employee.id);
        const alreadyOn = open && open.jobId === job.id && open.taskCode === activity.code;
        // Never steal a timer the worker already started on another job or task.
        if (open && !alreadyOn) return false;
        if (!open) {
          const [last] = await tx
            .select()
            .from(segments)
            .where(eq(segments.employeeId, employee.id))
            .orderBy(desc(segments.startedAt))
            .limit(1);
          if (last && (last.endReason === "pause" || last.endReason === "meal")) return false;
        }
        const doneTask = (
          await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.jobId, job.id),
                eq(tasks.assigneeId, employee.id),
                eq(tasks.activityCode, activity.code),
                eq(tasks.status, "done"),
              ),
            )
            .limit(1)
        )[0];
        const doneSegment = (
          await tx
            .select({ id: segments.id })
            .from(segments)
            .where(
              and(
                eq(segments.employeeId, employee.id),
                eq(segments.jobId, job.id),
                eq(segments.taskCode, activity.code),
                eq(segments.endReason, "complete"),
              ),
            )
            .limit(1)
        )[0];
        if (doneTask || doneSegment) {
          await tx.update(jobAssignees).set({ autoStartedAt: new Date() }).where(eq(jobAssignees.id, claim.id));
          return false;
        }
        if (!alreadyOn) {
          await assertClientService(this.db.db, job.clientId, department as ClientService);
          await this.claimJob(tx, job.id);
          const begin = claim.startAt > shift.clockIn ? claim.startAt : shift.clockIn;
          const segmentId = await this.touchSegment(tx, employee, shift.id, department, null, {
            jobId: job.id,
            activityId: activity.id,
            taskCode: activity.code,
            at: begin,
          });
          await this.audit(
            tx,
            employee.id,
            "tracking.task_auto_started",
            "activity_segment",
            segmentId,
            `${employee.name} started ${activity.name} on ${job.reference} at the time set on the job.`,
          );
        }
        await tx.update(jobAssignees).set({ autoStartedAt: new Date() }).where(eq(jobAssignees.id, claim.id));
        return true;
      }).catch(() => false);
      if (done) started += 1;
    }
    return { started };
  }

  async sweep() {
    const orm = this.db.db;
    const open = await orm.select().from(segments).where(isNull(segments.endedAt));
    let closed = 0;
    for (const segment of open) {
      const [shift] = await orm.select().from(shifts).where(eq(shifts.id, segment.shiftId)).limit(1);
      if (shift?.clockOut) {
        await orm.update(segments).set({ endedAt: shift.clockOut }).where(eq(segments.id, segment.id));
        closed += 1;
      }
    }
    const scheduled = await this.startScheduled();
    return { closed, started: scheduled.started };
  }

  private async inTx<T>(fn: (tx: Conn) => Promise<T>): Promise<T> {
    try {
      return await this.db.db.transaction(async (tx) => fn(tx as unknown as Conn));
    } catch (err) {
      if (err instanceof TrackingError) throw err;
      if (isUnique(err)) {
        throw new TrackingError("That was already recorded. Refresh and try again.");
      }
      throw err;
    }
  }

  private async requireDeviceAtWarehouse(
    badge: string,
    action: "in" | "out",
    where?: { latitude?: number; longitude?: number; accuracy?: number; capturedAt?: number },
    via = "QR",
  ) {
    const orm = this.db.db;
    const [employee] = await orm
      .select()
      .from(employees)
      .where(eq(employees.badgeCode, clean(badge)))
      .limit(1);
    if (!employee || !employee.active) throw new TrackingError("That badge is not on the floor.");
    const [row] = await orm.select().from(site).limit(1);
    const verdict = assertDeviceLocation({
      latitude: where?.latitude,
      longitude: where?.longitude,
      accuracy: where?.accuracy,
      capturedAt: where?.capturedAt,
      now: Date.now(),
      site: row
        ? { latitude: row.latitude, longitude: row.longitude, radiusMeters: row.radiusMeters }
        : null,
    });
    if (verdict.ok) return;
    const away = verdict.distanceMeters == null ? "" : ` ${Math.round(verdict.distanceMeters)} m away.`;
    const verb = action === "in" ? "check-in" : "check-out";
    await orm.insert(activity).values({
      actorId: employee.id,
      action: "tracking.location_refused",
      module: "tracking",
      entityType: "employee",
      entityId: employee.id,
      after: { summary: `${employee.name}'s ${via} ${verb} was refused. ${verdict.reason}${away}` },
    });
    throw new TrackingError(verdict.reason);
  }

  private async employeeByBadge(tx: Conn, badge: string) {
    const [employee] = await tx
      .select()
      .from(employees)
      .where(eq(employees.badgeCode, clean(badge)))
      .limit(1);
    if (!employee || !employee.active) throw new TrackingError("That badge is not on the floor.");
    return employee;
  }

  private async employeeById(tx: Conn, id: string) {
    const [employee] = await tx.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!employee) throw new TrackingError("That employee is not on the floor.");
    return employee;
  }

  private async employeeByWarehance(tx: Conn, warehanceUserId: string) {
    const [employee] = await tx
      .select()
      .from(employees)
      .where(eq(employees.warehanceUserId, clean(warehanceUserId)))
      .limit(1);
    if (!employee) throw new TrackingError("That station login is not linked to an employee.");
    return employee;
  }

  private async deviceByCode(tx: Conn, code: string) {
    const [device] = await tx.select().from(devices).where(eq(devices.code, clean(code))).limit(1);
    if (!device) throw new TrackingError("That device is not in the equipment register.");
    return device;
  }

  private async shipmentById(tx: Conn, id: string) {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    if (!shipment) throw new TrackingError("That shipment is not on the floor.");
    return shipment;
  }

  private async loadById(tx: Conn, id: string) {
    const [load] = await tx.select().from(loads).where(eq(loads.id, id)).limit(1);
    if (!load) throw new TrackingError("That truck or container is not on the floor.");
    return load;
  }

  private async openShift(tx: Conn, employeeId: string) {
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(and(eq(shifts.employeeId, employeeId), isNull(shifts.clockOut)))
      .limit(1);
    return shift ?? null;
  }

  private async openBreak(tx: Conn, shiftId: string) {
    const [row] = await tx
      .select()
      .from(breaks)
      .where(and(eq(breaks.shiftId, shiftId), isNull(breaks.endedAt)))
      .limit(1);
    return row ?? null;
  }

  private async openSegment(tx: Conn, employeeId: string) {
    const [row] = await tx
      .select()
      .from(segments)
      .where(and(eq(segments.employeeId, employeeId), isNull(segments.endedAt)))
      .orderBy(desc(segments.startedAt))
      .limit(1);
    return row ?? null;
  }

  private async closeOpenSegments(tx: Conn, employeeId: string, now: Date, reason: string, exceptId?: string) {
    const open = await tx
      .select()
      .from(segments)
      .where(and(eq(segments.employeeId, employeeId), isNull(segments.endedAt)));
    for (const row of open) {
      if (exceptId && row.id === exceptId) continue;
      await tx.update(segments).set({ endedAt: now, endReason: reason }).where(eq(segments.id, row.id));
    }
  }

  private async requireReady(tx: Conn, employee: Employee) {
    const shift = await this.openShift(tx, employee.id);
    if (!shift) throw new TrackingError(`${employee.name} is not checked in. Use the QR gate first.`);
    const meal = await this.openBreak(tx, shift.id);
    if (meal) throw new TrackingError(`${employee.name} is on a meal break. End it before starting work.`);
    return shift;
  }

  private async openSessionForDevice(tx: Conn, deviceId: string) {
    const [row] = await tx
      .select()
      .from(stationSessions)
      .where(and(eq(stationSessions.deviceId, deviceId), isNull(stationSessions.endedAt)))
      .limit(1);
    return row ?? null;
  }

  private async openSessionForEmployee(tx: Conn, employeeId: string) {
    const [row] = await tx
      .select()
      .from(stationSessions)
      .where(and(eq(stationSessions.employeeId, employeeId), isNull(stationSessions.endedAt)))
      .limit(1);
    return row ?? null;
  }

  private async openCheckoutForDevice(tx: Conn, deviceId: string) {
    const [row] = await tx
      .select()
      .from(deviceCheckouts)
      .where(and(eq(deviceCheckouts.deviceId, deviceId), isNull(deviceCheckouts.endedAt)))
      .limit(1);
    return row ?? null;
  }

  private async openCheckoutForEmployee(tx: Conn, employeeId: string) {
    const [row] = await tx
      .select()
      .from(deviceCheckouts)
      .where(and(eq(deviceCheckouts.employeeId, employeeId), isNull(deviceCheckouts.endedAt)))
      .limit(1);
    return row ?? null;
  }

  private async touchSegment(
    tx: Conn,
    employee: Employee,
    shiftId: string,
    department: Department,
    deviceId: string | null,
    link?: { jobId?: string | null; activityId?: string | null; taskCode?: string; at?: Date; note?: string | null },
  ) {
    const open = await this.openSegment(tx, employee.id);
    const taskCode = link?.taskCode ?? taskFor(department);
    const jobProvided = Boolean(link && Object.prototype.hasOwnProperty.call(link, "jobId"));
    // A packing scan must not keep a picking job on the new timer.
    const jobId = jobProvided
      ? (link?.jobId ?? null)
      : open && open.department === department && open.taskCode === taskCode
        ? open.jobId
        : null;
    const activityProvided = Boolean(link && Object.prototype.hasOwnProperty.call(link, "activityId"));
    const activityId = activityProvided
      ? (link?.activityId ?? null)
      : open && open.taskCode === taskCode
        ? open.activityId
        : null;
    const plan = planTaskSwitch({
      open: open
        ? { id: open.id, department: asDepartment(open.department), taskCode: open.taskCode, jobId: open.jobId }
        : null,
      next: { department, taskCode, jobId },
    });
    const now = link?.at ?? new Date();
    if (!plan.start && open) {
      if (deviceId && open.deviceId !== deviceId) {
        await tx.update(segments).set({ deviceId }).where(eq(segments.id, open.id));
      }
      await this.closeOpenSegments(tx, employee.id, now, "switch", open.id);
      return open.id;
    }
    await this.closeOpenSegments(tx, employee.id, now, "switch");
    const [created] = await tx
      .insert(segments)
      .values({
        employeeId: employee.id,
        shiftId,
        department,
        taskCode,
        jobId,
        activityId,
        startedAt: now,
        deviceId,
        note: link?.note ?? null,
      })
      .returning();
    if (!created) throw new TrackingError("Could not start that task.");
    if (plan.closeId) {
      await this.audit(
        tx,
        employee.id,
        "tracking.task_switched",
        "activity_segment",
        created.id,
        `${employee.name} changed task to ${department}.`,
      );
    }
    return created.id;
  }

  private async endSegmentOnDevice(tx: Conn, employeeId: string, deviceId: string, now: Date) {
    const open = await this.openSegment(tx, employeeId);
    if (open?.deviceId === deviceId) {
      await tx.update(segments).set({ endedAt: now }).where(eq(segments.id, open.id));
    }
  }

  private async endDepartmentSegment(tx: Conn, employeeId: string, department: Department, now: Date) {
    const open = await this.openSegment(tx, employeeId);
    if (open && open.department === department) {
      await tx.update(segments).set({ endedAt: now, endReason: "complete" }).where(eq(segments.id, open.id));
    }
  }

  private async closeOpenWork(tx: Conn, employeeId: string, now: Date) {
    await this.closeOpenSegments(tx, employeeId, now, "clock_out");
    const session = await this.openSessionForEmployee(tx, employeeId);
    if (session) {
      await tx.update(stationSessions).set({ endedAt: now }).where(eq(stationSessions.id, session.id));
    }
    const checkout = await this.openCheckoutForEmployee(tx, employeeId);
    if (checkout) {
      await tx.update(deviceCheckouts).set({ endedAt: now }).where(eq(deviceCheckouts.id, checkout.id));
    }
    await tx
      .update(shipmentWorkers)
      .set({ leftAt: now })
      .where(and(eq(shipmentWorkers.employeeId, employeeId), isNull(shipmentWorkers.leftAt)));
    await tx
      .update(loadCrew)
      .set({ endedAt: now })
      .where(and(eq(loadCrew.employeeId, employeeId), isNull(loadCrew.endedAt)));
  }

  private async jobById(tx: Conn, jobId: string) {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new TrackingError("That job is not on file.");
    return job;
  }

  private async assignedOpenTask(tx: Conn, employee: Employee, taskId: string) {
    const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!row) throw new TrackingError("That task is not on file.");
    if (row.assigneeId !== employee.id) throw new TrackingError(`${employee.name} is not assigned to that task.`);
    if (row.status === "done") throw new TrackingError("That task is already done.");
    if (!row.jobId) throw new TrackingError("That task is not on a job.");
    if (row.dependsOnId) {
      const [earlier] = await tx.select().from(tasks).where(eq(tasks.id, row.dependsOnId)).limit(1);
      if (earlier && earlier.status !== "done") {
        throw new TrackingError(`${row.title} is waiting on ${earlier.title}.`);
      }
    }
    return row;
  }

  private async billableActivityForJob(tx: Conn, employee: Employee, jobId: string) {
    const job = await this.jobById(tx, jobId);
    const [client] = await tx.select().from(clientRecords).where(eq(clientRecords.id, job.clientId)).limit(1);
    const services = enabledServiceList(client?.enabledServices);
    const catalog = await tx.select().from(activityTypes);
    const matches = catalog.filter(
      (row) =>
        row.active &&
        row.billable &&
        row.department !== "indirect" &&
        services.includes(row.department) &&
        (row.clientId == null || row.clientId === job.clientId),
    );
    const preferred = employee.departments?.length
      ? matches.find((row) => employee.departments?.includes(row.department))
      : null;
    const pick = preferred ?? matches[0];
    if (!pick) throw new TrackingError("This job has no task type to clock. Turn a service on for the client.");
    return pick;
  }

  private async jobForEmployee(tx: Conn, employee: Employee, jobId: string, department: Department) {
    const job = await this.jobById(tx, jobId);
    if (employee.clientId && job.clientId !== employee.clientId) {
      throw new TrackingError("That project belongs to another client.");
    }
    const [assignment] = await tx
      .select()
      .from(jobAssignees)
      .where(and(eq(jobAssignees.jobId, job.id), eq(jobAssignees.employeeId, employee.id)))
      .limit(1);
    if (!assignment) throw new TrackingError(`${employee.name} is not assigned to ${job.reference}.`);
    if (department !== "indirect") {
      await assertClientService(this.db.db, job.clientId, department);
    }
    return this.claimJob(tx, job.id);
  }

  private async claimJob(tx: Conn, jobId: string) {
    const job = await this.jobById(tx, jobId);
    if (job.status === "done") throw new TrackingError("That job is already closed.");
    if (job.status === "open") {
      await tx.update(jobs).set({ status: "active" }).where(eq(jobs.id, job.id));
    }
    return job;
  }

  private async activityByCode(tx: Conn, code: string) {
    const rows = await tx.select().from(activityTypes).where(eq(activityTypes.code, code.trim()));
    const activityType = rows.find((row) => row.clientId == null) ?? rows[0];
    if (!activityType || !activityType.active) throw new TrackingError("That activity is not on file.");
    return activityType;
  }

  private async audit(
    tx: Conn,
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    summary: string,
  ) {
    await tx.insert(activity).values({
      actorId,
      action,
      module: "tracking",
      entityType,
      entityId,
      after: { summary },
    });
  }
}
