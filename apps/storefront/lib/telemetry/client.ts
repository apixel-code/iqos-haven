import { storeEventsRequestSchema, type BrowsingEvent } from "@ih/contracts";
import {
  ANON_STORAGE_KEY,
  anonymousIdFrom,
  createTelemetry,
  isQuietPath,
  outcomeOf,
  type EventInput,
} from "./queue";

/**
 * The browser's telemetry (roadmap step 104, ADR 0070). Fire and forget: `track` returns at
 * once and sending happens on a timer, when 20 events wait, and when the page is hidden. On
 * the server, and on checkout and confirmation pages, it does nothing.
 */
const FLUSH_MS = 5_000;
const inBrowser = typeof window !== "undefined";

function anonymousId(): string | undefined {
  try {
    const { id, save } = anonymousIdFrom(
      window.localStorage.getItem(ANON_STORAGE_KEY),
      Date.now(),
      () => crypto.randomUUID(),
    );
    if (save) window.localStorage.setItem(ANON_STORAGE_KEY, save);
    return id;
  } catch {
    // Storage blocked: events go without one.
    return undefined;
  }
}

async function send(events: BrowsingEvent[], keepalive: boolean) {
  const anon = anonymousId();
  const body = storeEventsRequestSchema.safeParse({
    ...(anon ? { anonymousId: anon } : {}),
    events,
  });
  // Something the API would refuse is not worth a request, or a retry.
  if (!body.success) return "drop" as const;
  const response = await fetch("/api/v1/store/events", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    keepalive,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body.data),
  });
  return outcomeOf(response.status);
}

const telemetry = inBrowser
  ? createTelemetry({
      send,
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      enabled: () => !isQuietPath(window.location.pathname),
    })
  : null;

let timer: ReturnType<typeof setTimeout> | undefined;
/** One pending send; what is left after it (more than 20, or a retry) gets the next one. */
function schedule(): void {
  if (timer || !telemetry) return;
  timer = setTimeout(() => {
    timer = undefined;
    void telemetry.flush().then(() => {
      if (telemetry.state().queued) schedule();
    });
  }, FLUSH_MS);
}
if (inBrowser) {
  // Leaving or hiding the page sends what waits, without delaying the navigation.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void telemetry?.flush(true);
  });
  window.addEventListener("pagehide", () => void telemetry?.flush(true));
}

/** Records one browsing event. Never throws and never waits. */
export function track(input: EventInput): void {
  if (!telemetry) return;
  try {
    telemetry.track(input);
    if (telemetry.state().queued >= 20) void telemetry.flush().then(schedule);
    else schedule();
  } catch {
    // Telemetry never breaks the page.
  }
}
