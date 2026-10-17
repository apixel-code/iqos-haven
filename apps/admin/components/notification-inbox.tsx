"use client";
import Link from "next/link";
import { notificationDestination } from "../lib/links";
import { useCallback, useEffect, useState } from "react";
import {
  inboxResponseSchema,
  notificationReadResponseSchema,
  notificationsReadAllResponseSchema,
  type InboxNotification,
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
 * The full inbox (roadmap step 91 API; page added in step 115): every notification the user
 * may still see, newest first, paged by the API's keyset, with an unread-only view. The bell
 * in the header shows the latest few; this page is the same inbox, never a separate store.
 */
export function NotificationInbox() {
  const [items, setItems] = useState<InboxNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useCallback(
    (after?: string) =>
      `?limit=50${onlyUnread ? "&unread=true" : ""}${after ? `&after=${after}` : ""}`,
    [onlyUnread],
  );
  const load = useCallback(() => {
    call(query(), inboxResponseSchema)
      .then((inbox) => {
        setItems(inbox.items);
        setUnread(inbox.unreadCount);
        setNext(inbox.nextCursor);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [query]);
  useEffect(load, [load]);

  async function more() {
    if (!next) return;
    setBusy(true);
    try {
      const inbox = await call(query(next), inboxResponseSchema);
      setItems((current) => [...(current ?? []), ...inbox.items]);
      setNext(inbox.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const markRead = (id: string) =>
    call(`/${id}/read`, notificationReadResponseSchema, {})
      .then(load)
      .catch(() => setFailed(true));
  const markAll = () => {
    const newest = items?.[0]?.id;
    if (!newest) return;
    void call("/read-all", notificationsReadAllResponseSchema, { upTo: newest })
      .then(load)
      .catch(() => setFailed(true));
  };

  return (
    <div className="dashboard">
      <div className="inline-row">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(event) => setOnlyUnread(event.target.checked)}
          />
          Unread only
        </label>
        <span className="muted small">{unread} unread</span>
        {unread > 0 && (
          <button className="text-button" type="button" onClick={markAll}>
            Mark all as read
          </button>
        )}
      </div>
      {failed && (
        <p className="notice" role="alert">
          Notifications could not be loaded.{" "}
          <button className="text-button" type="button" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {!items && !failed && <p className="muted">Loading notifications…</p>}
      {items && items.length === 0 && (
        <p className="muted">{onlyUnread ? "Nothing unread." : "No notifications yet."}</p>
      )}
      {items && items.length > 0 && (
        <ul className="record-list">
          {items.map((item) => {
            const target = notificationDestination(item.link);
            return (
              <li key={item.id} className="record-card">
                <strong>
                  {!item.readAt && <span className="badge">New</span>} {item.title}
                </strong>
                <span className="muted small">
                  {item.body} · {when(item.createdAt)}
                </span>
                <span className="inline-row">
                  {target && <Link href={target.href}>{target.label}</Link>}
                  {!item.readAt && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void markRead(item.id)}
                    >
                      Mark read
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => void more()}
        >
          {busy ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );
}
