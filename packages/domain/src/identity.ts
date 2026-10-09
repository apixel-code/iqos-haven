/**
 * Staff identity rules (architecture §11). Emails are stored normalized so uniqueness is
 * case-insensitive; passwords follow a length-first policy with a small deny-list.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class IdentityValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Trimmed, lower-case address; mirrors the staff_users CHECK constraints. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_SHAPE.test(normalized))
    throw new IdentityValidationError("INVALID_EMAIL");
  return normalized;
}

export function normalizeStaffName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 100) throw new IdentityValidationError("INVALID_NAME");
  return normalized;
}

/**
 * Passwords are NFKC-normalized before hashing and before verification (NIST SP 800-63B), so
 * the same visible password typed on different devices produces the same hash input.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/** Obvious choices that length alone would accept. Compared case-insensitively as substrings. */
const DENY_SUBSTRINGS = [
  "password",
  "passw0rd",
  "iqoshaven",
  "iqos",
  "qwerty",
  "123456",
  "admin",
  "letmein",
];

export type PasswordProblem =
  "TOO_SHORT" | "TOO_LONG" | "CONTAINS_IDENTITY" | "TOO_COMMON" | "TOO_REPETITIVE";

/** Returns every problem (empty list = acceptable). Never echoes the password. */
export function passwordProblems(
  password: string,
  identity: { email?: string; name?: string } = {},
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push("TOO_SHORT");
  if (length > PASSWORD_MAX_LENGTH) problems.push("TOO_LONG");
  const lower = password.toLowerCase();
  const local = identity.email?.split("@")[0]?.toLowerCase();
  const nameParts = (identity.name ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 3);
  if (
    (local && local.length >= 3 && lower.includes(local)) ||
    nameParts.some((part) => lower.includes(part))
  )
    problems.push("CONTAINS_IDENTITY");
  if (DENY_SUBSTRINGS.some((word) => lower.includes(word))) problems.push("TOO_COMMON");
  if (new Set(password).size < 4) problems.push("TOO_REPETITIVE");
  return problems;
}
