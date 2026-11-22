import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { users } from "@opsengine/db";
import { ForbiddenError, type Principal } from "@opsengine/kernel";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, type AuthedRequest } from "../auth/auth.types.js";
import { principalFromUser } from "../auth/principal.js";
import { DbService } from "../db.service.js";
import { FLOOR_DEVICE_COOKIE, FLOOR_DEVICE_REFUSED, floorAllowed } from "./floor-access.js";
import { FloorDevicesService } from "./floor-devices.service.js";

/** Reads a sign-in if there is one. An expired sign-in must not lock an approved floor device. */
@Injectable()
export class FloorSessionGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.user = await this.read(req);
    return true;
  }

  async read(req: AuthedRequest): Promise<Principal | undefined> {
    const header = req.headers.authorization;
    const bearer = Array.isArray(header) ? header[0] : header;
    const token = req.cookies?.[SESSION_COOKIE] ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined);
    if (!token) return undefined;
    try {
      const { id } = this.jwt.verify<{ id: string }>(token);
      const [row] = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? principalFromUser(row) : undefined;
    } catch {
      return undefined;
    }
  }
}

@Injectable()
export class FloorAccessGuard implements CanActivate {
  constructor(
    @Inject(FloorSessionGuard) private readonly sessions: FloorSessionGuard,
    @Inject(FloorDevicesService) private readonly devices: FloorDevicesService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.user = await this.sessions.read(req);
    const device = await this.devices.find(req.cookies?.[FLOOR_DEVICE_COOKIE]);
    if (!floorAllowed({ deviceApproved: Boolean(device), principal: req.user })) {
      throw new ForbiddenError(FLOOR_DEVICE_REFUSED);
    }
    return true;
  }
}
