import type { ReactNode } from "react";
import { AGE_COPY } from "@/lib/age/copy";

/** Shared frame of the age-check and restricted pages (prototype `gateShell`). */
export function GateShell({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
        <span className="text-lg font-semibold tracking-tight">Iqos Haven</span>
        <span className="rounded-pill bg-accent-soft px-3 py-1 text-xs font-medium text-ink">
          {AGE_COPY.badge}
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <section
          aria-labelledby={labelledBy}
          className="flex w-full max-w-lg flex-col gap-6 text-center"
        >
          {children}
        </section>
      </main>
      <footer className="px-4 py-4 text-center text-xs text-ink-2 sm:px-8">
        {AGE_COPY.footer}
      </footer>
    </div>
  );
}
