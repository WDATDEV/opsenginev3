import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  activityTypes,
  charges,
  clientRecords,
  employees,
  gaylords,
  jobAssignees,
  jobs,
  loads,
  segments,
  shipments,
  tasks,
} from "@opsengine/db";
import type { z } from "zod";
import type { ClientService, createJobWorkSchema } from "@opsengine/contracts";
import { assertClientVisible, canSeeClient, type Principal } from "@opsengine/kernel";
import { assertClientService, enabledServiceList } from "../clients/access.js";
import { DbService } from "../db.service.js";

function isUnique(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("code" in err && err.code === "23505") return true;
  return "cause" in err && isUnique(err.cause);
}

const WORK_ACTIVITY = {
  receiving: "receive_shipment",
  unloading: "unload_trailer",
  packing: "pack_orders",
  picking: "pick_batch",
  sorting: "sort_gaylord",
} as const;

@Injectable()
export class JobsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(principal: Principal) {
    const orm = this.db.db;
    const [jobRows, clientRows, segmentRows, people, shipmentRows, loadRows, chargeRows, activities, assigneeRows, taskRows] =
      await Promise.all([
        orm.select().from(jobs).orderBy(desc(jobs.createdAt)),
        orm.select().from(clientRecords),
        orm.select().from(segments),
        orm.select().from(employees),
        orm.select().from(shipments),
        orm.select().from(loads),
        orm.select().from(charges).orderBy(desc(charges.createdAt)),
        orm.select().from(activityTypes),
        orm.select().from(jobAssignees),
        orm.select().from(tasks).orderBy(desc(tasks.createdAt)),
      ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    const clientById = new Map(clientRows.map((client) => [client.id, client]));
    const taskById = new Map(taskRows.map((task) => [task.id, task]));
    const showPeople = principal.role !== "external_customer";
    const showDrafts = principal.role !== "external_customer";
    const now = Date.now();

    return {
      jobs: jobRows
        .filter((job) => canSeeClient(principal, job.clientId))
        .map((job) => {
          const client = clientById.get(job.clientId);
          const jobSegments = segmentRows.filter((segment) => segment.jobId === job.id);
          const laborMinutes = jobSegments.reduce((sum, segment) => {
            const end = segment.endedAt ? segment.endedAt.getTime() : now;
            return sum + Math.max(0, Math.round((end - segment.startedAt.getTime()) / 60_000));
          }, 0);
          const openIds = [...new Set(jobSegments.filter((segment) => !segment.endedAt).map((segment) => segment.employeeId))];
          return {
            id: job.id,
            reference: job.reference,
            title: job.title,
            status: job.status,
            billBasis: job.billBasis,
            clientId: job.clientId,
            clientName: client?.name ?? "Client",
            clientCode: client?.code ?? "",
            enabledServices: enabledServiceList(client?.enabledServices),
            laborMinutes,
            assignees: assigneeRows
              .filter((row) => row.jobId === job.id)
              .map((row) => ({
                employeeId: row.employeeId,
                name: names.get(row.employeeId) ?? "Someone",
                startAt: row.startAt,
                activityCode: row.activityCode,
                activityName: row.activityCode
                  ? activities.find((item) => item.code === row.activityCode)?.name ?? row.activityCode
                  : null,
                started: Boolean(row.autoStartedAt),
              })),
            tasks: taskRows
              .filter((task) => task.jobId === job.id)
              .map((task) => ({
                id: task.id,
                title: task.title,
                details: task.details,
                status: task.status,
                dueOn: task.dueOn,
                assigneeId: task.assigneeId,
                assigneeName: task.assigneeId ? names.get(task.assigneeId) ?? null : null,
                startAt: task.startAt,
                activityCode: task.activityCode,
                activityName: task.activityCode
                  ? activities.find((item) => item.code === task.activityCode)?.name ?? task.activityCode
                  : null,
                started: Boolean(
                  task.startAt &&
                    assigneeRows.find((row) => row.jobId === job.id && row.employeeId === task.assigneeId)?.autoStartedAt,
                ),
                dependsOnId: task.dependsOnId,
                dependsOnTitle: task.dependsOnId ? taskById.get(task.dependsOnId)?.title ?? null : null,
                blocked: Boolean(task.dependsOnId && taskById.get(task.dependsOnId)?.status !== "done" && task.status !== "done"),
              })),
            openWorkerCount: openIds.length,
            openWorkers: showPeople ? openIds.map((id) => names.get(id) ?? "Someone") : [],
            shipments: shipmentRows
              .filter((shipment) => shipment.jobId === job.id)
              .map((shipment) => ({ id: shipment.id, reference: shipment.reference, status: shipment.status })),
            loads: loadRows
              .filter((load) => load.jobId === job.id)
              .map((load) => ({
                id: load.id,
                reference: load.reference,
                status: load.status,
                palletCount: load.palletCount,
                cartonCount: load.cartonCount,
              })),
            charges: chargeRows
              .filter((charge) => charge.jobId === job.id && (showDrafts || charge.status === "approved"))
              .map((charge) => ({
                id: charge.id,
                description: charge.description,
                quantity: charge.quantity,
                unit: charge.unit,
                amountCents: charge.amountCents,
                status: charge.status,
              })),
          };
        }),
      clients: clientRows
        .filter((client) => canSeeClient(principal, client.id))
        .map((client) => ({ id: client.id, name: client.name, code: client.code })),
      activities: activities
        .filter((activity) => activity.active)
        .map((activity) => ({
          code: activity.code,
          name: activity.name,
          department: activity.department,
          billable: activity.billable,
        })),
      people:
        principal.role === "external_customer"
          ? []
          : people.filter((person) => person.active).map((person) => ({ id: person.id, name: person.name })),
    };
  }

  async create(principal: Principal, input: { clientId: string; reference: string; title: string; billBasis?: string }) {
    assertClientVisible(principal, input.clientId);
    const [client] = await this.db.db.select().from(clientRecords).where(eq(clientRecords.id, input.clientId)).limit(1);
    if (!client) throw new NotFoundException("That client is not on file.");
    await assertClientService(this.db.db, client.id, "jobs");
    try {
      const [created] = await this.db.db
        .insert(jobs)
        .values({
          clientId: client.id,
          reference: input.reference.trim(),
          title: input.title.trim(),
          status: "open",
          billBasis: input.billBasis ?? "mixed",
        })
        .returning();
      if (!created) throw new ConflictException("Could not open that job.");
      return {
        id: created.id,
        message: `${created.reference} is open for ${client.name}.`,
      };
    } catch (err) {
      if (isUnique(err)) throw new ConflictException("That job reference is already used.");
      throw err;
    }
  }

  async close(principal: Principal, id: string) {
    const job = await this.requireJob(principal, id);
    const open = await this.db.db
      .select({ id: segments.id })
      .from(segments)
      .where(and(eq(segments.jobId, job.id), isNull(segments.endedAt)));
    if (open.length > 0) {
      throw new ConflictException("Pause everyone on this job before closing it.");
    }
    await this.db.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
    return { message: `${job.reference} is closed.` };
  }

  async assign(
    principal: Principal,
    jobId: string,
    employeeId: string,
    schedule?: { startAt?: string | null; activityCode?: string },
  ) {
    const job = await this.requireJob(principal, jobId);
    const person = await this.activeEmployee(employeeId);
    let start: { startAt: Date | null; activityCode: string | null; autoStartedAt: null } | null = null;
    if (schedule && schedule.startAt !== undefined) {
      if (schedule.startAt === null) {
        start = { startAt: null, activityCode: null, autoStartedAt: null };
      } else {
        if (!schedule.activityCode) throw new ConflictException("Choose the task type that starts at that time.");
        const rows = await this.db.db.select().from(activityTypes).where(eq(activityTypes.code, schedule.activityCode));
        const activity = rows.find((row) => row.clientId == null || row.clientId === job.clientId);
        if (!activity || !activity.active || !activity.billable || activity.department === "indirect") {
          throw new ConflictException("That task type cannot be started on a job.");
        }
        await assertClientService(this.db.db, job.clientId, activity.department as ClientService);
        start = { startAt: new Date(schedule.startAt), activityCode: activity.code, autoStartedAt: null };
      }
    }
    const existing = await this.db.db
      .select()
      .from(jobAssignees)
      .where(and(eq(jobAssignees.jobId, job.id), eq(jobAssignees.employeeId, person.id)))
      .limit(1);
    if (!existing[0]) {
      await this.db.db.insert(jobAssignees).values({ jobId: job.id, employeeId: person.id, ...(start ?? {}) });
    } else if (start) {
      await this.db.db.update(jobAssignees).set(start).where(eq(jobAssignees.id, existing[0].id));
    }
    if (start?.startAt) {
      return { message: `${person.name} is assigned to ${job.reference} and starts automatically at the set time.` };
    }
    if (start) return { message: `${person.name} will start ${job.reference} by hand on the floor phone.` };
    return { message: `${person.name} is assigned to ${job.reference}.` };
  }

  async unassign(principal: Principal, jobId: string, employeeId: string) {
    const job = await this.requireJob(principal, jobId);
    await this.db.db
      .delete(jobAssignees)
      .where(and(eq(jobAssignees.jobId, job.id), eq(jobAssignees.employeeId, employeeId)));
    return { message: `Removed from ${job.reference}.` };
  }

  async addTask(
    principal: Principal,
    jobId: string,
    input: {
      title: string;
      details?: string;
      assigneeId?: string;
      dueOn?: string;
      dependsOnId?: string;
      startAt?: string;
      activityCode?: string;
      related?: { type: string; id: string };
    },
  ) {
    const job = await this.requireJob(principal, jobId);
    const assignee = input.assigneeId ? await this.activeEmployee(input.assigneeId) : null;
    if (input.startAt && !assignee) throw new ConflictException("Choose who does this task before setting a start time.");
    if (assignee) {
      await this.requireCrew(job, assignee);
      if (input.startAt) {
        await this.assign(principal, job.id, assignee.id, {
          startAt: input.startAt,
          ...(input.activityCode ? { activityCode: input.activityCode } : {}),
        });
      }
    }
    if (input.dependsOnId) {
      const [earlier] = await this.db.db.select().from(tasks).where(eq(tasks.id, input.dependsOnId)).limit(1);
      if (!earlier || earlier.jobId !== job.id) {
        throw new ConflictException("A task can depend only on another task on this job.");
      }
    }
    const [created] = await this.db.db
      .insert(tasks)
      .values({
        title: input.title.trim(),
        details: input.details?.trim() || null,
        status: "open",
        clientId: job.clientId,
        requestorId: principal.id,
        jobId: job.id,
        assigneeId: assignee?.id ?? null,
        dueOn: input.dueOn ?? null,
        dependsOnId: input.dependsOnId ?? null,
        startAt: input.startAt ? new Date(input.startAt) : null,
        activityCode: input.activityCode ?? null,
        relatedType: input.related?.type ?? null,
        relatedId: input.related?.id ?? null,
      })
      .returning();
    if (!created) throw new ConflictException("Could not add that task.");
    if (input.startAt) {
      return { message: `${created.title} is on ${job.reference} and starts automatically at the set time.` };
    }
    return { message: `${created.title} is on ${job.reference}.` };
  }

  private async joinJob(
    job: { id: string; reference: string },
    currentJobId: string | null,
    reference: string,
    attach: () => Promise<void>,
  ) {
    if (currentJobId === job.id) return;
    if (currentJobId) {
      const [other] = await this.db.db.select().from(jobs).where(eq(jobs.id, currentJobId)).limit(1);
      throw new ConflictException(`${reference} is already on job ${other?.reference ?? "another job"}.`);
    }
    await attach();
  }

  private async requireCrew(job: { id: string; reference: string }, person: { id: string; name: string }) {
    const [onCrew] = await this.db.db
      .select()
      .from(jobAssignees)
      .where(and(eq(jobAssignees.jobId, job.id), eq(jobAssignees.employeeId, person.id)))
      .limit(1);
    if (!onCrew) throw new ConflictException(`Add ${person.name} to the crew of ${job.reference} first.`);
  }

  async setTaskStart(
    principal: Principal,
    jobId: string,
    taskId: string,
    input: { startAt: string | null; activityCode?: string },
  ) {
    const job = await this.requireJob(principal, jobId);
    const [task] = await this.db.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task || task.jobId !== job.id) throw new NotFoundException("That task is not on this job.");
    if (task.status === "done") throw new ConflictException("That task is already done.");
    if (!task.assigneeId) throw new ConflictException("Choose who does this task before setting a start time.");
    const activityCode = input.activityCode ?? task.activityCode ?? undefined;
    await this.assign(
      principal,
      job.id,
      task.assigneeId,
      input.startAt === null ? { startAt: null } : { startAt: input.startAt, ...(activityCode ? { activityCode } : {}) },
    );
    await this.db.db
      .update(tasks)
      .set({
        startAt: input.startAt ? new Date(input.startAt) : null,
        activityCode: activityCode ?? null,
      })
      .where(eq(tasks.id, task.id));
    return {
      message: input.startAt
        ? `${task.title} starts automatically at the set time.`
        : `${task.title} will be started by hand on the floor phone.`,
    };
  }

