"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { MeResponse } from "@ih/contracts";
import { ApiError, authRequest, currentSession } from "../lib/auth";
import { useNavCounts } from "../lib/nav-counts";
import { navHref, visibleNav, type NavItem } from "../lib/navigation";
import { GlobalSearch, MobileSearch } from "./global-search";
import { Icon, IconSprite, type IconName } from "./icons";
import { ConfirmHost, Drawer, Toasts } from "./overlays";
import { Pop } from "./pop";
import { NotificationBell } from "./notification-bell";
import { UnsavedChangesGuard } from "./unsaved-guard";
const SessionContext = createContext<MeResponse | null>(null);
const SessionCheckingContext = createContext(false);
export function useSessionChecking() {
  return useContext(SessionCheckingContext);
}
export function useSession() {
  return useContext(SessionContext);
}
/** The event stream says the session ended (revoked, expired, deactivated): sign in again. */
const signedOut = () => window.location.replace("/login?reason=expired");

export function SessionShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<{ session: MeResponse; path: string } | null>(null);
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [retry, setRetry] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    async function refresh() {
      controller?.abort();
      controller = new AbortController();
      const active = controller;
      setChecking(true);
      try {
        const session = await currentSession(active.signal);
        if (!disposed && controller === active) {
          setSnapshot({ session, path: pathname });
          setError(false);
          setChecking(false);
        }
      } catch (cause) {
        if (disposed || active.signal.aborted || controller !== active) return;
        setSnapshot(null);
        setChecking(false);
        if (cause instanceof ApiError && cause.status === 401)
          window.location.replace("/login?reason=expired");
        else setError(true);
      }
    }
    const focus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const interval = window.setInterval(focus, 60_000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [pathname, retry]);
  const session = snapshot?.path === pathname ? snapshot.session : null;
  if (!session)
    return (
      <main className="session-state">
        <h1>{error ? "Could not verify your session" : "Checking your session…"}</h1>
        {error && (
          <>
            <p>Reconnect and try again to continue securely.</p>
            <button className="primary-button" onClick={() => setRetry((v) => v + 1)}>
              Try again
            </button>
            <Link href="/login">Back to sign in</Link>
          </>
        )}
      </main>
    );
  async function logout() {
    setSigningOut(true);
    try {
      await authRequest("logout", {});
      window.location.replace("/login?reason=out");
    } catch {
      setSnapshot(null);
      setError(true);
      setSigningOut(false);
    }
  }
  return (
    <SessionContext.Provider value={session}>
      <SessionCheckingContext.Provider value={checking}>
        <Workspace session={session} pathname={pathname} signingOut={signingOut} onLogout={logout}>
          {children}
        </Workspace>
      </SessionCheckingContext.Provider>
    </SessionContext.Provider>
  );
}

type Theme = "light" | "dark" | "system";
const THEME_KEY = "ih_admin_theme";
/** The theme choice is a display preference of this browser, nothing else (prototype `pref`). */
function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/**
 * The admin prototype's shell (`shell`, `navHtml`, parity G-A12, ADR 0097): the sidebar with
 * groups, icons and attention counts (an icon rail from 720 px, full from 1100 px), the topbar
 * with search, role, bell and account, the page area, and on a phone the bottom navigation with
 * "More". What a user may not open is left out; the API still decides every request.
 */
