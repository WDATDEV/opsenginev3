import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { clientRecords } from "@opsengine/db";
import { authorize, type RequestContext } from "@opsengine/kernel";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { DbService } from "../db.service.js";

@Controller("clients")
export class ClientsController {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(@CurrentUser() ctx: RequestContext) {
    authorize(ctx, "client.read");
    return this.db.db.select().from(clientRecords);
  }
}
