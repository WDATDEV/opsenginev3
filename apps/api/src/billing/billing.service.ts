import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  activityTypes,
  charges,
  clientRecords,
  jobs,
  loads,
  packEvents,
  rateCards,
  receiptLines,
  segments,
  shipments,
} from "@opsengine/db";
import { assertClientVisible, type Principal } from "@opsengine/kernel";
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
      (rate) => rate.unit === input.unit && (rate.activityCode ?? null) === activityCode,
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

  async generate(principal: Principal, jobId: string) {
    const [job] = await this.db.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException("That job is not on file.");
    assertClientVisible(principal, job.clientId);
    const orm = this.db.db;
    const [rates, jobSegments, activities, jobLoads, jobShipments, packs] = await Promise.all([
      orm.select().from(rateCards).where(eq(rateCards.clientId, job.clientId)),
      orm.select().from(segments).where(eq(segments.jobId, job.id)),
      orm.select().from(activityTypes),
      orm.select().from(loads).where(eq(loads.jobId, job.id)),
      orm.select().from(shipments).where(eq(shipments.jobId, job.id)),
      orm.select().from(packEvents),
    ]);
    const names = new Map(activities.map((activity) => [activity.code, activity.name]));
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
      if (!segment.endedAt) continue;
      const minutes = Math.max(0, Math.round((segment.endedAt.getTime() - segment.startedAt.getTime()) / 60_000));
      const rate = latest(rates, segment.taskCode, "hour");
      if (!rate || minutes === 0) continue;
      const label = names.get(segment.taskCode) ?? segment.taskCode;
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
      if (palletRate && load.palletCount) {
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
      if (cartonRate && load.cartonCount) {
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
      const rate = latest(rates, "receive_shipment", "unit") ?? latest(rates, "receive_shipment", "sku");
      if (!rate) continue;
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
      if (!rate) continue;
      await draft({
        description: `Packed ${pack.orderNumber}`,
        quantity: pack.units,
        unit: "unit",
        rate,
        sourceType: "pack",
        sourceId: pack.id,
      });
    }

    for (const rate of rates.filter((item) => item.unit === "flat")) {
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
}

function latest(rates: Rate[], activityCode: string, unit: string) {
  return rates
    .filter((rate) => rate.unit === unit && rate.activityCode === activityCode)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}
