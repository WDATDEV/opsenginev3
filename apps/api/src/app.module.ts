import "./load-env.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard, OptionalAuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { ClientsController } from "./clients/clients.controller.js";
import { DbService } from "./db.service.js";
import { HealthController } from "./health.controller.js";
import { InternalController } from "./internal/internal.controller.js";
import { TrackingController } from "./tracking/tracking.controller.js";
import { TrackingService } from "./tracking/tracking.service.js";
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
    TrackingController,
    WorkController,
    InternalController,
  ],
  providers: [
    DbService,
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    TrackingService,
    WorkService,
  ],
})
export class AppModule {}
