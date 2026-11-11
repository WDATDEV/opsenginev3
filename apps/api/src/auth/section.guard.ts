import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SetMetadata } from "@nestjs/common";
import type { AppSection } from "@opsengine/contracts";
import { authorizeSection } from "@opsengine/kernel";
import type { AuthedRequest } from "./auth.types.js";

export const APP_SECTION_KEY = "appSection";

export const RequireSection = (section: AppSection) => SetMetadata(APP_SECTION_KEY, section);

// Reads @RequireSection on the handler or controller. AuthGuard must run first so req.user is set.
@Injectable()
export class SectionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const section = this.reflector.getAllAndOverride<AppSection | undefined>(APP_SECTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!section) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) return true;
    authorizeSection({ principal: req.user }, section);
    return true;
  }
}
