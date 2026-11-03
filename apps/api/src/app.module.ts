import "./load-env.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard, OptionalAuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { BillingController } from "./billing/billing.controller.js";
import { BillingService } from "./billing/billing.service.js";
import { ClientsController } from "./clients/clients.controller.js";
import { DbService } from "./db.service.js";
import { JobsController } from "./jobs/jobs.controller.js";
import { JobsService } from "./jobs/jobs.service.js";
import { HealthController } from "./health.controller.js";
import { InternalController } from "./internal/internal.controller.js";
import { SchedulerService } from "./tracking/scheduler.service.js";
import { TrackingController } from "./tracking/tracking.controller.js";
import { TrackingService } from "./tracking/tracking.service.js";
import { BroadcastController } from "./mail/broadcast.controller.js";
import { BroadcastService } from "./mail/broadcast.service.js";
import { AutomationController } from "./mail/automation.controller.js";
import { AutomationService } from "./mail/automation.service.js";
import { GmailService } from "./mail/gmail.service.js";
import { MailController } from "./mail/mail.controller.js";
import { SettingsController } from "./settings/settings.controller.js";
import { SettingsService } from "./settings/settings.service.js";
import { WorkController } from "./work/work.controller.js";
import { WorkService } from "./work/work.service.js";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "dev-only-change-me",
      signOptions: { expiresIn: "12h" },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    ClientsController,
    JobsController,
    BillingController,
    TrackingController,
    WorkController,
    SettingsController,
    MailController,
    AutomationController,
    BroadcastController,
    InternalController,
  ],
  providers: [
    DbService,
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    TrackingService,
    SchedulerService,
    JobsService,
    BillingService,
    WorkService,
    SettingsService,
    GmailService,
    AutomationService,
    BroadcastService,
  ],
})
export class AppModule {}
