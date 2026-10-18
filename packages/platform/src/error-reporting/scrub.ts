/**
 * Error-report scrubbing (roadmap step 125, ADR 0096): what may leave the process when SENTRY_DSN
 * is set. Like the logs, only the error kind, its code and the code location survive. Messages,
 * request data, users, breadcrumbs, extra context and local variables are dropped, because any of
 * them can carry customer details, tokens or cookies.
 */
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === "object" ? (value as Json) : undefined;
const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : undefined;

function frame(value: unknown) {
  const source = object(value) ?? {};
  return {
    filename: text(source.filename, 300),
    function: text(source.function, 200),
    module: text(source.module, 200),
    lineno: typeof source.lineno === "number" ? source.lineno : undefined,
    colno: typeof source.colno === "number" ? source.colno : undefined,
    in_app: typeof source.in_app === "boolean" ? source.in_app : undefined,
  };
}

export function scrubErrorEvent<E extends object>(event: E): E {
  const source = event as Json;
  const values = (object(source.exception)?.values as unknown[] | undefined) ?? [];
  const tags = object(source.tags);
  return {
    event_id: text(source.event_id, 64),
    timestamp: source.timestamp,
    level: text(source.level, 16),
    platform: text(source.platform, 32),
    release: text(source.release, 64),
    environment: text(source.environment, 32),
    tags: tags?.service ? { service: text(tags.service, 32) } : {},
    exception: {
      values: values.slice(0, 5).map((value) => {
        const exception = object(value) ?? {};
        const mechanism = object(exception.mechanism);
        const frames = (object(exception.stacktrace)?.frames as unknown[] | undefined) ?? [];
        return {
          type: text(exception.type, 100) ?? "Error",
          value: "[redacted]",
          ...(mechanism
            ? { mechanism: { type: text(mechanism.type, 64), handled: mechanism.handled } }
            : {}),
          stacktrace: { frames: frames.slice(-50).map(frame) },
        };
      }),
    },
  } as unknown as E;
}
