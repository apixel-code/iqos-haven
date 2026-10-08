/**
 * Audit trail rules (architecture §5 `audit_log`, §11 security controls).
 * Entries are append-only; the diff records only changed fields and never stores secrets or PII values.
 */
export type AuditActor =
  { readonly type: "staff"; readonly id: string } | { readonly type: "system" };

export type AuditValue =
  null | boolean | number | string | readonly AuditValue[] | { readonly [key: string]: AuditValue };

/**
 * A redacted change shows that the field changed, never its old or new value.
 * A truncated change marks an oversize diff: the field is named, values are dropped.
 */
export type AuditFieldChange =
  | { readonly from: AuditValue; readonly to: AuditValue }
  | { readonly redacted: true }
  | { readonly truncated: true };

export type AuditDiff = Readonly<Record<string, AuditFieldChange>>;

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly commandId?: string;
  readonly reason?: string;
  readonly diff: AuditDiff;
}

/** `<entity>.<verb>` in lower snake case, e.g. `order.status_changed`. Mirrors the SQL CHECK. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const AUDIT_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Secrets: recorded as changed, value never stored, cannot be revealed. */
const SECRET_KEY =
  /password|secret|token|hash|cookie|session|ticket|capability|idempotency|signing|private_?key|credential|otp/i;
/** Personal data, redacted by default. Non-personal entities may reveal e.g. product `name`. */
const PERSONAL_KEY =
  /phone|mobile|email|address|makani|notes|recipient|whatsapp|street|building|landmark|name$/i;
const PERSONAL_TOKENS = new Set(["name", "ip", "agent", "line1", "line2"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

const MAX_FIELDS = 100;
const MAX_KEY = 64;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_STRING = 500;
/** Characters; keeps the serialized diff well inside the 64 KiB database CHECK. */
const MAX_DIFF_CHARS = 16_384;
const MAX_REASON = 500;
const MAX_ID = 128;

export interface AuditDiffOptions {
  /** Extra field names to redact for this entity. Case-insensitive. */
  readonly redact?: readonly string[];
  /** Top-level personal-looking fields that are not personal for this entity, e.g. product `name`. Never reveals secrets. */
  readonly reveal?: readonly string[];
}

/**
 * Field-level diff of two flat snapshots. Unchanged fields are omitted.
 * `before = null` records a creation, `after = null` a removal/deactivation.
 */
export function buildAuditDiff(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
  options: AuditDiffOptions = {},
): AuditDiff {
  const extra = new Set((options.redact ?? []).map((name) => name.toLowerCase()));
  const reveal = new Set((options.reveal ?? []).map((name) => name.toLowerCase()));
  const personal = (key: string) =>
    PERSONAL_KEY.test(key) || keyTokens(key).some((token) => PERSONAL_TOKENS.has(token));
  const nested = (key: string) =>
    SECRET_KEY.test(key) || personal(key) || extra.has(key.toLowerCase());
  const topLevel = (key: string) =>
    SECRET_KEY.test(key) ||
    extra.has(key.toLowerCase()) ||
    (personal(key) && !reveal.has(key.toLowerCase()));
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => !UNSAFE_KEYS.has(key))
    .sort();
  const diff: Record<string, AuditFieldChange> = {};
  for (const key of keys) {
    const from = normalize(before?.[key], 0, nested);
    const to = normalize(after?.[key], 0, nested);
    if (sameValue(from, to)) continue;
    diff[key.slice(0, MAX_KEY)] = topLevel(key) ? { redacted: true } : { from, to };
  }
  return boundDiff(diff);
}

/** Validates an entry before it reaches storage; throws RangeError on contract violations. */
export function assertAuditEntry(entry: AuditEntry): AuditEntry {
  const { actor, action, entityType, entityId, requestId, commandId, reason, diff } = entry;
  if (actor.type === "staff" && !UUID_PATTERN.test(actor.id))
    throw new RangeError("Staff audit actor needs a UUID");
  if (action.length > 64 || !AUDIT_ACTION_PATTERN.test(action))
    throw new RangeError("Invalid audit action");
  if (entityType.length > 64 || !AUDIT_ENTITY_TYPE_PATTERN.test(entityType))
    throw new RangeError("Invalid audit entity type");
  for (const value of [entityId, requestId, commandId]) {
    if (value !== undefined && (!value || value.length > MAX_ID))
      throw new RangeError("Audit identifiers must be 1–128 characters");
  }
  if (reason !== undefined && (!reason.trim() || reason.length > MAX_REASON))
    throw new RangeError(`Audit reason must be 1–${MAX_REASON} characters`);
  if (JSON.stringify(diff).length > MAX_DIFF_CHARS) throw new RangeError("Audit diff too large");
  return entry;
}

/**
 * Oversize diffs must not abort the business mutation they describe:
 * keep the changed field names (first MAX_FIELDS) and drop the values.
 */
function boundDiff(diff: Record<string, AuditFieldChange>): AuditDiff {
  const keys = Object.keys(diff);
  if (keys.length <= MAX_FIELDS && JSON.stringify(diff).length <= MAX_DIFF_CHARS) return diff;
  const bounded: Record<string, AuditFieldChange> = {};
  for (const key of keys.slice(0, MAX_FIELDS))
    bounded[key] = "redacted" in diff[key]! ? { redacted: true } : { truncated: true };
  return bounded;
}

function normalize(value: unknown, depth: number, sensitive: (key: string) => boolean): AuditValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    // PostgreSQL jsonb rejects NUL; a rejected insert would roll back the mutation.
    const text = value.replaceAll("\u0000", "");
    return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + "…" : text;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // bigint fils/counters: JSON has no bigint; a string keeps the exact value.
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "object") return null;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, MAX_ARRAY).map((item) => normalize(item, depth + 1, sensitive));
  const result: Record<string, AuditValue> = {};
  for (const key of Object.keys(value)
    .filter((name) => !UNSAFE_KEYS.has(name))
    .sort()
    .slice(0, MAX_FIELDS)) {
    result[key] = sensitive(key)
      ? "[redacted]"
      : normalize((value as Record<string, unknown>)[key], depth + 1, sensitive);
  }
  return result;
}

function sameValue(a: AuditValue, b: AuditValue): boolean {
  // normalize() sorts object keys, so serialization is canonical.
  return JSON.stringify(a) === JSON.stringify(b);
}
