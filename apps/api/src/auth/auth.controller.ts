import { Body, Controller, Get, Inject, Post, Res, UseGuards } from "@nestjs/common";
import { loginSchema } from "@opsengine/contracts";
import type { RequestContext } from "@opsengine/kernel";
import type { Response } from "express";
import { ZodPipe } from "../http.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { SESSION_COOKIE } from "./auth.types.js";
import { CurrentUser } from "./current-user.js";

function sessionCookie() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.WEB_ORIGIN ?? "").startsWith("https://"),
    path: "/",
    maxAge: 12 * 60 * 60 * 1000,
  };
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("login")
  async login(
    @Body(new ZodPipe(loginSchema)) body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, principal } = await this.auth.login(body.email, body.password);
    res.cookie(SESSION_COOKIE, token, sessionCookie());
    return { user: principal };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    const cookie = sessionCookie();
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      path: cookie.path,
    });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentUser() ctx: RequestContext) {
    return { user: ctx.principal };
  }
}
