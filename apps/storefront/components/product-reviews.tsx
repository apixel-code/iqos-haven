import type { StoreProductResponse } from "@ih/contracts";

/** Five stars, filled to the nearest half (prototype `stars`). Read out as "4.5 out of 5". */
export function Stars({ value, size = "text-base" }: { value: number; size?: string }) {
  return (
    <span role="img" aria-label={`${value} out of 5`} className={`inline-flex ${size}`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          aria-hidden
          className={value >= star - 0.25 ? "text-accent" : "text-line-2"}
        >
          ★
        </span>
      ))}
    </span>
  );
}

const reviewCount = (count: number) => `${count} ${count === 1 ? "review" : "reviews"}`;
/** "15 Oct 2026" from the API's calendar date; no clock, so no time zone shift. */
const shownDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date + "T00:00:00Z"));

/** Under the product name: the rating, linking to the reviews below. */
export function RatingLink({ rating }: { rating: StoreProductResponse["rating"] }) {
  return (
    <a
      href="#reviews"
      className="inline-flex items-center gap-2 self-start text-sm text-ink-2 hover:text-ink"
    >
      <Stars value={rating?.average ?? 0} />
      <span>
        {rating ? `${rating.average.toFixed(1)} · ${reviewCount(rating.count)}` : "No reviews yet"}
      </span>
    </a>
  );
}

/**
 * Reviews on the product page (roadmap step 95): approved reviews only, as the API gives them.
 * The rating, the bars and the list all come from the server; nothing is computed or invented
 * here (the prototype's demo reviews and weights are not carried over).
 */
export function ProductReviews({
  rating,
  reviews,
}: Pick<StoreProductResponse, "rating" | "reviews">) {
  return (
    <section
      id="reviews"
      aria-labelledby="reviews-h"
      className="flex scroll-mt-24 flex-col gap-4 pt-12"
    >
      <h2 id="reviews-h" className="text-xl font-semibold tracking-tight">
        Reviews
      </h2>
      {!rating ? (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-line bg-surface px-5 py-9 text-center">
          <span aria-hidden className="text-2xl text-line-2">
            ★
          </span>
          <h3 className="text-lg font-semibold">No reviews yet</h3>
          <p className="text-sm text-ink-2">
            Reviews from delivered orders will appear here. Customers get a review link after
            delivery.
          </p>
        </div>
      ) : (
        <div className="grid gap-7 md:grid-cols-[minmax(0,320px)_1fr]">
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[auto_1fr] items-center gap-5 rounded-md border border-line bg-surface p-5">
              <div>
                <div className="text-[44px] font-semibold leading-none">
                  {rating.average.toFixed(1)}
                </div>
                <Stars value={rating.average} />
                <p className="mt-1 text-xs text-ink-2">{reviewCount(rating.count)}</p>
              </div>
              <dl className="flex flex-col gap-1.5 text-xs">
                {rating.distribution.map((count, index) => {
                  const stars = 5 - index;
                  return (
                    <div key={stars} className="grid grid-cols-[14px_1fr_28px] items-center gap-2">
                      <dt>
                        {stars}
                        <span className="sr-only"> {stars === 1 ? "star" : "stars"}</span>
                      </dt>
                      <dd className="h-1.5 overflow-hidden rounded-pill bg-line">
                        <span
                          className="block h-full bg-ink"
                          style={{ width: `${(count / rating.count) * 100}%` }}
                        />
                      </dd>
                      <dd className="text-right text-ink-2">{count}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            <p className="text-xs text-ink-2">
              Only customers with a delivered order can leave a review. Reviews are checked before
              they appear.
            </p>
          </div>
          <ul className="flex flex-col gap-5">
            {reviews.map((review, index) => (
              <li key={index}>
                <article className="flex flex-col gap-1.5 border-b border-line pb-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
                    <Stars value={review.rating} size="text-sm" />
                    <span>
                      {review.authorName} · {shownDate(review.date)}
                    </span>
                    {review.verified && (
                      <span className="font-medium text-success">✓ Verified purchase</span>
                    )}
                  </div>
                  <b className="text-[15px] font-semibold">{review.title}</b>
                  <p className="whitespace-pre-line break-words text-sm text-ink-2">
                    {review.body}
                  </p>
                </article>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
