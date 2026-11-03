import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ForbiddenError, type RequestContext } from "@opsengine/kernel";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { BroadcastService } from "./broadcast.service.js";

const audience = z.object({
  everyone: z.boolean(),
  groups: z.array(z.string().trim().min(1).max(40)).max(50),
  clientIds: z.array(z.string().uuid()).max(500),
  contactIds: z.array(z.string().uuid()).max(5000),
});

const campaignSchema = z.object({
  title: z.string().trim().min(1, "Give the campaign a name.").max(120),
  category: z.enum(["holiday", "notice", "other"]),
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().trim().min(1, "Write the message.").max(20_000),
  audience,
});

const scheduleSchema = z.object({
  // Empty means send right now.
  at: z.string().datetime({ offset: true, message: "Choose a date and time." }).nullable(),
});

const previewSchema = z.object({ audience });

const testSchema = z.object({
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().trim().min(1, "Write the message.").max(20_000),
});

const settingsSchema = z.object({
  senderName: z.string().trim().max(80),
  replyTo: z.string().trim().max(200),
  signature: z.string().trim().max(2000),
  dailyLimit: z.number().int().min(1).max(2000),
  perMinute: z.number().int().min(1).max(120),
});

const templateSchema = z.object({
  name: z.string().trim().min(1, "Name the template.").max(80),
  category: z.enum(["holiday", "notice", "other"]),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
});

const contactSchema = z.object({
  email: z.string().trim().min(1, "Enter an email address.").max(200),
  name: z.string().trim().max(120).default(""),
  clientId: z.string().uuid().nullable().optional(),
  groups: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const contactUpdateSchema = z.object({
  name: z.string().trim().max(120).default(""),
  clientId: z.string().uuid().nullable().optional(),
  groups: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  doNotEmail: z.boolean().default(false),
});

const importSchema = z.object({
  source: z.enum(["staff", "letters", "paste"]),
  text: z.string().max(200_000).optional(),
  group: z.string().trim().max(40).optional(),
  clientId: z.string().uuid().nullable().optional(),
});

function access(ctx: RequestContext) {
  if (ctx.principal.role !== "owner" && ctx.principal.role !== "warehouse_manager") {
    throw new ForbiddenError("Bulk email is for the warehouse manager.");
  }
}

@Controller("mail")
@UseGuards(AuthGuard)
export class BroadcastController {
  constructor(@Inject(BroadcastService) private readonly bulk: BroadcastService) {}

  @Get("bulk/options")
  options(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.bulk.options();
  }

  @Get("bulk/settings")
  settings(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.bulk.settings();
  }

  @Put("bulk/settings")
  saveSettings(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    access(ctx);
    return this.bulk.saveSettings(body);
  }

  @Get("bulk/templates")
  templates(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.bulk.templates();
  }

  @Post("bulk/templates")
  addTemplate(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(templateSchema)) body: z.infer<typeof templateSchema>) {
    access(ctx);
    return this.bulk.addTemplate(body);
  }

  @Delete("bulk/templates/:id")
  removeTemplate(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.removeTemplate(id);
  }

  @Get("bulk/contacts")
  contacts(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.bulk.contacts();
  }

  @Post("bulk/contacts")
  addContact(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    access(ctx);
    return this.bulk.addContact(body);
  }

  @Post("bulk/contacts/import")
  importContacts(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(importSchema)) body: z.infer<typeof importSchema>) {
    access(ctx);
    return this.bulk.importContacts(body);
  }

  @Put("bulk/contacts/:id")
  updateContact(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(contactUpdateSchema)) body: z.infer<typeof contactUpdateSchema>,
  ) {
    access(ctx);
    return this.bulk.updateContact(id, body);
  }

  @Delete("bulk/contacts/:id")
  removeContact(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.removeContact(id);
  }

  @Post("bulk/preview")
  preview(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(previewSchema)) body: z.infer<typeof previewSchema>) {
    access(ctx);
    return this.bulk.preview(body.audience);
  }

  @Post("bulk/test")
  test(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(testSchema)) body: z.infer<typeof testSchema>) {
    access(ctx);
    return this.bulk.test(body);
  }

  @Get("bulk/campaigns")
  campaigns(@CurrentUser() ctx: RequestContext) {
    access(ctx);
    return this.bulk.list();
  }

  @Post("bulk/campaigns")
  create(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(campaignSchema)) body: z.infer<typeof campaignSchema>) {
    access(ctx);
    return this.bulk.save(ctx.principal.id, null, body);
  }

  @Put("bulk/campaigns/:id")
  update(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(campaignSchema)) body: z.infer<typeof campaignSchema>,
  ) {
    access(ctx);
    return this.bulk.save(ctx.principal.id, id, body);
  }

  @Delete("bulk/campaigns/:id")
  remove(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.remove(id);
  }

  @Get("bulk/campaigns/:id/recipients")
  recipients(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.recipients(id);
  }

  @Post("bulk/campaigns/:id/schedule")
  schedule(
    @CurrentUser() ctx: RequestContext,
    @Param("id") id: string,
    @Body(new ZodPipe(scheduleSchema)) body: z.infer<typeof scheduleSchema>,
  ) {
    access(ctx);
    return this.bulk.schedule(id, body.at ? new Date(body.at) : null);
  }

  @Post("bulk/campaigns/:id/unschedule")
  unschedule(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.unschedule(id);
  }

  @Post("bulk/campaigns/:id/stop")
  stop(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    access(ctx);
    return this.bulk.stop(id);
  }
}
