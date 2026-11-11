import ExcelJS from "exceljs";
import { MAX_ROWS, toCsv, toTable } from "./spreadsheet.js";

export type FileFormat = "csv" | "xlsx" | "json";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME: Record<FileFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json; charset=utf-8",
};

function fileName(name: string, format: FileFormat) {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").trim().replace(/\.(csv|xlsx|json)$/i, "") || "data";
  return `${cleaned.slice(0, 80)}.${format}`;
}

// Turns lookup records into a file. Rows are copied exactly from the records, never rewritten.
export async function buildFile(input: {
  records: Record<string, unknown>[];
  format: FileFormat;
  name: string;
  columns?: string[];
}) {
  const name = fileName(input.name, input.format);
  let data: Buffer;
  let rows: number;
  let columns: string[];

  if (input.format === "json") {
    data = Buffer.from(JSON.stringify(input.records, null, 2), "utf8");
    rows = input.records.length;
    columns = [...new Set(input.records.flatMap((record) => Object.keys(record)))];
  } else if (input.format === "csv") {
    const built = toCsv(input.records, input.columns);
    // The byte-order mark makes Excel read accented letters correctly.
    data = Buffer.from(`\uFEFF${built.csv}`, "utf8");
    rows = built.rows;
    columns = built.columns;
  } else {
    const table = toTable(input.records, input.columns);
    const book = new ExcelJS.Workbook();
    book.creator = "Ops Engine";
    const sheet = book.addWorksheet("Data");
    sheet.addRow(table.columns);
    // Plain numbers become real numbers so Excel can add them up. Codes like 00123 stay text.
    const numeric = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
    for (const row of table.cells) sheet.addRow(row.map((cell) => (numeric.test(cell) ? Number(cell) : cell)));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    if (table.columns.length > 0) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
    }
    sheet.columns.forEach((column, index) => {
      const longest = Math.max(
        String(table.columns[index] ?? "").length,
        ...table.cells.slice(0, 200).map((row) => String(row[index] ?? "").length),
      );
      column.width = Math.min(50, Math.max(10, longest + 2));
    });
    data = Buffer.from(await book.xlsx.writeBuffer());
    rows = table.cells.length;
    columns = table.columns;
  }

  if (rows === 0) throw new Error("There are no rows to put in a file.");
  if (data.length > MAX_FILE_BYTES) throw new Error("That file would be over 10 MB. Add filters to ask for less.");
  return { name, format: input.format, mime: MIME[input.format], data, rows, columns };
}

const NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

function parseCsv(text: string) {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      row.push(cell);
      cell = "";
      if (row.some((item) => item !== "") || rows.length === 0) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error("That CSV file is not valid.");
  if (cell.length > 0 || row.length > 0) {
    if (cell.endsWith("\r")) cell = cell.slice(0, -1);
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item, index) => index === 0 || item.some((value) => value !== ""));
}

// Reads a saved chat file back into a table so a person can edit cells.
export async function readTable(format: FileFormat, data: Buffer) {
  if (format === "csv") {
    const rows = parseCsv(data.toString("utf8"));
    const columns = rows[0] ?? [];
    if (columns.length === 0) throw new Error("That file has no columns.");
    const cells = rows.slice(1, MAX_ROWS + 1).map((row) => columns.map((_, index) => row[index] ?? ""));
    return { columns, cells };
  }
  if (format === "xlsx") {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(data as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    if (!sheet) throw new Error("That spreadsheet is empty.");
    const header = sheet.getRow(1);
    const columns: string[] = [];
    header.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col > 80) return;
      columns[col - 1] = String(cell.value ?? "").trim() || `column_${col}`;
    });
    const width = columns.length;
    if (width === 0) throw new Error("That file has no columns.");
    const cells: string[][] = [];
    sheet.eachRow((row, number) => {
      if (number === 1 || cells.length >= MAX_ROWS) return;
      cells.push(columns.map((_, index) => {
        const value = row.getCell(index + 1).value;
        if (value === null || value === undefined) return "";
        if (typeof value === "object" && "text" in value) return String((value as { text: string }).text);
        if (typeof value === "object" && "result" in value) return String((value as { result: unknown }).result ?? "");
        return String(value);
      }));
    });
    return { columns, cells };
  }
  const parsed = JSON.parse(data.toString("utf8")) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const objects = records.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const columns = [...new Set(objects.flatMap((record) => Object.keys(record)))].slice(0, 80);
  const cells = objects.slice(0, MAX_ROWS).map((record) => columns.map((column) => {
    const value = record[column];
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }));
  return { columns, cells };
}

export async function buildTableFile(input: { columns: string[]; cells: string[][]; format: FileFormat; name: string }) {
  if (input.columns.length === 0) throw new Error("The table has no columns.");
  if (input.cells.length === 0) throw new Error("There are no rows to put in a file.");
  if (input.cells.length > MAX_ROWS) throw new Error(`Keep the file to ${MAX_ROWS} rows or fewer.`);
  const cells = input.cells.map((row) => input.columns.map((_, index) => String(row[index] ?? "")));
  const name = fileName(input.name, input.format);

  let data: Buffer;
  if (input.format === "json") {
    const records = cells.map((row) => Object.fromEntries(input.columns.map((column, index) => [column, row[index] ?? ""])));
    data = Buffer.from(JSON.stringify(records, null, 2), "utf8");
  } else if (input.format === "csv") {
    const lines = [input.columns.map(csvCell).join(",")];
    for (const row of cells) lines.push(row.map(csvCell).join(","));
    data = Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8");
  } else {
    const book = new ExcelJS.Workbook();
    book.creator = "Ops Engine";
    const sheet = book.addWorksheet("Data");
    sheet.addRow(input.columns);
    for (const row of cells) sheet.addRow(row.map((cell) => (NUMERIC.test(cell) ? Number(cell) : cell)));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    data = Buffer.from(await book.xlsx.writeBuffer());
  }
  if (data.length > MAX_FILE_BYTES) throw new Error("That file would be over 10 MB. Remove some rows.");
  return { name, format: input.format, mime: MIME[input.format], data, rows: cells.length, columns: input.columns };
}

function csvCell(cell: string) {
  const risky = /^[=+\-@]/.test(cell) && !NUMERIC.test(cell);
  const value = risky ? `'${cell}` : cell;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
