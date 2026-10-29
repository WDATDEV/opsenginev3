import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { createClientSchema, createRateSchema, setClientServiceSchema, type ClientService } from "@opsengine/contracts";
import { clientRecords, rateCards } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { authorize, assertClientVisible, canSeeClient, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { BillingService } from "../billing/billing.service.js";
import { DbService } from "../db.service.js";
import { ZodPipe } from "../http.js";
import { enabledServiceList } from "./access.js";

function isUnique(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

@Controller("clients")
@UseGuards(AuthGuard)
export class ClientsController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  @Get()
  async list(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "client.read");
    const [rows, rates] = await Promise.all([
      this.db.db.select().from(clientRecords),
      this.db.db.select().from(rateCards),
    ]);
    return rows
      .filter((client) => canSeeClient(ctx.principal, client.id))
      .map((client) => ({
        ...client,
        enabledServices: enabledServiceList(client.enabledServices),
        rates: rates
          .filter((rate) => rate.clientId === client.id)
          .map((rate) => ({
            id: rate.id,
            activityCode: rate.activityCode,
            unit: rate.unit,
            rateCents: rate.rateCents,
            label: rate.label,
          })),
      }));
  }

  @Post()
  async create(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createClientSchema)) body: { name: string; code: string; services: ClientService[] },
  ) {
    authorize(ctx, "tracking.manage");
    const code = body.code.trim().toUpperCase();
    try {
      const [created] = await this.db.db
        .insert(clientRecords)
        .values({
          name: body.name.trim(),
          code,
          enabledServices: body.services,
        })
        .returning();
      if (!created) throw new ConflictException("Could not add that client.");
      return { id: created.id, message: `${created.name} is on Warehance.` };
    } catch (err) {
      if (isUnique(err)) throw new ConflictException("That client code is already used.");
      throw err;
    }
  }

  @Post(":id/services")
  async setService(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(setClientServiceSchema)) body: { service: ClientService; enabled: boolean },
  ) {
    authorize(ctx, "tracking.manage");
    assertClientVisible(ctx.principal, id);
    const [client] = await this.db.db.select().from(clientRecords).where(eq(clientRecords.id, id)).limit(1);
    if (!client) throw new NotFoundException("That client is not on file.");
    const current = enabledServiceList(client.enabledServices);
    const next = body.enabled
      ? [...new Set([...current, body.service])]
      : current.filter((service) => service !== body.service);
    await this.db.db.update(clientRecords).set({ enabledServices: next }).where(eq(clientRecords.id, client.id));
    const label = body.service.charAt(0).toUpperCase() + body.service.slice(1);
    return { message: body.enabled ? `${label} is on for ${client.name}.` : `${label} is off for ${client.name}.` };
  }

  @Post(":id/rates")
  saveRate(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(createRateSchema))
    body: { activityCode?: string; unit: "hour" | "pallet" | "carton" | "unit" | "sku" | "flat"; rateCents: number; label: string },
  ) {
    authorize(ctx, "job.manage");
    return this.billing.saveRate(ctx.principal, id, body);
  }
}
