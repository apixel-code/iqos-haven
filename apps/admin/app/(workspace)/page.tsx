"use client";
import { useEffect, useState } from "react";
import { Dashboard } from "../../components/dashboard";
import { PageHead } from "../../components/page-head";
import { useSession } from "../../components/session-shell";

/** "Good morning" by the hour in Dubai (prototype `greet`). */
function greeting(now: Date) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Dubai" })
      .format(now)
      .slice(0, 2),
  );
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}
const dateLine = (now: Date) =>
  `${new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Dubai",
  }).format(now)} · ${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Dubai",
  }).format(now)} Dubai time`;

/** The workspace home: the prototype's greeting head over the operational dashboard. */
export default function WorkspaceHome() {
  const session = useSession();
  // The clock is read in the browser only, so the server and first client render agree.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const frame = requestAnimationFrame(tick);
    const timer = window.setInterval(tick, 60_000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, []);
  if (!session) return null;
  const first = session.user.name.split(/\s+/)[0] ?? session.user.name;
  return (
    <main className="page-content">
      <PageHead
        title={now ? `${greeting(now)}, ${first}` : `Welcome, ${first}`}
        {...(now ? { sub: dateLine(now) } : {})}
      />
      <Dashboard />
    </main>
  );
}
