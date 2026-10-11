"use client";

/**
 * Catalogue pages could not be loaded (API busy, limited or unavailable). No technical detail
 * is shown; the shopper can retry.
 */
export default function ShopError({ reset }: { reset: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3.5 rounded-lg border border-dashed border-line-2 bg-surface px-5 py-14 text-center"
    >
      <h1 className="text-lg font-semibold">We couldn&apos;t load this page</h1>
      <p className="text-sm text-ink-2">
        Something went wrong on our side. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-10 items-center rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Try again
      </button>
    </div>
  );
}
