/**
 * Minimal RFC 4180 CSV serialization for the admin screens' Export buttons.
 *
 * Kept here rather than pulled from a dependency because the requirements are
 * narrow (flat rows, known columns) and correctness hinges on one rule that is
 * easy to get wrong by hand: a field containing a comma, quote, CR or LF must
 * be quoted, and embedded quotes doubled.
 */

export interface CsvColumn<T> {
  /** Header text written to the first line. */
  header: string;
  /** Pulls the cell value for one row. */
  value: (row: T) => unknown;
}

/**
 * Quote a single field only when it has to be.
 *
 * `null`/`undefined` become an empty field rather than the strings "null" or
 * "undefined", which is what a spreadsheet reader expects for missing data.
 *
 * A leading =, +, - or @ is prefixed with a single quote: Excel and Sheets
 * treat such a field as a formula, so an imported value like `=1+1` (or a
 * crafted `=HYPERLINK(...)`) would execute on open instead of displaying.
 */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Objects are JSON-encoded rather than passed to String(), which would
  // render every one of them as the useless "[object Object]".
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    text = JSON.stringify(value) ?? '';
  }

  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize rows to a CSV document, header line first. CRLF per RFC 4180. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines: string[] = [
    columns.map((column) => escapeField(column.header)).join(','),
  ];

  for (const row of rows) {
    lines.push(
      columns.map((column) => escapeField(column.value(row))).join(','),
    );
  }

  return lines.join('\r\n');
}

/** `employees-2026-09-11.csv` — a dated, stable name for downloads. */
export function csvFilename(prefix: string, date = new Date()): string {
  return `${prefix}-${date.toISOString().slice(0, 10)}.csv`;
}
