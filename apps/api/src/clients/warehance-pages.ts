export const LIST_PAGE_SIZE = 100;
export const LIST_PAGE_CAP = 200;

export function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function recordsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const body = asObj(data);
  const nested = asObj(body.data);
  for (const bag of [body.records, body.clients, body.users, nested.records, nested.clients, nested.users]) {
    if (Array.isArray(bag)) return bag;
  }
  return [];
}

export function cursorOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function nextListPage(
  data: unknown,
  got: number,
  limit: number,
  offset: number,
): { cursor?: string; offset?: number } | null {
  const body = asObj(data);
  const nested = asObj(body.data);
  const pagination = asObj(body.pagination ?? nested.pagination);
  const cursor =
    cursorOf(body.next_cursor) ??
    cursorOf(nested.next_cursor) ??
    cursorOf(pagination.next_cursor) ??
    cursorOf(body.cursor) ??
    cursorOf(pagination.cursor);
  if (cursor) return { cursor };
  const more = body.has_next_page === true || nested.has_next_page === true || pagination.has_next_page === true;
  if (more || got >= limit) return { offset: offset + Math.max(got, 1) };
  return null;
}

export function listPageArgs(limit: number, cursor?: string, offset?: number): Record<string, unknown> {
  const args: Record<string, unknown> = { limit };
  if (cursor) {
    const asNumber = Number(cursor);
    args.cursor = Number.isInteger(asNumber) && String(asNumber) === cursor ? asNumber : cursor;
    return args;
  }
  if (offset) args.offset = offset;
  return args;
}
