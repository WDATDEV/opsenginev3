import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { appSections } from "@opsengine/contracts";
import { authorizeSection, type RequestContext } from "@opsengine/kernel";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.js";
import { RequireSection, SectionGuard } from "../auth/section.guard.js";
import { ZodPipe } from "../http.js";
import { UsersService } from "./users.service.js";

const staffRole = z.enum(["warehouse_manager", "warehouse_employee", "client_services", "hr_finance", "external_customer"]);

const saveSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80),
  email: z.string().trim().email("Enter an email address.").max(200),
  password: z.union([z.string().min(8, "Use at least 8 characters."), z.literal("")]).optional(),
  role: staffRole,
  sections: z.array(z.enum(appSections)).min(1, "Turn on at least one section."),
  clientIds: z.array(z.string().uuid()).max(500).optional().nullable(),
});

@Controller("users")
@UseGuards(AuthGuard, SectionGuard)
@RequireSection("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() ctx: RequestContext) {
    authorizeSection(ctx, "users");
    return this.users.list();
  }

  @Post()
  create(@CurrentUser() ctx: RequestContext, @Body(new ZodPipe(saveSchema)) body: z.infer<typeof saveSchema>) {
    authorizeSection(ctx, "users");
    return this.users.create(ctx.principal, {
      ...body,
      password: body.password || undefined,
    });
  }

  @Patch(":id")
  update(@CurrentUser() ctx: RequestContext, @Param("id") id: string, @Body(new ZodPipe(saveSchema)) body: z.infer<typeof saveSchema>) {
    authorizeSection(ctx, "users");
    return this.users.update(ctx.principal, id, {
      ...body,
      password: body.password || undefined,
    });
  }

  @Delete(":id")
  remove(@CurrentUser() ctx: RequestContext, @Param("id") id: string) {
    authorizeSection(ctx, "users");
    return this.users.remove(ctx.principal, id);
  }
}
