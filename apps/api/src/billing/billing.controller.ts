import { Controller, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { BillingService } from "./billing.service.js";

@Controller("billing")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("time")
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Post("charges/:id/approve")
  approve(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "billing.approve");
    return this.billing.approve(ctx.principal, id);
  }

  @Post("invoices/:id/paid")
  paid(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "billing.approve");
    return this.billing.markPaid(ctx.principal, id);
  }
}
