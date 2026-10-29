import { Injectable } from "@nestjs/common";
import { createDb, type Database } from "@opsengine/db";

@Injectable()
export class DbService {
  readonly db: Database = createDb();
}
