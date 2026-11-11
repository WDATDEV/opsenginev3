import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { authorizeSection, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { ZodPipe } from "../http.js";
import { SettingsService } from "./settings.service.js";

const warehanceSchema = z.object({
  url: z.string().trim().url("Enter the connector address, including https://."),
  key: z.string().trim().optional().default(""),
});

const slackSchema = z.object({
  token: z.string().trim().optional().default(""),
  channel: z.string().trim().max(200).optional().default(""),
});

const anthropicSchema = z.object({
  key: z.string().trim().optional().default(""),
});

const kindSchema = z.enum(["gmail", "warehance", "slack", "anthropic"]);

function kindOf(value: string) {
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Unknown connector.");
  return parsed.data;
}

function connectors(ctx: RequestContext) {
  authorizeSection(ctx, "settings");
}

@Controller()
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get("settings/connectors")
  list(@CurrentUser() ctx: RequestContext) {
    connectors(ctx);
    return this.settings.list();
  }

  @Get("mail/status")
  status(@CurrentUser() ctx: RequestContext) {
    authorizeSection(ctx, "mail");
    return this.settings.status();
  }

  @Post("settings/connectors/warehance")
  saveWarehance(
    @CurrentUser() ctx: RequestContext,
    @Body(new ZodPipe(warehanceSchema)) body: z.infer<typeof warehanceSchema>,
  ) {
    connectors(ctx);
    return this.settings.saveWarehance(body.url, body.key);
  }

  @Post("settings/connectors/slack")
  saveSlack(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(slackSchema)) body: z.infer<typeof slackSchema>) {
    connectors(ctx);
    return this.settings.saveSlack(body.token, body.channel);
  }

  @Post("settings/connectors/anthropic")
  saveAnthropic(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(anthropicSchema)) body: z.infer<typeof anthropicSchema>) {
    connectors(ctx);
    return this.settings.saveAnthropic(body.key);
  }

  @Post("settings/connectors/:kind/test")
  test(@CurrentUser() ctx: RequestContext, @Param("kind") kind: string) {
    connectors(ctx);
    return this.settings.test(kindOf(kind));
  }

  @Delete("settings/connectors/:kind")
  remove(@CurrentUser() ctx: RequestContext, @Param("kind") kind: string) {
    connectors(ctx);
    return this.settings.disconnect(kindOf(kind));
  }
}
