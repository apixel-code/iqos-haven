import type { StoreProductResponse } from "@ih/contracts";
import { Icon } from "@/components/icons";

/** Five stars, filled to the nearest half (prototype `stars`). Read out as "4.5 out of 5". */
export function Stars({ value }: { value: number }) {
  return (
    <span className="stars" role="img" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <svg key={star} className={value >= star - 0.25 ? "i" : "i off"} aria-hidden="true">
          <use href="#i-star" />
        </svg>
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

/** Under the product name: the rating, linking to the reviews below (prototype `rate-link`). */
export function RatingLink({ rating }: { rating: StoreProductResponse["rating"] }) {
  return (
    <a href="#reviews" className="rate-link">
      <Stars value={rating?.average ?? 0} />
      <span>
        {rating ? `${rating.average.toFixed(1)} · ${reviewCount(rating.count)}` : "No reviews yet"}
      </span>
    </a>
  );
}

/**
 * Reviews on the product page (roadmap step 95, prototype `reviews`): approved reviews only, as
 * the API gives them. The rating, the bars and the list all come from the server; nothing is
 * computed or invented here (the prototype's demo reviews, weights and badge are not carried over).
 */
export function ProductReviews({
  rating,
  reviews,
}: Pick<StoreProductResponse, "rating" | "reviews">) {
  return (
    <section className="sec rv-sec" id="reviews" aria-labelledby="reviews-h">
      <h2 className="h2 rv-title" id="reviews-h">
        Reviews
      </h2>
      {!rating ? (
        <div className="empty rv-empty">
          <span className="ic">
            <Icon name="star" size="lg" />
          </span>
          <h3 className="h3">No reviews yet</h3>
          <p>
            Reviews from delivered orders will appear here. Customers get a review link after
            delivery.
          </p>
        </div>
      ) : (
        <div className="two rv-two">
          <div className="rv-side">
            <div className="rv-sum">
              <div>
                <div className="rv-avg">{rating.average.toFixed(1)}</div>
                <Stars value={rating.average} />
                <p className="small muted rv-count">{reviewCount(rating.count)}</p>
              </div>
              <dl className="rv-bars">
                {rating.distribution.map((count, index) => {
                  const stars = 5 - index;
                  return (
                    <div key={stars}>
                      <dt>
                        {stars}
                        <span className="sr"> {stars === 1 ? "star" : "stars"}</span>
                      </dt>
                      <dd>
                        <s>
                          <i style={{ width: `${(count / rating.count) * 100}%` }} />
                        </s>
                      </dd>
                      <dd className="muted">{count}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            <p className="small muted">
              Only customers with a delivered order can leave a review. Reviews are checked before
              they appear.
            </p>
          </div>
          <ul className="rv-list">
            {reviews.map((review, index) => (
              <li key={index}>
                <article className="rv">
                  <div className="rv-h">
                    <Stars value={review.rating} />
                    <span>
                      {review.authorName} · {shownDate(review.date)}
                      {review.verified && <span className="rv-ok"> · ✓ Verified purchase</span>}
                    </span>
                  </div>
                  <b>{review.title}</b>
                  <p className="muted rv-body">{review.body}</p>
                </article>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
