import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  activityTypes,
  charges,
  clientRecords,
  employees,
  jobs,
  loads,
  segments,
  shipments,
} from "@opsengine/db";
import { assertClientVisible, canSeeClient, type Principal } from "@opsengine/kernel";
import { DbService } from "../db.service.js";

function isUnique(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

@Injectable()
export class JobsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(principal: Principal) {
    const orm = this.db.db;
    const [jobRows, clientRows, segmentRows, people, shipmentRows, loadRows, chargeRows, activities] =
      await Promise.all([
        orm.select().from(jobs).orderBy(desc(jobs.createdAt)),
        orm.select().from(clientRecords),
        orm.select().from(segments),
        orm.select().from(employees),
        orm.select().from(shipments),
        orm.select().from(loads),
        orm.select().from(charges).orderBy(desc(charges.createdAt)),
        orm.select().from(activityTypes),
      ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    const clientById = new Map(clientRows.map((client) => [client.id, client]));
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
            clientId: job.clientId,
            clientName: client?.name ?? "Client",
            clientCode: client?.code ?? "",
            laborMinutes,
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
    };
  }

  async create(principal: Principal, input: { clientId: string; reference: string; title: string }) {
    assertClientVisible(principal, input.clientId);
    const [client] = await this.db.db.select().from(clientRecords).where(eq(clientRecords.id, input.clientId)).limit(1);
    if (!client) throw new NotFoundException("That client is not on file.");
    try {
      const [created] = await this.db.db
        .insert(jobs)
        .values({
          clientId: client.id,
          reference: input.reference.trim(),
          title: input.title.trim(),
          status: "open",
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

  async requireJob(principal: Principal, id: string) {
    const [job] = await this.db.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!job) throw new NotFoundException("That job is not on file.");
    assertClientVisible(principal, job.clientId);
    return job;
  }
}
