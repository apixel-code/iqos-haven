import * as Sentry from "@sentry/node";
import { scrubErrorEvent } from "./scrub";

/**
 * Optional error reporting (roadmap step 125, ADR 0096). Off unless SENTRY_DSN is set. Only
 * uncaught errors and the 5xx the caller reports are sent, scrubbed to error kind and code
 * location; no tracing, no breadcrumbs, no request data, no default integrations.
 */
export function startErrorReporting(
  env: { SENTRY_DSN?: string | undefined; SENTRY_RELEASE?: string | undefined; APP_ENV: string },
  service: "api" | "worker",
): ((error: unknown) => void) | undefined {
  if (!env.SENTRY_DSN) return undefined;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),
    environment: env.APP_ENV,
    // Collect nothing about requests or users; beforeSend scrubs again regardless.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
    },
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    initialScope: { tags: { service } },
    beforeSend: (event) => scrubErrorEvent(event),
    beforeBreadcrumb: () => null,
  });
  return (error) => {
    Sentry.captureException(error);
  };
}

/** Sends what is queued before the process exits (bounded). */
export async function flushErrorReporting(timeoutMs = 2_000): Promise<void> {
  await Sentry.close(timeoutMs).catch(() => undefined);
}
