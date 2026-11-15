import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const APPROVAL_VERSION = 1;
export const APPROVAL_TTL_SECONDS = 120;

const PAYLOAD_KEYS = [
  "v",
  "sku",
  "location_name",
  "warehouse",
  "quantity",
  "client_id",
  "approved_by",
  "approved_at",
  "exp",
  "nonce",
] as const;

export type ApprovalPayload = {
  v: typeof APPROVAL_VERSION;
  sku: string;
  location_name: string;
  warehouse: string;
  quantity: number;
  client_id: number | null;
  approved_by: string;
  approved_at: number;
  exp: number;
  nonce: string;
};

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export function readApprovalSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.APPROVAL_SECRET;
  if (!secret) return null;
  if (Buffer.byteLength(secret, "utf8") < 32) return null;
  return secret;
}

export function signApproval(
  input: {
    sku: string;
    location_name: string;
    warehouse: string;
    quantity: number;
    client_id: number | null;
    approved_by: string;
    approved_at: number;
    exp: number;
    nonce?: string;
  },
  secret: string,
): { approval: string; payload: ApprovalPayload; p: string } {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) {
    throw new ApprovalError("Quantity must be a non-zero integer.");
  }
  if (input.exp < input.approved_at || input.exp - input.approved_at > APPROVAL_TTL_SECONDS) {
    throw new ApprovalError("Approval expiry must be at most 120 seconds after approval.");
  }
  const payload: ApprovalPayload = {
    v: APPROVAL_VERSION,
    sku: input.sku,
    location_name: input.location_name,
    warehouse: input.warehouse,
    quantity: input.quantity,
    client_id: input.client_id,
    approved_by: input.approved_by,
    approved_at: input.approved_at,
    exp: input.exp,
    nonce: input.nonce ?? randomUUID(),
  };
  const p = toBase64Url(Buffer.from(encodePayload(payload), "utf8"));
  const sig = toBase64Url(createHmac("sha256", secret).update(p).digest());
  return { approval: `${p}.${sig}`, payload, p };
}

export type ChangeValue = string | number | boolean | ChangeValue[];
export type ChangeArgs = Record<string, ChangeValue>;

export type ChangeApprovalPayload = {
  v: 2;
  tool: string;
  change: ChangeArgs;
  approved_by: string;
  approved_at: number;
  exp: number;
  nonce: string;
};

export function canonicalChange(value: unknown): ChangeArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalError("Approval is not valid.");
  }
  return sortValue(value) as ChangeArgs;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) out[key] = sortValue(row[key]);
    return out;
  }
  return value;
}

export function signChangeApproval(
  input: {
    tool: string;
    change: ChangeArgs;
    approved_by: string;
    approved_at: number;
    exp: number;
    nonce?: string;
  },
  secret: string,
): { approval: string; payload: ChangeApprovalPayload; p: string } {
  if (!input.tool.trim()) throw new ApprovalError("Approval is not valid.");
  if (input.exp < input.approved_at || input.exp - input.approved_at > APPROVAL_TTL_SECONDS) {
    throw new ApprovalError("Approval expiry must be at most 120 seconds after approval.");
  }
  const payload: ChangeApprovalPayload = {
    v: 2,
    tool: input.tool,
    change: canonicalChange(input.change),
    approved_by: input.approved_by,
    approved_at: input.approved_at,
    exp: input.exp,
    nonce: input.nonce ?? randomUUID(),
  };
  const p = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = toBase64Url(createHmac("sha256", secret).update(p).digest());
  return { approval: `${p}.${sig}`, payload, p };
}

export function verifyChangeApproval(approval: string, secret: string): ChangeApprovalPayload {
  const parsed = decodeSigned(approval, secret);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApprovalError("Approval is not valid.");
  const row = parsed as Record<string, unknown>;
  if (row.v !== 2) throw new ApprovalError("Approval is not valid.");
  if (typeof row.tool !== "string" || typeof row.approved_by !== "string" || typeof row.nonce !== "string") {
    throw new ApprovalError("Approval is not valid.");
  }
  const approved_at = row.approved_at;
  const exp = row.exp;
  if (typeof approved_at !== "number" || typeof exp !== "number" || !Number.isInteger(approved_at) || !Number.isInteger(exp)) {
    throw new ApprovalError("Approval is not valid.");
  }
  if (exp < approved_at || exp - approved_at > APPROVAL_TTL_SECONDS) throw new ApprovalError("Approval is not valid.");
  assertChangeValues(row.change);
  return {
    v: 2,
    tool: row.tool,
    change: canonicalChange(row.change),
    approved_by: row.approved_by,
    approved_at,
    exp,
    nonce: row.nonce,
  };
}

