"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  adminContentResponseSchema,
  adminContentSectionSchema,
  brandsResponseSchema,
  categoriesResponseSchema,
  contentImagesResponseSchema,
  contentPreviewResponseSchema,
  mediaAssetSchema,
  mediaUploadResponseSchema,
  productsResponseSchema,
  TICKER_MESSAGES,
  type AdminContentSection,
  type ContentLink,
  type ContentSectionKey,
} from "@ih/contracts";
import { ApiError } from "../lib/auth";
import { managementRequest } from "../lib/management";
import {
  checkDraft,
  CONTENT_TABS,
  emptyContent,
  LINK_KINDS,
  move,
  problemLines,
} from "../lib/content";
import { rejectionMessage, uploadForm, uploadRequestFor } from "../lib/media";
import { money } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

type Doc = Record<string, unknown>;
type Names = Record<string, string>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Storefront content editor (roadmap step 97, ADR 0065; prototype `VIEWS.content`). Seven fixed
 * sections with typed fields only: no HTML, no free links, no page builder. A draft is saved,
 * previewed, then published; nothing changes on the store until Publish. Owner only.
 */
export function ContentManagement() {
  const content = useManagementResource("/content", adminContentResponseSchema);
  const [tab, setTab] = useState<ContentSectionKey>("ticker");
  const [drafts, setDrafts] = useState<Partial<Record<ContentSectionKey, Doc>>>({});
  const [names, setNames] = useState<Names>({});
  const [problems, setProblems] = useState<string[]>([]);
  const remember = (more: Names) => setNames((current) => ({ ...current, ...more }));
  const section = content.data?.sections.find((item) => item.key === tab);
  const saved = (section?.draft as Doc | null) ?? emptyContent(tab);
  const draft = drafts[tab] ?? saved;
  const dirty = !same(draft, saved);
  const setDraft = (next: Doc) => setDrafts((current) => ({ ...current, [tab]: next }));

  const replace = (next: AdminContentSection) =>
    content.setData((current) =>
      current
        ? { sections: current.sections.map((item) => (item.key === next.key ? next : item)) }
        : current,
    );

  async function save() {
    if (!section) return;
    setProblems([]);
    const outcome = await content.run((signal) =>
      managementRequest(
        `/content/${tab}/draft`,
        adminContentSectionSchema,
        "PUT",
        { expectedVersion: section.version, content: checkDraft(tab, draft) },
        signal,
      ),
    );
    if (outcome.ok) {
      replace(outcome.value);
      setDrafts((current) => ({ ...current, [tab]: undefined }));
    }
  }
  async function publish() {
    if (!section) return;
    setProblems([]);
    try {
      const next = await managementRequest(
        `/content/${tab}/publish`,
        adminContentSectionSchema,
        "POST",
        { expectedVersion: section.version },
      );
      replace(next);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONTENT_REFERENCES") {
        // The preview lists exactly what blocks publishing.
        const fresh = await managementRequest(
          `/content/${tab}/preview`,
          contentPreviewResponseSchema,
        ).catch(() => null);
        setProblems(
          fresh
            ? problemLines(fresh.problems, names)
            : ["Something in this section can't be shown."],
        );
      } else
        setProblems([
          error instanceof ApiError && error.code === "VERSION_CONFLICT"
            ? "Someone changed this section meanwhile. Reload the page."
            : "Could not publish. Reload and try again.",
        ]);
    }
  }

  return (
    <section className="management-card">
      <header className="card-heading">
        <div>
          <h2>Storefront content</h2>
          <p className="muted">
            Edit the home page sections. Save a draft, check the preview, then publish: the store
            changes only when you publish.
          </p>
        </div>
      </header>
      <div className="tab-list" role="tablist" aria-label="Section">
        {CONTENT_TABS.map((item) => {
          const state = content.data?.sections.find((row) => row.key === item.key);
          const changed =
            drafts[item.key] !== undefined &&
            !same(drafts[item.key], state?.draft ?? emptyContent(item.key));
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              className="secondary-button"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setProblems([]);
              }}
            >
              {item.label}
              {changed && <small aria-label="unsaved"> •</small>}
            </button>
          );
        })}
      </div>
      <ResourceNotice resource={content} />
      {section && (
        <div className="order-detail-grid">
          <article className="record-card">
            <header className="card-heading">
              <div>
                <h3>{CONTENT_TABS.find((item) => item.key === tab)!.label}</h3>
                <p className="muted small">{CONTENT_TABS.find((item) => item.key === tab)!.help}</p>
              </div>
              <span
                className={`order-status ${dirty ? "status-pending" : section.publishedAt && !section.unpublishedChanges ? "status-delivered" : "status-confirmed"}`}
              >
                {dirty
                  ? "Unsaved"
                  : !section.publishedAt
                    ? section.version
                      ? "Draft, never published"
                      : "Not set up"
                    : section.unpublishedChanges
                      ? "Draft differs from live"
                      : "Live"}
              </span>
            </header>
            <SectionEditor
              sectionKey={tab}
              value={draft}
              onChange={setDraft}
              names={names}
              remember={remember}
            />
            <div className="form-actions">
              {dirty && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={content.disabled}
                  onClick={() => setDrafts((current) => ({ ...current, [tab]: undefined }))}
                >
                  Discard changes
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={!dirty || content.disabled}
                onClick={() => void save()}
              >
                Save draft
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  dirty || !section.unpublishedChanges || section.version === 0 || content.disabled
                }
                onClick={() => void publish()}
              >
                Publish
              </button>
            </div>
            {problems.length > 0 && (
              <div role="alert" className="notice">
                <strong>Not published:</strong>
                <ul>
                  {problems.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
          <aside className="record-card">
            <h3>Preview of the saved draft</h3>
            <p className="muted small">Approximate, not to scale. Unsaved changes are not shown.</p>
            {section.version === 0 ? (
              <p className="muted">Save a draft to see it here.</p>
            ) : (
              <PreviewPanel
                key={`${tab}:${section.version}`}
                sectionKey={tab}
                doc={saved}
                names={names}
                remember={remember}
              />
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

type PreviewData = NonNullable<ReturnType<typeof contentPreviewResponseSchema.parse>>;
/** The saved draft as the store would resolve it; read again after every save. */
function PreviewPanel({
  sectionKey,
  doc,
  names,
  remember,
}: {
  sectionKey: ContentSectionKey;
  doc: Doc;
  names: Names;
  remember: (more: Names) => void;
}) {
  const preview = useManagementResource(
    `/content/${sectionKey}/preview`,
    contentPreviewResponseSchema,
  );
  const data = preview.data;
  useEffect(() => {
    if (!data) return;
    remember(
      Object.fromEntries(
        [...data.products, ...data.brands, ...data.categories].map((item) => [item.id, item.name]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return (
    <>
      <ResourceNotice resource={preview} />
      {data && <Preview sectionKey={sectionKey} doc={doc} preview={data} names={names} />}
    </>
  );
}
function Preview({
  sectionKey,
  doc,
  preview,
  names,
}: {
  sectionKey: ContentSectionKey;
  doc: Doc;
  preview: PreviewData;
  names: Names;
}) {
  const image = preview.images[0];
  const enabled = doc.enabled !== false;
  return (
    <div className="preview-block">
      {!enabled && <p className="muted">Hidden on the store.</p>}
      {preview.problems.length > 0 && (
        <div className="notice">
          <strong>Can&apos;t be published yet:</strong>
          <ul>
            {problemLines(preview.problems, names).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {sectionKey === "ticker" && (
        <p className="mono small">{(doc.messages as string[]).join("  ·  ")}</p>
      )}
      {sectionKey === "hero" && (
        <div className="preview-hero">
          {/* Signed link to a sanitized derivative; next/image must not fetch private links. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {image?.url && <img src={image.url} alt="" />}
          {typeof doc.eyebrow === "string" && <p className="eyebrow">{doc.eyebrow}</p>}
          <strong>{String(doc.title)}</strong>
          {typeof doc.subtitle === "string" && <p>{doc.subtitle}</p>}
          {doc.cta !== null && (
            <span className="badge">{(doc.cta as { label: string }).label}</span>
          )}
        </div>
      )}
      {sectionKey === "campaign_banner" &&
        (doc.banners as Doc[]).map((banner, index) => (
          <p key={index} className={banner.enabled ? undefined : "muted"}>
            <strong>{String(banner.title)}</strong>
            {typeof banner.subtitle === "string" && ` · ${banner.subtitle}`}
            {!banner.enabled && " (hidden)"}
          </p>
        ))}
      {preview.products.length > 0 && (
        <ul className="record-list">
          {preview.products.map((product) => (
            <li key={product.id} className={product.visible ? undefined : "muted"}>
              {product.name}
              <small>
                {product.priceFromFils !== null ? ` · from ${money(product.priceFromFils)}` : ""}
                {product.soldOut ? " · Out of stock" : ""}
                {product.visible ? "" : " · not visible"}
              </small>
            </li>
          ))}
        </ul>
      )}
      {preview.brands.length > 0 && (
        <p>
          {preview.brands
            .map((brand) => brand.name + (brand.visible ? "" : " (hidden)"))
            .join(" · ")}
        </p>
      )}
      {sectionKey === "best_sellers" && doc.mode === "auto" && (
        <p className="muted">
          Top 8 products by units sold in the last 30 days, worked out on the store.
        </p>
      )}
    </div>
  );
}

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label>
      <span>{label}</span>
      {children}
      {help && <small className="muted">{help}</small>}
    </label>
  );
}
const textOrNull = (value: string) => (value.trim() ? value : null);

function SectionEditor({
  sectionKey,
  value,
  onChange,
  names,
  remember,
}: {
  sectionKey: ContentSectionKey;
  value: Doc;
  onChange: (next: Doc) => void;
  names: Names;
  remember: (more: Names) => void;
}) {
  const set = (field: string, next: unknown) => onChange({ ...value, [field]: next });
  const toggle = (label: string) => (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={value.enabled === true}
        onChange={(event) => set("enabled", event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  switch (sectionKey) {
    case "ticker": {
      const messages = value.messages as string[];
      return (
        <div className="form-grid">
          {toggle("Show the promotional bar on the store")}
          {messages.map((message, index) => (
            <div key={index} className="wide-field inline-row">
              <input
                aria-label={`Message ${index + 1}`}
                value={message}
                maxLength={TICKER_MESSAGES.length}
                onChange={(event) =>
                  set(
                    "messages",
                    messages.map((item, at) => (at === index ? event.target.value : item)),
                  )
                }
              />
              <button
                type="button"
                className="text-button"
                disabled={messages.length <= TICKER_MESSAGES.min}
                onClick={() =>
                  set(
                    "messages",
                    messages.filter((_item, at) => at !== index),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          {messages.length < TICKER_MESSAGES.max && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => set("messages", [...messages, ""])}
            >
              Add message
            </button>
          )}
          <small className="muted wide-field">
            Keep each message under 90 characters. Plain text only.
          </small>
        </div>
      );
    }
    case "hero":
      return (
        <div className="form-grid">
          <Field label="Eyebrow (optional)">
            <input
              value={(value.eyebrow as string | null) ?? ""}
              maxLength={40}
              onChange={(event) => set("eyebrow", textOrNull(event.target.value))}
            />
          </Field>
          <Field label="Headline" help={`${String(value.title).length}/60`}>
            <input
              value={String(value.title)}
              maxLength={60}
              required
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>
          <Field label="Supporting text (optional)">
            <textarea
              value={(value.subtitle as string | null) ?? ""}
              maxLength={160}
              onChange={(event) => set("subtitle", textOrNull(event.target.value))}
            />
          </Field>
          <CtaEditor
            value={value.cta as Doc | null}
            onChange={(next) => set("cta", next)}
            names={names}
            remember={remember}
          />
          <ImageField
            value={value.image as Doc | null}
            onChange={(next) => set("image", next)}
            hint="1600 × 900 px"
          />
        </div>
      );
    case "featured":
      return (
        <ProductList
          ids={value.productIds as string[]}
          max={8}
          onChange={(ids) => set("productIds", ids)}
          names={names}
          remember={remember}
        />
      );
    case "best_sellers":
      return (
        <div className="form-grid">
          {(["auto", "manual"] as const).map((mode) => (
            <label key={mode} className="checkbox-row wide-field">
              <input
                type="radio"
                name="best-mode"
                checked={value.mode === mode}
                onChange={() =>
                  onChange({
                    mode,
                    productIds: mode === "auto" ? [] : (value.productIds as string[]),
                  })
                }
              />
              <span>
                {mode === "auto"
                  ? "Automatic: top 8 products by units sold in the last 30 days."
                  : "Pick manually: choose and order the products yourself."}
              </span>
            </label>
          ))}
          {value.mode === "manual" && (
            <ProductList
              ids={value.productIds as string[]}
              max={8}
              onChange={(ids) => set("productIds", ids)}
              names={names}
              remember={remember}
            />
          )}
        </div>
      );
    case "brands":
      return (
        <BrandList
          ids={value.brandIds as string[]}
          onChange={(ids) => set("brandIds", ids)}
          remember={remember}
        />
      );
    case "campaign_banner": {
      const banners = value.banners as Doc[];
      const setBanner = (index: number, next: Doc) =>
        set(
          "banners",
          banners.map((item, at) => (at === index ? next : item)),
        );
      return (
        <div className="form-grid">
          {banners.map((banner, index) => (
            <fieldset key={index} className="wide-field form-grid">
              <legend>Banner {index + 1}</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={banner.enabled === true}
                  onChange={(event) =>
                    setBanner(index, { ...banner, enabled: event.target.checked })
                  }
                />
                <span>Show</span>
              </label>
              <Field label="Title">
                <input
                  value={String(banner.title)}
                  maxLength={60}
                  onChange={(event) => setBanner(index, { ...banner, title: event.target.value })}
                />
              </Field>
              <Field label="Subtitle (optional)">
                <input
                  value={(banner.subtitle as string | null) ?? ""}
                  maxLength={120}
                  onChange={(event) =>
                    setBanner(index, { ...banner, subtitle: textOrNull(event.target.value) })
                  }
                />
              </Field>
              <CtaEditor
                value={banner.cta as Doc | null}
                onChange={(next) => setBanner(index, { ...banner, cta: next })}
                names={names}
                remember={remember}
              />
              <ImageField
                value={banner.image as Doc | null}
                onChange={(next) => setBanner(index, { ...banner, image: next })}
                hint="1200 × 600 px"
              />
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  set(
                    "banners",
                    banners.filter((_item, at) => at !== index),
                  )
                }
              >
                Remove banner
              </button>
            </fieldset>
          ))}
          {banners.length < 2 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                set("banners", [
                  ...banners,
                  { enabled: false, title: "", subtitle: null, cta: null, image: null },
                ])
              }
            >
              Add banner
            </button>
          )}
        </div>
      );
    }
    case "offers":
      return (
        <div className="form-grid">
          {toggle("Show the offers section")}
          <Field label="Section title">
            <input
              value={String(value.title)}
              maxLength={60}
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>
          <ProductList
            ids={value.productIds as string[]}
            max={6}
            onChange={(ids) => set("productIds", ids)}
            names={names}
            remember={remember}
          />
        </div>
      );
  }
}

/** Published products, searched by name; the order is the order on the store. */
function ProductList({
  ids,
  max,
  onChange,
  names,
  remember,
}: {
  ids: string[];
  max: number;
  onChange: (ids: string[]) => void;
  names: Names;
  remember: (more: Names) => void;
}) {
  return (
    <div className="wide-field form-grid">
      <ol className="record-list wide-field">
        {ids.map((id, index) => (
          <li key={id}>
            {names[id] ?? "Product"}
            <span>
              <button
                type="button"
                className="text-button"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onChange(move(ids, index, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="text-button"
                aria-label="Move down"
                disabled={index === ids.length - 1}
                onClick={() => onChange(move(ids, index, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(ids.filter((item) => item !== id))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      {ids.length < max ? (
        <ProductSearch
          exclude={ids}
          onPick={(id, name) => {
            remember({ [id]: name });
            onChange([...ids, id]);
          }}
        />
      ) : (
        <p className="muted small wide-field">Maximum {max} products.</p>
      )}
    </div>
  );
}

function ProductSearch({
  exclude,
  onPick,
}: {
  exclude: string[];
  onPick: (id: string, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  const [failed, setFailed] = useState(false);
  async function search() {
    setFailed(false);
    const params = new URLSearchParams({ status: "published", limit: "10" });
    if (q.trim()) params.set("q", q.trim());
    try {
      const found = await managementRequest(`/products?${params}`, productsResponseSchema);
      setResults(found.items.map((item) => ({ id: item.id, name: item.name })));
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="wide-field">
      <div className="inline-row">
        <input
          aria-label="Search published products"
          placeholder="Search published products"
          value={q}
          maxLength={100}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), void search())}
        />
        <button type="button" className="secondary-button" onClick={() => void search()}>
          Search
        </button>
      </div>
      {failed && <p className="muted small">Could not search. Try again.</p>}
      <ul className="record-list">
        {results
          .filter((item) => !exclude.includes(item.id))
          .map((item) => (
            <li key={item.id}>
              {item.name}
              <button
                type="button"
                className="text-button"
                onClick={() => onPick(item.id, item.name)}
              >
                Add
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function BrandList({
  ids,
  onChange,
  remember,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  remember: (more: Names) => void;
}) {
  const brands = useManagementResource("/brands?limit=100", brandsResponseSchema);
  const all = brands.data?.items ?? [];
  const name = (id: string) => all.find((brand) => brand.id === id)?.name ?? "Brand";
  useEffect(() => {
    if (brands.data)
      remember(Object.fromEntries(brands.data.items.map((brand) => [brand.id, brand.name])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brands.data]);
  return (
    <div className="form-grid">
      <ResourceNotice resource={brands} />
      <ol className="record-list wide-field">
        {ids.map((id, index) => (
          <li key={id}>
            {name(id)}
            <span>
              <button
                type="button"
                className="text-button"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onChange(move(ids, index, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="text-button"
                aria-label="Move down"
                disabled={index === ids.length - 1}
                onClick={() => onChange(move(ids, index, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(ids.filter((item) => item !== id))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="wide-field tab-list">
        {all
          .filter((brand) => brand.active && !ids.includes(brand.id))
          .map((brand) => (
            <button
              key={brand.id}
              type="button"
              className="secondary-button"
              disabled={ids.length >= 24}
              onClick={() => onChange([...ids, brand.id])}
            >
              + {brand.name}
            </button>
          ))}
      </div>
    </div>
  );
}

/** A button: a label and a store page (no free URLs). */
function CtaEditor({
  value,
  onChange,
  names,
  remember,
}: {
  value: Doc | null;
  onChange: (next: Doc | null) => void;
  names: Names;
  remember: (more: Names) => void;
}) {
  const brands = useManagementResource(
    value ? "/brands?limit=100" : "/brands?limit=1",
    brandsResponseSchema,
  );
  const categories = useManagementResource(
    value ? "/categories?limit=100" : "/categories?limit=1",
    categoriesResponseSchema,
  );
  if (!value)
    return (
      <button
        type="button"
        className="secondary-button"
        onClick={() => onChange({ label: "", link: { kind: "shop" } })}
      >
        Add a button
      </button>
    );
  const link = value.link as ContentLink;
  const setLink = (next: ContentLink) => onChange({ ...value, link: next });
  return (
    <fieldset className="wide-field form-grid">
      <legend>Button</legend>
      <Field label="Button label">
        <input
          value={String(value.label)}
          maxLength={30}
          onChange={(event) => onChange({ ...value, label: event.target.value })}
        />
      </Field>
      <Field label="Goes to">
        <select
          value={link.kind}
          onChange={(event) => {
            const kind = event.target.value as ContentLink["kind"];
            if (kind === "shop") setLink({ kind });
            else if (kind === "brand" && brands.data?.items[0])
              setLink({ kind, brandId: brands.data.items[0].id });
            else if (kind === "category" && categories.data?.items[0])
              setLink({ kind, categoryId: categories.data.items[0].id });
            else if (kind === "product")
              onChange({ ...value, link: { kind: "product", productId: "" } });
          }}
        >
          {LINK_KINDS.map((item) => (
            <option key={item.kind} value={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      {link.kind === "brand" && (
        <Field label="Brand">
          <select
            value={link.brandId}
            onChange={(event) => setLink({ kind: "brand", brandId: event.target.value })}
          >
            {brands.data?.items.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
                {brand.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </Field>
      )}
      {link.kind === "category" && (
        <Field label="Category">
          <select
            value={link.categoryId}
            onChange={(event) => setLink({ kind: "category", categoryId: event.target.value })}
          >
            {categories.data?.items.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </Field>
      )}
      {link.kind === "product" && (
        <div className="wide-field">
          <p className="small">
            {link.productId ? `Product: ${names[link.productId] ?? "chosen"}` : "Choose a product:"}
          </p>
          <ProductSearch
            exclude={link.productId ? [link.productId] : []}
            onPick={(id, name) => {
              remember({ [id]: name });
              setLink({ kind: "product", productId: id });
            }}
          />
        </div>
      )}
      <button type="button" className="text-button" onClick={() => onChange(null)}>
        Remove button
      </button>
    </fieldset>
  );
}

/** A processed content image with its description; upload or pick an earlier one. */
function ImageField({
  value,
  onChange,
  hint,
}: {
  value: Doc | null;
  onChange: (next: Doc | null) => void;
  hint: string;
}) {
  const images = useManagementResource("/content/images", contentImagesResponseSchema);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const processing = images.data?.items.some(
    (item) => item.state === "uploaded" || item.state === "processing",
  );
  const { reload } = images;
  useEffect(() => {
    if (!processing) return;
    const timer = setTimeout(reload, 2500);
    return () => clearTimeout(timer);
  }, [processing, reload, images.data]);

  async function upload(file: File) {
    setNote("");
    setBusy(true);
    try {
      const grant = await managementRequest(
        "/content/images/uploads",
        mediaUploadResponseSchema,
        "POST",
        uploadRequestFor(file),
      );
      const sent = await fetch(grant.upload.url, {
        method: "POST",
        body: uploadForm(grant.upload.fields, file),
        credentials: "omit",
      });
      if (!sent.ok) throw new Error("storage");
      await managementRequest(
        `/content/images/${grant.asset.id}/complete`,
        mediaAssetSchema,
        "POST",
        {},
      );
      reload();
    } catch (error) {
      setNote(
        error instanceof Error && error.message !== "storage" && !(error instanceof ApiError)
          ? error.message
          : "The upload did not complete. Choose the file again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const chosen = images.data?.items.find((item) => item.id === value?.assetId);
  return (
    <fieldset className="wide-field form-grid">
      <legend>Image (optional)</legend>
      {value ? (
        <>
          {chosen?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="content-thumb" src={chosen.url} alt="" />
          ) : (
            <p className="muted small">Image chosen (its preview is on the right after saving).</p>
          )}
          <Field label="Image description (for screen readers)">
            <input
              value={String(value.alt)}
              maxLength={125}
              onChange={(event) => onChange({ ...value, alt: event.target.value })}
            />
          </Field>
          <button type="button" className="text-button" onClick={() => onChange(null)}>
            Remove image
          </button>
        </>
      ) : (
        <>
          <Field label="Upload an image" help={`${hint}. JPEG, PNG or WebP, up to 8 MB.`}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </Field>
          {note && (
            <p role="alert" className="small">
              {note}
            </p>
          )}
          <ResourceNotice resource={images} />
          <div className="content-images wide-field">
            {images.data?.items.map((item) =>
              item.state === "ready" && item.url ? (
                <button
                  key={item.id}
                  type="button"
                  className="content-image-choice"
                  onClick={() => onChange({ assetId: item.id, alt: "" })}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt="" />
                  <span className="small">Use this image</span>
                </button>
              ) : (
                <span key={item.id} className="muted small">
                  {item.state === "rejected"
                    ? rejectionMessage(item.error)
                    : item.state === "expired"
                      ? "Upload not finished"
                      : "Processing…"}
                </span>
              ),
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
