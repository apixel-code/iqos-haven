"use client";
import Link from "next/link";
import { notificationDestination } from "../lib/links";
import { useCallback, useEffect, useState } from "react";
import {
  inboxResponseSchema,
  notificationReadResponseSchema,
  notificationsReadAllResponseSchema,
  type InboxResponse,
} from "@ih/contracts";
import { when } from "../lib/orders";

async function call<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1/admin/notifications${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(String(response.status));
  return schema.parse(await response.json());
}

/**
 * The signed-in user's inbox (roadmap step 91, ADR 0059). The list always comes from the
 * inbox API; the event stream only says "something new arrived", so a missed or repeated event
 * can never hide or double a notification. The browser reconnects the stream by itself, and the
 * inbox is read again whenever it (re)connects.
 */
export function NotificationBell({ onSignedOut }: { onSignedOut: () => void }) {
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    call("?limit=20", inboxResponseSchema)
      .then((value) => {
        setInbox(value);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    refresh();
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      source = new EventSource("/api/v1/admin/events/stream");
      // `ready` comes on every (re)connection: read the inbox again to fill any gap.
      source.addEventListener("ready", refresh);
      source.addEventListener("notification", refresh);
      source.addEventListener("signed-out", () => {
        source?.close();
        onSignedOut();
      });
      // The browser retries a dropped stream itself, but gives up on a refusal (too many open
      // tabs, a lost permission): try again later instead of staying silent.
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          retry = setTimeout(connect, 60_000);
        }
      };
    };
    connect();
    // A slow, quiet poll in case the stream cannot stay open (proxies, sleep).
    const fallback = setInterval(refresh, 120_000);
    return () => {
      stopped = true;
      source?.close();
      if (retry) clearTimeout(retry);
      clearInterval(fallback);
    };
  }, [refresh, onSignedOut]);

  const unread = inbox?.unreadCount ?? 0;
  return (
    <div className="notification-bell">
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        Notifications{unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="record-card notification-panel" role="dialog" aria-label="Notifications">
          {failed && <p role="alert">Notifications could not be loaded. Try again shortly.</p>}
          {inbox && inbox.items.length === 0 && <p className="muted">No notifications yet.</p>}
          {inbox && inbox.items.length > 0 && (
            <>
              <ul className="record-list">
                {inbox.items.map((item) => (
                  <li key={item.id} className={item.readAt ? "muted" : undefined}>
                    <strong>{item.title}</strong>
                    <small>
                      {item.body} · {when(item.createdAt)}
                    </small>
                    <span>
                      {(() => {
                        const target = notificationDestination(item.link);
                        return (
                          target && (
                            <Link href={target.href} onClick={() => setOpen(false)}>
                              {target.label}
                            </Link>
                          )
                        );
                      })()}{" "}
                      {!item.readAt && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            void call(`/${item.id}/read`, notificationReadResponseSchema, {})
                              .then(refresh)
                              .catch(() => setFailed(true))
                          }
                        >
                          Mark read
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {unread > 0 && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void call("/read-all", notificationsReadAllResponseSchema, {
                      upTo: inbox.items[0]!.id,
                    })
                      .then(refresh)
                      .catch(() => setFailed(true))
                  }
                >
                  Mark all read
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
