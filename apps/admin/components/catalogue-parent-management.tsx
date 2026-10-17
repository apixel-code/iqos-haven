"use client";
import { useState } from "react";
import {
  brandResponseSchema,
  brandsResponseSchema,
  categoriesResponseSchema,
  categoryResponseSchema,
  parentPurgeResponseSchema,
  type BrandResponse,
  type CategoryResponse,
} from "@ih/contracts";
import {
  brandCreateCommand,
  brandUpdateCommand,
  categoryCreateCommand,
  categoryUpdateCommand,
  plural,
  slugify,
} from "../lib/catalogue";
import { managementRequest, type ResponseContract } from "../lib/management";
import { Fields, ResourceNotice, useManagementResource, type Field } from "./management-resource";
import { ParentImage } from "./parent-image";

type Tab = "live" | "trashed";
type Parent = BrandResponse | CategoryResponse;
type Page = { items: Parent[]; nextCursor: string | null };

interface KindConfig {
  readonly path: "/brands" | "/categories";
  readonly title: string;
  readonly noun: string;
  readonly urlPrefix: string;
  readonly badge: string;
  readonly empty: string;
  readonly description: boolean;
  /** The image's label: a brand's logo or a category's image (parity G-A7). */
  readonly imageLabel: string;
  readonly page: ResponseContract<Page>;
  readonly row: ResponseContract<Parent>;
  readonly create: (data: FormData, seo: boolean) => unknown;
  readonly update: (row: Parent, data: FormData, seo: boolean) => unknown;
}

const KINDS: Record<"brand" | "category", KindConfig> = {
  brand: {
    path: "/brands",
    title: "Brands",
    noun: "brand",
    urlPrefix: "/brand/",
    badge: "Brand pages and Shop by Brand",
    empty: "No brands found. Add a brand to group products and create a brand page.",
    description: true,
    imageLabel: "Logo",
    page: brandsResponseSchema as ResponseContract<Page>,
    row: brandResponseSchema as ResponseContract<Parent>,
    create: brandCreateCommand,
    update: (row, data, seo) => brandUpdateCommand(row as BrandResponse, data, seo),
  },
  category: {
    path: "/categories",
    title: "Categories",
    noun: "category",
    urlPrefix: "/category/",
    badge: "Navigation and category pages",
    empty: "No categories found. Add a category to organise products in the store.",
    description: false,
    imageLabel: "Image",
    page: categoriesResponseSchema as ResponseContract<Page>,
    row: categoryResponseSchema as ResponseContract<Parent>,
    create: categoryCreateCommand,
    update: (row, data, seo) => categoryUpdateCommand(row as CategoryResponse, data, seo),
  },
};

/**
 * Brands (step 42) and categories (step 43). Server permissions decide every action; buttons only
 * mirror them. A brand logo or category image is uploaded here (parity G-A7, ADR 0091), and the
 * Owner can delete a trashed one that no product uses.
 */
