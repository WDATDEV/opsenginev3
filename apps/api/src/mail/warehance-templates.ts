export type TemplateId = "inventory_locations";

export type Check = { ok: boolean; text: string };

const ALIASES: Record<string, string[]> = {
  sku: ["sku", "product_sku", "product.sku", "item_sku"],
  action: ["action", "action_type"],
  quantity: ["quantity", "qty", "on_hand", "onhand", "qty_on_hand", "available", "stock", "qoh"],
  location: ["location", "location_name", "bin", "bin_name", "location.bin"],
  adjustment_reason: ["adjustment_reason", "reason", "adjustmentreason"],
  warehouse: ["warehouse", "warehouse_name", "wh"],
  lot_code: ["lot_code", "lot", "lot_number", "batch"],
  lot_expiration_date: ["lot_expiration_date", "expiration_date", "expiry", "best_by"],
};

function key(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findColumn(columns: string[], field: string) {
  const aliases = ALIASES[field] ?? [field];
  const names = columns.map(key);
  for (const alias of aliases) {
    const index = names.findIndex((name) => name === alias || name.endsWith(`_${alias}`) || name.startsWith(`${alias}_`));
    if (index >= 0) return index;
  }
  return -1;
}

function wholeNumber(value: string) {
  return /^-?\d+$/.test(value.trim());
}

export function inventoryLocationColumns() {
  return ["sku", "action", "quantity", "location", "adjustment_reason", "warehouse", "lot_code", "lot_expiration_date"] as const;
}

// Turns a Chat table into Warehance's inventory-locations import CSV shape.
export function toInventoryLocations(
  columns: string[],
  cells: string[][],
  fill: { action: "set" | "adjust"; warehouse: string; reason: string; zeroQuantity: boolean },
) {
  const index = {
    sku: findColumn(columns, "sku"),
    action: findColumn(columns, "action"),
    quantity: findColumn(columns, "quantity"),
    location: findColumn(columns, "location"),
    reason: findColumn(columns, "adjustment_reason"),
    warehouse: findColumn(columns, "warehouse"),
    lot: findColumn(columns, "lot_code"),
    expiry: findColumn(columns, "lot_expiration_date"),
  };

  const outColumns = [...inventoryLocationColumns()];
  const outCells = cells.map((row) => {
    const qty = index.quantity >= 0 ? String(row[index.quantity] ?? "").trim() : "";
    return [
      index.sku >= 0 ? String(row[index.sku] ?? "").trim() : "",
      (index.action >= 0 ? String(row[index.action] ?? "").trim() : "") || fill.action,
      fill.zeroQuantity ? "0" : qty,
      index.location >= 0 ? String(row[index.location] ?? "").trim() : "",
      (index.reason >= 0 ? String(row[index.reason] ?? "").trim() : "") || fill.reason,
      (index.warehouse >= 0 ? String(row[index.warehouse] ?? "").trim() : "") || fill.warehouse,
      index.lot >= 0 ? String(row[index.lot] ?? "").trim() : "",
      index.expiry >= 0 ? String(row[index.expiry] ?? "").trim() : "",
    ];
  });

  return { columns: outColumns, cells: outCells, mapped: index };
}

export function checkInventoryLocations(columns: string[], cells: string[][]): Check[] {
  const sku = columns.indexOf("sku");
  const action = columns.indexOf("action");
  const quantity = columns.indexOf("quantity");
  const location = columns.indexOf("location");
  const reason = columns.indexOf("adjustment_reason");
  const warehouse = columns.indexOf("warehouse");

  const missing = ["sku", "action", "quantity", "location", "adjustment_reason", "warehouse"].filter((name) => !columns.includes(name));
  const checks: Check[] = [
    { ok: missing.length === 0, text: missing.length === 0 ? "Required columns are present (sku, action, quantity, location, adjustment_reason, warehouse)." : `Missing columns: ${missing.join(", ")}.` },
  ];
  if (missing.length > 0) return checks;

  let empty = 0;
  let badAction = 0;
  let badQty = 0;
  let negativeSet = 0;
  const seen = new Map<string, number>();
  let dupes = 0;

  for (const row of cells) {
    const s = (row[sku] ?? "").trim();
    const loc = (row[location] ?? "").trim();
    const act = (row[action] ?? "").trim().toLowerCase();
    const qty = (row[quantity] ?? "").trim();
    const why = (row[reason] ?? "").trim();
    const wh = (row[warehouse] ?? "").trim();
    if (!s || !loc || !why || !wh) empty += 1;
    if (act !== "set" && act !== "adjust") badAction += 1;
    if (!wholeNumber(qty)) badQty += 1;
    else if (act === "set" && Number(qty) < 0) negativeSet += 1;
    const key = `${s.toLowerCase()}|${loc.toLowerCase()}`;
    if (s && loc) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n === 2) dupes += 1;
    }
  }

  checks.push({ ok: empty === 0, text: empty === 0 ? "Every row has SKU, location, warehouse, and a reason." : `${empty} row(s) are missing SKU, location, warehouse, or reason.` });
  checks.push({ ok: badAction === 0, text: badAction === 0 ? "Every action is set or adjust." : `${badAction} row(s) have an action that is not set or adjust.` });
  checks.push({ ok: badQty === 0, text: badQty === 0 ? "Every quantity is a whole number." : `${badQty} row(s) have a quantity that is not a whole number.` });
  checks.push({ ok: negativeSet === 0, text: negativeSet === 0 ? "Set quantities are 0 or more." : `${negativeSet} row(s) try to set a negative quantity.` });
  const allZero = cells.every((row) => (row[quantity] ?? "").trim() === "0");
  const usingAdjust = cells.some((row) => (row[action] ?? "").trim().toLowerCase() === "adjust");
  checks.push({ ok: dupes === 0, text: dupes === 0 ? "Each SKU + location appears only once." : `${dupes} SKU + location pair(s) are repeated. Warehance will reject those.` });
  checks.push({
    ok: !(allZero && usingAdjust),
    text:
      allZero && usingAdjust
        ? "Every quantity is 0 with action adjust. That does not clear on-hand. Use set if you want Warehance to set stock to 0."
        : "If you mean to clear on-hand, action is set and quantity is 0. adjust would add or subtract instead.",
  });
  checks.push({
    ok: true,
    text: "Before you upload in Warehance: warehouse and location names must already exist, pick the right client (3PL), do not include bundle parent SKUs, and add lot_code for lot-tracked products.",
  });
  checks.push({
    ok: true,
    text: "Ops Engine does not send this to Warehance. Download the file, then Inventory → Import. Check the preview there before you confirm.",
  });
  return checks;
}
