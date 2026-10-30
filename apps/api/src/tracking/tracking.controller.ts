import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
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
  createDeviceSchema,
  createEmployeeSchema,
  siteSchema,
  createGaylordSchema,
  createLoadSchema,
  createShipmentSchema,
  finishLoadSchema,
  joinShipmentSchema,
  receiptLineSchema,
  recordPickSchema,
  sortScanSchema,
  switchTaskSchema,
} from "@opsengine/contracts";
import { authorize, can, ForbiddenError, type Principal, type RequestContext } from "@opsengine/kernel";
import { AuthGuard, OptionalAuthGuard } from "../auth/auth.guard.js";
import { CurrentPrincipal, CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
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
  badge(@Param("badge") badge: string) {
    return this.tracking.badgeContext(badge);
  }

  @Get("gate")
  gate() {
    return this.tracking.gateStatus();
  }

  @Get("site")
  @UseGuards(AuthGuard)
  site(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.readSite();
  }

  @Post("site")
  @UseGuards(AuthGuard)
  saveSite(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(siteSchema)) body: { latitude: number; longitude: number; radiusMeters: number },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.saveSite(body);
  }

  @Get("checkins")
  @UseGuards(AuthGuard)
  checkins(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.checkins();
  }

  @Post("clock")
  clock(
    @Body(new ZodPipe(clockSchema))
    body: {
      badge: string;
      action: "in" | "out" | "meal_start" | "meal_end";
      source: "kiosk" | "qr";
      place?: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      capturedAt?: number;
    },
  ) {
    return this.tracking.clock(body.badge, body.action, body.source, {
      place: body.place,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
      capturedAt: body.capturedAt,
    });
  }

  @Post("tasks/switch")
  switchTask(
    @Body(new ZodPipe(switchTaskSchema))
    body: { badge: string; department?: "packing" | "picking" | "receiving" | "unloading" | "sorting" | "indirect"; activityCode?: string; jobId?: string },
  ) {
    return this.tracking.switchTask(body.badge, body);
  }

  @Post("tasks/pause")
  pause(@Body(new ZodPipe(badgeSchema)) body: { badge: string }) {
    return this.tracking.pauseTask(body.badge);
  }

  @Post("tasks/resume")
  resume(@Body(new ZodPipe(badgeSchema)) body: { badge: string }) {
    return this.tracking.resumeTask(body.badge);
  }

  @Post("tasks/stop")
  stop(@Body(new ZodPipe(badgeSchema)) body: { badge: string }) {
    return this.tracking.stopTask(body.badge);
  }

  @Post("stations/claim")
  claim(@Body(new ZodPipe(claimStationSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.claimStation(body.badge, body.deviceCode);
  }

  @Post("stations/release")
  release(@Body(new ZodPipe(claimStationSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.releaseStation(body.badge, body.deviceCode);
  }

  @Post("packing")
  @UseGuards(OptionalAuthGuard)
  pack(
    @CurrentPrincipal() principal: Principal | null,
    @Body(new ZodPipe(completePackSchema))
    body: {
      orderNumber: string;
      deviceCode: string;
      badge?: string;
      units: number;
      warehanceRecorded?: boolean;
      warehanceUserId?: string;
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
  @UseGuards(OptionalAuthGuard)
  pick(
    @CurrentPrincipal() principal: Principal | null,
    @Body(new ZodPipe(recordPickSchema))
    body: {
      deviceCode: string;
      badge?: string;
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
  checkout(@Body(new ZodPipe(checkoutSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.checkout(body.badge, body.deviceCode);
  }

  @Post("devices/checkin")
  checkin(@Body(new ZodPipe(checkoutSchema)) body: { badge: string; deviceCode: string }) {
    return this.tracking.checkin(body.badge, body.deviceCode);
  }

  @Get("devices")
  @UseGuards(AuthGuard)
  devices(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "tracking.read");
    return this.tracking.listDevices();
  }

  @Post("devices")
  @UseGuards(AuthGuard)
  createDevice(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(createDeviceSchema))
    body: {
      code: string;
      label: string;
      kind: "packing_computer" | "barcode_scanner" | "handheld";
      ownership: "personal" | "shared_pool";
      warehanceLoginMode: "individual" | "shared" | "none";
      location: string;
      assignedBadge?: string;
      clientId?: string;
    },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createDevice(body, ctx.principal);
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
      warehanceUserId?: string;
      clientId?: string;
    },
  ) {
    authorize(ctx, "tracking.manage");
    return this.tracking.createEmployee(body);
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
  join(
    @Param("id") id: string,
    @Body(new ZodPipe(joinShipmentSchema)) body: { badge: string; role: "lead" | "counter" },
  ) {
    return this.tracking.joinShipment(id, body.badge, body.role);
  }

  @Post("receiving/:id/lines")
  @UseGuards(OptionalAuthGuard)
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
  @UseGuards(OptionalAuthGuard)
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
