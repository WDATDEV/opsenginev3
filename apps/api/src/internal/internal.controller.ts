import { Controller, Headers, Inject, Logger, Post, UnauthorizedException } from "@nestjs/common";
import { GmailService } from "../mail/gmail.service.js";
import { TrackingService } from "../tracking/tracking.service.js";

@Controller("internal")
export class InternalController {
  private readonly log = new Logger("Tick");

  constructor(
    @Inject(TrackingService) private readonly tracking: TrackingService,
    @Inject(GmailService) private readonly gmail: GmailService,
  ) {}

  @Post("tick")
  async tick(@Headers("x-job-token") token?: string) {
    if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
      throw new UnauthorizedException("Worker token was rejected.");
    }
    const swept = await this.tracking.sweep();
    // Mail must never stop the floor sweep, so a Gmail failure is only logged.
    await this.gmail.sync().catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Mail check failed."));
    return swept;
  }
}