export function CatalogueParentManagement({
  kind,
  permissions,
}: {
  kind: "brand" | "category";
  permissions: readonly string[];
}) {
  const config = KINDS[kind];
  const canWrite = permissions.includes("catalog.write");
  const canTrash = permissions.includes("catalog.trash");
  const canPurge = permissions.includes("catalog.purge");
  const canSeo = permissions.includes("seo.write");
  const [tab, setTab] = useState<Tab>("live");
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const resource = useManagementResource(
    `${config.path}?status=${tab}&limit=50` +
      (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    config.page,
  );
  const items = (resource.data?.items ?? []).filter((row) =>
    row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function replace(updated: Parent) {
    resource.setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
  }
  function drop(id: string) {
    resource.setData((current) =>
      current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current,
    );
  }
  function show(next: Tab) {
    setTab(next);
    setCursor(null);
  }
  async function moveToTrash(row: Parent) {
    if (row.publishedProductCount > 0) {
      window.alert(
        `${plural(row.publishedProductCount, "published product")} use ${row.name}. Move or unpublish them before moving the ${config.noun} to trash.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Move ${row.name} to trash? The ${config.noun} page will be hidden. You can restore it from Trash.`,
      )
    )
      return;
    const outcome = await resource.run((signal) =>
      managementRequest(
        `${config.path}/${row.id}/trash`,
        config.row,
        "POST",
        { version: row.version },
        signal,
      ),
    );
    if (outcome.ok) drop(row.id);
  }
  async function restore(row: Parent) {
    const outcome = await resource.run((signal) =>
      managementRequest(
        `${config.path}/${row.id}/restore`,
        config.row,
        "POST",
        { version: row.version },
        signal,
      ),
    );
    if (outcome.ok) drop(row.id);
  }
  /** Owner only (parity G-A7): a trashed brand or category that no product uses. */
  async function purge(row: Parent) {
    if (
      !window.confirm(
        `Delete ${row.name} permanently? Its old links stop redirecting. This cannot be undone.`,
      )
    )
      return;
    const outcome = await resource.run((signal) =>
      managementRequest(
        `${config.path}/${row.id}/purge`,
        parentPurgeResponseSchema,
        "POST",
        { version: row.version },
        signal,
      ),
    );
    if (outcome.ok) drop(row.id);
  }

  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>{config.title}</h2>
        <span className="badge">{config.badge}</span>
      </header>
      <div className="tab-list" role="tablist" aria-label={`${config.title} lists`}>
        <button
          type="button"
          role="tab"
          className="secondary-button"
          aria-selected={tab === "live"}
          onClick={() => show("live")}
        >
          {config.title}
        </button>
        <button
          type="button"
          role="tab"
          className="secondary-button"
          aria-selected={tab === "trashed"}
          onClick={() => show("trashed")}
        >
          Trash
        </button>
      </div>
      <label>
        <span className="sr-only">Filter {config.title.toLowerCase()} on this page</span>
        <input
          type="search"
          placeholder="Filter this page by name"
          value={search}
          maxLength={150}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <ResourceNotice resource={resource} />
      {resource.data && (
        <>
          {tab === "live" && canWrite && (
            <CreateParent
              config={config}
              resource={resource}
              canSeo={canSeo}
              onCreated={() => {
                setCursor(null);
                resource.reload();
              }}
            />
          )}
          {items.length === 0 && (
            <p className="muted">
              {tab === "live"
                ? config.empty
                : `Trash is empty. ${config.title} moved to trash can be restored from here.`}
            </p>
          )}
          <div className="record-list">
            {items.map((row) =>
              tab === "trashed" ? (
                <article className="record-card" key={`${row.id}-${row.version}`}>
                  <header className="card-heading">
                    <strong>{row.name}</strong>
                    <span className="badge">
                      {config.urlPrefix}
                      {row.slug} · v{row.version}
                    </span>
                  </header>
                  {canTrash && (
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={resource.disabled}
                        onClick={() => void restore(row)}
                      >
                        Restore
                      </button>
                      {canPurge && (
                        <button
                          type="button"
                          className="danger-button"
                          disabled={resource.disabled}
                          onClick={() => void purge(row)}
                        >
                          Delete permanently
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ) : (
                <form
                  className="record-card"
                  key={`${row.id}-${row.version}`}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    const outcome = await resource.run((signal) =>
                      managementRequest(
                        `${config.path}/${row.id}`,
                        config.row,
                        "PATCH",
                        config.update(row, data, canSeo),
                        signal,
                      ),
                    );
                    if (outcome.ok) replace(outcome.value);
                  }}
                >
                  <header className="card-heading">
                    <strong>{row.name}</strong>
                    <span className="badge">
                      {row.active ? "Shown in store" : "Hidden"} ·{" "}
                      {plural(row.publishedProductCount, "published product")} · v{row.version}
                    </span>
                  </header>
                  <fieldset disabled={resource.disabled || !canWrite}>
                    <Fields fields={parentFields(config, canSeo, true, true)} value={row} />
                    <ParentImage
                      initial={"logoAssetId" in row ? row.logoAssetId : row.imageAssetId}
                      label={config.imageLabel}
                    />
                    <div className="form-actions">
                      {canWrite && (
                        <button className="secondary-button" type="submit">
                          Save changes
                        </button>
                      )}
                      {canTrash && (
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => void moveToTrash(row)}
                        >
                          Move to trash
                        </button>
                      )}
                    </div>
                  </fieldset>
                </form>
              ),
            )}
          </div>
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!cursor || resource.busy}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!resource.data.nextCursor || resource.busy}
              onClick={() => setCursor(resource.data!.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function parentFields(
  config: KindConfig,
  canSeo: boolean,
  withIdentity = true,
  editing = false,
): Field[] {
  const label = config.noun[0]!.toUpperCase() + config.noun.slice(1);
  return [
    ...(withIdentity
      ? [
          { name: "name", label: `${label} name`, required: true, max: 150 },
          {
            name: "slug",
            label: `Slug (${config.urlPrefix}…)`,
            required: true,
            max: 150,
            help:
              editing && !canSeo
                ? "Only the Owner can change a link once it exists (the old link becomes a redirect)."
                : "Lower-case letters, numbers and single hyphens. Renaming keeps the old link working.",
            readOnly: editing && !canSeo,
          },
        ]
      : []),
    ...(config.description
      ? [
          {
            name: "description",
            label: "Description (optional)",
            kind: "textarea" as const,
            max: 10_000,
          },
        ]
      : []),
    { name: "sortOrder", label: "Display order", max: 6, help: "Lower numbers appear first." },
    { name: "active", label: "Show in store", kind: "checkbox" as const },
    ...(canSeo
      ? [
          { name: "seo.title", label: "SEO title (optional)", max: 120 },
          {
            name: "seo.description",
            label: "SEO description (optional)",
            kind: "textarea" as const,
            max: 320,
          },
        ]
      : []),
  ];
}

function CreateParent({
  config,
  resource,
  canSeo,
  onCreated,
}: {
  config: KindConfig;
  resource: ReturnType<typeof useManagementResource<Page>>;
  canSeo: boolean;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  return (
    <details>
      <summary>New {config.noun}</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const outcome = await resource.run((signal) =>
            managementRequest(
              config.path,
              config.row,
              "POST",
              config.create(new FormData(form), canSeo),
              signal,
            ),
          );
          if (outcome.ok) {
            form.reset();
            setName("");
            setSlug("");
            setTouched(false);
            onCreated();
          }
        }}
      >
        <fieldset disabled={resource.disabled}>
          <div className="form-grid">
            <label>
              <span>{config.noun[0]!.toUpperCase() + config.noun.slice(1)} name *</span>
              <input
                name="name"
                required
                maxLength={150}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!touched) setSlug(slugify(e.target.value));
                }}
              />
            </label>
            <label>
              <span>Slug ({config.urlPrefix}…) *</span>
              <input
                name="slug"
                required
                maxLength={150}
                value={slug}
                onChange={(e) => {
                  setTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </label>
          </div>
          <Fields
            fields={parentFields(config, canSeo, false)}
            value={{ active: true, sortOrder: 0 }}
          />
          <ParentImage initial={null} label={config.imageLabel} />
          <button className="primary-button" type="submit">
            Create {config.noun}
          </button>
        </fieldset>
      </form>
    </details>
  );
}
