import { Controller, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { TrackingService } from "../tracking/tracking.service.js";

@Controller("internal")
export class InternalController {
  constructor(@Inject(TrackingService) private readonly tracking: TrackingService) {}

  @Post("tick")
  tick(@Headers("x-job-token") token?: string) {
    if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
      throw new UnauthorizedException("Worker token was rejected.");
    }
    return this.tracking.sweep();
  }
}
