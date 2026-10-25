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
  emptyHeroSlide,
  LINK_KINDS,
  move,
  problemLines,
} from "../lib/content";
import { rejectionMessage, uploadForm, uploadRequestFor } from "../lib/media";
import { money } from "../lib/orders";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { PageHead } from "./page-head";
import { useUnsavedChanges } from "./unsaved-guard";

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
  // Drafts live in state across tabs: any unsaved section guards leaving the page (G-A9).
  useUnsavedChanges(
    CONTENT_TABS.some(
      (item) =>
        drafts[item.key] !== undefined &&
        !same(
          drafts[item.key],
          (content.data?.sections.find((row) => row.key === item.key)?.draft as Doc | null) ??
            emptyContent(item.key),
        ),
    )
      ? "the storefront content"
      : null,
  );

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

  const info = CONTENT_TABS.find((item) => item.key === tab)!;
  const status = !section
    ? null
    : dirty
      ? { label: "Unsaved", tone: "low" }
      : !section.publishedAt
        ? { label: section.version ? "Draft, never published" : "Not set up", tone: "" }
        : section.unpublishedChanges
          ? { label: "Draft differs from live", tone: "info" }
          : { label: "Live", tone: "ok" };
  return (
    <>
      <PageHead
        title="Storefront content"
        sub="Edit the home page sections. Save a draft, check the preview, then publish: the store changes only when you publish."
        actions={
          <a className="btn btn-s" href="/" target="_blank" rel="noopener">
            <Icon name="ext" />
            View store
          </a>
        }
      />
      <div className="tabs ct-tabs" role="tablist" aria-label="Section">
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
              className="tab"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setProblems([]);
              }}
            >
              {item.label}
              {changed && <span className="dotc ct-dot" aria-label="unsaved" />}
            </button>
          );
        })}
      </div>
      <ResourceNotice resource={content} compact />
      {section && status && (
        <div className="split wide">
          <section className="card" aria-labelledby="ct-title">
            <div className="card-h">
              <div>
                <h2 id="ct-title">{info.label}</h2>
                <p className="sub">{info.help}</p>
              </div>
              <span className={`tag ct-status ${status.tone}`}>
                {status.tone === "ok" && <Icon name="check" size="sm" />}
                {status.label}
              </span>
            </div>
            <div className="card-b form ct-ed">
              <SectionEditor
                sectionKey={tab}
                value={draft}
                onChange={setDraft}
                names={names}
                remember={remember}
              />
              {problems.length > 0 && (
                <div role="alert" className="note err ct-problems">
                  <Icon name="alert" />
                  <div>
                    <b>Not published:</b>
                    <ul>
                      {problems.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <div className="card-f">
              {dirty && (
                <button
                  type="button"
                  className="btn btn-s"
                  disabled={content.disabled}
                  onClick={() => setDrafts((current) => ({ ...current, [tab]: undefined }))}
                >
                  Discard changes
                </button>
              )}
              <button
                type="button"
                className="btn btn-s"
                disabled={!dirty || content.disabled}
                onClick={() => void save()}
              >
                Save draft
              </button>
              <button
                type="button"
                className="btn btn-p"
                disabled={
                  dirty || !section.unpublishedChanges || section.version === 0 || content.disabled
                }
                onClick={() => void publish()}
              >
                <Icon name="globe" />
                Publish
              </button>
            </div>
          </section>
          <section className="card ct-preview" aria-labelledby="ct-preview">
            <div className="card-h">
              <h2 id="ct-preview">Preview</h2>
              <span className="sub">Saved draft · approximate, not to scale</span>
            </div>
            <div className="card-b">
              {section.version === 0 ? (
                <p className="small muted">Save a draft to see it here.</p>
              ) : (
                <PreviewPanel
                  key={`${tab}:${section.version}`}
                  sectionKey={tab}
                  doc={saved}
                  names={names}
                  remember={remember}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </>
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
      <ResourceNotice resource={preview} compact />
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
  const enabled = doc.enabled !== false;
  return (
    <div className="preview-block">
      {!enabled && <p className="muted">Hidden on the store.</p>}
      {preview.problems.length > 0 && (
        <div className="note warn">
          <strong>Can&apos;t be published yet:</strong>
          <ul>
            {problemLines(preview.problems, names).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {sectionKey === "ticker" && (
        <>
          {/* The prototype's ticker strip; the joined line is also there for screen readers. */}
          <div className={enabled ? "tick" : "tick off"} aria-hidden="true">
            <div className="tick-t">
              {(doc.messages as string[]).map((message, index) => (
                <span key={index}>{message}</span>
              ))}
            </div>
          </div>
          <p className="help ct-tick-text">{(doc.messages as string[]).join("  ·  ")}</p>
        </>
      )}
      {sectionKey === "hero" &&
        (doc.slides as Doc[]).map((slide, index) => {
          const slideImage = preview.images.find(
            (item) => item.id === (slide.image as { assetId?: string } | null)?.assetId,
          );
          return (
            <div key={index} className="browser ct-browser">
              <div className="browser-b" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <div className={`preview-hero ct-hero ct-hero-${String(slide.style)}`}>
                {/* Signed link to a sanitized derivative; next/image must not fetch private links. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {slideImage?.url && <img src={slideImage.url} alt="" />}
                <p className="eyebrow">
                  Slide {index + 1} · {String(slide.style)}
                  {typeof slide.eyebrow === "string" ? ` · ${slide.eyebrow}` : ""}
                </p>
                <strong>{String(slide.title)}</strong>
                {typeof slide.subtitle === "string" && <p>{slide.subtitle}</p>}
                {slide.cta !== null && (
                  <span className="badge">{(slide.cta as { label: string }).label}</span>
                )}
                {slide.secondaryCta !== null && (
                  <span className="badge">{(slide.secondaryCta as { label: string }).label}</span>
                )}
              </div>
            </div>
          );
        })}
      {sectionKey === "campaign_banner" &&
        (doc.banners as Doc[]).map((banner, index) => (
          <p key={index} className={banner.enabled ? undefined : "muted"}>
            <strong>{String(banner.title)}</strong>
            {typeof banner.subtitle === "string" && ` · ${banner.subtitle}`}
            {!banner.enabled && " (hidden)"}
          </p>
        ))}
      {preview.products.length > 0 && (
        <ul className="list ct-mini">
          {preview.products.map((product) => (
            <li key={product.id} className={product.visible ? "li" : "li muted"}>
              <span className="li-b">
                <b>{product.name}</b>
                <small>
                  {product.soldOut ? (
                    <span className="warn-t">Out of stock</span>
                  ) : product.priceFromFils !== null ? (
                    `from ${money(product.priceFromFils)}`
                  ) : (
                    ""
                  )}
                  {product.visible ? "" : " · not visible"}
                </small>
              </span>
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

/** The prototype's field (`field`/`label`); the label wraps the control so they stay linked. */
function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
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
    <label className="switch">
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
        <div className="form">
          {toggle("Show the promotional bar on the store")}
          {messages.map((message, index) => (
            <div key={index} className="row nowrap-row">
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
                className="btn btn-g btn-sm"
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
              className="btn btn-s btn-sm"
              onClick={() => set("messages", [...messages, ""])}
            >
              Add message
            </button>
          )}
          <p className="help">Keep each message under 90 characters. Plain text only.</p>
        </div>
      );
    }
    case "hero": {
      // The carousel (ADR 0097): one to three slides; one slide shows no dots or arrows.
      const slides = value.slides as Doc[];
      const setSlide = (index: number, next: Doc) =>
        set(
          "slides",
          slides.map((item, at) => (at === index ? next : item)),
        );
      const swap = (index: number, offset: -1 | 1) => {
        const next = [...slides];
        [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
        set("slides", next);
      };
      return (
        <div className="form">
          {slides.map((slide, index) => (
            <fieldset key={index} className="ct-group form">
              <legend>Slide {index + 1}</legend>
              <Field label="Look">
                <select
                  value={String(slide.style)}
                  onChange={(event) => setSlide(index, { ...slide, style: event.target.value })}
                >
                  <option value="navy">Navy, light text</option>
                  <option value="lilac">Lilac, dark text</option>
                  <option value="coral">Coral, light text</option>
                </select>
              </Field>
              <Field label="Eyebrow (optional)">
                <input
                  value={(slide.eyebrow as string | null) ?? ""}
                  maxLength={40}
                  onChange={(event) =>
                    setSlide(index, { ...slide, eyebrow: textOrNull(event.target.value) })
                  }
                />
              </Field>
              <Field label="Headline" help={`${String(slide.title).length}/60`}>
                <input
                  value={String(slide.title)}
                  maxLength={60}
                  required
                  onChange={(event) => setSlide(index, { ...slide, title: event.target.value })}
                />
              </Field>
              <Field label="Supporting text (optional)">
                <textarea
                  value={(slide.subtitle as string | null) ?? ""}
                  maxLength={160}
                  onChange={(event) =>
                    setSlide(index, { ...slide, subtitle: textOrNull(event.target.value) })
                  }
                />
              </Field>
              <CtaEditor
                value={slide.cta as Doc | null}
                onChange={(next) => setSlide(index, { ...slide, cta: next })}
                names={names}
                remember={remember}
              />
              <CtaEditor
                name="Second button"
                value={slide.secondaryCta as Doc | null}
                onChange={(next) => setSlide(index, { ...slide, secondaryCta: next })}
                names={names}
                remember={remember}
              />
              <ImageField
                value={slide.image as Doc | null}
                onChange={(next) => setSlide(index, { ...slide, image: next })}
                hint="1600 × 900 px"
              />
              <div className="row">
                {index > 0 && (
                  <button
                    type="button"
                    className="btn btn-g btn-sm"
                    onClick={() => swap(index, -1)}
                  >
                    Move up
                  </button>
                )}
                {index < slides.length - 1 && (
                  <button type="button" className="btn btn-g btn-sm" onClick={() => swap(index, 1)}>
                    Move down
                  </button>
                )}
                {slides.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-g btn-sm"
                    onClick={() =>
                      set(
                        "slides",
                        slides.filter((_item, at) => at !== index),
                      )
                    }
                  >
                    Remove slide
                  </button>
                )}
              </div>
            </fieldset>
          ))}
          {slides.length < 3 && (
            <button
              type="button"
              className="btn btn-s btn-sm"
              onClick={() => set("slides", [...slides, emptyHeroSlide()])}
            >
              Add slide
            </button>
          )}
        </div>
      );
    }
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
        <div className="form">
          <div className="radios">
            {(["auto", "manual"] as const).map((mode) => (
              <label key={mode} className="ropt">
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
                  <b>{mode === "auto" ? "Automatic" : "Pick manually"}</b>
                  <small>
                    {mode === "auto"
                      ? "Top 8 products by units sold in the last 30 days."
                      : "Choose and order the products yourself."}
                  </small>
                </span>
              </label>
            ))}
          </div>
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
        <div className="form">
          {banners.map((banner, index) => (
            <fieldset key={index} className="ct-group form">
              <legend>Banner {index + 1}</legend>
              <label className="switch">
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
                className="btn btn-g btn-sm"
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
              className="btn btn-s btn-sm"
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
        <div className="form">
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

function OrderedRows({
  ids,
  label,
  onChange,
}: {
  ids: string[];
  label: (id: string) => string;
  onChange: (ids: string[]) => void;
}) {
  if (!ids.length) return <p className="small muted">None chosen yet.</p>;
  return (
    <ol className="stack ct-rows">
      {ids.map((id, index) => (
        <li key={id} className="pick ct-row">
          <span className="ct-n">{index + 1}</span>
          <b>{label(id)}</b>
          <button
            type="button"
            className="ibtn"
            aria-label={`Move ${label(id)} up`}
            disabled={index === 0}
            onClick={() => onChange(move(ids, index, -1))}
          >
            <Icon name="cu" size="sm" />
          </button>
          <button
            type="button"
            className="ibtn"
            aria-label={`Move ${label(id)} down`}
            disabled={index === ids.length - 1}
            onClick={() => onChange(move(ids, index, 1))}
          >
            <Icon name="cd" size="sm" />
          </button>
          <button
            type="button"
            className="ibtn"
            aria-label={`Remove ${label(id)}`}
            onClick={() => onChange(ids.filter((item) => item !== id))}
          >
            <Icon name="x" size="sm" />
          </button>
        </li>
      ))}
    </ol>
  );
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
    <div className="stack">
      <OrderedRows ids={ids} label={(id) => names[id] ?? "Product"} onChange={onChange} />
      {ids.length < max ? (
        <ProductSearch
          exclude={ids}
          onPick={(id, name) => {
            remember({ [id]: name });
            onChange([...ids, id]);
          }}
        />
      ) : (
        <p className="help">Maximum {max} products.</p>
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
    <div className="stack">
      <div className="row nowrap-row">
        <input
          className="input"
          aria-label="Search published products"
          placeholder="Search published products"
          value={q}
          maxLength={100}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), void search())}
        />
        <button type="button" className="btn btn-s" onClick={() => void search()}>
          <Icon name="search" size="sm" />
          Search
        </button>
      </div>
      {failed && <p className="help">Could not search. Try again.</p>}
      {results
        .filter((item) => !exclude.includes(item.id))
        .map((item) => (
          <div key={item.id} className="pick ct-add">
            <span>{item.name}</span>
            <button
              type="button"
              className="btn btn-g btn-sm"
              onClick={() => onPick(item.id, item.name)}
            >
              <Icon name="plus" size="sm" />
              Add
            </button>
          </div>
        ))}
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
    <div className="form">
      <ResourceNotice resource={brands} compact />
      <OrderedRows ids={ids} label={name} onChange={onChange} />
      <div className="stack ct-picks">
        {all
          .filter((brand) => brand.active && !ids.includes(brand.id))
          .map((brand) => (
            <button
              key={brand.id}
              type="button"
              className="pick ct-add"
              disabled={ids.length >= 24}
              onClick={() => onChange([...ids, brand.id])}
            >
              <span className="muted">{brand.name}</span>
              <Icon name="plus" size="sm" />
              <span className="sr">Add {brand.name}</span>
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
  name = "Button",
}: {
  value: Doc | null;
  onChange: (next: Doc | null) => void;
  names: Names;
  remember: (more: Names) => void;
  /** The legend, e.g. "Second button". */
  name?: string;
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
        className="btn btn-s btn-sm"
        onClick={() => onChange({ label: "", link: { kind: "shop" } })}
      >
        Add {name === "Button" ? "a button" : name.toLowerCase()}
      </button>
    );
  const link = value.link as ContentLink;
  const setLink = (next: ContentLink) => onChange({ ...value, link: next });
  return (
    <fieldset className="ct-group form">
      <legend>{name}</legend>
      <Field label={`${name} label`}>
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
        <div className="stack">
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
      <button type="button" className="btn btn-g btn-sm" onClick={() => onChange(null)}>
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
    <fieldset className="ct-group form">
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
          <button type="button" className="btn btn-g btn-sm" onClick={() => onChange(null)}>
            Remove image
          </button>
        </>
      ) : (
        <>
          {/* The prototype's drop zone; the file input stays the labelled control. */}
          <label className="drop drop-sm">
            <Icon name="upload" />
            <span className="small">{busy ? "Uploading…" : "Upload an image"}</span>
            <span className="help">{hint}. JPEG, PNG or WebP, up to 8 MB.</span>
            <input
              type="file"
              className="sr"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
          {note && (
            <p role="alert" className="small">
              {note}
            </p>
          )}
          <ResourceNotice resource={images} compact />
          <div className="content-images">
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
