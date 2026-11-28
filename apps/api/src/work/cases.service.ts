import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { activity, caseNotes, cases, clientRecords, employees, jobs, users, type Database } from "@opsengine/db";
import { can, type Principal } from "@opsengine/kernel";
import type { CaseKind, CaseStatus } from "@opsengine/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { CASE_KIND_LABELS, openCase } from "./case-store.js";

type Conn = Database;
type CaseRow = typeof cases.$inferSelect;

type Refs = {
  trackingNumber?: string;
  orderNumber?: string;
  sku?: string;
  shipmentId?: string;
  loadId?: string;
  gaylordId?: string;
};

const STATUS_LABELS: Record<string, string> = { open: "open", investigating: "investigating", resolved: "resolved", closed: "closed" };

/** Owners, warehouse managers and HR see problems. Only owners and managers change them. */
export function canSeeCases(principal: Principal) {
  return can(principal, "tracking.manage") || principal.role === "hr_finance";
}

function assertSee(principal: Principal) {
  if (!canSeeCases(principal)) throw new ForbiddenException("Only managers and HR can see problems.");
}

function assertManage(principal: Principal) {
  if (!can(principal, "tracking.manage")) throw new ForbiddenException("Only an owner or warehouse manager can change problems.");
}

function refs(input: Refs) {
  return {
    trackingNumber: input.trackingNumber?.trim().toUpperCase() || null,
    orderNumber: input.orderNumber?.trim() || null,
    sku: input.sku?.trim() || null,
    shipmentId: input.shipmentId ?? null,
    loadId: input.loadId ?? null,
    gaylordId: input.gaylordId ?? null,
  };
}

