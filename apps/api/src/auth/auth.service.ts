import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { users } from "@opsengine/db";
import { DbService } from "../db.service.js";
import { LoginLimiter } from "./login-limit.js";
import { principalFromUser } from "./principal.js";

@Injectable()
export class AuthService {
  private readonly limiter = new LoginLimiter();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const key = email.trim().toLowerCase();
    const waitMs = this.limiter.retryAfterMs(key);
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60_000);
      throw new HttpException(`Too many failed sign-ins. Try again in ${minutes} min.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const [user] = await this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user || !(await compare(password, user.passwordHash))) {
      this.limiter.fail(key);
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    this.limiter.succeed(key);

    const principal = principalFromUser(user);
    const token = await this.jwt.signAsync(principal);
    return { token, principal };
  }
}
