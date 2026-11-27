import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { shiftEditSchema, timecardWeekSchema, timekeepingSettingsSchema } from "@opsengine/contracts";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { StationAccessGuard } from "./floor-access.guard.js";
import { TimecardsService } from "./timecards.service.js";

type Week = { weekOf?: string; tz?: string };

/** Weekly timecards: managers correct and approve, HR reads, employees confirm their own. */
@Controller("tracking")
export class TimecardsController {
  constructor(@Inject(TimecardsService) private readonly timecards: TimecardsService) {}

  @Get("timekeeping/settings")
  @UseGuards(AuthGuard)
  settings(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.timecards.settings();
  }

  @Post("timekeeping/settings")
  @UseGuards(AuthGuard)
  saveSettings(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(timekeepingSettingsSchema))
    body: { dailyOvertimeMinutes: number; weeklyOvertimeMinutes: number; weekStartsOn: number; timeZone: string },
  ) {
    authorize(ctx, "tracking.manage");
    return this.timecards.saveSettings(ctx.principal, body);
  }

  @Get("timecards")
  @UseGuards(AuthGuard)
  list(@CurrentUser() ctx: RequestContext, @Query(new ZodPipe(timecardWeekSchema)) query: Week) {
    authorize(ctx, "tracking.read");
    return this.timecards.list(query.weekOf, query.tz);
  }

  // Declared before timecards/:employeeId so these words are not read as an id.
  @Get("timecards/attention")
  @UseGuards(AuthGuard)
  attention(@CurrentUser() ctx: RequestContext, @Query(new ZodPipe(timecardWeekSchema)) query: Week) {
    authorize(ctx, "tracking.read");
    return this.timecards.attention(query.tz);
  }

  @Get("timecards/print")
  @UseGuards(AuthGuard)
  print(
    @CurrentUser() ctx: RequestContext,
    @Query(new ZodPipe(timecardWeekSchema)) query: Week,
    @Query("employees") employeeList?: string,
    @Query("agency") agency?: string,
  ) {
    authorize(ctx, "tracking.read");
    const employeeIds = (employeeList ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^[0-9a-f-]{36}$/i.test(item));
    return this.timecards.print(query.weekOf, query.tz, { employeeIds, agency: agency?.trim() || undefined });
  }

  @Get("timecards/:employeeId")
  @UseGuards(AuthGuard)
  card(
    @CurrentUser() ctx: RequestContext,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Query(new ZodPipe(timecardWeekSchema)) query: Week,
  ) {
    authorize(ctx, "tracking.read");
    return this.timecards.card(employeeId, query.weekOf, query.tz);
  }

  @Post("timecards/:employeeId/approve")
  @UseGuards(AuthGuard)
  approve(
    @CurrentUser() ctx: RequestContext,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodPipe(timecardWeekSchema)) body: Week,
  ) {
    authorize(ctx, "tracking.manage");
    return this.timecards.approve(ctx.principal, employeeId, body.weekOf, body.tz);
  }

  @Post("timecards/:employeeId/unapprove")
  @UseGuards(AuthGuard)
  unapprove(
    @CurrentUser() ctx: RequestContext,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodPipe(timecardWeekSchema)) body: Week,
  ) {
    authorize(ctx, "tracking.manage");
    return this.timecards.unapprove(ctx.principal, employeeId, body.weekOf, body.tz);
  }

  @Post("shifts/:id/edit")
  @UseGuards(AuthGuard)
  editShift(
    @CurrentUser() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(shiftEditSchema)) body: { clockIn: string; clockOut: string | null; reason: string },
    @Query(new ZodPipe(timecardWeekSchema)) query: Week,
  ) {
    authorize(ctx, "tracking.manage");
    return this.timecards.editShift(ctx.principal, id, body, query.tz);
  }

  @Get("badge/:badge/timecard")
  @UseGuards(StationAccessGuard)
  myWeek(@Param("badge") badge: string, @Query(new ZodPipe(timecardWeekSchema)) query: Week) {
    return this.timecards.myWeek(badge, query.weekOf, query.tz);
  }

  @Post("badge/:badge/timecard/confirm")
  @UseGuards(StationAccessGuard)
  confirm(@Param("badge") badge: string, @Body(new ZodPipe(timecardWeekSchema)) body: Week) {
    return this.timecards.confirm(badge, body.weekOf, body.tz);
  }
}
