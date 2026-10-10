"use client";
import { useState } from "react";
import { brandResponseSchema, brandsResponseSchema, type BrandResponse } from "@ih/contracts";
import { brandCreateCommand, brandUpdateCommand, plural, slugify } from "../lib/catalogue";
import { managementRequest } from "../lib/management";
import { Fields, ResourceNotice, useManagementResource } from "./management-resource";

type Tab = "live" | "trashed";

/**
 * Brands (step 42). Server permissions decide every action; buttons only mirror them. Logos
 * arrive with the media pipeline (steps 48–50); permanent deletion is the step-51 purge flow.
 */
export function BrandManagement({ permissions }: { permissions: readonly string[] }) {
  const canWrite = permissions.includes("catalog.write");
  const canTrash = permissions.includes("catalog.trash");
  const canSeo = permissions.includes("seo.write");
  const [tab, setTab] = useState<Tab>("live");
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const brands = useManagementResource(
    `/brands?status=${tab}&limit=50` + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    brandsResponseSchema,
  );
  const items = (brands.data?.items ?? []).filter((brand) =>
    brand.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function replace(updated: BrandResponse) {
    brands.setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
  }
  function drop(id: string) {
    brands.setData((current) =>
      current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current,
    );
  }
  function show(next: Tab) {
    setTab(next);
    setCursor(null);
  }
  async function moveToTrash(brand: BrandResponse) {
    if (brand.publishedProductCount > 0) {
      window.alert(
        `${plural(brand.publishedProductCount, "published product")} use ${brand.name}. Move or unpublish them before moving the brand to trash.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Move ${brand.name} to trash? The brand page will be hidden. You can restore it from Trash.`,
      )
    )
      return;
    const outcome = await brands.run((signal) =>
      managementRequest(
        `/brands/${brand.id}/trash`,
        brandResponseSchema,
        "POST",
        { version: brand.version },
        signal,
      ),
    );
    if (outcome.ok) drop(brand.id);
  }
  async function restore(brand: BrandResponse) {
    const outcome = await brands.run((signal) =>
      managementRequest(
        `/brands/${brand.id}/restore`,
        brandResponseSchema,
        "POST",
        { version: brand.version },
        signal,
      ),
    );
    if (outcome.ok) drop(brand.id);
  }

  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Brands</h2>
        <span className="badge">Brand pages and Shop by Brand</span>
      </header>
      <div className="tab-list" role="tablist" aria-label="Brand lists">
        <button
          type="button"
          role="tab"
          className="secondary-button"
          aria-selected={tab === "live"}
          onClick={() => show("live")}
        >
          Brands
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
        <span className="sr-only">Filter brands on this page</span>
        <input
          type="search"
          placeholder="Filter this page by name"
          value={search}
          maxLength={150}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <ResourceNotice resource={brands} />
      {brands.data && (
        <>
          {tab === "live" && canWrite && (
            <CreateBrand
              resource={brands}
              canSeo={canSeo}
              onCreated={() => {
                setCursor(null);
                brands.reload();
              }}
            />
          )}
          {items.length === 0 && (
            <p className="muted">
              {tab === "live"
                ? "No brands found. Add a brand to group products and create a brand page."
                : "Trash is empty. Brands moved to trash can be restored from here."}
            </p>
          )}
          <div className="record-list">
            {items.map((brand) =>
              tab === "trashed" ? (
                <article className="record-card" key={`${brand.id}-${brand.version}`}>
                  <header className="card-heading">
                    <strong>{brand.name}</strong>
                    <span className="badge">
                      /{brand.slug} · v{brand.version}
                    </span>
                  </header>
                  {canTrash && (
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={brands.disabled}
                        onClick={() => void restore(brand)}
                      >
                        Restore
                      </button>
                    </div>
                  )}
                </article>
              ) : (
                <form
                  className="record-card"
                  key={`${brand.id}-${brand.version}`}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    const outcome = await brands.run((signal) =>
                      managementRequest(
                        `/brands/${brand.id}`,
                        brandResponseSchema,
                        "PATCH",
                        brandUpdateCommand(brand, data, canSeo),
                        signal,
                      ),
                    );
                    if (outcome.ok) replace(outcome.value);
                  }}
                >
                  <header className="card-heading">
                    <strong>{brand.name}</strong>
                    <span className="badge">
                      {brand.active ? "Shown in store" : "Hidden"} ·{" "}
                      {plural(brand.publishedProductCount, "published product")} · v{brand.version}
                    </span>
                  </header>
                  <fieldset disabled={brands.disabled || !canWrite}>
                    <BrandFields brand={brand} canSeo={canSeo} />
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
                          onClick={() => void moveToTrash(brand)}
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
              disabled={!cursor || brands.busy}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!brands.data.nextCursor || brands.busy}
              onClick={() => setCursor(brands.data!.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function BrandFields({ brand, canSeo }: { brand: BrandResponse | null; canSeo: boolean }) {
  return (
    <Fields
      fields={[
        { name: "name", label: "Brand name", required: true, max: 150 },
        {
          name: "slug",
          label: "Slug (/brand/…)",
          required: true,
          max: 150,
          help: "Lower-case letters, numbers and single hyphens. Renaming keeps the old link working.",
        },
        { name: "description", label: "Description (optional)", kind: "textarea", max: 10_000 },
        { name: "sortOrder", label: "Display order", max: 6, help: "Lower numbers appear first." },
        { name: "active", label: "Show in store", kind: "checkbox" },
        ...(canSeo
          ? ([
              { name: "seo.title", label: "SEO title (optional)", max: 120 },
              {
                name: "seo.description",
                label: "SEO description (optional)",
                kind: "textarea",
                max: 320,
              },
            ] as const)
          : []),
      ]}
      value={brand}
    />
  );
}

function CreateBrand({
  resource,
  canSeo,
  onCreated,
}: {
  resource: ReturnType<
    typeof useManagementResource<{ items: BrandResponse[]; nextCursor: string | null }>
  >;
  canSeo: boolean;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  return (
    <details>
      <summary>New brand</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const outcome = await resource.run((signal) =>
            managementRequest(
              "/brands",
              brandResponseSchema,
              "POST",
              brandCreateCommand(new FormData(form), canSeo),
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
              <span>Brand name *</span>
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
              <span>Slug (/brand/…) *</span>
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
            fields={[
              {
                name: "description",
                label: "Description (optional)",
                kind: "textarea",
                max: 10_000,
              },
              { name: "sortOrder", label: "Display order", max: 6 },
              { name: "active", label: "Show in store", kind: "checkbox" },
              ...(canSeo
                ? ([
                    { name: "seo.title", label: "SEO title (optional)", max: 120 },
                    {
                      name: "seo.description",
                      label: "SEO description (optional)",
                      kind: "textarea",
                      max: 320,
                    },
                  ] as const)
                : []),
            ]}
            value={{ active: true, sortOrder: 0 }}
          />
          <p className="muted">Logos can be added once image upload is available.</p>
          <button className="primary-button" type="submit">
            Create brand
          </button>
        </fieldset>
      </form>
    </details>
  );
}
