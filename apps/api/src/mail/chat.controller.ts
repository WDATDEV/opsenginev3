import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Res, UseGuards } from "@nestjs/common";
import { authorizeSection, ForbiddenError, type RequestContext } from "@opsengine/kernel";
import type { Response } from "express";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { ZodPipe } from "../http.js";
import { ChatService } from "./chat.service.js";

const model = z.enum(["haiku", "sonnet"]);
const clientId = z.number().int().positive().nullable();
const clientName = z.string().trim().max(200).nullable();

const createSchema = z.object({
  clientId: clientId.default(null),
  clientName: clientName.default(null),
  model: model.default("haiku"),
});

const updateSchema = z.object({
  title: z.string().trim().min(1, "Give the chat a name.").max(120).optional(),
  clientId: clientId.optional(),
  clientName: clientName.optional(),
  model: model.optional(),
});

const askSchema = z.object({ text: z.string().trim().min(1, "Type a question.").max(8000) });
const recoverSchema = z.object({ format: z.enum(["csv", "xlsx", "json"]).default("csv") });
const stockSchema = z.object({
  keep: z.array(z.object({ sku: z.string().trim().min(1).max(80), location: z.string().trim().min(1).max(120) })).max(20).default([]),
});

const emailSchema = z.object({
  messageId: z.string().uuid(),
  to: z.string().trim().min(1, "Enter an email address.").max(1000),
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().trim().min(1, "Write the message.").max(20_000),
  fileIds: z.array(z.string().uuid()).max(5).default([]),
});

const slackSchema = z.object({
  messageId: z.string().uuid(),
  to: z.string().trim().min(1, "Choose a channel or a person.").max(200),
  text: z.string().trim().max(4000).default(""),
  fileIds: z.array(z.string().uuid()).max(5).default([]),
});

const tableSchema = z.object({
  columns: z.array(z.string().trim().min(1).max(120)).min(1).max(80),
  cells: z.array(z.array(z.string().max(2000)).max(80)).min(1).max(5000),
  name: z.string().trim().min(1).max(120).optional(),
});

const warehanceSchema = tableSchema.extend({
  action: z.enum(["set", "adjust"]).default("set"),
  warehouse: z.string().trim().max(120).default(""),
  reason: z.string().trim().max(200).default(""),
  zeroQuantity: z.boolean().default(false),
});

function access(ctx: RequestContext) {
  authorizeSection(ctx, "chat");
  return ctx.principal.id;
}

@Controller("mail/chat")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("chat")
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get("config")
  config(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.chat.config();
  }

  @Get("clients")
  clients(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.chat.clients();
  }

  @Get("threads")
  list(@CurrentUser() ctx: RequestContext) {
    return this.chat.list(access(ctx));
  }

  @Post("threads")
  create(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.chat.create(access(ctx), body);
  }

  @Get("threads/:id")
  get(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    return this.chat.get(access(ctx), id);
  }

  @Patch("threads/:id")
  update(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.chat.update(access(ctx), id, body);
  }

  @Delete("threads/:id")
  remove(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    return this.chat.remove(access(ctx), id);
  }

  @Post("threads/:id/messages")
  ask(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(askSchema)) body: z.infer<typeof askSchema>) {
    return this.chat.ask(access(ctx), id, body.text);
  }

  @Post("threads/:id/messages/:messageId/recover")
  recover(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body(new ZodPipe(recoverSchema)) body: z.infer<typeof recoverSchema>,
  ) {
    return this.chat.recover(access(ctx), id, messageId, body.format);
  }

  @Get("threads/:id/stock-logs")
  stockLogs(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    if (ctx.principal.role !== "owner") throw new ForbiddenError("Only the owner can open stock-change logs.");
    return this.chat.stockLogs(access(ctx), id);
  }

  @Post("threads/:id/messages/:messageId/stock")
  confirmStock(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body(new ZodPipe(stockSchema)) body: z.infer<typeof stockSchema>,
  ) {
    return this.chat.confirmStock(ctx.principal, id, messageId, body.keep);
  }

  @Post("threads/:id/email")
  email(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(emailSchema)) body: z.infer<typeof emailSchema>) {
    return this.chat.email(access(ctx), id, body);
  }

  @Post("threads/:id/slack")
  slack(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(slackSchema)) body: z.infer<typeof slackSchema>) {
    return this.chat.slack(access(ctx), id, body);
  }

  @Get("files/:id/download")
  async download(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Res() res: Response) {
    const file = await this.chat.file(access(ctx), id);
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/[^\w.\- ]+/g, "_")}"`);
    res.send(file.data);
  }

  @Get("files/:id/table")
  table(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    return this.chat.table(access(ctx), id);
  }

  @Post("files/:id/table")
  saveTable(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(tableSchema)) body: z.infer<typeof tableSchema>) {
    return this.chat.saveTable(access(ctx), id, body);
  }

  @Post("files/:id/warehance")
  warehanceCsv(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(warehanceSchema)) body: z.infer<typeof warehanceSchema>) {
    return this.chat.warehanceCsv(access(ctx), id, body);
  }
}
