"use client";
import { useId, useState } from "react";
import {
  GUIDE_LIMITS,
  guideResponseSchema,
  guidesResponseSchema,
  readGuideBody,
  type GuideResponse,
} from "@ih/contracts";
import { managementRequest } from "../lib/management";
import { when } from "../lib/orders";
import { toast } from "../lib/ui/toast";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";

/** A link-safe slug from a title: lower-case words joined by single hyphens. */
export function slugFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GUIDE_LIMITS.slug)
    .replace(/-+$/, "");
}

function StatusTag({ guide }: { guide: GuideResponse }) {
  return guide.published ? (
    <span className="tag ok">
      <Icon name="check" size="sm" />
      Published
    </span>
  ) : (
    <span className="tag">
      <Icon name="eye-off" size="sm" />
      {guide.publishedAt ? "Hidden" : "Draft"}
    </span>
  );
}

/**
 * Guides (ADR 0117): articles shown under /guides in the store and offered to search engines
 * with the catalogue. Owner only (`content.manage`). A guide is hidden, never deleted; once
 * published its link stays the same.
 */
export function GuideManagement() {
  const [editing, setEditing] = useState<GuideResponse | "new" | null>(null);
  const guides = useManagementResource("/guides", guidesResponseSchema);
  const items = guides.data?.items ?? [];
  return (
    <>
      <PageHead
        title="Guides"
        sub="Articles for the store's Guides page. They help shoppers choose and bring visitors from search."
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            New guide
          </button>
        }
      />
      <ResourceNotice resource={guides} compact />
      {guides.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name="file" />
              </div>
              <h3>No guides yet</h3>
              <p>Write a guide about a device or a set of flavours, then publish it.</p>
              <div className="row">
                <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
                  <Icon name="plus" />
                  New guide
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Guide</th>
                    <th>Status</th>
                    <th>Last change</th>
                    <th className="w1">
                      <span className="sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((guide) => (
                    <tr key={`${guide.id}-${guide.version}`}>
                      <td>
                        <b>{guide.title}</b>
                        <div className="small muted">/guides/{guide.slug}</div>
                      </td>
                      <td>
                        <StatusTag guide={guide} />
                      </td>
                      <td className="small">{when(guide.updatedAt)}</td>
                      <td className="w1">
                        <button
                          type="button"
                          className="ibtn"
                          aria-label={`Edit ${guide.title}`}
                          onClick={() => setEditing(guide)}
                        >
                          <Icon name="edit" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      {editing && (
        <GuideDrawer
          key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
          guide={editing === "new" ? null : editing}
          resource={guides}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            toast(saved.published ? `"${saved.title}" is live` : `"${saved.title}" saved`);
            guides.reload();
          }}
        />
      )}
    </>
  );
}

function GuideDrawer({
  guide,
  resource,
  onClose,
  onSaved,
}: {
  guide: GuideResponse | null;
  resource: Pick<
    ReturnType<typeof useManagementResource>,
    "run" | "disabled" | "message" | "busy" | "denied" | "reload"
  >;
  onClose: () => void;
  onSaved: (saved: GuideResponse) => void;
}) {
  const form = useId();
  const [title, setTitle] = useState(guide?.title ?? "");
  const [slug, setSlug] = useState(guide?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(guide !== null);
  const [summary, setSummary] = useState(guide?.summary ?? "");
  const [body, setBody] = useState(guide?.body ?? "");
  const [published, setPublished] = useState(guide?.published ?? false);
  const slugLocked = guide?.publishedAt != null;
  const problems = body.trim() ? readGuideBody(body).problems : [];
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={guide ? `Edit "${guide.title}"` : "New guide"}
      sub={guide ? <StatusTag guide={guide} /> : "Draft until you publish it"}
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={form}
            className="btn btn-p"
            disabled={resource.disabled || problems.length > 0}
          >
            {published ? "Save and publish" : "Save"}
          </button>
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved={guide ? guide.title : "this new guide"}
        onSubmit={async (event) => {
          event.preventDefault();
          const fields = { slug, title, summary, body, published };
          const outcome = await resource.run((signal) =>
            guide
              ? managementRequest(
                  "/guides/" + guide.id,
                  guideResponseSchema,
                  "PATCH",
                  { ...fields, version: guide.version },
                  signal,
                )
              : managementRequest("/guides", guideResponseSchema, "POST", fields, signal),
          );
          if (outcome.ok) onSaved(outcome.value);
        }}
      >
        <ResourceNotice resource={resource} compact />
        <fieldset className="plain-fs form" disabled={resource.disabled}>
          <div className="field">
            <label className="label" htmlFor={`${form}-title`}>
              <span>Title</span>
            </label>
            <input
              id={`${form}-title`}
              className="input"
              required
              maxLength={GUIDE_LIMITS.title}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (!slugTouched) setSlug(slugFromTitle(event.target.value));
              }}
            />
            <p className="help">Shown as the heading and in search results.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${form}-slug`}>
              <span>Link</span>
            </label>
            <div className="row nowrap-row">
              <span className="muted small">/guides/</span>
              <input
                id={`${form}-slug`}
                className="input mono"
                required
                readOnly={slugLocked}
                maxLength={GUIDE_LIMITS.slug}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                value={slug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value);
                }}
              />
            </div>
            <p className="help">
              {slugLocked
                ? "This guide has been published, so its link stays the same."
                : "Lowercase letters, numbers and single hyphens. It cannot change after publishing."}
            </p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${form}-summary`}>
              <span>Summary</span>
              <span className="opt">
                {summary.length}/{GUIDE_LIMITS.summary}
              </span>
            </label>
            <textarea
              id={`${form}-summary`}
              className="textarea"
              required
              rows={2}
              maxLength={GUIDE_LIMITS.summary}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <p className="help">One or two sentences: the guide list and search results show it.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${form}-body`}>
              <span>Text</span>
              <span className="opt">
                {body.length}/{GUIDE_LIMITS.body}
              </span>
            </label>
            <textarea
              id={`${form}-body`}
              className="textarea mono"
              required
              rows={18}
              maxLength={GUIDE_LIMITS.body}
              value={body}
              aria-describedby={`${form}-format`}
              onChange={(event) => setBody(event.target.value)}
            />
            <p id={`${form}-format`} className="help">
              Leave an empty line between paragraphs. <code>## </code> starts a heading,{" "}
              <code>### </code> a smaller one, <code>- </code> a list item. Write{" "}
              <code>**bold**</code> for bold and <code>[link text](/sticks)</code> for a link to a
              store page.
            </p>
            {problems.length > 0 && (
              <ul className="err" role="alert">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={published}
              onChange={(event) => setPublished(event.target.checked)}
            />
            <span>Published: shown on the store&apos;s Guides page</span>
          </label>
        </fieldset>
      </form>
    </Drawer>
  );
}
