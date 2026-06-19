import Papa from 'papaparse';
import { ColumnDef, ColumnType, Row, RowData, makeId } from '../shared/types';

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const BOOL_RE = /^(true|false|yes|no)$/i;

/**
 * Detect the delimiter for a CSV blob by counting candidates on the first non-empty line.
 * `auto` falls back to comma if no other candidate clearly wins.
 */
/** Strip a UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function detectDelimiter(text: string, configured: string): string {
  if (configured && configured !== 'auto') return configured;
  const firstLine = stripBom(text).split(/\r?\n/).find((l) => l.length > 0) ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

function inferType(samples: string[]): ColumnType {
  const nonEmpty = samples.filter((s) => s.trim().length > 0);
  if (nonEmpty.length === 0) return 'text';
  if (nonEmpty.every((s) => BOOL_RE.test(s.trim()))) return 'boolean';
  if (nonEmpty.every((s) => NUMBER_RE.test(s.trim()))) return 'number';
  return 'text';
}

function coerce(value: string, type: ColumnType): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return type === 'boolean' ? false : type === 'number' ? null : '';
  if (type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (type === 'boolean') {
    return /^(true|yes)$/i.test(trimmed);
  }
  return value;
}

export interface ParsedCsv {
  columns: ColumnDef[];
  rows: Row[];
}

export function parseCsv(text: string, delimiter: string): ParsedCsv {
  const parsed = Papa.parse<string[]>(stripBom(text), {
    delimiter,
    skipEmptyLines: true,
  });
  const records = parsed.data;
  if (records.length === 0) {
    return { columns: [], rows: [] };
  }
  const headerRow = records[0];
  const dataRows = records.slice(1);
  const columnSamples: string[][] = headerRow.map((_, ci) =>
    dataRows.slice(0, 50).map((r) => r[ci] ?? ''),
  );
  const columns: ColumnDef[] = headerRow.map((name, ci) => {
    const headerName = (name ?? '').trim() || `Column ${ci + 1}`;
    return {
      id: makeId('col'),
      name: headerName,
      type: inferType(columnSamples[ci] ?? []),
    };
  });
  const rows: Row[] = dataRows.map((rec) => {
    const cells: RowData = {};
    columns.forEach((col, ci) => {
      cells[col.id] = coerce(rec[ci] ?? '', col.type) as RowData[string];
    });
    return { id: makeId('row'), cells };
  });
  return { columns, rows };
}

/**
 * CSV/formula injection guard (OWASP): a cell beginning with =, +, -, @, tab,
 * or CR executes as a formula when the exported file is opened in Excel /
 * Sheets. Workflow cells can contain agent-produced text, so exports escape
 * these by prefixing a single quote. Only string cells are escaped — numeric
 * and boolean cells can't carry a formula. Opt out via `safe: false`
 * (the round-trip CSV editor keeps cells verbatim; only exports escape).
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function escapeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function serializeCsv(
  columns: ColumnDef[],
  rows: Row[],
  delimiter: string,
  opts: { safe?: boolean } = {},
): string {
  const headers = columns.map((c) => c.name);
  const data = rows.map((r) =>
    columns.map((c) => {
      const v = r.cells[c.id];
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'string' && opts.safe) return escapeFormula(v);
      return String(v);
    }),
  );
  return Papa.unparse([headers, ...data], { delimiter, newline: '\n' });
}
