import Link from "next/link";

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ trail }: { trail: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="pt-[18px] text-[13px] text-ink-3">
      <ol className="flex flex-wrap items-center gap-1.5">
        {trail.map((crumb, index) => (
          <li key={crumb.label} className="flex items-center gap-1.5">
            {index > 0 && <span aria-hidden="true">›</span>}
            {crumb.href ? (
              <Link href={crumb.href} prefetch={false} className="hover:text-ink">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-2">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <header className="flex flex-col gap-2 pb-[18px] pt-3.5">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {lead && <p className="text-sm text-ink-2">{lead}</p>}
    </header>
  );
}

/** Prototype empty state: dashed card, short explanation, one way out. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 rounded-lg border border-dashed border-line-2 bg-surface px-5 py-14 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-ink-2">{body}</p>
      {action && (
        <Link
          href={action.href}
          prefetch={false}
          className="inline-flex h-10 items-center rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
