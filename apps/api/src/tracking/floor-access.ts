import { createHash, randomBytes } from "node:crypto";
import { can, type Principal } from "@opsengine/kernel";

export const FLOOR_DEVICE_COOKIE = "oe_floor_device";
export const FLOOR_DEVICE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
export const FLOOR_DEVICE_REFUSED = "This device is not approved for floor scans. Ask a manager to register it.";

export function newDeviceToken() {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** A floor action needs an approved device, or a signed-in person who may record floor work. */
export function floorAllowed(input: { deviceApproved: boolean; principal?: Principal | null }) {
  if (input.deviceApproved) return true;
  const principal = input.principal;
  return Boolean(principal && (can(principal, "tracking.record") || can(principal, "tracking.manage")));
}

// A kiosk punch has no location check, so a direct clock in or out must go through the QR gate.
// The floor phone's own check-in runs on the server after its location check.
export function directClockAllowed(action: "in" | "out" | "meal_start" | "meal_end", source: "kiosk" | "qr") {
  return source === "qr" || action === "meal_start" || action === "meal_end";
}