  async addWork(principal: Principal, jobId: string, input: z.infer<typeof createJobWorkSchema>) {
    const job = await this.requireJob(principal, jobId);
    if (job.status === "done") throw new ConflictException("That job is already closed.");
    await assertClientService(this.db.db, job.clientId, input.kind);
    const orm = this.db.db;
    if (input.assigneeId) await this.requireCrew(job, await this.activeEmployee(input.assigneeId));
    let title: string;
    let details: string | undefined;
    let related: { type: string; id: string } | undefined;
    const sameClient = (owner: string | null) => {
      if (owner && owner !== job.clientId) {
        throw new ConflictException("That number belongs to another client.");
      }
    };
    try {
      if (input.kind === "receiving") {
        const reference = input.reference.toUpperCase();
        const [found] = await orm.select().from(shipments).where(eq(shipments.reference, reference)).limit(1);
        if (found) {
          sameClient(found.clientId);
          await this.joinJob(job, found.jobId, reference, async () => {
            await orm.update(shipments).set({ jobId: job.id }).where(eq(shipments.id, found.id));
          });
          related = { type: "shipment", id: found.id };
        } else {
          const [created] = await orm
            .insert(shipments)
            .values({
              reference,
              clientId: job.clientId,
              jobId: job.id,
              carrier: input.carrier,
              status: "expected",
              expectedCartons: input.expectedCartons,
              receivedCartons: 0,
            })
            .returning();
          if (!created) throw new ConflictException("Could not add that shipment.");
          related = { type: "shipment", id: created.id };
        }
        title = `Receive shipment ${reference}`;
        details = `${input.expectedCartons} cartons expected from ${input.carrier.toUpperCase()}.`;
      } else if (input.kind === "unloading") {
        const reference = input.reference.toUpperCase();
        const [found] = await orm.select().from(loads).where(eq(loads.reference, reference)).limit(1);
        if (found) {
          sameClient(found.clientId);
          await this.joinJob(job, found.jobId, reference, async () => {
            await orm.update(loads).set({ jobId: job.id }).where(eq(loads.id, found.id));
          });
          related = { type: "load", id: found.id };
          details = `${found.palletCount ?? 0} pallets, ${found.cartonCount ?? 0} cartons.`;
        } else {
          const [created] = await orm
            .insert(loads)
            .values({
              reference,
              clientId: job.clientId,
              jobId: job.id,
              kind: input.loadKind,
              dock: input.dock,
              status: "arrived",
              arrivalAt: new Date(),
              palletCount: input.pallets,
              cartonCount: input.cartons,
            })
            .returning();
          if (!created) throw new ConflictException("Could not add that load.");
          related = { type: "load", id: created.id };
          details = `${input.pallets} pallets, ${input.cartons} cartons.`;
        }
        title = `Unload ${reference}`;
      } else if (input.kind === "sorting") {
        const code = input.reference.toUpperCase();
        const [found] = await orm.select().from(gaylords).where(eq(gaylords.code, code)).limit(1);
        if (found) {
          sameClient(found.clientId);
          related = { type: "gaylord", id: found.id };
        } else {
          const [created] = await orm
            .insert(gaylords)
            .values({ code, carrier: input.carrier, clientId: job.clientId, status: "open" })
            .returning();
          if (!created) throw new ConflictException("Could not add that gaylord.");
          related = { type: "gaylord", id: created.id };
        }
        title = `Sort into gaylord ${code}`;
        details = `Carrier ${input.carrier.toUpperCase()}.`;
      } else if (input.kind === "packing") {
        title = `Pack ${input.orders} ${input.orders === 1 ? "order" : "orders"}`;
        details = input.note || undefined;
      } else {
        title = `Pick ${input.units} ${input.units === 1 ? "unit" : "units"} for batch ${input.reference.toUpperCase()}`;
      }
    } catch (err) {
      if (isUnique(err)) throw new ConflictException("That number is already used. Enter a different one.");
      throw err;
    }
    await this.addTask(principal, job.id, {
      title,
      details,
      assigneeId: input.assigneeId,
      dueOn: input.dueOn,
      dependsOnId: input.dependsOnId,
      startAt: input.startAt,
      activityCode: WORK_ACTIVITY[input.kind],
      ...(related ? { related } : {}),
    });
    return { message: `${title} is on ${job.reference}.` };
  }

