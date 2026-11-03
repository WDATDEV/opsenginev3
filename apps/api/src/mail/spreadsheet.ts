type Row = Record<string, string>;

const MAX_ROWS = 5000;

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: string | number | boolean | null) {
  return value === null ? "" : String(value);
}

// Turns one lookup record into table rows. Nested objects become "a.b" columns. The first list of
// objects (for example the items on an order) gets one row per entry. Any later list is joined into one cell.
function flatten(value: Record<string, unknown>, prefix = ""): Row[] {
  let rows: Row[] = [{}];
  let exploded = false;

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isScalar(child)) {
      for (const row of rows) row[path] = text(child);
    } else if (isObject(child)) {
      const inner = flatten(child, path);
      rows = rows.flatMap((row) => inner.map((extra) => ({ ...row, ...extra })));
    } else if (Array.isArray(child)) {
      if (child.length === 0) continue;
      if (child.every(isScalar)) {
        const joined = child.map((item) => text(item as string | number | boolean | null)).join("; ");
        for (const row of rows) row[path] = joined;
      } else if (!exploded) {
        exploded = true;
        const inner = child.flatMap((item) => (isObject(item) ? flatten(item, path) : [{ [path]: String(item) }]));
        if (inner.length > 0) rows = rows.flatMap((row) => inner.map((extra) => ({ ...row, ...extra })));
      } else {
        const columns = new Map<string, string[]>();
        for (const item of child) {
          if (!isObject(item)) continue;
          for (const row of flatten(item, path)) {
            for (const [column, cell] of Object.entries(row)) columns.set(column, [...(columns.get(column) ?? []), cell]);
          }
        }
        for (const row of rows) for (const [column, cells] of columns) row[column] = cells.join("; ");
      }
    }
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
  }
  return rows;
}

// A cell that starts with = + - or @ can run as a formula in Excel, so it gets a leading apostrophe.
function safeCell(cell: string) {
  const risky = /^[=+\-@]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell);
  const value = risky ? `'${cell}` : cell;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(records: Record<string, unknown>[], wanted?: string[]) {
  const rows = records.flatMap((record) => flatten(record)).slice(0, MAX_ROWS);
  const seen: string[] = [];
  for (const row of rows) for (const column of Object.keys(row)) if (!seen.includes(column)) seen.push(column);
  const columns = wanted && wanted.length > 0 ? wanted.filter((column) => seen.includes(column)) : seen;
  const lines = [columns.map(safeCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => safeCell(row[column] ?? "")).join(","));
  return { csv: lines.join("\r\n"), rows: rows.length, columns };
}
