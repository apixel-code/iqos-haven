import type { ReactNode } from "react";
import { IconSprite } from "@/components/icons";
import { AGE_COPY } from "@/lib/age/copy";
import { PolicyLinks } from "./(policy)/policy-page";

/**
 * Shared frame of the age-check and restricted pages (prototype `gateShell`, ADR 0097): the
 * arcs, the wordmark with the adults-only badge, the card and the foot with the policy links.
 * No catalogue data is ever rendered here.
 */
export function GateShell({
  labelledBy,
  restricted = false,
  children,
}: {
  labelledBy: string;
  restricted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={restricted ? "gate restricted" : "gate"}>
      <IconSprite />
      <div className="gate-arcs" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="gate-top">
        <span className="logo">
          <span className="wm">
            Iqos <span>Haven</span>
          </span>
        </span>
        <span className="badge badge-soft">{AGE_COPY.badge}</span>
      </header>
      <main className="gate-main">
        <section className="gate-card" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>
      <footer className="gate-foot">
        <span>{AGE_COPY.footer}</span>
        <PolicyLinks />
      </footer>
    </div>
  );
}
