import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  addCrewSchema,
  badgeSchema,
  checkoutSchema,
  claimStationSchema,
  clockSchema,
  completePackSchema,
  createActivitySchema,
  createEmployeeSchema,
  employeeStatusSchema,
  createGaylordSchema,
  pauseSchema,
  stopSchema,
  createLoadSchema,
  createShipmentSchema,
  finishLoadSchema,
  joinShipmentSchema,
  receiptLineSchema,
  recordPickSchema,
  sortScanSchema,
  switchTaskSchema,
  updateEmployeeSchema,
} from "@opsengine/contracts";
import { authorize, can, ForbiddenError, type Principal, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentPrincipal, CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { FloorAccessGuard, StationAccessGuard } from "./floor-access.guard.js";
import { TrackingService } from "./tracking.service.js";

@Controller("tracking")
export class TrackingController {
  constructor(@Inject(TrackingService) private readonly tracking: TrackingService) {}

  @Get("activities")
  @UseGuards(AuthGuard)
  activities(@CurrentUser() ctx: RequestContext) {
    if (!can(ctx.principal, "tracking.read") && !can(ctx.principal, "job.read")) {
      throw new ForbiddenError();
    }
    return this.tracking.listActivities();
  }

  @Post("activities")
  @UseGuards(AuthGuard)
  createActivity(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createActivitySchema))
    body: {
      code: string;
      name: string;
      department: "packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect";
      billable: boolean;
      clientId?: string;
    },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createActivity(body);
  }

  @Get("floor")
  @UseGuards(AuthGuard)
  floor(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.floor();
  }

  @Get("policy")
  @UseGuards(AuthGuard)
  policy(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.policy();
  }

  @Get("badge/:badge")
  @UseGuards(StationAccessGuard)
  badge(@Param("badge") badge: string) {
    return this.tracking.badgeContext(badge);
  }

  @Get("badge/:badge/records")
  @UseGuards(StationAccessGuard)
  records(@Param("badge") badge: string) {
    return this.tracking.myRecords(badge);
  }

  @Get("checkins")
  @UseGuards(AuthGuard)
  checkins(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.checkins();
  }

  @Post("clock")
  @UseGuards(StationAccessGuard)
  clock(@Body(new ZodPipe(clockSchema)) body: { badge: string; action: "in" | "out" | "meal_start" | "meal_end" }) {
    return this.tracking.clock(body.badge, body.action);
  }

  @Post("tasks/switch")
  @UseGuards(StationAccessGuard)
  switchTask(
    @Body(new ZodPipe(switchTaskSchema))
    body: { badge: string; department?: "packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect"; activityCode?: string; jobId?: string; taskId?: string },
  ) {
    return this.tracking.switchTask(body.badge, body);
  }

  @Post("tasks/pause")
  @UseGuards(StationAccessGuard)
  pause(@Body(new ZodPipe(pauseSchema)) body: { badge: string; reason: string }) {
    return this.tracking.pauseTask(body.badge, body.reason);
  }

  @Post("tasks/resume")
  @UseGuards(StationAccessGuard)
  resume(@Body(new ZodPipe(badgeSchema)) body: { badge: string }) {
    return this.tracking.resumeTask(body.badge);
  }

  @Post("tasks/stop")
  @UseGuards(StationAccessGuard)
  stop(@Body(new ZodPipe(stopSchema)) body: { badge: string; taskId?: string }) {
    return this.tracking.stopTask(body.badge, body.taskId);
  }

  @Post("stations/claim")
  @UseGuards(FloorAccessGuard)
  claim(@Body(new ZodPipe(claimStationSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.claimStation(body.badge, body.deviceCode);
  }

  @Post("stations/release")
  @UseGuards(FloorAccessGuard)
  release(@Body(new ZodPipe(claimStationSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.releaseStation(body.badge, body.deviceCode);
  }

  @Post("packing")
  @UseGuards(StationAccessGuard)
  pack(
    @CurrentPrincipal() principal: Principal | null,
    @Body(new ZodPipe(completePackSchema))
    body: {
      orderNumber: string;
      badge: string;
      units: number;
      clientId?: string;
    },
  ) {
    return this.tracking.completePack(body, principal);
  }

  @Get("packing")
  @UseGuards(AuthGuard)
  packing(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.packingBoard();
  }

  @Post("picking")
  @UseGuards(StationAccessGuard)
  pick(
    @CurrentPrincipal() principal: Principal | null,
    @Body(new ZodPipe(recordPickSchema))
    body: {
      badge: string;
      batchCode: string;
      sku: string;
      qty: number;
      orderNumber?: string;
      clientId?: string;
    },
  ) {
    return this.tracking.recordPick(body, principal);
  }

  @Get("picking")
  @UseGuards(AuthGuard)
  picking(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.pickingBoard();
  }

  @Post("devices/checkout")
  @UseGuards(FloorAccessGuard)
  checkout(@Body(new ZodPipe(checkoutSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.checkout(body.badge, body.deviceCode);
  }

  @Post("devices/checkin")
  @UseGuards(FloorAccessGuard)
  checkin(@Body(new ZodPipe(checkoutSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.checkin(body.badge, body.deviceCode);
  }

  @Get("employees")
  @UseGuards(AuthGuard)
  employees(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.listEmployees();
  }

  @Post("employees")
  @UseGuards(AuthGuard)
  createEmployee(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createEmployeeSchema))
    body: {
      name: string;
      badgeCode: string;
      departmentHome?: "packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect";
      departments?: ("packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect")[];
      employmentType: "employee" | "temp";
      clientId?: string;
    },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createEmployee(body);
  }

  @Post("employees/:id")
  @UseGuards(AuthGuard)
  updateEmployee(
    @CurrentUser() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateEmployeeSchema))
    body: { name: string; badgeCode: string; departments: ("packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect")[] },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.updateEmployee(ctx.principal, id, body);
  }

  @Post("employees/:id/status")
  @UseGuards(AuthGuard)
  employeeStatus(
    @CurrentUser() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(employeeStatusSchema)) body: { active: boolean },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.setEmployeeActive(ctx.principal, id, body.active);
  }

  @Get("receiving")
  @UseGuards(AuthGuard)
  receiving(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.receivingBoard();
  }

  @Post("receiving")
  @UseGuards(AuthGuard)
  createShipment(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createShipmentSchema))
    body: { reference: string; jobId: string; carrier: string; expectedCartons: number },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createShipment(body);
  }

  @Post("receiving/:id/join")
  @UseGuards(StationAccessGuard)
  join(
    @Param("id") id: string,
    @Body(new ZodPipe(joinShipmentSchema)) body: { badge: string; role: "lead" | "counter" },
  ) {
    return this.tracking.joinShipment(id, body.badge, body.role);
  }

  @Post("receiving/:id/lines")
  @UseGuards(StationAccessGuard)
  line(
    @CurrentPrincipal() principal: Principal | null,
    @Param("id") id: string,
    @Body(new ZodPipe(receiptLineSchema))
    body: { badge: string; sku: string; expectedQty: number; receivedQty: number },
  ) {
    return this.tracking.addReceiptLine(id, body, principal);
  }

  @Post("receiving/:id/close")
  @UseGuards(AuthGuard)
  closeShipment(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "tracking.manage");
    return this.tracking.closeShipment(id);
  }

  @Get("unloading")
  @UseGuards(AuthGuard)
  unloading(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.unloadingBoard();
  }

  @Post("unloading")
  @UseGuards(AuthGuard)
  createLoad(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createLoadSchema))
    body: { reference: string; jobId: string; kind: "truck" | "container"; dock: string; seal?: string },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createLoad(body);
  }

  @Post("unloading/:id/crew")
  @UseGuards(StationAccessGuard)
  crew(
    @CurrentPrincipal() principal: Principal | null,
    @Param("id") id: string,
    @Body(new ZodPipe(addCrewSchema))
    body: { source: "badge" | "lead_added" | "paper"; badge?: string; employeeId?: string },
  ) {
    return this.tracking.addCrew(id, body, principal);
  }

  @Post("unloading/:id/finish")
  @UseGuards(AuthGuard)
  finish(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(finishLoadSchema)) body: { palletCount: number; cartonCount: number },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.finishLoad(id, body);
  }

  @Get("sorting")
  @UseGuards(AuthGuard)
  sorting(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.sortingBoard();
  }

  @Post("sorting/gaylords")
  @UseGuards(AuthGuard)
  gaylord(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createGaylordSchema))
    body: { code: string; carrier: "usps" | "ups" | "fedex" | "dhl" | "other"; clientId?: string },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createGaylord(body);
  }

  @Post("sorting/scan")
  @UseGuards(StationAccessGuard)
  scan(
    @Body(new ZodPipe(sortScanSchema))
    body: {
      gaylordCode: string;
      trackingNumber: string;
      badge: string;
      deviceCode?: string;
      method: "scan" | "manual_place";
      reason?: string;
    },
  ) {
    return this.tracking.sortScan(body);
  }

  @Post("sorting/:id/close")
  @UseGuards(AuthGuard)
  closeGaylord(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorize(ctx, "tracking.manage");
    return this.tracking.closeGaylord(id);
  }
}
