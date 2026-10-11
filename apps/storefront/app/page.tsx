import Link from "next/link";

/**
 * Placeholder home (the real home shell is roadmap step 64). Restricted like every other page:
 * the routing gate requires a valid age ticket before this renders.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="rounded-pill bg-accent-soft px-3 py-1 text-xs font-medium text-ink">
        18+ only · Dubai
      </span>
      <h1 className="text-3xl font-semibold tracking-tight">Iqos Haven</h1>
      <p className="text-sm text-ink-2">Browse the catalogue while the full home page is built.</p>
      <nav aria-label="Catalogue" className="flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/shop" prefetch={false} className="underline underline-offset-2">
          All products
        </Link>
        <Link href="/brands" prefetch={false} className="underline underline-offset-2">
          Brands
        </Link>
      </nav>
    </main>
  );
}
