import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ForbiddenError, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { SettingsService } from "./settings.service.js";

const gmailSchema = z.object({
  email: z.string().trim().email("Enter the warehouse mailbox."),
});

const warehanceSchema = z.object({
  url: z.string().trim().url("Enter the connector address, including https://."),
  key: z.string().trim().optional().default(""),
});

const slackSchema = z.object({
  token: z.string().trim().optional().default(""),
  channel: z.string().trim().min(1, "Enter the Slack channel, such as #client-mail.").max(80),
});

const kindSchema = z.enum(["gmail", "warehance", "slack"]);

function kindOf(value: string) {
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Unknown connector.");
  return parsed.data;
}

function ownerOnly(ctx: RequestContext) {
  if (ctx.principal.role !== "owner") throw new ForbiddenError("Only the owner can change connectors.");
}

@Controller()
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get("settings/connectors")
  list(@CurrentUser() ctx: RequestContext) {
    ownerOnly(ctx);
    return this.settings.list();
  }

  @Get("mail/status")
  status(@CurrentUser() ctx: RequestContext) {
    if (ctx.principal.role !== "owner" && ctx.principal.role !== "warehouse_manager") {
      throw new ForbiddenError("Mail is for the warehouse manager.");
    }
    return this.settings.status();
  }

  @Post("settings/connectors/gmail")
  saveGmail(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(gmailSchema)) body: z.infer<typeof gmailSchema>) {
    ownerOnly(ctx);
    return this.settings.saveGmail(body.email);
  }

  @Post("settings/connectors/warehance")
  saveWarehance(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(warehanceSchema)) body: z.infer<typeof warehanceSchema>,
  ) {
    ownerOnly(ctx);
    return this.settings.saveWarehance(body.url, body.key);
  }

  @Post("settings/connectors/slack")
  saveSlack(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(slackSchema)) body: z.infer<typeof slackSchema>) {
    ownerOnly(ctx);
    return this.settings.saveSlack(body.token, body.channel);
  }

  @Post("settings/connectors/:kind/test")
  test(@CurrentUser() ctx: RequestContext, @Param("kind") kind: string) {
    ownerOnly(ctx);
    return this.settings.test(kindOf(kind));
  }

  @Delete("settings/connectors/:kind")
  remove(@CurrentUser() ctx: RequestContext, @Param("kind") kind: string) {
    ownerOnly(ctx);
    return this.settings.disconnect(kindOf(kind));
  }
}
