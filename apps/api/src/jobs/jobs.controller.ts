import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import {
  addTaskTimeSchema,
  assignCrewSchema,
  assignEmployeeSchema,
  createJobSchema,
  createJobTaskSchema,
  createJobWorkSchema,
  setTaskStartSchema,
} from "@opsengine/contracts";
import type { z } from "zod";
import { authorize, authorizeSection, can, ForbiddenError, type Principal, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { BillingService } from "../billing/billing.service.js";
import { ZodPipe } from "../http.js";
import { JobsService } from "./jobs.service.js";

@Controller("jobs")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("time")
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
    @Body(new ZodPipe(createJobSchema))
    body: { clientId: string; reference: string; title: string; billBasis?: "time" | "pallet" | "carton" | "sku" | "mixed" },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.create(ctx.principal, body);
  }

  @Post(":id/assignees")
  assign(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(assignCrewSchema))
    body: { employeeId: string; startAt?: string | null; activityCode?: string },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.assign(ctx.principal, id, body.employeeId, body);
  }

  @Post(":id/assignees/remove")
  unassign(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(assignEmployeeSchema)) body: { employeeId: string },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.unassign(ctx.principal, id, body.employeeId);
  }

  @Post(":id/tasks/:taskId/done")
  taskDone(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Param("taskId") taskId: string) {
    authorize(ctx, "job.manage");
    return this.jobs.completeTask(ctx.principal, id, taskId);
  }

  @Post(":id/tasks")
  task(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(createJobTaskSchema))
    body: {
      title: string;
      details?: string;
      assigneeId?: string;
      dueOn?: string;
      dependsOnId?: string;
      startAt?: string;
      activityCode?: string;
    },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.addTask(ctx.principal, id, body);
  }

  @Post(":id/tasks/:taskId/start")
  taskStart(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Body(new ZodPipe(setTaskStartSchema)) body: { startAt: string | null; activityCode?: string },
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.setTaskStart(ctx.principal, id, taskId, body);
  }

  @Post(":id/tasks/:taskId/time")
  taskTime(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Body(new ZodPipe(addTaskTimeSchema)) body: z.infer<typeof addTaskTimeSchema>,
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.addTaskTime(ctx.principal, id, taskId, body);
  }

  @Post(":id/work")
  work(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(createJobWorkSchema)) body: z.infer<typeof createJobWorkSchema>,
  ) {
    authorize(ctx, "job.manage");
    return this.jobs.addWork(ctx.principal, id, body);
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