function decodeSigned(approval: string, secret: string): unknown {
  const dot = approval.indexOf(".");
  if (dot <= 0 || approval.indexOf(".", dot + 1) !== -1) throw new ApprovalError("Approval is not valid.");
  const p = approval.slice(0, dot);
  const sig = approval.slice(dot + 1);
  const expected = toBase64Url(createHmac("sha256", secret).update(p).digest());
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ApprovalError("Approval is not valid.");
  try {
    return JSON.parse(Buffer.from(fromBase64Url(p)).toString("utf8"));
  } catch {
    throw new ApprovalError("Approval is not valid.");
  }
}

function assertChangeValues(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApprovalError("Approval is not valid.");
  const walk = (item: unknown) => {
    if (typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new ApprovalError("Approval is not valid.");
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
      return;
    }
    throw new ApprovalError("Approval is not valid.");
  };
  for (const item of Object.values(value as Record<string, unknown>)) walk(item);
}

export function verifyApproval(approval: string, secret: string): ApprovalPayload {
  const dot = approval.indexOf(".");
  if (dot <= 0 || approval.indexOf(".", dot + 1) !== -1) {
    throw new ApprovalError("Approval is not valid.");
  }
  const p = approval.slice(0, dot);
  const sig = approval.slice(dot + 1);
  const expected = toBase64Url(createHmac("sha256", secret).update(p).digest());
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApprovalError("Approval is not valid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(fromBase64Url(p)).toString("utf8"));
  } catch {
    throw new ApprovalError("Approval is not valid.");
  }
  return assertPayload(parsed);
}

function encodePayload(payload: ApprovalPayload) {
  const ordered: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) ordered[key] = payload[key];
  return JSON.stringify(ordered);
}

function assertPayload(value: unknown): ApprovalPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalError("Approval is not valid.");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== PAYLOAD_KEYS.length || PAYLOAD_KEYS.some((key, i) => keys[i] !== key && !keys.includes(key))) {
    const same = keys.length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => keys.includes(key));
    if (!same) throw new ApprovalError("Approval is not valid.");
  }
  for (const key of Object.keys(row)) {
    if (!(PAYLOAD_KEYS as readonly string[]).includes(key)) throw new ApprovalError("Approval is not valid.");
  }
  for (const key of PAYLOAD_KEYS) {
    if (!(key in row)) throw new ApprovalError("Approval is not valid.");
  }
  if (row.v !== APPROVAL_VERSION) throw new ApprovalError("Approval is not valid.");
  if (typeof row.sku !== "string" || typeof row.location_name !== "string" || typeof row.warehouse !== "string") {
    throw new ApprovalError("Approval is not valid.");
  }
  if (typeof row.approved_by !== "string" || typeof row.nonce !== "string") throw new ApprovalError("Approval is not valid.");
  const quantity = row.quantity;
  const approved_at = row.approved_at;
  const exp = row.exp;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity === 0) throw new ApprovalError("Approval is not valid.");
  if (row.client_id !== null && (typeof row.client_id !== "number" || !Number.isInteger(row.client_id))) {
    throw new ApprovalError("Approval is not valid.");
  }
  if (typeof approved_at !== "number" || typeof exp !== "number" || !Number.isInteger(approved_at) || !Number.isInteger(exp)) {
    throw new ApprovalError("Approval is not valid.");
  }
  if (exp < approved_at || exp - approved_at > APPROVAL_TTL_SECONDS) {
    throw new ApprovalError("Approval is not valid.");
  }
  return {
    v: APPROVAL_VERSION,
    sku: row.sku,
    location_name: row.location_name,
    warehouse: row.warehouse,
    quantity,
    client_id: row.client_id as number | null,
    approved_by: row.approved_by,
    approved_at,
    exp,
    nonce: row.nonce,
  };
}

export function toBase64Url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}
