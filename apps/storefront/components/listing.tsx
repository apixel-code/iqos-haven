import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

export interface Crumb {
  label: string;
  href?: string;
}

/** The prototype's breadcrumb (`crumbs`): links separated by chevrons, the page last. */
export function Breadcrumbs({ trail }: { trail: readonly Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {trail.map((crumb, index) => (
        <Fragment key={crumb.label}>
          {index > 0 && <Icon name="chev-r" />}
          {crumb.href ? (
            <Link href={crumb.href} prefetch={false}>
              {crumb.label}
            </Link>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** The prototype's page heading (`shop-head`). */
export function PageHead({
  title,
  lead,
  leadIcon,
}: {
  title: string;
  lead?: string;
  /** A small icon before the lead (the saved page's "on this device"). */
  leadIcon?: IconName;
}) {
  return (
    <div className="shop-head">
      <h1 className="h1">{title}</h1>
      {lead && (
        <p className={leadIcon ? "muted lead-ic" : "muted"}>
          {leadIcon && <Icon name={leadIcon} size="sm" />}
          {lead}
        </p>
      )}
    </div>
  );
}

/** The prototype's empty state (`empty`): icon, short explanation, one way out. */
export function EmptyState({
  title,
  body,
  action,
  icon = "search",
  children,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
  icon?: "search" | "heart" | "bag" | "compare";
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="ic">
        <Icon name={icon} size="lg" />
      </span>
      <h2 className="h3">{title}</h2>
      <p>{body}</p>
      {action && (
        <div className="sq-chips" style={{ justifyContent: "center" }}>
          <Link href={action.href} prefetch={false} className="btn btn-primary btn-sm">
            {action.label}
          </Link>
        </div>
      )}
      {children}
    </div>
  );
}
