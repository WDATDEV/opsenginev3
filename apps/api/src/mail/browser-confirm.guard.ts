import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { SESSION_COOKIE, type AuthedRequest } from "../auth/auth.types.js";
import { assertBrowserConfirm } from "./browser-confirm.js";

@Injectable()
export class BrowserConfirmGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    assertBrowserConfirm(req.headers, req.cookies?.[SESSION_COOKIE], process.env.WEB_ORIGIN ?? "http://localhost:3010");
    return true;
  }
}
