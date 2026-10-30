import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { TrackingService } from "./tracking.service.js";

const EVERY_MS = Number(process.env.SCHEDULE_CHECK_MS ?? 20_000);

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(TrackingService) private readonly tracking: TrackingService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tracking
        .startScheduled()
        .then((result) => {
          if (result.started > 0) this.log.log(`Started ${result.started} scheduled job(s).`);
        })
        .catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Scheduled start check failed."));
    }, EVERY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
