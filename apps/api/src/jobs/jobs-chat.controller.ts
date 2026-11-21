import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { BrowserConfirmGuard } from "../mail/browser-confirm.guard.js";
import { JobsChatService } from "./jobs-chat.service.js";

const askSchema = z.object({
  text: z.string().trim().min(1, "Type a question.").max(4000),
  clientId: z.string().uuid().nullable().optional(),
});

@Controller("jobs/chat")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("time")
export class JobsChatController {
  constructor(@Inject(JobsChatService) private readonly chat: JobsChatService) {}

  @Get()
  get(@CurrentUser() ctx: RequestContext, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.read");
    return this.chat.get(ctx.principal, clientId || null);
  }

  @Get("ready")
  ready(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "job.read");
    return this.chat.ready();
  }

  @Post()
  ask(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(askSchema)) body: z.infer<typeof askSchema>) {
    authorize(ctx, "job.manage");
    return this.chat.ask(ctx.principal, body.text, body.clientId ?? null);
  }

  @Post("messages/:messageId/cancel")
  cancel(@CurrentUser() ctx: RequestContext, @Param("messageId") messageId: string, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.manage");
    return this.chat.cancel(ctx.principal, messageId, clientId || null);
  }

  @Post("messages/:messageId/confirm")
  @UseGuards(BrowserConfirmGuard)
  confirm(@CurrentUser() ctx: RequestContext, @Param("messageId") messageId: string, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.manage");
    return this.chat.confirm(ctx.principal, messageId, clientId || null);
  }
}
