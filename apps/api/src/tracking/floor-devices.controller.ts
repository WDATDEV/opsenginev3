import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { floorDeviceSchema } from "@opsengine/contracts";
import { authorize, type RequestContext } from "@opsengine/kernel";
import type { Request, Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthedRequest } from "../auth/auth.types.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { FLOOR_DEVICE_COOKIE, FLOOR_DEVICE_MAX_AGE_MS, floorAllowed } from "./floor-access.js";
import { FloorSessionGuard } from "./floor-access.guard.js";
import { FloorDevicesService } from "./floor-devices.service.js";

function deviceCookie() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.WEB_ORIGIN ?? "").startsWith("https://"),
    path: "/",
    maxAge: FLOOR_DEVICE_MAX_AGE_MS,
  };
}

function deviceToken(req: Request) {
  return (req.cookies as Record<string, string> | undefined)?.[FLOOR_DEVICE_COOKIE];
}

@Controller("tracking/floor-devices")
export class FloorDevicesController {
  constructor(@Inject(FloorDevicesService) private readonly devices: FloorDevicesService) {}

  @Get("me")
  @UseGuards(FloorSessionGuard)
  async me(@Req() req: Request) {
    const device = await this.devices.find(deviceToken(req));
    const principal = (req as unknown as AuthedRequest).user;
    return {
      allowed: floorAllowed({ deviceApproved: Boolean(device), principal }),
      approved: Boolean(device),
      name: device?.name ?? null,
      // The station warns when someone is signed in on it, so staff cannot reach the rest of the app.
      signedIn: Boolean(principal),
    };
  }

  @Get()
  @UseGuards(AuthGuard)
  list(@CurrentUser() ctx: RequestContext, @Req() req: Request) {
    authorize(ctx, "tracking.manage");
    return this.devices.list(deviceToken(req));
  }

  @Post()
  @UseGuards(AuthGuard)
  async register(
    @CurrentUser() ctx: RequestContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodPipe(floorDeviceSchema)) body: { name: string },
  ) {
    authorize(ctx, "tracking.manage");
    const result = await this.devices.register(ctx.principal, body.name, deviceToken(req));
    res.cookie(FLOOR_DEVICE_COOKIE, result.token, deviceCookie());
    return { message: result.message };
  }

  @Post(":id/revoke")
  @UseGuards(AuthGuard)
  revoke(@CurrentUser() ctx: RequestContext, @Param("id", new ParseUUIDPipe()) id: string) {
    authorize(ctx, "tracking.manage");
    return this.devices.revoke(ctx.principal, id);
  }
}
