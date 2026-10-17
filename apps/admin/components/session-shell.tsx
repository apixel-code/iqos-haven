"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { MeResponse } from "@ih/contracts";
import { ApiError, authRequest, currentSession } from "../lib/auth";
import { visibleSections } from "../lib/navigation";
import { NotificationBell } from "./notification-bell";
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
  const [dark, setDark] = useState(false);
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
        <div className="workspace" data-theme={dark ? "dark" : "light"}>
          <aside className="sidebar">
            <Link href="/" className="workspace-brand">
              <span className="brand-mark">IH</span>Iqos Haven
            </Link>
            <nav aria-label="Main navigation">
              <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
                Workspace
              </Link>
              {visibleSections(session.permissions).map((section) => (
                <Link
                  key={section.key}
                  href={`/workspace/${section.key}`}
                  aria-current={pathname === `/workspace/${section.key}` ? "page" : undefined}
                >
                  {section.label}
                </Link>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className="text-button"
                onClick={() => {
                  document.documentElement.dataset.theme = dark ? "light" : "dark";
                  setDark((v) => !v);
                }}
              >
                {dark ? "Light theme" : "Dark theme"}
              </button>
              <button className="text-button" onClick={logout} disabled={signingOut}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </aside>
          <div className="workspace-body">
            <header className="workspace-header">
              <span className="muted">Admin workspace</span>
              {session.permissions.includes("notifications.read_own") && (
                <NotificationBell onSignedOut={signedOut} />
              )}
              <span>
                {session.user.name}{" "}
                <span className="badge">{session.user.role === "owner" ? "Owner" : "Staff"}</span>
              </span>
            </header>
            {children}
          </div>
        </div>
      </SessionCheckingContext.Provider>
    </SessionContext.Provider>
  );
}
