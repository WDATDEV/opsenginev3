import { connectors } from "@opsengine/db";
import { APPROVAL_TTL_SECONDS, readApprovalSecret, signApproval } from "./approval.js";
import { argsForLocationLookup, liveBinFromRecords, pickLocationLookupTool, type StockRow } from "./stock-change.js";
import { WarehanceClient } from "./warehance-client.js";

export const SETUP_ERROR = "Stock changes are not set up.";
export const UNCLEAR_APPLY = "may or may not have been applied, check the bin";
export const WRITE_KIND = "warehance_write";

export type ConnectorCall = { role: "staff" | "write"; name: string; args: Record<string, unknown> };

export function takeProposed(box: { status: string }) {
  if (box.status !== "proposed") return false;
  box.status = "applying";
  return true;
}

export function confirmGate(input: {
  role: string;
  actorId: string;
  threadOwnerId: string;
  status: string | null | undefined;
  expiresAt: string | null | undefined;
  now: number;
}): string | null {
  if (input.role !== "owner") return "Only the owner can confirm a stock change.";
  if (input.actorId !== input.threadOwnerId) return "That chat belongs to someone else.";
  if (input.status !== "proposed") return "There is no stock change waiting on that message.";
  if (!input.expiresAt || Date.parse(input.expiresAt) < input.now) return "That card expired. Ask again.";
  return null;
}

export function writeKeyIsReady(rows: { kind: string; secret: string | null; extra?: string | null }[]) {
  const write = rows.find((row) => row.kind === WRITE_KIND);
  return Boolean(write?.secret && (write.extra || rows.find((row) => row.kind === "warehance")?.extra));
}

