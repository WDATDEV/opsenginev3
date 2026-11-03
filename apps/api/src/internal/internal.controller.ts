import { Controller, Headers, Inject, Logger, Post, UnauthorizedException } from "@nestjs/common";
import { BroadcastService } from "../mail/broadcast.service.js";
import { GmailService } from "../mail/gmail.service.js";
import { TrackingService } from "../tracking/tracking.service.js";

@Controller("internal")
export class InternalController {
  private readonly log = new Logger("Tick");

  constructor(
    @Inject(TrackingService) private readonly tracking: TrackingService,
    @Inject(GmailService) private readonly gmail: GmailService,
    @Inject(BroadcastService) private readonly bulk: BroadcastService,
  ) {}

  @Post("tick")
  async tick(@Headers("x-job-token") token?: string) {
    if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
      throw new UnauthorizedException("Worker token was rejected.");
    }
    const swept = await this.tracking.sweep();
    // Mail must never stop the floor sweep, so a Gmail failure is only logged.
    await this.gmail.sync().catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Mail check failed."));
    // Scheduled bulk email goes out on the same beat, and also must not stop the sweep.
    await this.bulk.process().catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Bulk email failed."));
    return swept;
  }
}
