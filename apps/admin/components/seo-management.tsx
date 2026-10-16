"use client";
import { useCallback, useEffect, useState } from "react";
import {
  seoIssuesResponseSchema,
  seoOverviewSchema,
  type SeoIssuesResponse,
  type SeoOverview,
} from "@ih/contracts";

const ISSUE_LABELS: Record<SeoIssuesResponse["items"][number]["kind"], string> = {
  missing_title: "No SEO title (the name is used)",
  missing_description: "No SEO description (the store text is used)",
  title_too_long: "Title longer than search results show",
  description_too_long: "Description longer than search results show",
  duplicate_title: "Same title as another page",
};
const ENTITY_LABELS = { product: "Product", brand: "Brand", category: "Category" } as const;
const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

/**
 * SEO (roadmap step 113, ADR 0079). Shows what is really active, lets the Owner choose the
 * indexing policy (closed, or the public policy pages), and lists SEO problems of what shoppers
 * can reach. Product indexing is shown as inactive, never as a switch (BI-05). The SEO fields
 * themselves are edited on each product, brand and category.
 */
export function SeoManagement({ canReport }: { canReport: boolean }) {
  const [overview, setOverview] = useState<SeoOverview | null>(null);
  const [issues, setIssues] = useState<SeoIssuesResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch("/api/v1/admin/seo", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setOverview(seoOverviewSchema.parse(await response.json()));
      })
      .catch(() => setNotice("SEO settings could not be loaded."));
    if (canReport)
      fetch("/api/v1/admin/seo/issues", { credentials: "same-origin", cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          setIssues(seoIssuesResponseSchema.parse(await response.json()));
        })
        .catch(() => setNotice("The SEO report could not be loaded."));
  }, [canReport]);
  useEffect(load, [load]);

  async function choose(indexing: SeoOverview["policy"]["indexing"]) {
    if (!overview || overview.policy.indexing === indexing) return;
    const message =
      indexing === "public_pages"
        ? "Offer the responsible-use, terms and privacy pages to search engines? Products stay hidden from them."
        : "Close the store to search engines again? robots.txt will disallow everything.";
    if (!window.confirm(message)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/v1/admin/seo/policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: overview.version, indexing }),
      });
      if (response.status === 409) {
        setNotice("Someone changed this meanwhile. The current setting is shown; try again.");
        load();
      } else if (!response.ok) setNotice("The setting could not be saved.");
      else {
        setOverview(seoOverviewSchema.parse(await response.json()));
        setNotice("Saved. The storefront follows within a minute.");
      }
    } catch {
      setNotice("The setting could not be saved. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {overview && (
        <section className="management-card" aria-labelledby="seo-policy">
          <h2 id="seo-policy">Search engines</h2>
          <fieldset className="seo-choices" disabled={busy}>
            <legend className="muted small">What search engines may be offered</legend>
            <label className="seo-choice">
              <input
                type="radio"
                name="indexing"
                checked={overview.policy.indexing === "closed"}
                onChange={() => void choose("closed")}
              />
              <span>
                <b>Closed</b> — nothing is offered; robots.txt disallows the whole store.
              </span>
            </label>
            <label className="seo-choice">
              <input
                type="radio"
                name="indexing"
                checked={overview.policy.indexing === "public_pages"}
                onChange={() => void choose("public_pages")}
              />
              <span>
                <b>Public pages</b> — responsible use, terms and privacy may be indexed and are
                listed in sitemap.xml. Products, brands and categories stay hidden.
              </span>
            </label>
          </fieldset>
          <p className="muted small">
            {overview.updatedAt
              ? `Last changed ${dubaiTime(overview.updatedAt)}.`
              : "Never changed."}{" "}
            Product indexing needs a separate decision (business input BI-05) and is not offered
            here.
          </p>
        </section>
      )}
      {overview && (
        <section className="management-card" aria-labelledby="seo-features">
          <h2 id="seo-features">What is active</h2>
          <ul className="dashboard-list">
            {overview.features.map((feature) => (
              <li key={feature.key}>
                <span className={feature.state === "active" ? "seo-active" : "seo-inactive"}>
                  {feature.state === "active" ? "Active" : "Inactive"}
                </span>{" "}
                <b>{feature.label}</b>
                <br />
                <span className="muted small">{feature.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {canReport && issues && (
        <section className="management-card" aria-labelledby="seo-issues">
          <div className="inline-row">
            <h2 id="seo-issues">SEO issues</h2>
            <button className="text-button" type="button" onClick={load}>
              Check again
            </button>
          </div>
          <p className="muted small">
            Checked {issues.checked.products} published products, {issues.checked.brands} brands and{" "}
            {issues.checked.categories} categories at {dubaiTime(issues.generatedAt)}. Titles over{" "}
            {issues.limits.title} and descriptions over {issues.limits.description} characters are
            cut short in search results. Fix them on the page itself.
          </p>
          {issues.items.length ? (
            <div className="order-table-wrap">
              <table className="order-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Page</th>
                    <th>Address</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.items.map((item) => (
                    <tr key={`${item.kind}:${item.id}`}>
                      <td>{ISSUE_LABELS[item.kind]}</td>
                      <td>
                        {ENTITY_LABELS[item.entity]}: {item.name}
                      </td>
                      <td>{item.slug}</td>
                      <td>{item.detail ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No issues found.</p>
          )}
        </section>
      )}
    </div>
  );
}
