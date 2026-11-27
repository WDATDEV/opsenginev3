import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { caseNoteSchema, createCaseSchema, floorProblemSchema, updateCaseSchema } from "@opsengine/contracts";
import type { RequestContext } from "@opsengine/kernel";
import type { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { StationAccessGuard } from "../tracking/floor-access.guard.js";
import { CasesService } from "./cases.service.js";

/** Problems to follow up. Managers and HR on /problems; the floor reports from the floor phone. */
@Controller()
export class CasesController {
  constructor(@Inject(CasesService) private readonly cases: CasesService) {}

  @Get("work/cases")
  @UseGuards(AuthGuard)
  list(@CurrentUser() ctx: RequestContext, @Query("status") status?: string, @Query("kind") kind?: string) {
    return this.cases.list(ctx.principal, { status: status || undefined, kind: kind || undefined });
  }

  // Declared before work/cases/:id so the word is not read as an id.
  @Get("work/cases/owners")
  @UseGuards(AuthGuard)
  owners(@CurrentUser() ctx: RequestContext) {
    return this.cases.owners(ctx.principal);
  }

  @Get("work/cases/:id")
  @UseGuards(AuthGuard)
  get(@CurrentUser() ctx: RequestContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.cases.get(ctx.principal, id);
  }

  @Post("work/cases")
  @UseGuards(AuthGuard)
  create(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(createCaseSchema)) body: z.infer<typeof createCaseSchema>) {
    return this.cases.create(ctx.principal, body);
  }

  @Post("work/cases/:id")
  @UseGuards(AuthGuard)
  update(
    @CurrentUser() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCaseSchema)) body: z.infer<typeof updateCaseSchema>,
  ) {
    return this.cases.update(ctx.principal, id, body);
  }

  @Post("work/cases/:id/notes")
  @UseGuards(AuthGuard)
  note(
    @CurrentUser() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(caseNoteSchema)) body: z.infer<typeof caseNoteSchema>,
  ) {
    return this.cases.addNote(ctx.principal, id, body);
  }

  @Post("tracking/badge/:badge/problem")
  @UseGuards(StationAccessGuard)
  report(@Param("badge") badge: string, @Body(new ZodPipe(floorProblemSchema)) body: z.infer<typeof floorProblemSchema>) {
    return this.cases.reportFromFloor(badge, body);
  }
}
