export class InvalidPhoneError extends Error {}
export class InvalidCustomerNameError extends Error {}
const E164 = /^\+[1-9]\d{7,14}$/;
/** UAE national number without the trunk zero: a mobile (5x) or a geographic landline. */
const UAE_NATIONAL = /^(?:5\d{8}|[234679]\d{7})$/;
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
/**
 * The single phone identity of a guest customer: E.164, so every way of typing one number
 * (050…, 50…, 00971…, +971 (0)50…) is one customer. Local forms are read as UAE numbers; a
 * number from another country needs its country code. Never guesses: anything else throws.
 * Known limit: a trunk zero typed after a non-UAE country code ("+44 (0)20 …") is kept, so that
 * spelling is a different identity from the correct one. Only the UAE form is repaired.
 */
export function normalizePhone(input: string): string {
  if (typeof input !== "string" || input.length > 40) throw new InvalidPhoneError();
  const compact = input
    .replace(EASTERN_DIGITS, (digit) => String(digit.charCodeAt(0) & 0xf))
    .replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(compact)) throw new InvalidPhoneError();
  let digits: string;
  if (compact.startsWith("+")) digits = compact.slice(1);
  else if (compact.startsWith("00")) digits = compact.slice(2);
  else if (compact.startsWith("0")) digits = "971" + compact.slice(1);
  else if (/^5\d{8}$/.test(compact)) digits = "971" + compact;
  else if (compact.startsWith("971")) digits = compact;
  else throw new InvalidPhoneError();
  if (digits.startsWith("971")) {
    // "+971 050 …" keeps the trunk zero by mistake; it is never part of the number.
    const national = digits.slice(3).replace(/^0/, "");
    if (!UAE_NATIONAL.test(national)) throw new InvalidPhoneError();
    return "+971" + national;
  }
  const phone = "+" + digits;
  if (!E164.test(phone)) throw new InvalidPhoneError();
  return phone;
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
