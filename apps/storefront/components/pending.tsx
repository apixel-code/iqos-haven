"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps, ReactNode } from "react";

function PendingLabel({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-busy={pending || undefined} className={pending ? "opacity-60" : undefined}>
      {pending ? "Loading…" : children}
    </span>
  );
}

/**
 * A link that says "Loading…" while its page is being fetched. Catalogue pages are rendered in
 * full on the server (so a missing page is a real 404 and works without JavaScript); this is the
 * loading state for navigations between them.
 */
export function PendingLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link prefetch={false} {...props}>
      <PendingLabel>{children}</PendingLabel>
    </Link>
  );
}
