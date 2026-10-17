import { DUBAI_UTC_OFFSET_MINUTES } from "./schedule";

/**
 * CSV encoding for the reports (roadmap step 111, ADR 0077). RFC 4180: comma separated, CRLF
 * line ends, a field quoted when it holds a comma, quote, line break or edge space. UTF-8 with a
 * byte-order mark so spreadsheet programs read non-English names correctly.
 *
 * Spreadsheet formulas: a text field that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return would be run as a formula when the file is opened (CSV injection). Such text gets a
 * leading apostrophe, which spreadsheets show as plain text. Numbers are written by the report
 * itself (`CsvNumber`), never from free text, so they are left alone.
 */
export const CSV_BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** A number the report computed (count or AED amount), written as is. */
export class CsvNumber {
  constructor(readonly text: string) {
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new RangeError("Not a number");
  }
}
export type CsvValue = string | CsvNumber | number | null;

export function csvField(value: CsvValue): string {
  if (value === null) return "";
  if (value instanceof CsvNumber) return value.text;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("Only integer counts are written raw");
    return String(value);
  }
  let text = value;
  if (FORMULA_START.test(text)) text = "'" + text;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvLine = (values: readonly CsvValue[]): string =>
  values.map(csvField).join(",") + "\r\n";

/** Integer fils as an AED amount with two decimals, e.g. 123456 → "1234.56". No floats. */
export function aedAmount(fils: number | bigint): CsvNumber {
  const value = BigInt(fils);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return new CsvNumber(`${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`);
}

/** Basis points as a percentage with two decimals, e.g. 1234 → "12.34". */
export function percentAmount(bps: number | null): CsvNumber | null {
  if (bps === null) return null;
  return new CsvNumber(`${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, "0")}`);
}

/** An instant as Dubai wall-clock time, `YYYY-MM-DD HH:MM`. */
export function dubaiDateTime(instant: Date): string {
  return new Date(instant.getTime() + DUBAI_UTC_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}
