import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { customType } from "drizzle-orm/pg-core";

/**
 * Encryption for connector keys (Gmail refresh token, Warehance staff key, Slack bot token, Anthropic key).
 *
 * These cannot be hashed. A hash is one way, and we have to send the real key to Google, Warehance, Slack
 * and Anthropic. So they are encrypted with AES-256-GCM, and the key that unlocks them lives in the server
 * environment, never in the database. A copy of the database alone shows only scrambled text.
 */

const PREFIX = "enc:v1:";
let warned = false;
let cached: Buffer | null = null;

function masterKey() {
  if (cached) return cached;
  const source = process.env.SECRETS_KEY || process.env.JWT_SECRET || "dev-only-change-me";
  if (!process.env.SECRETS_KEY && !warned) {
    warned = true;
    console.warn("SECRETS_KEY is not set. Stored connector keys are encrypted with JWT_SECRET instead. Set SECRETS_KEY.");
  }
  cached = createHash("sha256").update(source).digest();
  return cached;
}

export function isSealed(value: string) {
  return value.startsWith(PREFIX);
}

/** Encrypt a value. Values that are already encrypted are left alone. */
export function seal(plain: string) {
  if (isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${body.toString("base64")}`;
}

/**
 * Decrypt a value. Older plain text rows are returned as they are, until the boot migration encrypts them.
 * When decryption fails (the key changed), an empty string comes back so the connector reads as "not set".
 */
export function open(stored: string) {
  if (!isSealed(stored)) return stored;
  try {
    const [iv, tag, body] = stored.slice(PREFIX.length).split(":");
    if (!iv || !tag || !body) throw new Error("Malformed value.");
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    console.error("A stored connector key could not be decrypted. SECRETS_KEY or JWT_SECRET changed. Save the connector again.");
    return "";
  }
}

/** A text column that encrypts on write and decrypts on read. */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return seal(value);
  },
  fromDriver(value) {
    return open(value);
  },
});
