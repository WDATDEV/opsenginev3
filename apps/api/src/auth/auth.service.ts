import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Role } from "@opsengine/contracts";
import { users } from "@opsengine/db";
import type { Principal } from "@opsengine/kernel";
import { DbService } from "../db.service.js";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const [user] = await this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Email or password is incorrect.");
    }

    const principal: Principal = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
      clientIds: Array.isArray(user.clientIds) ? user.clientIds : null,
    };
    const token = await this.jwt.signAsync(principal);
    return { token, principal };
  }
}
