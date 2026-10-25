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
import { confirmDialog } from "../lib/ui/confirm";
import { toast } from "../lib/ui/toast";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { PageHead } from "./page-head";

type Tab = "pending" | "approved" | "rejected" | "all";
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];
/** The prototype's stars (`stars`): five star icons, the unearned ones dimmed. */
function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} className={i > rating ? "i off" : "i"} aria-hidden="true">
          <use href="#i-star" />
        </svg>
      ))}
    </span>
  );
}

/**
 * Review moderation (roadmap step 95, ADR 0063) in the prototype's layout (`VIEWS.reviews`, ADR
 * 0097 V-A8). New reviews stay
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
    if (outcome.ok) {
      reviews.reload();
      toast(
        decision === "approve"
          ? "Review approved and visible on the product page"
          : "Review rejected and hidden",
      );
    }
  }
  /** The prototype's "Approve all": each listed review in turn, on the version shown. */
  async function approveAll(list: readonly AdminReview[]) {
    if (
      !(await confirmDialog({
        title: `Approve ${list.length} reviews?`,
        body: "They become visible on their product pages.",
        ok: `Approve ${list.length}`,
      }))
    )
      return;
    let approved = 0;
    for (const review of list) {
      const outcome = await reviews.run((signal) =>
        managementRequest(
          `/reviews/${review.id}/moderation`,
          reviewModerationResponseSchema,
          "POST",
          { decision: "approve", expectedVersion: review.version },
          signal,
        ),
      );
      if (!outcome.ok) break;
      approved += 1;
    }
    reviews.reload();
    if (approved) toast(`${approved} ${approved === 1 ? "review" : "reviews"} approved`);
  }

  const filtered = Boolean(productId || rating);
  const items = data?.items ?? [];
  return (
    <>
      <PageHead
        title="Reviews"
        sub={
          <>
            New reviews stay hidden until approved ·{" "}
            {data?.approvedAverage != null ? data.approvedAverage.toFixed(1) : "—"} average from{" "}
            {data?.counts.approved ?? 0} published{" "}
            {data?.counts.approved === 1 ? "review" : "reviews"}
          </>
        }
      />
      <div className="stack orders-head">
        <div className="tabs" role="tablist" aria-label="Review status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === item.key}
              onClick={() => reset(() => setTab(item.key))}
            >
              {item.label}
              {data && (
                <span className="c">
                  {item.key === "all"
                    ? data.counts.pending + data.counts.approved + data.counts.rejected
                    : data.counts[item.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <select
            className="fsel"
            aria-label="Product"
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
          <select
            className="fsel"
            aria-label="Rating"
            value={rating}
            onChange={(event) => reset(() => setRating(event.target.value))}
          >
            <option value="">Any rating</option>
            {[5, 4, 3, 2, 1].map((value) => (
              <option key={value} value={value}>
                {value} {value === 1 ? "star" : "stars"}
              </option>
            ))}
          </select>
          {tab === "pending" && items.length > 1 && (
            <button
              type="button"
              className="btn btn-s toolbar-end"
              disabled={reviews.disabled}
              onClick={() => void approveAll(items)}
            >
              <Icon name="check" />
              Approve all {items.length}
            </button>
          )}
        </div>
      </div>
      <ResourceNotice resource={reviews} compact />
      {data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name={tab === "pending" && !filtered ? "check-c" : "star"} />
              </div>
              {tab === "pending" && !filtered ? (
                <>
                  <h3>No reviews waiting</h3>
                  <p>
                    New customer reviews will appear here for approval before they show on the
                    store.
                  </p>
                </>
              ) : (
                <>
                  <h3>No reviews here</h3>
                  <p>Try another filter.</p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="card">
            {items.map((review) => (
              <article key={review.id} className="rv">
                <div className="rv-h">
                  <Stars rating={review.rating} />
                  <h4>{review.title}</h4>
                  {review.status === "pending" ? (
                    <span className="tag low">
                      <Icon name="clock" size="sm" />
                      Pending
                    </span>
                  ) : review.status === "approved" ? (
                    <span className="tag ok">
                      <Icon name="check" size="sm" />
                      Approved · visible
                    </span>
                  ) : (
                    <span className="tag">
                      <Icon name="eye-off" size="sm" />
                      Rejected · hidden
                    </span>
                  )}
                </div>
                <p>{review.body}</p>
                <div className="row small muted rv-meta">
                  {canOpenProducts ? (
                    <Link className="lnk" href={productHref(review.product.id)}>
                      {review.product.name}
                    </Link>
                  ) : (
                    <span>{review.product.name}</span>
                  )}
                  <span>{review.authorName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{when(review.createdAt)}</span>
                  {review.verified && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="row rv-verified">
                        <Icon name="check-c" size="sm" />
                        Verified order
                        {canOpenOrders && review.order && (
                          <Link className="lnk mono" href={orderHref(review.order.id)}>
                            {review.order.orderNumber}
                          </Link>
                        )}
                      </span>
                    </>
                  )}
                </div>
                <div className="rv-a">
                  {review.status !== "approved" && (
                    <button
                      type="button"
                      className="btn btn-p btn-sm"
                      disabled={reviews.disabled}
                      onClick={() => void decide(review, "approve")}
                    >
                      <Icon name="check" size="sm" />
                      Approve
                    </button>
                  )}
                  {review.status !== "rejected" && (
                    <button
                      type="button"
                      className="btn btn-s btn-sm"
                      disabled={reviews.disabled}
                      onClick={() => void decide(review, "reject")}
                    >
                      <Icon name="x" size="sm" />
                      {review.status === "approved" ? "Hide (reject)" : "Reject"}
                    </button>
                  )}
                </div>
              </article>
            ))}
            <div className="tbl-f">
              <span>
                {items.length} {items.length === 1 ? "review" : "reviews"} on this page
              </span>
              <div className="pager">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={cursors.length === 0 || reviews.busy}
                  onClick={() => setCursors((value) => value.slice(0, -1))}
                >
                  <Icon name="cl" size="sm" />
                </button>
                <button type="button" aria-current="page" aria-label={`Page ${cursors.length + 1}`}>
                  {cursors.length + 1}
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={!data.nextCursor || reviews.busy}
                  onClick={() => setCursors((value) => [...value, data.nextCursor!])}
                >
                  <Icon name="cr" size="sm" />
                </button>
              </div>
            </div>
          </div>
        ))}
    </>
  );
}
