import { Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { WorkService } from "./work.service.js";

@Controller("work")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("time")
export class WorkController {
  constructor(@Inject(WorkService) private readonly work: WorkService) {}

  @Get("tasks")
  @UseGuards(AuthGuard)
  tasks(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "task.read");
    return this.work.list(ctx.principal);
  }

  @Post("tasks/:id/done")
  @UseGuards(AuthGuard)
  done(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "task.update");
    return this.work.complete(ctx.principal, id);
  }
}
