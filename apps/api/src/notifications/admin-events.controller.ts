import {
  Controller,
  Get,
  Headers,
  Inject,
  Req,
  Res,
  ServiceUnavailableException,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import { HttpException, HttpStatus } from "@nestjs/common";
import { inboxAfter, latestInboxId, sessionStillValid, type Database } from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { NoResponseBody } from "../auth/serialize";
import { DATABASE } from "../infra/tokens";

/**
 * Timing of the admin event stream. Exported so tests can shorten it; the defaults are the
 * production values.
 */
export const EVENT_STREAM = {
  /** How often the stream looks for new notifications in the database. */
  pollMs: 2_000,
  /** How often the session is checked again (revoked, expired, idle, deactivated). */
  authCheckMs: 10_000,
  /** Comment line that keeps proxies and the browser from closing an idle connection. */
  heartbeatMs: 20_000,
  /** A stream ends after this long; the browser reconnects and authenticates again. */
  maxLifetimeMs: 30 * 60_000,
  /** Open streams per user and per API process. */
  perUser: 5,
  perProcess: 200,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /v1/admin/events/stream` (roadmap step 91, ADR 0059): server-sent wake-ups for the
 * signed-in user's inbox. The inbox in PostgreSQL is the authority: an event names a new
 * notification by ID and the browser refetches the inbox, so a missed or repeated event never
 * hides or doubles a notification. The stream ends when the session stops being valid, after
 * its maximum lifetime, and when the API shuts down.
 */
@Controller({ path: "admin/events", version: "1" })
@RequirePermission("notifications.read_own")
export class AdminEventsController implements BeforeApplicationShutdown {
  private readonly open = new Map<string, number>();
  private total = 0;
  /** Every open stream's close, so a shutdown can end them instead of waiting on them. */
  private readonly closers = new Set<(event?: string) => void>();
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  beforeApplicationShutdown() {
    for (const close of [...this.closers]) close("reconnect");
  }

  private release(userId: string) {
    this.total -= 1;
    const left = (this.open.get(userId) ?? 1) - 1;
    if (left > 0) this.open.set(userId, left);
    else this.open.delete(userId);
  }

  @Get("stream")
  @NoResponseBody()
  async stream(
    @Headers("last-event-id") lastEventId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const staff = request.staff!;
    if (this.total >= EVENT_STREAM.perProcess) throw new ServiceUnavailableException();
    if ((this.open.get(staff.userId) ?? 0) >= EVENT_STREAM.perUser)
      throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    // Counted before any await, so parallel connects cannot all pass the bound.
    this.total += 1;
    this.open.set(staff.userId, (this.open.get(staff.userId) ?? 0) + 1);
    let cursor: string | null;
    try {
      // Resume after the last event the browser saw, or start at the newest notification:
      // the page loads the inbox itself when it opens the stream.
      cursor =
        lastEventId && UUID.test(lastEventId)
          ? lastEventId.toLowerCase()
          : await latestInboxId(this.db, staff.userId);
    } catch (error) {
      this.release(staff.userId);
      throw error;
    }

    reply.hijack();
    const raw = reply.raw;
    let closed = false;
    const intervals: NodeJS.Timeout[] = [];
    const timeouts: NodeJS.Timeout[] = [];
    const close = (event?: string) => {
      if (closed) return;
      closed = true;
      this.closers.delete(close);
      for (const timer of intervals) clearInterval(timer);
      for (const timer of timeouts) clearTimeout(timer);
      if (event && raw.writable) raw.write(`event: ${event}\ndata: {}\n\n`);
      if (!raw.writableEnded) raw.end();
      this.release(staff.userId);
    };
    this.closers.add(close);
    // The response's own close: the client went away (or we ended it). Write errors on a
    // reset socket end the stream instead of escaping.
    raw.on("close", () => close());
    raw.on("error", () => close());
    if (raw.destroyed) {
      close();
      return;
    }
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Proxies that honour it (nginx) stream instead of buffering; the gateway is set too.
      "X-Accel-Buffering": "no",
      "X-Request-Id": String(request.id),
    });
    raw.write(`retry: 5000\n\n`);
    raw.write(`event: ready\ndata: {}\n\n`);

    let polling = false;
    intervals.push(
      setInterval(() => {
        if (polling || closed) return;
        polling = true;
        void inboxAfter(this.db, staff.userId, cursor)
          .then((rows) => {
            for (const row of rows) {
              if (closed) return;
              // IDs only: the browser reads the content from the inbox, with its permissions.
              raw.write(
                `id: ${row.id}\nevent: notification\ndata: ${JSON.stringify({ id: row.id, type: row.type })}\n\n`,
              );
              cursor = row.id;
            }
            // A client that stopped reading must not make the server hold its backlog.
            if (raw.writableLength > 64 * 1024) close();
          })
          // The read failed. A user who was signed out meanwhile (deactivated, role changed,
          // session revoked) is told so; otherwise (inbox right lost, database down) the
          // browser reconnects and is authenticated again.
          .catch(() =>
            sessionStillValid(this.db, staff.sessionId)
              .then((valid) => close(valid ? "reconnect" : "signed-out"))
              .catch(() => close("reconnect")),
          )
          .finally(() => {
            polling = false;
          });
      }, EVENT_STREAM.pollMs),
      setInterval(() => {
        if (!closed) raw.write(`: ping\n\n`);
      }, EVENT_STREAM.heartbeatMs),
      setInterval(() => {
        void sessionStillValid(this.db, staff.sessionId)
          .then((valid) => {
            if (!valid) close("signed-out");
          })
          .catch(() => close("reconnect"));
      }, EVENT_STREAM.authCheckMs),
    );
    for (const timer of intervals) timer.unref();
    const lifetime = setTimeout(() => close("reconnect"), EVENT_STREAM.maxLifetimeMs);
    lifetime.unref();
    timeouts.push(lifetime);
  }
}
