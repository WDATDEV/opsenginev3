import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { createRateSchema } from "@opsengine/contracts";
import { clientRecords, rateCards } from "@opsengine/db";
import { authorize, canSeeClient, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { BillingService } from "../billing/billing.service.js";
import { DbService } from "../db.service.js";
import { ZodPipe } from "../http.js";

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
