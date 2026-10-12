export class InvalidPhoneError extends Error {}
export class InvalidCustomerNameError extends Error {}
/**
 * UAE mobile without the trunk zero. Orders are taken from UAE mobiles only (ADR 0035). Any
 * 5x prefix is accepted on purpose: operators add prefixes, and refusing a real customer is
 * worse than accepting a mistyped one, which staff confirmation catches.
 */
const UAE_MOBILE = /^5\d{8}$/;
const EASTERN_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/g;
/** Arabic-Indic and Persian digits as ASCII digits; everything else unchanged. */
export function toAsciiDigits(input: string): string {
  return input.replace(EASTERN_DIGITS, (digit) => String(digit.charCodeAt(0) & 0xf));
}
/**
 * The single phone identity of a guest customer: E.164, so every way of typing one number
 * (050…, 50…, 00971…, +971 (0)50…) is one customer. Only UAE mobile numbers are accepted;
 * landlines, service numbers and numbers of other countries throw, as does anything unclear.
 */
export function normalizePhone(input: string): string {
  if (typeof input !== "string" || input.length > 40) throw new InvalidPhoneError();
  const compact = toAsciiDigits(input).replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(compact)) throw new InvalidPhoneError();
  let national: string;
  if (compact.startsWith("+971")) national = compact.slice(4);
  else if (compact.startsWith("00971")) national = compact.slice(5);
  else if (compact.startsWith("971")) national = compact.slice(3);
  else if (compact.startsWith("+") || compact.startsWith("00")) throw new InvalidPhoneError();
  else national = compact;
  // "050…" and "+971 050…" carry the trunk zero; it is never part of the number.
  national = national.replace(/^0/, "");
  if (!UAE_MOBILE.test(national)) throw new InvalidPhoneError();
  return "+971" + national;
}
// Control characters, lone surrogates and invisible format characters (bidirectional overrides
// can reorder what staff read; zero-width ones make a blank look filled). The two joiners stay:
// several scripts need them.
const CONTROL = /[\p{Cc}\p{Cs}]|(?![\u200c\u200d])\p{Cf}/u;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** Collapses whitespace; a line with nothing visible is `null`. Control characters are refused. */
export function normalizeTextLine(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const line = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (CONTROL.test(line)) throw new RangeError("Control characters are not allowed");
  return VISIBLE.test(line) ? line : null;
}
export function normalizeCustomerName(input: string): string {
  let name: string | null;
  try {
    name = typeof input === "string" && input.length <= 400 ? normalizeTextLine(input) : null;
  } catch {
    name = null;
  }
  if (!name || name.length > 100 || !/[\p{L}\p{N}]/u.test(name))
    throw new InvalidCustomerNameError();
  return name;
}
