import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  activityTypes,
  charges,
  clientRecords,
  employees,
  jobAssignees,
  jobs,
  loads,
  segments,
  shipments,
  tasks,
} from "@opsengine/db";
import { assertClientVisible, canSeeClient, type Principal } from "@opsengine/kernel";
import { assertClientService } from "../clients/access.js";
import { DbService } from "../db.service.js";

function isUnique(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

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
            laborMinutes,
            assignees: assigneeRows
              .filter((row) => row.jobId === job.id)
              .map((row) => ({ employeeId: row.employeeId, name: names.get(row.employeeId) ?? "Someone" })),
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

  async assign(principal: Principal, jobId: string, employeeId: string) {
    const job = await this.requireJob(principal, jobId);
    const person = await this.activeEmployee(employeeId);
    const existing = await this.db.db
      .select()
      .from(jobAssignees)
      .where(and(eq(jobAssignees.jobId, job.id), eq(jobAssignees.employeeId, person.id)))
      .limit(1);
    if (!existing[0]) {
      await this.db.db.insert(jobAssignees).values({ jobId: job.id, employeeId: person.id });
    }
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
    input: { title: string; details?: string; assigneeId?: string; dueOn?: string; dependsOnId?: string },
  ) {
    const job = await this.requireJob(principal, jobId);
    const assignee = input.assigneeId ? await this.activeEmployee(input.assigneeId) : null;
    if (assignee) await this.assign(principal, job.id, assignee.id);
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
      })
      .returning();
    if (!created) throw new ConflictException("Could not add that task.");
    return { message: `${created.title} is on ${job.reference}.` };
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
    return { message: `${task.title} is done.` };
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
