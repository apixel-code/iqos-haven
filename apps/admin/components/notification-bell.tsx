"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { notificationDestination } from "../lib/links";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  inboxResponseSchema,
  notificationReadResponseSchema,
  notificationsReadAllResponseSchema,
  type InboxResponse,
} from "@ih/contracts";
import { when } from "../lib/orders";
import { toast } from "../lib/ui/toast";
import { Icon, type IconName } from "./icons";
import { Pop } from "./pop";

/** The prototype's notification icons by kind (`notifItem`), keyed by the type's prefix. */
const KIND: Record<string, { icon: IconName; tone: "info" | "warn" | "ok" }> = {
  order: { icon: "orders", tone: "info" },
  inventory: { icon: "layers", tone: "warn" },
  review: { icon: "star", tone: "info" },
  system: { icon: "info", tone: "ok" },
};

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
  const bell = useRef<HTMLButtonElement>(null);
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
  const router = useRouter();
  const markRead = (id: string) =>
    call(`/${id}/read`, notificationReadResponseSchema, {})
      .then(refresh)
      .catch(() => setFailed(true));
  return (
    <>
      {/* The prototype's bell (`#bell`): the count as a dot, in the accessible name too. */}
      <button
        ref={bell}
        type="button"
        className="ibtn bell"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="dot" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Pop
        anchor={bell}
        open={open}
        onClose={() => setOpen(false)}
        label="Notifications"
        className="notif"
      >
        <div className="notif-h">
          <h3>Notifications</h3>
          {inbox && unread > 0 && (
            <button
              type="button"
              className="btn btn-g btn-sm"
              onClick={() =>
                void call("/read-all", notificationsReadAllResponseSchema, {
                  upTo: inbox.items[0]!.id,
                })
                  .then(() => {
                    refresh();
                    toast("All notifications marked as read");
                  })
                  .catch(() => setFailed(true))
              }
            >
              Mark all as read
            </button>
          )}
        </div>
        <div className="notif-l">
          {failed && (
            <p role="alert" className="notif-msg">
              Notifications could not be loaded. Try again shortly.
            </p>
          )}
          {inbox && inbox.items.length === 0 && (
            <div className="empty">
              <div className="ic">
                <Icon name="bell" />
              </div>
              <h3>You&apos;re all caught up</h3>
              <p>No notifications yet. New orders and stock alerts will appear here.</p>
            </div>
          )}
          {inbox?.items.slice(0, 8).map((item) => {
            const target = notificationDestination(item.link);
            // What it links to decides the icon; else the type ("order.new" → "order").
            const about = target?.href.startsWith("/workspace/orders")
              ? "order"
              : target?.href.startsWith("/workspace/inventory")
                ? "inventory"
                : target?.href.startsWith("/workspace/reviews")
                  ? "review"
                  : item.type.split(".")[0]!;
            const kind = KIND[about] ?? KIND.system!;
            return (
              <button
                key={item.id}
                type="button"
                className={item.readAt ? "ni read" : "ni"}
                onClick={() => {
                  if (!item.readAt) void markRead(item.id);
                  if (target) {
                    setOpen(false);
                    router.push(target.href);
                  }
                }}
              >
                <span className={`ic ic-${kind.tone}`}>
                  <Icon name={kind.icon} />
                </span>
                <span>
                  <b>{item.title}</b>
                  <small>{item.body}</small>
                  <small>{when(item.createdAt)}</small>
                </span>
                {!item.readAt && (
                  <span className="ud">
                    <span className="sr">Unread. Mark read</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="notif-f">
          <Link
            href="/workspace/notifications"
            className="btn btn-g btn-sm"
            onClick={() => setOpen(false)}
          >
            View all notifications
          </Link>
        </div>
      </Pop>
    </>
  );
}
