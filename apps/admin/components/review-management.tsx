"use client";
import Link from "next/link";
import { useState } from "react";
import {
  adminReviewsResponseSchema,
  reviewModerationResponseSchema,
  type AdminReview,
} from "@ih/contracts";
import { orderHref, productHref } from "../lib/links";
import { managementRequest } from "../lib/management";
import { when } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

type Tab = "pending" | "approved" | "rejected" | "all";
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];
const STATUS_TAG: Record<AdminReview["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "status-pending" },
  approved: { label: "Approved · visible", className: "status-delivered" },
  rejected: { label: "Rejected · hidden", className: "status-cancelled" },
};
const stars = (rating: number) => "★".repeat(rating) + "☆".repeat(5 - rating);

/**
 * Review moderation (roadmap step 95, ADR 0063; prototype `VIEWS.reviews`). New reviews stay
 * hidden until approved; rejecting hides one, also after approval. There is no delete: a
 * review is kept as a record. Each decision is made on the version shown.
 */
export function ReviewManagement({
  canOpenOrders,
  canOpenProducts,
}: {
  canOpenOrders: boolean;
  canOpenProducts: boolean;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  const [productId, setProductId] = useState("");
  const [rating, setRating] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({ limit: "25" });
  if (tab !== "all") params.set("status", tab);
  if (productId) params.set("productId", productId);
  if (rating) params.set("rating", rating);
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const reviews = useManagementResource(`/reviews?${params}`, adminReviewsResponseSchema);
  const data = reviews.data;
  const reset = (change: () => void) => {
    change();
    setCursors([]);
  };

  async function decide(review: AdminReview, decision: "approve" | "reject") {
    const outcome = await reviews.run((signal) =>
      managementRequest(
        `/reviews/${review.id}/moderation`,
        reviewModerationResponseSchema,
        "POST",
        { decision, expectedVersion: review.version },
        signal,
      ),
    );
    // The list, counts and average all move: read them again.
    if (outcome.ok) reviews.reload();
  }

  const filtered = Boolean(productId || rating);
  return (
    <section className="management-card order-management">
      <header className="card-heading">
        <div>
          <h2>Reviews</h2>
          <p className="muted">
            New reviews stay hidden until approved ·{" "}
            {data?.approvedAverage != null ? data.approvedAverage.toFixed(1) : "—"} average from{" "}
            {data?.counts.approved ?? 0} published{" "}
            {data?.counts.approved === 1 ? "review" : "reviews"}
          </p>
        </div>
      </header>
      <div className="tab-list" role="tablist" aria-label="Review status">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            className="secondary-button"
            aria-selected={tab === item.key}
            onClick={() => reset(() => setTab(item.key))}
          >
            {item.label}
            {data && item.key !== "all" && <small> {data.counts[item.key]}</small>}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>
          <span>Product</span>
          <select
            value={productId}
            onChange={(event) => reset(() => setProductId(event.target.value))}
          >
            <option value="">All products</option>
            {data?.products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Rating</span>
          <select value={rating} onChange={(event) => reset(() => setRating(event.target.value))}>
            <option value="">Any rating</option>
            {[5, 4, 3, 2, 1].map((value) => (
              <option key={value} value={value}>
                {value} {value === 1 ? "star" : "stars"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ResourceNotice resource={reviews} />
      {data &&
        (data.items.length === 0 ? (
          tab === "pending" && !filtered ? (
            <div className="empty-panel">
              <h3>No reviews waiting</h3>
              <p className="muted">
                New customer reviews will appear here for approval before they show on the store.
              </p>
            </div>
          ) : (
            <div className="empty-panel">
              <h3>No reviews here</h3>
              <p className="muted">Try another filter.</p>
            </div>
          )
        ) : (
          <ul className="record-list">
            {data.items.map((review) => (
              <li key={review.id}>
                <article className="record-card">
                  <header className="card-heading">
                    <div>
                      <span aria-label={`${review.rating} out of 5 stars`}>
                        {stars(review.rating)}
                      </span>{" "}
                      <strong>{review.title}</strong>
                    </div>
                    <span className={`order-status ${STATUS_TAG[review.status].className}`}>
                      {STATUS_TAG[review.status].label}
                    </span>
                  </header>
                  <p className="review-body">{review.body}</p>
                  <p className="muted small">
                    {canOpenProducts ? (
                      <Link href={productHref(review.product.id)}>{review.product.name}</Link>
                    ) : (
                      review.product.name
                    )}{" "}
                    · {review.authorName} · {when(review.createdAt)}
                    {review.verified && " · ✓ Verified order"}
                    {canOpenOrders && review.order && (
                      <>
                        {" "}
                        <Link className="mono" href={orderHref(review.order.id)}>
                          {review.order.orderNumber}
                        </Link>
                      </>
                    )}
                  </p>
                  <div className="form-actions">
                    {review.status !== "approved" && (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={reviews.disabled}
                        onClick={() => void decide(review, "approve")}
                      >
                        Approve
                      </button>
                    )}
                    {review.status !== "rejected" && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={reviews.disabled}
                        onClick={() => void decide(review, "reject")}
                      >
                        {review.status === "approved" ? "Hide (reject)" : "Reject"}
                      </button>
                    )}
                  </div>
                </article>
              </li>
            ))}
          </ul>
        ))}
      {data && (
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={cursors.length === 0 || reviews.busy}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous page
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!data.nextCursor || reviews.busy}
            onClick={() => setCursors((value) => [...value, data.nextCursor!])}
          >
            Next page
          </button>
        </div>
      )}
    </section>
  );
}
