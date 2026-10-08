/**
 * Placeholder shell (roadmap step 8). Real pages arrive after the age boundary (steps 55–64).
 * Never render catalogue data here until the server-side age gate exists.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="rounded-pill bg-accent-soft px-3 py-1 text-xs font-medium text-ink">
        18+ only · Dubai
      </span>
      <h1 className="text-3xl font-semibold tracking-tight">Iqos Haven</h1>
      <p className="text-sm text-ink-2">Storefront foundation is running. Shop opens soon.</p>
    </main>
  );
}