export function redactSensitive(text: string, extra: string[] = []) {
  let out = text.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[redacted]");
  for (const value of extra) {
    if (value && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out;
}

export function parseAdjustResult(data: unknown): { appliedQuantity: number | null; capped: boolean | null } {
  // The connector answers {record: {applied_quantity, capped, ...}}; a flat object is accepted too.
  const top = asObj(data);
  const row = top.record && typeof top.record === "object" ? asObj(top.record) : top;
  const applied = numberOf(row.applied_quantity ?? row.appliedQuantity);
  const capped = row.capped;
  return { appliedQuantity: applied, capped: typeof capped === "boolean" ? capped : null };
}

export type ApplyDeps = {
  secret: string | null;
  writeReady: boolean;
  nowSeconds: () => number;
  uuid: () => string;
  lookup: (row: StockRow) => Promise<unknown>;
  adjust: (args: Record<string, unknown>) => Promise<{ data: unknown; failed: boolean }>;
};

export async function applyConfirmedRows(
  rows: StockRow[],
  meta: { clientId: number | null; approvedBy: string; reason: string; note: string },
  deps: ApplyDeps,
): Promise<{ rows: StockRow[]; calls: ConnectorCall[] }> {
  const calls: ConnectorCall[] = [];
  if (!deps.secret || !deps.writeReady) {
    throw new Error(SETUP_ERROR);
  }
  const secret = deps.secret;
  const out: StockRow[] = [];
  for (const row of rows) {
    let live: unknown;
    try {
      live = await deps.lookup(row);
      calls.push({ role: "staff", name: "search_inventory_locations", args: { sku: row.sku, location_name: row.location, warehouse: row.warehouse } });
    } catch (err) {
      out.push({
        ...row,
        ok: false,
        error: redactSensitive(err instanceof Error ? err.message : "Could not re-read that bin."),
        nonce: null,
        appliedQuantity: null,
        capped: null,
      });
      continue;
    }
    const bin = liveBinFromRecords(live, row);
    if (!bin) {
      out.push({ ...row, ok: false, error: `${row.sku} was not found at ${row.location} in ${row.warehouse}.`, nonce: null, appliedQuantity: null, capped: null });
      continue;
    }
    if (bin.onHand === 0) {
      out.push({ ...row, qtyBefore: 0, ok: true, error: null, nonce: null, appliedQuantity: 0, capped: false });
      continue;
    }
    if (bin.available === 0 && bin.onHand > 0) {
      out.push({
        ...row,
        qtyBefore: bin.onHand,
        ok: false,
        error: `${row.sku} @ ${row.location} has ${bin.onHand} on hand but none available. Nothing was changed.`,
        nonce: null,
        appliedQuantity: null,
        capped: null,
      });
      continue;
    }
    const quantity = -Math.trunc(bin.available);
    if (!Number.isInteger(quantity) || quantity === 0) {
      out.push({ ...row, qtyBefore: bin.onHand, ok: false, error: "Live available quantity could not be turned into a signed change.", nonce: null, appliedQuantity: null, capped: null });
      continue;
    }
    const approved_at = deps.nowSeconds();
    const nonce = deps.uuid();
    const { approval, payload } = signApproval(
      {
        sku: row.sku,
        location_name: row.location,
        warehouse: row.warehouse,
        quantity,
        client_id: meta.clientId,
        approved_by: meta.approvedBy,
        approved_at,
        exp: approved_at + APPROVAL_TTL_SECONDS,
        nonce,
      },
      secret,
    );
    const args: Record<string, unknown> = {
      sku: payload.sku,
      location_name: payload.location_name,
      warehouse: payload.warehouse,
      quantity: payload.quantity,
      reason: meta.reason,
      note: meta.note,
      approval,
    };
    if (payload.client_id != null) args.client_id = payload.client_id;
    try {
      const { data, failed } = await deps.adjust(args);
      calls.push({ role: "write", name: "adjust_inventory", args });
      if (failed) {
        out.push({
          ...row,
          qtyBefore: bin.onHand,
          ok: false,
          error: redactSensitive(typeof data === "string" ? data : UNCLEAR_APPLY, [approval, secret]),
          nonce,
          appliedQuantity: null,
          capped: null,
        });
        continue;
      }
      const parsed = parseAdjustResult(data);
      out.push({
        ...row,
        qtyBefore: bin.onHand,
        ok: true,
        error: null,
        nonce,
        appliedQuantity: parsed.appliedQuantity ?? quantity,
        capped: parsed.capped,
      });
    } catch (err) {
      calls.push({ role: "write", name: "adjust_inventory", args });
      out.push({
        ...row,
        qtyBefore: bin.onHand,
        ok: false,
        error: redactSensitive(err instanceof Error && /timeout|timed out|abort/i.test(err.message) ? UNCLEAR_APPLY : UNCLEAR_APPLY, [approval, secret]),
        nonce,
        appliedQuantity: null,
        capped: null,
      });
    }
  }
  return { rows: out, calls };
}

export async function staffAndWrite(database: { select: () => { from: (table: typeof connectors) => unknown } }) {
  const rows = (await database.select().from(connectors)) as { kind: string; secret: string | null; extra: string | null }[];
  const staff = rows.find((row) => row.kind === "warehance");
  const write = rows.find((row) => row.kind === WRITE_KIND);
  const secret = readApprovalSecret();
  const url = write?.extra || staff?.extra || "";
  if (!secret || !write?.secret || !url || !staff?.secret || !staff.extra) {
    return { ok: false as const, secret: null, staff: null, write: null };
  }
  return {
    ok: true as const,
    secret,
    staff: new WarehanceClient(staff.extra, staff.secret),
    write: new WarehanceClient(url, write.secret),
  };
}

export async function lookupLiveBin(staff: WarehanceClient, row: StockRow, clientId: number | null) {
  const tools = await staff.listTools();
  const tool = pickLocationLookupTool(tools);
  if (!tool) throw new Error("The staff key cannot search inventory locations.");
  const args = argsForLocationLookup(tool, row.sku, clientId);
  args.location_name = row.location;
  args.warehouse = row.warehouse;
  const { data, failed } = await staff.call(tool.name, args);
  if (failed) throw new Error(typeof data === "string" ? data : "Could not re-read that bin.");
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    if (Array.isArray(row.records)) return row.records;
    return [row];
  }
  return [];
}

function asObj(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function numberOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
