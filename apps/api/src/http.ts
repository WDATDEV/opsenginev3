import {
  type ArgumentMetadata,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import { ForbiddenError } from "@opsengine/kernel";
import { TrackingError } from "@opsengine/tracking";
import type { Response } from "express";
import type { ZodType } from "zod";

@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown, _meta: ArgumentMetadata) {
    const parsed = this.schema.safeParse(value ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message;
      throw new BadRequestException(issue && issue !== "Required" ? issue : "Check the fields and try again.");
    }
    return parsed.data;
  }
}

@Catch(ForbiddenError)
export class ForbiddenErrorFilter implements ExceptionFilter {
  catch(exception: ForbiddenError, host: import("@nestjs/common").ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(403).json({ statusCode: 403, message: exception.message });
  }
}

@Catch(TrackingError)
export class TrackingErrorFilter implements ExceptionFilter {
  catch(exception: TrackingError, host: import("@nestjs/common").ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(409).json({ statusCode: 409, message: exception.message });
  }
}
