import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Role } from "@opsengine/contracts";
import type { Principal } from "@opsengine/kernel";
import { SESSION_COOKIE, type AuthedRequest } from "./auth.types.js";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.user = this.read(req, true);
    return true;
  }

  private read(req: AuthedRequest, required: boolean): Principal | undefined {
    const token = readToken(req);
    if (!token) {
      if (required) throw new UnauthorizedException("Sign in to continue.");
      return undefined;
    }
    try {
      const payload = this.jwt.verify<Principal>(token);
      return {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        role: payload.role as Role,
        clientIds: payload.clientIds ?? null,
      };
    } catch {
      throw new UnauthorizedException("Your session expired. Sign in again.");
    }
  }
}

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readToken(req);
    if (!token) return true;
    try {
      const payload = this.jwt.verify<Principal>(token);
      req.user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        role: payload.role as Role,
        clientIds: payload.clientIds ?? null,
      };
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
