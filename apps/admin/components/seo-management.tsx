"use client";
import { confirmDialog } from "../lib/ui/confirm";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  seoIssuesResponseSchema,
  seoOverviewSchema,
  type SeoIssuesResponse,
  type SeoOverview,
} from "@ih/contracts";
import { productHref } from "../lib/links";
import { Icon } from "./icons";
import { PageHead } from "./page-head";

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
    if (
      !(await confirmDialog({
        title:
          indexing === "public_pages"
            ? "Open policy pages to search engines?"
            : "Close the store to search engines?",
        body: message,
        ok: indexing === "public_pages" ? "Open to search engines" : "Close to search engines",
      }))
    )
      return;
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

  const [q, setQ] = useState("");
  const [entity, setEntity] = useState<"" | keyof typeof ENTITY_LABELS>("");
  const items = (issues?.items ?? []).filter(
    (item) =>
      (!entity || item.entity === entity) &&
      (!q.trim() || item.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const pages = issues
    ? issues.checked.products + issues.checked.brands + issues.checked.categories
    : null;
  const pagesWithIssues = issues ? new Set(issues.items.map((item) => item.id)).size : null;
  const saved = notice?.startsWith("Saved");
  return (
    <>
      <PageHead
        title="SEO"
        sub="What search engines may see, and the titles and descriptions of the pages shoppers reach."
      />
      {notice && (
        <div className={saved ? "note ok" : "note err"} role="status">
          <Icon name={saved ? "check-c" : "alert"} />
          <p>{notice}</p>
        </div>
      )}
      {overview && (
        <div className="kpis">
          <div className="kpi">
            <span className="kpi-l">Store indexing</span>
            <span className="kpi-v kpi-v-sm">
              {overview.policy.indexing === "closed" ? "Closed" : "Public pages"}
            </span>
            <span className="kpi-f">
              <span className="delta-c">
                {overview.policy.indexing === "closed"
                  ? "robots.txt disallows the store"
                  : "policy pages only"}
              </span>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-l">Product indexing</span>
            <span className="kpi-v kpi-v-sm">Off</span>
            <span className="kpi-f">
              <span className="delta-c">Needs business decision BI-05</span>
            </span>
          </div>
          {issues && (
            <>
              <div className="kpi">
                <span className="kpi-l">Pages checked</span>
                <span className="kpi-v">{pages}</span>
                <span className="kpi-f">
                  <span className="delta-c">published products, brands, categories</span>
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-l">Need attention</span>
                <span className={pagesWithIssues ? "kpi-v warn-t" : "kpi-v ok-t"}>
                  {pagesWithIssues}
                </span>
                <span className="kpi-f">
                  <span className="delta-c">missing, too long or repeated</span>
                </span>
              </div>
            </>
          )}
        </div>
      )}
      {overview && (
        <div className="grid g2 an-split">
          <section className="card" aria-labelledby="seo-policy">
            <div className="card-h">
              <h2 id="seo-policy">Search engines</h2>
            </div>
            <div className="card-b form">
              <fieldset className="plain-fs" disabled={busy}>
                <legend className="label">What search engines may be offered</legend>
                <div className="radios">
                  <label className="ropt">
                    <input
                      type="radio"
                      name="indexing"
                      checked={overview.policy.indexing === "closed"}
                      onChange={() => void choose("closed")}
                    />
                    <span>
                      <b>Closed</b>
                      <small>Nothing is offered; robots.txt disallows the whole store.</small>
                    </span>
                  </label>
                  <label className="ropt">
                    <input
                      type="radio"
                      name="indexing"
                      checked={overview.policy.indexing === "public_pages"}
                      onChange={() => void choose("public_pages")}
                    />
                    <span>
                      <b>Public pages</b>
                      <small>
                        Responsible use, terms and privacy may be indexed and are listed in
                        sitemap.xml. Products, brands and categories stay hidden.
                      </small>
                    </span>
                  </label>
                </div>
              </fieldset>
              <p className="help">
                {overview.updatedAt
                  ? `Last changed ${dubaiTime(overview.updatedAt)}.`
                  : "Never changed."}{" "}
                Product indexing needs a separate decision (business input BI-05) and is not offered
                here.
              </p>
            </div>
          </section>
          <section className="card" aria-labelledby="seo-features">
            <div className="card-h">
              <h2 id="seo-features">What is active</h2>
            </div>
            <ul className="list an-list seo-features">
              {overview.features.map((feature) => (
                <li className="li" key={feature.key}>
                  <span className="li-b">
                    <span className="row tag-gap">
                      {feature.state === "active" ? (
                        <span className="tag ok">
                          <Icon name="check" size="sm" />
                          Active
                        </span>
                      ) : (
                        <span className="tag">Inactive</span>
                      )}
                      <b>{feature.label}</b>
                    </span>
                    <small>{feature.note}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {canReport && issues && (
        <section className="tbl-wrap" aria-labelledby="seo-issues">
          <div className="card-h an-tbl-h">
            <div>
              <h2 id="seo-issues">SEO issues</h2>
              <p className="sub">
                Checked at {dubaiTime(issues.generatedAt)}. Titles over {issues.limits.title} and
                descriptions over {issues.limits.description} characters are cut short in search
                results. Fix them on the page itself.
              </p>
            </div>
            <button className="btn btn-g btn-sm" type="button" onClick={load}>
              <Icon name="refresh" size="sm" />
              Check again
            </button>
          </div>
          <div className="toolbar seo-toolbar">
            <div className="search">
              <Icon name="search" />
              <label className="sr" htmlFor="seo-q">
                Search pages
              </label>
              <input
                id="seo-q"
                type="search"
                placeholder="Search pages"
                value={q}
                maxLength={100}
                onChange={(event) => setQ(event.target.value)}
              />
            </div>
            <select
              className="fsel"
              aria-label="Page type"
              value={entity}
              onChange={(event) => setEntity(event.target.value as typeof entity)}
            >
              <option value="">All page types</option>
              {(Object.keys(ENTITY_LABELS) as Array<keyof typeof ENTITY_LABELS>).map((key) => (
                <option key={key} value={key}>
                  {ENTITY_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          {items.length ? (
            // Scrolls sideways on a phone, so it takes keyboard focus (WCAG 2.1.1, axe).
            <div className="tbl-scroll" role="region" aria-label="Page issues" tabIndex={0}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Issue</th>
                    <th className="hide-m">Detail</th>
                    <th className="w1">
                      <span className="sr">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={`${item.kind}:${item.id}`}>
                      <td>
                        <b className="cust">{item.name}</b>
                        <div className="mono xs muted">
                          /{item.slug} · {ENTITY_LABELS[item.entity]}
                        </div>
                      </td>
                      <td>
                        <span className="tag low">
                          <Icon name="alert" size="sm" />
                          {ISSUE_LABELS[item.kind]}
                        </span>
                      </td>
                      <td className="small hide-m seo-detail">{item.detail ?? "—"}</td>
                      <td className="w1">
                        <Link className="btn btn-g btn-sm" href={editHref(item)}>
                          Edit
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty dash-empty">
              <div className="ic">
                <Icon name="check-c" />
              </div>
              <h3>{issues.items.length ? "No matching pages" : "Nothing needs attention"}</h3>
              <p>
                {issues.items.length
                  ? "Try another page type or name."
                  : "Every page has a title and description of the right length."}
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** Where a page's SEO fields are edited: the product itself, or the brand or category list. */
function editHref(item: SeoIssuesResponse["items"][number]) {
  if (item.entity === "product") return productHref(item.id);
  return item.entity === "brand" ? "/workspace/brands" : "/workspace/categories";
}
