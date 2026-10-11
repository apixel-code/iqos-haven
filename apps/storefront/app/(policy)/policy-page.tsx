import Link from "next/link";
import type { ReactNode } from "react";
import { AGE_COPY } from "@/lib/age/copy";
import { POLICY_PAGES, SITE } from "@/lib/site";

/** Frame for the public policy pages: store name, links between them, no catalogue data. */
export function PolicyPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
        {/* prefetch off: the home page is gated, and a prefetch would only fetch a redirect. */}
        <Link href="/" prefetch={false} className="text-lg font-semibold tracking-tight">
          {SITE.name}
        </Link>
        <span className="rounded-pill bg-accent-soft px-3 py-1 text-xs font-medium text-ink">
          {AGE_COPY.badge}
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex flex-col gap-3 text-sm text-ink-2">{children}</div>
      </main>
      <footer className="flex flex-col items-center gap-2 px-4 py-6 text-xs text-ink-2">
        <PolicyLinks />
        <span>{AGE_COPY.footer}</span>
      </footer>
    </div>
  );
}

export function PolicyLinks() {
  return (
    <nav aria-label="Policies">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {POLICY_PAGES.map((page) => (
          <li key={page.path}>
            <a href={page.path} className="underline underline-offset-2 hover:text-ink">
              {page.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Shown where the approved legal text will go. */
export function PendingText() {
  return (
    <p className="rounded-lg border border-line-2 bg-surface px-4 py-3">
      The full text of this policy is being finalised and will be published here before the store
      opens.
    </p>
  );
}
