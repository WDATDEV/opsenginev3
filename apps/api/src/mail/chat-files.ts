import ExcelJS from "exceljs";
import { toCsv, toTable } from "./spreadsheet.js";

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
