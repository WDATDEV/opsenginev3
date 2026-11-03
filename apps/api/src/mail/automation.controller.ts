import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import { ForbiddenError, type RequestContext } from "@opsengine/kernel";
import type { Response } from "express";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { AutomationService } from "./automation.service.js";

const condition = z.object({
  field: z.enum(["subject", "body", "sender", "domain"]),
  op: z.enum(["contains_any", "contains_all", "not_contains", "equals", "ends_with"]),
  value: z.string().trim().min(1, "Every condition needs a word to look for.").max(500),
});

const people = z.array(z.string().trim().min(1).max(120)).max(20);

const ruleSchema = z.object({
  name: z.string().trim().min(1, "Name the rule.").max(120),
  enabled: z.boolean(),
  matchMode: z.enum(["all", "any"]),
  conditions: z.array(condition).min(1, "Add at least one condition.").max(20),
  draft: z.object({
    enabled: z.boolean(),
    instructions: z.string().max(4000),
    model: z.enum(["haiku", "sonnet"]),
    useWarehance: z.boolean(),
    warehanceClientId: z.number().int().positive().nullable(),
    spreadsheet: z.boolean(),
  }),
  slack: z.object({
    enabled: z.boolean(),
    channel: z.string().trim().max(80),
    mentions: people,
    direct: people,
    includeDraft: z.boolean(),
  }),
});

const runSchema = z.object({ ruleId: z.string().uuid() });

function access(ctx: RequestContext) {
  if (ctx.principal.role !== "owner" && ctx.principal.role !== "warehouse_manager") {
    throw new ForbiddenError("Email automation is for the warehouse manager.");
  }
}

@Controller("mail")
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(@Inject(AutomationService) private readonly automation: AutomationService) {}

  @Get("rules")
  list(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.automation.listRules();
  }

  @Post("rules")
  create(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(ruleSchema)) body: z.infer<typeof ruleSchema>) {
    access(ctx);
    return this.automation.createRule(body);
  }

  @Put("rules/:id")
  update(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(ruleSchema)) body: z.infer<typeof ruleSchema>,
  ) {
    access(ctx);
    return this.automation.updateRule(id, body);
  }

  @Delete("rules/:id")
  remove(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.automation.removeRule(id);
  }

  @Get("runs")
  runs(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.automation.listRuns();
  }

  @Post("letters/:id/run")
  run(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>) {
    access(ctx);
    return this.automation.runNow(id, body.ruleId);
  }

  @Get("runs/:id/attachment")
  async attachment(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Res() res: Response) {
    access(ctx);
    const file = await this.automation.attachment(id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.send(file.csv);
  }
}
