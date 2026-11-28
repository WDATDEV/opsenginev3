/**
 * Which carrier a tracking number belongs to, from its format alone. Only confident matches are named;
 * anything else is null and is never used to refuse a scan.
 */
export type Carrier = "usps" | "ups" | "fedex" | "dhl";

const RULES: [Carrier, RegExp][] = [
  ["ups", /^1Z[0-9A-Z]{16}$/],
  // USPS: 22-digit IMpb numbers start 92–95. Scanned labels may carry "420" + ZIP (5 or 9 digits) in front.
  ["usps", /^(420\d{5}(\d{4})?)?9[2-5]\d{20}$/],
  // International mail: two letters, nine digits, US.
  ["usps", /^[A-Z]{2}\d{9}US$/],
  // FedEx Ground/Home 22-digit numbers start 96.
  ["fedex", /^96\d{20}$/],
  ["fedex", /^(\d{12}|\d{15})$/],
  ["dhl", /^JD\d{18}$/],
  ["dhl", /^\d{10}$/],
];

export function normalizeTracking(value: string) {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

export function carrierFromTracking(value: string): Carrier | null {
  const code = normalizeTracking(value);
  return RULES.find(([, pattern]) => pattern.test(code))?.[0] ?? null;
}

const NAMES: Record<string, string> = { usps: "USPS", ups: "UPS", fedex: "FedEx", dhl: "DHL", other: "other" };

export function carrierName(code: string) {
  return NAMES[code] ?? code.toUpperCase();
}

/** Whether a package may go into a bin: unknown numbers and "other" bins are never refused. */
export function carrierMismatch(trackingNumber: string, binCarrier: string): { expected: Carrier } | null {
  if (binCarrier === "other") return null;
  const expected = carrierFromTracking(trackingNumber);
  if (!expected || expected === binCarrier) return null;
  return { expected };
}
