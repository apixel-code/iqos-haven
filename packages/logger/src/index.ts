import pino, { type Logger, type LoggerOptions, type DestinationStream } from "pino";
const CENSOR = "[redacted]";
const PRIVATE_KEY =
  /password|secret|token|cookie|authorization|phone|mobile|email|address|makani|notes|customer|recipient|idempotency|capability|replay|sql|stack|ticket|signing|private|key|credential|hash|session/i;
const PRIVATE_FIELDS = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "body",
  "payload",
  "query",
  "params",
  "headers",
  "url",
  "path",
  "referer",
  "referrer",
  "message",
]);

export const REDACT_PATHS = [
  "password",
  "token",
  "phone",
  "email",
  "address",
  "*.password",
  "*.token",
  "*.phone",
  "*.email",
  "*.address",
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
];

/** Error text/stack may contain SQL, provider responses, credentials or PII. */
export function errorSummary(error: unknown): { errorKind: string; errorCode?: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = record.name;
  const errorKind =
    typeof name === "string" &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "ConfigurationError",
      "PrismaClientKnownRequestError",
      "PrismaClientUnknownRequestError",
    ].includes(name)
      ? name
      : "Error";
  const code = record.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)
    ? { errorKind, errorCode: code }
    : { errorKind };
}

/** Bounded recursive defense; application log calls still use allowlisted fields and static messages. */
export function sanitizeLogRecord(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return errorSummary(value);
  if (depth >= 12 || seen.has(value)) return "[truncated]";
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : "[invalid-date]";
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeLogRecord(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (PRIVATE_KEY.test(key) || PRIVATE_FIELDS.has(key.toLowerCase())) result[key] = CENSOR;
    else if (key === "req" && item && typeof item === "object") {
      const req = item as Record<string, unknown>;
      result[key] = { id: req.id, method: req.method };
    } else if (key === "res" && item && typeof item === "object") {
      result[key] = { statusCode: (item as Record<string, unknown>).statusCode };
    } else result[key] = sanitizeLogRecord(item, depth + 1, seen);
  }
  return result;
}

export function loggerOptions(service: string, level = "info"): LoggerOptions {
  return {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        const sanitized = args.map((arg) =>
          typeof arg === "object" ? sanitizeLogRecord(arg) : arg,
        );
        return method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  };
}
export function createLogger(
  { service, level = "info" }: { service: string; level?: string },
  destination?: DestinationStream,
): Logger {
  return destination
    ? pino(loggerOptions(service, level), destination)
    : pino(loggerOptions(service, level));
}
export type { Logger };
