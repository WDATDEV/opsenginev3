import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { SESSION_COOKIE, type AuthedRequest } from "../auth/auth.types.js";
import { assertBrowserConfirm, originCheckSkipped } from "./browser-confirm.js";

@Injectable()
export class BrowserConfirmGuard implements CanActivate {
  private warned = false;

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const appEnv = process.env.APP_ENV;
    if (originCheckSkipped(appEnv) && !this.warned) {
      this.warned = true;
      new Logger("Confirm").warn("APP_ENV=test: stock Confirm does not check the browser address. Never set this in production.");
    }
    assertBrowserConfirm(req.headers, req.cookies?.[SESSION_COOKIE], process.env.WEB_ORIGIN ?? "http://localhost:3010", appEnv);
    return true;
  }
}
