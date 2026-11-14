import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { users } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { SESSION_COOKIE, type AuthedRequest } from "./auth.types.js";
import { principalFromUser } from "./principal.js";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.user = await this.read(req, true);
    return true;
  }

  private async read(req: AuthedRequest, required: boolean) {
    const token = readToken(req);
    if (!token) {
      if (required) throw new UnauthorizedException("Sign in to continue.");
      return undefined;
    }
    let id: string;
    try {
      id = this.jwt.verify<{ id: string }>(token).id;
    } catch {
      throw new UnauthorizedException("Your session expired. Sign in again.");
    }
    const [row] = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new UnauthorizedException("Sign in to continue.");
    return principalFromUser(row);
  }
}

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readToken(req);
    if (!token) return true;
    try {
      const id = this.jwt.verify<{ id: string }>(token).id;
      const [row] = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
      if (row) req.user = principalFromUser(row);
      return true;
    } catch {
      throw new UnauthorizedException("Your session expired. Sign in again.");
    }
  }
}

function readToken(req: AuthedRequest): string | undefined {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value?.startsWith("Bearer ")) return value.slice(7);
  return undefined;
}
