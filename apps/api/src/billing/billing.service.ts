import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  activityTypes,
  charges,
  clientRecords,
  employees,
  invoices,
  jobs,
  loads,
  packEvents,
  rateCards,
  receiptLines,
  segments,
  shipments,
  tasks,
} from "@opsengine/db";
import type { HourlyService } from "@opsengine/contracts";
import { assertClientVisible, type Principal } from "@opsengine/kernel";
import { assertClientService } from "../clients/access.js";
import { DbService } from "../db.service.js";

type Rate = typeof rateCards.$inferSelect;

@Injectable()
export class BillingService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async saveRate(
    principal: Principal,
    clientId: string,
    input: { activityCode?: string; unit: string; rateCents: number; label: string },
  ) {
    assertClientVisible(principal, clientId);
    const [client] = await this.db.db.select().from(clientRecords).where(eq(clientRecords.id, clientId)).limit(1);
    if (!client) throw new NotFoundException("That client is not on file.");
    if (input.activityCode) {
      const [activity] = await this.db.db
        .select()
        .from(activityTypes)
        .where(eq(activityTypes.code, input.activityCode))
        .limit(1);
      if (!activity) throw new NotFoundException("That activity is not on file.");
    }
    const existingRates = await this.db.db.select().from(rateCards).where(eq(rateCards.clientId, clientId));
    const activityCode = input.activityCode ?? null;
    const existing = existingRates.find(
      (rate) => !rate.department && rate.unit === input.unit && (rate.activityCode ?? null) === activityCode,
    );
    if (existing) {
      await this.db.db
        .update(rateCards)
        .set({ rateCents: input.rateCents, label: input.label.trim() })
        .where(eq(rateCards.id, existing.id));
      return { message: `${input.label.trim()} updated for ${client.name}.` };
    }
    await this.db.db.insert(rateCards).values({
      clientId,
      activityCode,
      unit: input.unit,
      rateCents: input.rateCents,
      label: input.label.trim(),
    });
    return { message: `${input.label.trim()} added for ${client.name}.` };
  }

  /**
   * The hourly price of each service for one client: receiving, unloading, packing, picking, sorting.
   * A price of null clears that service. Hours worked in a service are charged at its price.
   */
  async saveHourlyRates(
    principal: Principal,
    clientId: string,
    input: { department: HourlyService; rateCents: number | null }[],
  ) {
    assertClientVisible(principal, clientId);
    const [client] = await this.db.db.select().from(clientRecords).where(eq(clientRecords.id, clientId)).limit(1);
    if (!client) throw new NotFoundException("That client is not on file.");

    const current = await this.db.db.select().from(rateCards).where(eq(rateCards.clientId, clientId));
    for (const entry of input) {
      const existing = current.find((rate) => rate.department === entry.department && rate.unit === "hour");
      if (entry.rateCents === null) {
        if (existing) await this.db.db.delete(rateCards).where(eq(rateCards.id, existing.id));
        continue;
      }
      const label = `${entry.department.charAt(0).toUpperCase()}${entry.department.slice(1)} per hour`;
      if (existing) {
        await this.db.db.update(rateCards).set({ rateCents: entry.rateCents, label }).where(eq(rateCards.id, existing.id));
      } else {
        await this.db.db.insert(rateCards).values({
          clientId,
          activityCode: null,
          department: entry.department,
          unit: "hour",
          rateCents: entry.rateCents,
          label,
        });
      }
    }
    return { message: `Hourly prices saved for ${client.name}.` };
  }

  async generate(principal: Principal, jobId: string) {
    const [job] = await this.db.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException("That job is not on file.");
    assertClientVisible(principal, job.clientId);
    const orm = this.db.db;
    const [rates, jobSegments, activities, jobLoads, jobShipments, packs, jobTasks] = await Promise.all([
      orm.select().from(rateCards).where(eq(rateCards.clientId, job.clientId)),
      orm.select().from(segments).where(eq(segments.jobId, job.id)),
      orm.select().from(activityTypes),
      orm.select().from(loads).where(eq(loads.jobId, job.id)),
      orm.select().from(shipments).where(eq(shipments.jobId, job.id)),
      orm.select().from(packEvents),
      orm.select().from(tasks).where(eq(tasks.jobId, job.id)),
    ]);
    const basis = job.billBasis || "mixed";
    const names = new Map(activities.map((activity) => [activity.code, activity.name]));
    const taskById = new Map(jobTasks.map((task) => [task.id, task]));
    const departmentByCode = new Map(activities.map((activity) => [activity.code, activity.department]));
    const shipmentIds = new Set(jobShipments.map((shipment) => shipment.id));
    const lines = shipmentIds.size
      ? (await orm.select().from(receiptLines)).filter((line) => shipmentIds.has(line.shipmentId))
      : [];
    const segmentIds = new Set(jobSegments.map((segment) => segment.id));
    let created = 0;

    const draft = async (row: {
      description: string;
      quantity: number;
      unit: string;
      rate: Rate;
      sourceType: string;
      sourceId: string;
    }) => {
      if (row.quantity <= 0) return;
      const amountCents = row.unit === "hour" ? Math.round((row.quantity * row.rate.rateCents) / 60) : row.quantity * row.rate.rateCents;
      const [inserted] = await orm
        .insert(charges)
        .values({
          clientId: job.clientId,
          jobId: job.id,
          rateCardId: row.rate.id,
          description: row.description,
          quantity: row.quantity,
          unit: row.unit,
          rateCents: row.rate.rateCents,
          amountCents,
          status: "draft",
          idempotencyKey: `${row.sourceType}:${row.sourceId}:${row.unit}`,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
        })
        .onConflictDoNothing({ target: charges.idempotencyKey })
        .returning();
      if (inserted) created += 1;
    };

    for (const segment of jobSegments) {
      if (!billsUnit(basis, "hour") || !segment.endedAt) continue;
      const elapsedMs = segment.endedAt.getTime() - segment.startedAt.getTime();
      if (elapsedMs <= 0) continue;
      const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
      const linked = segment.note ? taskById.get(segment.note) : null;
      const activityCode = linked?.activityCode ?? segment.taskCode;
      const department = departmentByCode.get(activityCode) ?? segment.department;
      // A price set for this exact activity wins. Otherwise the hourly price of the whole service applies.
      const rate = latest(rates, activityCode, "hour") ?? serviceRate(rates, department);
      if (!rate) continue;
      const label = linked?.title ?? names.get(activityCode) ?? names.get(segment.taskCode) ?? segment.taskCode;
      await draft({
        description: `${label}, ${minutes} min`,
        quantity: minutes,
        unit: "hour",
        rate,
        sourceType: "segment",
        sourceId: segment.id,
      });
    }

    for (const load of jobLoads) {
      if (load.status !== "done") continue;
      const palletRate = latest(rates, "unload_trailer", "pallet");
      if (billsUnit(basis, "pallet") && palletRate && load.palletCount) {
        await draft({
          description: `${load.reference}, ${load.palletCount} pallets`,
          quantity: load.palletCount,
          unit: "pallet",
          rate: palletRate,
          sourceType: "load",
          sourceId: `${load.id}:pallet`,
        });
      }
      const cartonRate = latest(rates, "unload_trailer", "carton");
      if (billsUnit(basis, "carton") && cartonRate && load.cartonCount) {
        await draft({
          description: `${load.reference}, ${load.cartonCount} cartons`,
          quantity: load.cartonCount,
          unit: "carton",
          rate: cartonRate,
          sourceType: "load",
          sourceId: `${load.id}:carton`,
        });
      }
    }

    for (const line of lines) {
      const skuRate = latest(rates, "receive_shipment", "sku");
      const unitRate = latest(rates, "receive_shipment", "unit");
      const rate = basis === "sku" ? skuRate : basis === "mixed" ? unitRate ?? skuRate : null;
      if (!rate || !billsUnit(basis, rate.unit)) continue;
      const quantity = rate.unit === "sku" ? 1 : line.receivedQty;
      await draft({
        description: `${line.sku} on receiving`,
        quantity,
        unit: rate.unit,
        rate,
        sourceType: "receipt",
        sourceId: line.id,
      });
    }

    for (const pack of packs) {
      if (!pack.segmentId || !segmentIds.has(pack.segmentId)) continue;
      const rate = latest(rates, "pack_orders", "unit");
      if (!rate || !billsUnit(basis, "unit")) continue;
      await draft({
        description: `Packed ${pack.orderNumber}`,
        quantity: pack.units,
        unit: "unit",
        rate,
        sourceType: "pack",
        sourceId: pack.id,
      });
    }

    for (const rate of rates.filter((item) => item.unit === "flat" && billsUnit(basis, "flat"))) {
      await draft({
        description: rate.label,
        quantity: 1,
        unit: "flat",
        rate,
        sourceType: "job",
        sourceId: `${job.id}:${rate.id}`,
      });
    }

    const message =
      created > 0
        ? `${created} charge${created === 1 ? "" : "s"} drafted for ${job.reference}.`
        : `No new charges for ${job.reference}. Finished work needs a matching rate, and each charge is drafted once.`;
    return { message, created };
  }

  async approve(principal: Principal, chargeId: string) {
    const [charge] = await this.db.db.select().from(charges).where(eq(charges.id, chargeId)).limit(1);
    if (!charge) throw new NotFoundException("That charge is not on file.");
    assertClientVisible(principal, charge.clientId);
    if (charge.status === "approved") return { message: "That charge is already approved." };
    await this.db.db.update(charges).set({ status: "approved" }).where(eq(charges.id, charge.id));
    return { message: "Charge approved." };
  }

  async summary(principal: Principal, clientId: string) {
    const client = await assertClientService(this.db.db, clientId, "reports");
    assertClientVisible(principal, client.id);
    const orm = this.db.db;
    const [jobRows, segmentRows, people, activities, chargeRows] = await Promise.all([
      orm.select().from(jobs).where(eq(jobs.clientId, client.id)),
      orm.select().from(segments),
      orm.select().from(employees),
      orm.select().from(activityTypes),
      orm.select().from(charges).where(eq(charges.clientId, client.id)),
    ]);
    const jobIds = new Set(jobRows.map((job) => job.id));
    const nameById = new Map(people.map((person) => [person.id, person.name]));
    const taskName = new Map(activities.map((activity) => [activity.code, activity.name]));
    const showPeople = principal.role !== "external_customer";
    const now = Date.now();
    const lines = segmentRows
      .filter((segment) => segment.jobId && jobIds.has(segment.jobId))
      .map((segment) => {
        const end = segment.endedAt ? segment.endedAt.getTime() : now;
        const minutes = Math.max(0, Math.round((end - segment.startedAt.getTime()) / 60_000));
        const job = jobRows.find((item) => item.id === segment.jobId);
        return {
          employeeName: showPeople ? nameById.get(segment.employeeId) ?? "Someone" : "Staff",
          jobId: segment.jobId,
          jobReference: job?.reference ?? "",
          jobTitle: job?.title ?? "",
          taskName: taskName.get(segment.taskCode) ?? segment.taskCode,
          minutes,
          running: !segment.endedAt,
        };
      })
      .filter((line) => line.minutes > 0 || line.running);
    const projects = jobRows.map((job) => {
      const jobLines = lines.filter((line) => line.jobId === job.id);
      const jobCharges = chargeRows.filter((charge) => charge.jobId === job.id);
      return {
        id: job.id,
        reference: job.reference,
        title: job.title,
        status: job.status,
        billBasis: job.billBasis,
        minutes: jobLines.reduce((sum, line) => sum + line.minutes, 0),
        running: jobLines.some((line) => line.running),
        employees: showPeople ? [...new Set(jobLines.map((line) => line.employeeName))] : [],
        draftCents: jobCharges.filter((charge) => charge.status === "draft").reduce((sum, charge) => sum + charge.amountCents, 0),
        approvedCents: jobCharges.filter((charge) => charge.status === "approved").reduce((sum, charge) => sum + charge.amountCents, 0),
      };
    });
    return {
      clientName: client.name,
      minutes: lines.reduce((sum, line) => sum + line.minutes, 0),
      lines: showPeople ? lines : [],
      projects,
    };
  }

  async listInvoices(principal: Principal, clientId: string) {
    const client = await assertClientService(this.db.db, clientId, "invoices");
    assertClientVisible(principal, client.id);
    const orm = this.db.db;
    const [invoiceRows, chargeRows] = await Promise.all([
      orm.select().from(invoices).where(eq(invoices.clientId, client.id)),
      orm.select().from(charges).where(eq(charges.clientId, client.id)),
    ]);
    const visibleCharges =
      principal.role === "external_customer" ? chargeRows.filter((charge) => charge.status === "approved") : chargeRows;
    const mapped = invoiceRows
      .map((invoice) => {
        const lines = visibleCharges.filter((charge) => charge.invoiceId === invoice.id);
        return {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          issuedAt: invoice.issuedAt,
          paidAt: invoice.paidAt,
          amountCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
          lines: lines.map((line) => ({
            description: line.description,
            amountCents: line.amountCents,
          })),
        };
      })
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
    const ready = visibleCharges.filter((charge) => charge.status === "approved" && !charge.invoiceId);
    return {
      clientName: client.name,
      openCents: mapped.filter((invoice) => invoice.status === "open").reduce((sum, invoice) => sum + invoice.amountCents, 0),
      paidCents: mapped.filter((invoice) => invoice.status === "paid").reduce((sum, invoice) => sum + invoice.amountCents, 0),
      readyCents: ready.reduce((sum, charge) => sum + charge.amountCents, 0),
      invoices: mapped,
    };
  }

  async issueInvoice(principal: Principal, clientId: string, jobId?: string) {
    const client = await assertClientService(this.db.db, clientId, "invoices");
    assertClientVisible(principal, client.id);
    const orm = this.db.db;
    const ready = await orm
      .select()
      .from(charges)
      .where(and(eq(charges.clientId, client.id), eq(charges.status, "approved"), isNull(charges.invoiceId)));
    const chosen = jobId ? ready.filter((charge) => charge.jobId === jobId) : ready;
    if (chosen.length === 0) {
      throw new ConflictException("Approve the charges on a job before an invoice can be made.");
    }
    const existing = await orm.select({ id: invoices.id }).from(invoices).where(eq(invoices.clientId, client.id));
    const number = `INV-${client.code}-${String(existing.length + 1).padStart(3, "0")}`;
    const [created] = await orm.insert(invoices).values({ clientId: client.id, number, status: "open" }).returning();
    if (!created) throw new ConflictException("Could not make that invoice.");
    for (const charge of chosen) {
      await orm.update(charges).set({ invoiceId: created.id }).where(eq(charges.id, charge.id));
    }
    const amount = chosen.reduce((sum, charge) => sum + charge.amountCents, 0);
    const dollars = (amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    return { id: created.id, message: `${created.number} is open for ${client.name}. ${dollars}.` };
  }

  async markPaid(principal: Principal, invoiceId: string) {
    const [invoice] = await this.db.db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new NotFoundException("That invoice is not on file.");
    assertClientVisible(principal, invoice.clientId);
    await assertClientService(this.db.db, invoice.clientId, "invoices");
    if (invoice.status === "paid") return { message: `${invoice.number} is already paid.` };
    await this.db.db.update(invoices).set({ status: "paid", paidAt: new Date() }).where(eq(invoices.id, invoice.id));
    return { message: `${invoice.number} is paid.` };
  }
}

function billsUnit(basis: string, unit: string) {
  if (basis === "mixed") return true;
  if (basis === "time") return unit === "hour";
  return basis === unit;
}

function serviceRate(rates: Rate[], department: string) {
  return rates.find((rate) => rate.department === department && rate.unit === "hour");
}

function latest(rates: Rate[], activityCode: string, unit: string) {
  return rates
    .filter((rate) => rate.unit === unit && rate.activityCode === activityCode)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}