@Injectable()
export class CasesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(principal: Principal, filter: { status?: string; kind?: string }) {
    assertSee(principal);
    const orm = this.db.db;
    const where = [
      filter.status === "active" ? inArray(cases.status, ["open", "investigating"]) : filter.status ? eq(cases.status, filter.status) : undefined,
      filter.kind ? eq(cases.kind, filter.kind) : undefined,
    ].filter(Boolean);
    const rows = await orm
      .select()
      .from(cases)
      .where(where.length ? and(...(where as NonNullable<(typeof where)[number]>[])) : undefined)
      .orderBy(desc(cases.createdAt))
      .limit(300);
    const ids = rows.map((row) => row.id);
    const counts = ids.length
      ? await orm
          .select({ caseId: caseNotes.caseId, notes: sql<number>`count(*)::int`, photos: sql<number>`count(${caseNotes.photo})::int` })
          .from(caseNotes)
          .where(inArray(caseNotes.caseId, ids))
          .groupBy(caseNotes.caseId)
      : [];
    const names = await this.names(rows);
    const tally = await orm
      .select({ status: cases.status, count: sql<number>`count(*)::int` })
      .from(cases)
      .groupBy(cases.status);
    return {
      counts: Object.fromEntries(tally.map((row) => [row.status, row.count])),
      cases: rows.map((row) => ({
        ...this.view(row, names),
        notes: counts.find((item) => item.caseId === row.id)?.notes ?? 0,
        photos: counts.find((item) => item.caseId === row.id)?.photos ?? 0,
      })),
    };
  }

  async get(principal: Principal, id: string) {
    assertSee(principal);
    const row = await this.caseById(this.db.db, id);
    const notes = await this.db.db.select().from(caseNotes).where(eq(caseNotes.caseId, row.id)).orderBy(caseNotes.createdAt);
    const names = await this.names([row]);
    return {
      ...this.view(row, names),
      notes: notes.map((note) => ({
        id: note.id,
        authorName: note.authorName,
        text: note.text,
        photo: note.photo,
        system: note.system,
        createdAt: note.createdAt,
      })),
    };
  }

  /** People a case can be given to. */
  async owners(principal: Principal) {
    assertSee(principal);
    const rows = await this.db.db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(inArray(users.role, ["owner", "warehouse_manager", "hr_finance"]));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(
    principal: Principal,
    input: Refs & {
      kind: CaseKind;
      title: string;
      details?: string;
      clientId?: string;
      jobId?: string;
      employeeId?: string;
      ownerUserId?: string;
      photo?: string;
    },
  ) {
    assertManage(principal);
    if (input.kind === "employee_error" && !input.employeeId) throw new ConflictException("Choose who the suspected error is about.");
    return this.db.db.transaction(async (raw) => {
      const tx = raw as unknown as Conn;
      const clientId = await this.clientFor(tx, input.jobId, input.clientId);
      if (input.employeeId) await this.employee(tx, input.employeeId);
      const created = await openCase(
        tx,
        {
          kind: input.kind,
          title: input.title.trim(),
          details: input.details?.trim() || null,
          clientId,
          jobId: input.jobId ?? null,
          employeeId: input.employeeId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          reportedByUserId: principal.id,
          ...refs(input),
        },
        { authorName: principal.name, authorUserId: principal.id, text: input.details?.trim() || null, photo: input.photo ?? null },
      );
      return { id: created.id, message: "Problem recorded." };
    });
  }

  /** Someone on the floor reports a problem from the floor phone, with an optional photo. */
  async reportFromFloor(badge: string, input: Refs & { kind: CaseKind; details: string; jobId?: string; photo?: string }) {
    return this.db.db.transaction(async (raw) => {
      const tx = raw as unknown as Conn;
      const [employee] = await tx.select().from(employees).where(eq(employees.badgeCode, badge.trim().toUpperCase())).limit(1);
      if (!employee || !employee.active) throw new NotFoundException("That badge is not on the floor.");
      const clientId = await this.clientFor(tx, input.jobId, employee.clientId ?? undefined);
      const details = input.details.trim();
      const short = details.length > 60 ? `${details.slice(0, 57)}…` : details;
      const created = await openCase(
        tx,
        {
          kind: input.kind,
          title: `${CASE_KIND_LABELS[input.kind] ?? "Problem"}: ${short}`,
          details,
          clientId,
          jobId: input.jobId ?? null,
          reportedByEmployeeId: employee.id,
          ...refs(input),
        },
        { authorName: employee.name, authorEmployeeId: employee.id, text: details, photo: input.photo ?? null },
      );
      return { id: created.id, message: "Thanks. A manager will look at it." };
    });
  }

  async update(
    principal: Principal,
    id: string,
    patch: {
      status?: CaseStatus;
      ownerUserId?: string | null;
      rootCause?: string | null;
      correctiveAction?: string | null;
      correctiveDueOn?: string | null;
      correctiveDone?: boolean;
      errorConfirmed?: boolean;
    },
  ) {
    assertManage(principal);
    return this.db.db.transaction(async (raw) => {
      const tx = raw as unknown as Conn;
      const row = await this.caseById(tx, id);
      const now = new Date();
      const set: Partial<typeof cases.$inferInsert> = { updatedAt: now };
      const changes: string[] = [];

      if (patch.status && patch.status !== row.status) {
        set.status = patch.status;
        set.resolvedAt = patch.status === "resolved" || patch.status === "closed" ? now : null;
        changes.push(`status to ${STATUS_LABELS[patch.status]}`);
      }
      if (patch.ownerUserId !== undefined && patch.ownerUserId !== row.ownerUserId) {
        let ownerName = "nobody";
        if (patch.ownerUserId) {
          const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, patch.ownerUserId)).limit(1);
          if (!owner) throw new NotFoundException("That person is not a user.");
          ownerName = owner.name;
        }
        set.ownerUserId = patch.ownerUserId;
        changes.push(`owner to ${ownerName}`);
      }
      const text = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null);
      const rootCause = text(patch.rootCause);
      if (rootCause !== undefined && rootCause !== row.rootCause) {
        set.rootCause = rootCause;
        changes.push(rootCause ? `root cause to "${rootCause}"` : "cleared the root cause");
      }
      const correctiveAction = text(patch.correctiveAction);
      if (correctiveAction !== undefined && correctiveAction !== row.correctiveAction) {
        set.correctiveAction = correctiveAction;
        changes.push(correctiveAction ? `corrective action to "${correctiveAction}"` : "cleared the corrective action");
      }
      if (patch.correctiveDueOn !== undefined && patch.correctiveDueOn !== row.correctiveDueOn) {
        set.correctiveDueOn = patch.correctiveDueOn;
        changes.push(patch.correctiveDueOn ? `corrective action due ${patch.correctiveDueOn}` : "cleared the due date");
      }
      if (patch.correctiveDone !== undefined && patch.correctiveDone !== Boolean(row.correctiveDoneAt)) {
        if (patch.correctiveDone && !(set.correctiveAction ?? row.correctiveAction)) {
          throw new ConflictException("Write the corrective action before marking it done.");
        }
        set.correctiveDoneAt = patch.correctiveDone ? now : null;
        changes.push(patch.correctiveDone ? "marked the corrective action done" : "reopened the corrective action");
      }
      if (patch.errorConfirmed !== undefined && patch.errorConfirmed !== row.errorConfirmed) {
        // A system exception never proves someone made a mistake. Only an employee-error case can be confirmed.
        if (row.kind !== "employee_error") throw new ConflictException("Only an employee-error case can be confirmed as an error.");
        set.errorConfirmed = patch.errorConfirmed;
        changes.push(patch.errorConfirmed ? "confirmed the employee error" : "set the error back to suspected");
      }
      if (changes.length === 0) return { message: "Nothing changed." };

      await tx.update(cases).set(set).where(eq(cases.id, row.id));
      const summary = `${principal.name} changed ${changes.join("; ")}.`;
      await tx.insert(caseNotes).values({ caseId: row.id, authorName: principal.name, authorUserId: principal.id, text: summary, system: true });
      await tx.insert(activity).values({
        actorId: principal.id,
        action: "work.case_updated",
        module: "work",
        entityType: "case",
        entityId: row.id,
        after: { summary: `${summary} (${row.title})` },
      });
      return { message: "Saved." };
    });
  }

  async addNote(principal: Principal, id: string, input: { text?: string; photo?: string }) {
    assertSee(principal);
    const row = await this.caseById(this.db.db, id);
    await this.db.db.insert(caseNotes).values({
      caseId: row.id,
      authorName: principal.name,
      authorUserId: principal.id,
      text: input.text?.trim() || null,
      photo: input.photo ?? null,
    });
    await this.db.db.update(cases).set({ updatedAt: new Date() }).where(eq(cases.id, row.id));
    return { message: "Note added." };
  }

  // ---------------------------------------------------------------- helpers

  private view(row: CaseRow, names: Awaited<ReturnType<CasesService["names"]>>) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      details: row.details,
      clientId: row.clientId,
      clientName: row.clientId ? names.client.get(row.clientId) ?? null : null,
      jobId: row.jobId,
      jobReference: row.jobId ? names.job.get(row.jobId) ?? null : null,
      employeeId: row.employeeId,
      employeeName: row.employeeId ? names.employee.get(row.employeeId) ?? null : null,
      errorConfirmed: row.errorConfirmed,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId ? names.user.get(row.ownerUserId) ?? null : null,
      reportedBy: row.reportedByUserId
        ? names.user.get(row.reportedByUserId) ?? "A user"
        : row.reportedByEmployeeId
          ? names.employee.get(row.reportedByEmployeeId) ?? "Someone on the floor"
          : "Ops Engine",
      trackingNumber: row.trackingNumber,
      orderNumber: row.orderNumber,
      sku: row.sku,
      rootCause: row.rootCause,
      correctiveAction: row.correctiveAction,
      correctiveDueOn: row.correctiveDueOn,
      correctiveDoneAt: row.correctiveDoneAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt,
    };
  }

  private async names(rows: CaseRow[]) {
    const orm = this.db.db;
    const ids = (pick: (row: CaseRow) => (string | null)[]) => [...new Set(rows.flatMap(pick).filter((id): id is string => Boolean(id)))];
    const clientIds = ids((row) => [row.clientId]);
    const jobIds = ids((row) => [row.jobId]);
    const employeeIds = ids((row) => [row.employeeId, row.reportedByEmployeeId]);
    const userIds = ids((row) => [row.ownerUserId, row.reportedByUserId]);
    const [clientRows, jobRows, employeeRows, userRows] = await Promise.all([
      clientIds.length ? orm.select({ id: clientRecords.id, name: clientRecords.name }).from(clientRecords).where(inArray(clientRecords.id, clientIds)) : [],
      jobIds.length ? orm.select({ id: jobs.id, name: jobs.reference }).from(jobs).where(inArray(jobs.id, jobIds)) : [],
      employeeIds.length ? orm.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, employeeIds)) : [],
      userIds.length ? orm.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    ]);
    const map = (list: { id: string; name: string }[]) => new Map(list.map((item) => [item.id, item.name]));
    return { client: map(clientRows), job: map(jobRows), employee: map(employeeRows), user: map(userRows) };
  }

  private async caseById(conn: Conn, id: string) {
    const [row] = await conn.select().from(cases).where(eq(cases.id, id)).limit(1);
    if (!row) throw new NotFoundException("That problem is not on file.");
    return row;
  }

  private async employee(conn: Conn, id: string) {
    const [row] = await conn.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!row) throw new NotFoundException("That person is not on file.");
    return row;
  }

  /** The client a case belongs to: the job's client wins over one given directly. */
  private async clientFor(conn: Conn, jobId?: string, clientId?: string) {
    if (jobId) {
      const [job] = await conn.select({ clientId: jobs.clientId }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!job) throw new NotFoundException("That job is not on file.");
      return job.clientId;
    }
    if (clientId) {
      const [client] = await conn.select({ id: clientRecords.id }).from(clientRecords).where(eq(clientRecords.id, clientId)).limit(1);
      if (!client) throw new NotFoundException("That client is not on file.");
      return client.id;
    }
    return null;
  }
}
