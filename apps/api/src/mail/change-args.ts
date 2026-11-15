export const CHANGE_KINDS = [
  "adjust_inventory",
  "move_inventory",
  "update_order",
  "cancel_order",
  "update_order_item",
  "cancel_order_item",
  "update_product",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

const NOTE = 200;

type Field =
  | { type: "string"; max?: number }
  | { type: "int"; min?: number; max?: number; nonzero?: boolean }
  | { type: "number" }
  | { type: "bool" }
  | { type: "int[]" }
  | { type: "string[]" };

const FIELDS: Record<ChangeKind, Record<string, Field>> = {
  adjust_inventory: {
    sku: { type: "string" },
    location_name: { type: "string" },
    warehouse: { type: "string" },
    quantity: { type: "int", nonzero: true },
    reason: { type: "string", max: NOTE },
    note: { type: "string", max: NOTE },
    client_id: { type: "int", min: 1 },
  },
  move_inventory: {
    sku: { type: "string" },
    warehouse: { type: "string" },
    from_location_name: { type: "string" },
    to_location_name: { type: "string" },
    quantity: { type: "int", min: 1 },
    reason: { type: "string", max: NOTE },
    note: { type: "string", max: NOTE },
    client_id: { type: "int", min: 1 },
  },
  update_order: {
    order_id: { type: "int", min: 1 },
    address_hold: { type: "bool" },
    payment_hold: { type: "bool" },
    warehouse_hold: { type: "bool" },
    allocation_hold: { type: "bool" },
    fraud_hold: { type: "bool" },
    custom_hold_ids: { type: "int[]" },
    hold_until_date: { type: "string" },
    required_ship_date: { type: "string" },
    packing_note: { type: "string", max: NOTE },
    gift_note: { type: "string", max: NOTE },
    internal_note: { type: "string", max: NOTE },
    delivery_instructions: { type: "string", max: NOTE },
    tags: { type: "string[]" },
  },
  cancel_order: {
    order_id: { type: "int", min: 1 },
  },
  update_order_item: {
    order_item_id: { type: "int", min: 1 },
    quantity: { type: "int", min: 0 },
  },
  cancel_order_item: {
    order_item_id: { type: "int", min: 1 },
  },
  update_product: {
    product_id: { type: "int", min: 1 },
    name: { type: "string", max: NOTE },
    barcode: { type: "string", max: NOTE },
    product_note: { type: "string", max: NOTE },
    pack_note: { type: "string", max: NOTE },
    return_note: { type: "string", max: NOTE },
    weight: { type: "number" },
    length: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    reserve_amount: { type: "int" },
    replenishment_level: { type: "int" },
    archived: { type: "bool" },
    tags: { type: "string[]" },
    add_tags: { type: "string[]" },
    remove_tags: { type: "string[]" },
  },
};

const REQUIRED: Record<ChangeKind, string[]> = {
  adjust_inventory: ["sku", "location_name", "warehouse", "quantity"],
  move_inventory: ["sku", "warehouse", "from_location_name", "to_location_name", "quantity"],
  update_order: ["order_id"],
  cancel_order: ["order_id"],
  update_order_item: ["order_item_id", "quantity"],
  cancel_order_item: ["order_item_id"],
  update_product: ["product_id"],
};

const UPDATE_OPTIONAL: Partial<Record<ChangeKind, string[]>> = {
  update_order: Object.keys(FIELDS.update_order).filter((key) => key !== "order_id"),
  update_product: Object.keys(FIELDS.update_product).filter((key) => key !== "product_id"),
};

export function parseChangeArgs(kind: string, args: unknown): { ok: true; kind: ChangeKind; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!(CHANGE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "That change is not allowed." };
  const tool = kind as ChangeKind;
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "That change is missing its arguments." };
  const input = args as Record<string, unknown>;
  const allowed = FIELDS[tool];
  for (const key of Object.keys(input)) {
    if (!(key in allowed)) return { ok: false, error: `'${key}' is not allowed on ${tool}.` };
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(allowed)) {
    if (!(key in input) || input[key] === undefined) continue;
    const parsed = readField(input[key], spec);
    if (parsed.error) return { ok: false, error: `'${key}' ${parsed.error}` };
    out[key] = parsed.value;
  }
  for (const key of REQUIRED[tool]) {
    if (!(key in out)) return { ok: false, error: `'${key}' is required.` };
  }
  const extras = UPDATE_OPTIONAL[tool];
  if (extras && !extras.some((key) => key in out)) return { ok: false, error: "Choose at least one field to update." };
  if (tool === "update_product" && "tags" in out && ("add_tags" in out || "remove_tags" in out)) {
    return { ok: false, error: "Do not send tags together with add_tags or remove_tags." };
  }
  return { ok: true, kind: tool, args: out };
}

function readField(value: unknown, spec: Field): { value: unknown; error?: string } {
  if (spec.type === "string") {
    if (typeof value !== "string") return { value, error: "must be a string." };
    if (spec.max !== undefined && value.length > spec.max) return { value, error: `must be at most ${spec.max} characters.` };
    return { value };
  }
  if (spec.type === "bool") {
    if (typeof value !== "boolean") return { value, error: "must be true or false." };
    return { value };
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { value, error: "must be a number." };
    return { value };
  }
  if (spec.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) return { value, error: "must be a whole number." };
    if (spec.nonzero && value === 0) return { value, error: "must not be 0." };
    if (spec.min !== undefined && value < spec.min) return { value, error: `must be at least ${spec.min}.` };
    if (spec.max !== undefined && value > spec.max) return { value, error: `must be at most ${spec.max}.` };
    return { value };
  }
  if (spec.type === "int[]") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
      return { value, error: "must be a list of whole numbers." };
    }
    return { value };
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return { value, error: "must be a list of strings." };
  return { value };
}

export function isChangeKind(name: string): name is ChangeKind {
  return (CHANGE_KINDS as readonly string[]).includes(name);
}
