import { config } from "dotenv";
import { resolve } from "node:path";
import { ensureSchema } from "./schema-sql.js";

config({ path: resolve(process.cwd(), "../../../.env") });
config({ path: resolve(process.cwd(), ".env") });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

await ensureSchema(url);
console.log("Tracking schema is ready.");
