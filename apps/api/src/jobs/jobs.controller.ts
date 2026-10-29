import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { createJobSchema } from "@opsengine/contracts";
import { authorize, can, ForbiddenError, type Principal, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { BillingService } from "../billing/billing.service.js";
import { ZodPipe } from "../http.js";
import { JobsService } from "./jobs.service.js";

@Controller("jobs")
@UseGuards(AuthGuard)
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  @Get()
  list(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "job.read");
    return this.jobs.list(ctx.principal);
  }

  @Post()
  create(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createJobSchema)) body: { clientId: string; reference: string; title: string },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.create(ctx.principal, body);
  }

  @Post(":id/done")
  done(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "job.manage");
    return this.jobs.close(ctx.principal, id);
  }

  @Post(":id/charges")
  charges(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    assertCanBill(ctx.principal);
    return this.billing.generate(ctx.principal, id);
  }
}

function assertCanBill(principal: Principal) {
  if (!can(principal, "job.manage") && !can(principal, "billing.approve")) {
    throw new ForbiddenError();
  }
}
