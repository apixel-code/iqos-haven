"use client";
import Link from "next/link";
import { useSession } from "../../components/session-shell";
import { visibleSections } from "../../lib/navigation";
export default function WorkspaceHome() {
  const session = useSession();
  if (!session) return null;
  return (
    <main className="page-content">
      <p className="eyebrow">Your workspace</p>
      <h1>Welcome, {session.user.name}</h1>
      <p className="muted">Choose an area to get started.</p>
      <div className="section-grid">
        {visibleSections(session.permissions).map((section) => (
          <Link className="section-card" href={`/workspace/${section.key}`} key={section.key}>
            <span className="eyebrow">{section.group}</span>
            <h2>{section.label}</h2>
            <span className="muted">Open workspace →</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