  private async endAssigneeTimer(
    jobId: string,
    task: { assigneeId: string | null; activityCode: string | null; startAt: Date | null },
  ) {
    if (!task.assigneeId) return false;
    const orm = this.db.db;
    const matches = (row: { jobId: string | null; taskCode: string }) =>
      row.jobId === jobId && (!task.activityCode || row.taskCode === task.activityCode);
    let ended = false;
    const [open] = await orm
      .select()
      .from(segments)
      .where(and(eq(segments.employeeId, task.assigneeId), isNull(segments.endedAt)))
      .limit(1);
    if (open && matches(open)) {
      await orm.update(segments).set({ endedAt: new Date(), endReason: "complete" }).where(eq(segments.id, open.id));
      ended = true;
    } else if (!open) {
      const [last] = await orm
        .select()
        .from(segments)
        .where(eq(segments.employeeId, task.assigneeId))
        .orderBy(desc(segments.startedAt))
        .limit(1);
      if (last && (last.endReason === "pause" || last.endReason === "meal") && matches(last)) {
        await orm.update(segments).set({ endReason: "complete" }).where(eq(segments.id, last.id));
        ended = true;
      }
    }
    if (task.startAt) {
      await orm
        .update(jobAssignees)
        .set({ startAt: null, activityCode: null })
        .where(
          and(
            eq(jobAssignees.jobId, jobId),
            eq(jobAssignees.employeeId, task.assigneeId),
            isNull(jobAssignees.autoStartedAt),
          ),
        );
    }
    return ended;
  }

  async completeTask(principal: Principal, jobId: string, taskId: string) {
    const job = await this.requireJob(principal, jobId);
    const [task] = await this.db.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task || task.jobId !== job.id) throw new NotFoundException("That task is not on this job.");
    if (task.dependsOnId) {
      const [earlier] = await this.db.db.select().from(tasks).where(eq(tasks.id, task.dependsOnId)).limit(1);
      if (earlier && earlier.status !== "done") {
        throw new ConflictException(`Finish ${earlier.title} before closing this task.`);
      }
    }
    await this.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    const ended = task.assigneeId ? await this.endAssigneeTimer(job.id, task) : false;
    return {
      message: ended
        ? `${task.title} is done. The timer on the floor phone is ended.`
        : `${task.title} is done.`,
    };
  }

  private async activeEmployee(employeeId: string) {
    const [person] = await this.db.db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    if (!person || !person.active) throw new NotFoundException("That employee is not on the floor.");
    return person;
  }

  async requireJob(principal: Principal, id: string) {
    const [job] = await this.db.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!job) throw new NotFoundException("That job is not on file.");
    assertClientVisible(principal, job.clientId);
    return job;
  }
}
