import { BadRequestException, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ForbiddenError, type RequestContext } from "@opsengine/kernel";
import type { Request, Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { GmailService } from "./gmail.service.js";

function web(path: string) {
  return `${(process.env.WEB_ORIGIN ?? "http://localhost:3010").replace(/\/$/, "")}${path}`;
}

function mailAccess(ctx: RequestContext) {
  if (ctx.principal.role !== "owner" && ctx.principal.role !== "warehouse_manager") {
    throw new ForbiddenError("Mail is for the warehouse manager.");
  }
}

@Controller()
export class MailController {
  constructor(@Inject(GmailService) private readonly gmail: GmailService) {}

  // The browser asks for a Google sign-in address, then goes there itself.
  @Post("settings/connectors/gmail/connect")
  @UseGuards(AuthGuard)
  connect(@CurrentUser() ctx: RequestContext, @Req() req: Request) {
    if (ctx.principal.role !== "owner") throw new ForbiddenError("Only the owner can change connectors.");
    return { url: this.gmail.connectUrl(ctx.principal.id, this.gmail.redirectUri(req)) };
  }

  // Google sends the owner here. There is no session cookie on this hop, so the signed state proves who started it.
  @Get("auth/google/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error || !code || !state) return res.redirect(web("/settings?gmail=denied"));
    try {
      await this.gmail.finishConnect(code, state, this.gmail.redirectUri(req));
      await this.gmail.sync().catch(() => undefined);
      return res.redirect(web("/settings?gmail=connected"));
    } catch (err) {
      const message = err instanceof BadRequestException ? String(err.message) : "Could not finish the Google sign-in.";
      return res.redirect(web(`/settings?gmail=failed&reason=${encodeURIComponent(message)}`));
    }
  }

  @Get("mail/letters")
  @UseGuards(AuthGuard)
  letters(@CurrentUser() ctx: RequestContext) {
    mailAccess(ctx);
    return this.gmail.list();
  }

  @Post("mail/sync")
  @UseGuards(AuthGuard)
  async sync(@CurrentUser() ctx: RequestContext) {
    mailAccess(ctx);
    return this.gmail.sync();
  }
}
