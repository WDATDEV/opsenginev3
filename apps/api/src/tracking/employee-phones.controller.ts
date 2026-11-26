import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { phoneClaimSchema } from "@opsengine/contracts";
import { authorize, type RequestContext } from "@opsengine/kernel";
import type { Request, Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { EmployeePhonesService } from "./employee-phones.service.js";
import { EMPLOYEE_PHONE_COOKIE, FLOOR_DEVICE_COOKIE, FLOOR_DEVICE_MAX_AGE_MS } from "./floor-access.js";
import { FloorDevicesService } from "./floor-devices.service.js";

function phoneCookie() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.WEB_ORIGIN ?? "").startsWith("https://"),
    path: "/",
    maxAge: FLOOR_DEVICE_MAX_AGE_MS,
  };
}

function cookie(req: Request, name: string) {
  return (req.cookies as Record<string, string> | undefined)?.[name];
}

/** Employees' own phones: a manager makes a one-time link, the employee opens it once. */
@Controller("tracking/phones")
export class EmployeePhonesController {
  constructor(
    @Inject(EmployeePhonesService) private readonly phones: EmployeePhonesService,
    @Inject(FloorDevicesService) private readonly devices: FloorDevicesService,
  ) {}

  @Post("link/:employeeId")
  @UseGuards(AuthGuard)
  async link(@CurrentUser() ctx: RequestContext, @Param("employeeId", new ParseUUIDPipe()) employeeId: string) {
    authorize(ctx, "tracking.manage");
    const result = await this.phones.createLink(ctx.principal, employeeId);
    return { path: `/station?link=${encodeURIComponent(result.token)}`, expiresAt: result.expiresAt, name: result.name };
  }

  @Get("employee/:employeeId")
  @UseGuards(AuthGuard)
  list(@CurrentUser() ctx: RequestContext, @Param("employeeId", new ParseUUIDPipe()) employeeId: string) {
    authorize(ctx, "tracking.manage");
    return this.phones.list(employeeId);
  }

  @Post(":id/revoke")
  @UseGuards(AuthGuard)
  revoke(@CurrentUser() ctx: RequestContext, @Param("id", new ParseUUIDPipe()) id: string) {
    authorize(ctx, "tracking.manage");
    return this.phones.revoke(ctx.principal, id, ctx.principal.name);
  }

  // Open on purpose: the one-time link is the proof. It is 32 random bytes and works once, within a day.
  @Post("claim")
  async claim(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body(new ZodPipe(phoneClaimSchema)) body: { token: string }) {
    const station = await this.devices.find(cookie(req, FLOOR_DEVICE_COOKIE));
    const result = await this.phones.claim(body.token, Boolean(station));
    res.cookie(EMPLOYEE_PHONE_COOKIE, result.token, phoneCookie());
    return { message: `This phone now records ${result.name}'s time.`, name: result.name };
  }

  /** The employee unlinks their own phone. */
  @Post("forget")
  async forget(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const phone = await this.phones.find(cookie(req, EMPLOYEE_PHONE_COOKIE));
    if (phone) await this.phones.revoke(null, phone.id, phone.name);
    res.clearCookie(EMPLOYEE_PHONE_COOKIE, { path: "/" });
    return { message: "This phone is no longer linked." };
  }
}