function Workspace({
  session,
  pathname,
  signingOut,
  onLogout,
  children,
}: {
  session: MeResponse;
  pathname: string;
  signingOut: boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  const nav = visibleNav(session.permissions);
  const counts = useNavCounts(pathname);
  const owner = session.user.role === "owner";
  const [theme, setTheme] = useState<Theme>("system");
  const [menuFrom, setMenuFrom] = useState<"side" | "top" | null>(null);
  const [more, setMore] = useState(false);
  const sideWho = useRef<HTMLButtonElement>(null);
  const topWho = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Read after hydration, so the server and first client render agree.
    const stored = readTheme();
    applyTheme(stored);
    const frame = requestAnimationFrame(() => setTheme(stored));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A followed link closes the "More" sheet.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMore(false);
    setMenuFrom(null);
  }

  const active = (key: string) =>
    key === "dashboard" ? pathname === "/" : pathname === navHref(key);
  const countOf = (item: NavItem) => (item.count ? (counts[item.count] ?? 0) : 0);
  const badge = (item: NavItem) => {
    const value = countOf(item);
    return value > 0 ? (
      <span
        className={item.count === "lowStock" ? "cnt warn" : "cnt"}
        aria-label={`${value} need attention`}
      >
        {value}
      </span>
    ) : null;
  };
  const link = (item: NavItem, sub = false) => (
    <Link
      key={item.key}
      href={navHref(item.key)}
      className="nav-a"
      title={item.label}
      aria-current={active(item.key) ? "page" : undefined}
    >
      {!sub && <Icon name={item.icon as IconName} />}
      <span className="lbl">{item.label}</span>
      {badge(item)}
    </Link>
  );
  const roleLine = owner ? "Owner · full access" : "Staff";
  const accountMenu = (
    <div className="menu account-menu">
      <div className="menu-who">
        <b>{session.user.name}</b>
        <span className="small muted">{session.user.email}</span>
        <span className={owner ? "tag pub" : "tag"}>
          <Icon name={owner ? "shield" : "user"} size="sm" />
          {owner ? "Owner" : "Staff"}
        </span>
      </div>
      <hr />
      {(
        [
          ["light", "Light theme", "sun"],
          ["dark", "Dark theme", "moon"],
          ["system", "Match device", "monitor"],
        ] as const
      ).map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          onClick={() => {
            applyTheme(value);
            setTheme(value);
          }}
        >
          <Icon name={icon} />
          {label}
          {theme === value && (
            <span className="chk">
              <Icon name="check" />
            </span>
          )}
        </button>
      ))}
      <hr />
      <button type="button" onClick={onLogout} disabled={signingOut} data-leave>
        <Icon name="logout" />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
  // The bottom bar on a phone: four places and "More" (prototype `bnav`).
  const bottom = [
    { key: "dashboard", label: "Home", icon: "home" as IconName },
    { key: "orders", label: "Orders", icon: "orders" as IconName, count: "pendingOrders" as const },
    { key: "inventory", label: "Stock", icon: "layers" as IconName, count: "lowStock" as const },
    { key: "products", label: "Products", icon: "box" as IconName },
  ].filter(
    (item) =>
      item.key === "dashboard" || nav.some((group) => group.items.some((i) => i.key === item.key)),
  );
  const inBottom = bottom.some(
    (item) =>
      active(item.key) || (item.key === "products" && (active("categories") || active("brands"))),
  );
  return (
    <div className="workspace-shell">
      <IconSprite />
      <div className="app">
        <aside className="side">
          <div className="side-top">
            <Link href="/" className="side-logo">
              <span className="mark" aria-hidden="true">
                IH
              </span>
              <span className="wm">
                Iqos <span>Haven</span>
              </span>
              <span className="wm-tag">Admin</span>
            </Link>
          </div>
          <nav aria-label="Main navigation">
            {nav.map(({ group, items }) => (
              <div key={group ?? "home"} className="nav-grp">
                {group && <div className="nav-g">{group}</div>}
                {items.map((item) => (
                  <div key={item.key}>
                    {link(item)}
                    {item.sub && item.sub.length > 0 && (
                      <div className="nav-sub">{item.sub.map((child) => link(child, true))}</div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <button
              ref={sideWho}
              type="button"
              className="who"
              aria-expanded={menuFrom === "side"}
              onClick={() => setMenuFrom(menuFrom === "side" ? null : "side")}
            >
              {/* The visible name stays part of the accessible name (WCAG 2.5.3). */}
              <span className="sr">Account menu: </span>
              <span className="av" aria-hidden="true">
                {initials(session.user.name)}
              </span>
              <span>
                <b>{session.user.name}</b>
                <small>{roleLine}</small>
              </span>
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <Link href="/" className="mlogo">
              <span className="mark" aria-hidden="true">
                IH
              </span>
              <span className="wm">
                Iqos <span>Haven</span>
              </span>
            </Link>
            <GlobalSearch permissions={session.permissions} />
            <span className="tb-sp" />
            <MobileSearch permissions={session.permissions} />
            <span className="rolepill hide-m" title="Signed in role">
              <Icon name={owner ? "shield" : "user"} size="sm" />
              {owner ? "Owner" : "Staff"}
            </span>
            {session.permissions.includes("notifications.read_own") && (
              <NotificationBell onSignedOut={signedOut} />
            )}
            <button
              ref={topWho}
              type="button"
              className="ibtn only-m-f"
              aria-expanded={menuFrom === "top"}
              onClick={() => setMenuFrom(menuFrom === "top" ? null : "top")}
            >
              <span className="sr">Account menu: </span>
              <span className="av av-sm">{initials(session.user.name)}</span>
            </button>
          </header>
          <div className="scroll" id="scroll">
            <div className="page">{children}</div>
          </div>
          <nav className="bnav" aria-label="Main navigation">
            {bottom.map((item) => {
              const value = item.count ? (counts[item.count] ?? 0) : 0;
              const current =
                active(item.key) ||
                (item.key === "products" && (active("categories") || active("brands")));
              return (
                <Link
                  key={item.key}
                  href={navHref(item.key)}
                  aria-current={current ? "page" : undefined}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {value > 0 && (
                    <span
                      className={item.count === "lowStock" ? "cnt warn" : "cnt"}
                      aria-label={`${value} need attention`}
                    >
                      {value}
                    </span>
                  )}
                </Link>
              );
            })}
            <button
              type="button"
              aria-current={inBottom ? undefined : "page"}
              aria-expanded={more}
              onClick={() => setMore(true)}
            >
              <Icon name="menu" />
              <span>More</span>
            </button>
          </nav>
        </div>
      </div>
      <Pop
        anchor={menuFrom === "top" ? topWho : sideWho}
        open={menuFrom !== null}
        onClose={() => setMenuFrom(null)}
        align={menuFrom === "side" ? "left" : "right"}
        label="Account menu"
      >
        {accountMenu}
      </Pop>
      <Drawer open={more} onClose={() => setMore(false)} title="Menu">
        <div className="stack more-nav">
          {nav.map(({ group, items }) => (
            <div key={group ?? "home"} className="more-grp">
              {group && <div className="nav-g">{group}</div>}
              {items.map((item) => (
                <div key={item.key}>
                  {link(item)}
                  {item.sub?.map((child) => (
                    <Link key={child.key} href={navHref(child.key)} className="nav-a more-sub">
                      <span className="lbl">{child.label}</span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          ))}
          <hr />
          <div className="more-who">
            <span className="av" aria-hidden="true">
              {initials(session.user.name)}
            </span>
            <span>
              <b>{session.user.name}</b>
              <small>{owner ? "Owner" : "Staff"}</small>
            </span>
            <button
              type="button"
              className="btn btn-s btn-sm"
              onClick={onLogout}
              disabled={signingOut}
              data-leave
            >
              <Icon name="logout" size="sm" />
              Sign out
            </button>
          </div>
        </div>
      </Drawer>
      <ConfirmHost />
      <Toasts />
      <UnsavedChangesGuard />
    </div>
  );
}
