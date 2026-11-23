import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { BrowserConfirmGuard } from "../mail/browser-confirm.guard.js";
import { BILL_BASES, type CardEdit } from "./jobs-chat.js";
import { JobsChatService } from "./jobs-chat.service.js";

const askSchema = z.object({
  text: z.string().trim().min(1, "Type a question.").max(4000),
  clientId: z.string().uuid().nullable().optional(),
  threadId: z.string().uuid().nullable().optional(),
});

const cardEditSchema = z
  .object({
    title: z.string().trim().min(1, "Give the job a title.").max(120).optional(),
    reference: z.string().trim().min(1, "Give the job a reference.").max(40).optional(),
    billBasis: z.enum(BILL_BASES).optional(),
    employeeIds: z.array(z.string().uuid()).max(100).optional(),
    tasks: z
      .array(
        z
          .object({
            title: z.string().trim().min(1, "Give each task a title.").max(120),
            activityCode: z.string().trim().min(1).max(60),
            employeeId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .max(40)
      .optional(),
  })
  .strict();

@Controller("jobs/chat")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("time")
export class JobsChatController {
  constructor(@Inject(JobsChatService) private readonly chat: JobsChatService) {}

  @Get()
  get(
    @CurrentUser() ctx: RequestContext,
    @Query("clientId") clientId?: string,
    @Query("threadId", new ParseUUIDPipe({ optional: true })) threadId?: string,
  ) {
    authorize(ctx, "job.read");
    return this.chat.get(ctx.principal, clientId || null, threadId ?? null);
  }

  @Get("ready")
  ready(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "job.read");
    return this.chat.ready();
  }

  @Post()
  ask(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(askSchema)) body: z.infer<typeof askSchema>) {
    authorize(ctx, "job.manage");
    return this.chat.ask(ctx.principal, body.text, body.clientId ?? null, body.threadId ?? null);
  }

  @Post("threads")
  @UseGuards(BrowserConfirmGuard)
  newThread(@CurrentUser() ctx: RequestContext, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.manage");
    return this.chat.newSession(ctx.principal, clientId || null);
  }

  @Post("threads/:threadId/hide")
  @UseGuards(BrowserConfirmGuard)
  hide(
    @CurrentUser() ctx: RequestContext,
    @Param("threadId", ParseUUIDPipe) threadId: string,
    @Query("clientId") clientId?: string,
  ) {
    authorize(ctx, "job.manage");
    return this.chat.setHidden(ctx.principal, threadId, true, clientId || null);
  }

  @Post("threads/:threadId/show")
  @UseGuards(BrowserConfirmGuard)
  show(
    @CurrentUser() ctx: RequestContext,
    @Param("threadId", ParseUUIDPipe) threadId: string,
    @Query("clientId") clientId?: string,
  ) {
    authorize(ctx, "job.manage");
    return this.chat.setHidden(ctx.principal, threadId, false, clientId || null);
  }

  @Post("messages/:messageId/cancel")
  cancel(@CurrentUser() ctx: RequestContext, @Param("messageId") messageId: string, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.manage");
    return this.chat.cancel(ctx.principal, messageId, clientId || null);
  }

  @Post("messages/:messageId/edit")
  @UseGuards(BrowserConfirmGuard)
  edit(
    @CurrentUser() ctx: RequestContext,
    @Param("messageId") messageId: string,
    @Body(new ZodPipe(cardEditSchema)) body: z.infer<typeof cardEditSchema>,
    @Query("clientId") clientId?: string,
  ) {
    authorize(ctx, "job.manage");
    return this.chat.editCard(ctx.principal, messageId, body as CardEdit, clientId || null);
  }

  @Post("messages/:messageId/confirm")
  @UseGuards(BrowserConfirmGuard)
  confirm(@CurrentUser() ctx: RequestContext, @Param("messageId") messageId: string, @Query("clientId") clientId?: string) {
    authorize(ctx, "job.manage");
    return this.chat.confirm(ctx.principal, messageId, clientId || null);
  }
}
