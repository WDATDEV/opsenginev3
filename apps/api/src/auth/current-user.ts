import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Principal, RequestContext } from "@opsengine/kernel";
import type { AuthedRequest } from "./auth.types.js";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new Error("CurrentUser used without AuthGuard");
    return { principal: req.user };
  },
);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | null => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.user ?? null;
  },
);
