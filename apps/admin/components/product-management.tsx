"use client";
import { useState } from "react";
import {
  brandsResponseSchema,
  categoriesResponseSchema,
  productResponseSchema,
  productsResponseSchema,
  productReadinessSchema,
  productPurgeResponseSchema,
  type ProductResponse,
  type ProductSort,
  type ProductSummary,
} from "@ih/contracts";
import { slugify } from "../lib/catalogue";
import { filsToAed, managementRequest, type ResponseContract } from "../lib/management";
import { formatExtraSpecs, productCreateCommand, productUpdateCommand } from "../lib/products";
import { isUuid } from "../lib/links";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { useUrlQuery } from "./use-url-query";
import { ProductVariants } from "./product-variants";
import { ProductImages } from "./product-images";
import { ProductPublishing } from "./product-publishing";

type Status = "all" | "published" | "draft" | "trashed";
type StockFilter = "" | "in_stock" | "low" | "out";

const SORT_LABELS: Record<ProductSort, string> = {
  newest: "Newest first",
  name: "Name A–Z",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
};
const STOCK_LABELS = { in_stock: "In stock", low: "Low stock", out: "Out of stock" } as const;

// Module-level contracts: the resource reloads when its contract identity changes, so these
// must never be recreated per render (that caused an endless reload of the editor).
const EXISTING_PRODUCT: ResponseContract<ProductResponse | null> = productResponseSchema;
/** A new product has nothing to load; the probe request only confirms read access. */
const NEW_PRODUCT: ResponseContract<ProductResponse | null> = { parse: () => null };

/**
 * Products (step 44): list and draft-first editor. Variants/SKU (45), stock (46–47), images
 * (48–50) and publish/trash (51) arrive later; the server enforces every rule shown here.
 */
export function ProductManagement({ permissions }: { permissions: readonly string[] }) {
  const canWrite = permissions.includes("catalog.write");
  const canSeo = permissions.includes("seo.write");
  // An existing product opens from the URL (`?product=`, parity G-A2); a new one is local.
  const { get, navigate } = useUrlQuery();
  const [creating, setCreating] = useState(false);
  const urlProduct = get("product");
  const editing: string | "new" | null = creating ? "new" : isUuid(urlProduct) ? urlProduct : null;
  const setEditing = (id: string | "new" | null) => {
    setCreating(id === "new");
    if (id !== "new") navigate({ product: id }, true);
  };
  if (editing)
    return (
      <ProductEditor
        id={editing === "new" ? null : editing}
        canWrite={canWrite}
        canSeo={canSeo}
        permissions={permissions}
        onDone={(id) => setEditing(id)}
        onBack={() => setEditing(null)}
      />
    );
  return <ProductList canWrite={canWrite} permissions={permissions} onOpen={setEditing} />;
}

function ProductList({
  canWrite,
  permissions,
  onOpen,
}: {
  canWrite: boolean;
  permissions: readonly string[];
  onOpen: (id: string | "new") => void;
}) {
  const [status, setStatus] = useState<Status>("all");
  const [brandId, setBrandId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [q, setQ] = useState("");
  const [stock, setStock] = useState<StockFilter>("");
  const [sort, setSort] = useState<ProductSort>("newest");
  const [cursor, setCursor] = useState<string | null>(null);
  // Stock levels are `inventory.read` data: the API strips them and refuses the filter without it.
  const canSeeStock = permissions.includes("inventory.read");
  const brands = useManagementResource("/brands?limit=100", brandsResponseSchema);
  const categories = useManagementResource("/categories?limit=100", categoriesResponseSchema);
  const params = new URLSearchParams({ status, limit: "25" });
  if (brandId) params.set("brandId", brandId);
  if (categoryId) params.set("categoryId", categoryId);
  if (q) params.set("q", q);
  if (stock && canSeeStock) params.set("stock", stock);
  if (sort !== "newest") params.set("sort", sort);
  if (cursor) params.set("after", cursor);
  const products = useManagementResource(`/products?${params}`, productsResponseSchema);
  const reset = (apply: () => void) => {
    apply();
    setCursor(null);
  };
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Products</h2>
        {canWrite && (
          <button type="button" className="primary-button" onClick={() => onOpen("new")}>
            Add product
          </button>
        )}
      </header>
      <div className="tab-list" role="tablist" aria-label="Product status">
        {(["all", "published", "draft", "trashed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="secondary-button"
            aria-selected={status === value}
            onClick={() => reset(() => setStatus(value))}
          >
            {value === "all"
              ? "All"
              : value === "published"
                ? "Published"
                : value === "draft"
                  ? "Drafts"
                  : "Trash"}
          </button>
        ))}
      </div>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          reset(() => setQ(String(new FormData(e.currentTarget).get("q") ?? "").trim()));
        }}
      >
        <label>
          <span>Search name or SKU</span>
          <input name="q" type="search" maxLength={100} defaultValue={q} />
        </label>
        <label>
          <span>Brand</span>
          <select value={brandId} onChange={(e) => reset(() => setBrandId(e.target.value))}>
            <option value="">All brands</option>
            {brands.data?.items.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select value={categoryId} onChange={(e) => reset(() => setCategoryId(e.target.value))}>
            <option value="">All categories</option>
            {categories.data?.items.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        {canSeeStock && (
          <label>
            <span>Stock</span>
            <select
              value={stock}
              onChange={(e) => reset(() => setStock(e.target.value as StockFilter))}
            >
              <option value="">Any stock</option>
              {(Object.keys(STOCK_LABELS) as Array<keyof typeof STOCK_LABELS>).map((value) => (
                <option key={value} value={value}>
                  {STOCK_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Sort</span>
          <select
            value={sort}
            onChange={(e) => reset(() => setSort(e.target.value as ProductSort))}
          >
            {(Object.keys(SORT_LABELS) as ProductSort[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </form>
      <ResourceNotice resource={products} />
      {products.data && (
        <>
          {products.data.items.length === 0 && (
            <p className="muted">No matching products. Try a different name, SKU or filter.</p>
          )}
          <div className="record-list">
            {products.data.items.map((product) => (
              <article className="record-card product-row" key={product.id}>
                {product.thumbnailUrl ? (
                  // Signed, short-lived thumbnail from the API; decorative next to the name.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="product-thumb" src={product.thumbnailUrl} alt="" />
                ) : (
                  <span className="product-thumb" aria-hidden="true" />
                )}
                <div className="product-row-body">
                  <header className="card-heading">
                    <strong>{product.name}</strong>
                    <span className="badge">
                      {product.status === "published" ? "Published" : "Draft"} · AED{" "}
                      {filsToAed(product.basePriceFils)}
                    </span>
                  </header>
                  <p className="muted">
                    {product.brand.name} · {product.category.name} ·{" "}
                    {product.type === "kit" ? "Kit" : "Disposable"}
                    {product.isNew ? " · New" : ""}
                  </p>
                  {product.stock && (
                    <p className="product-stock">
                      <span className={`stock-tag stock-${product.stock.state}`}>
                        {STOCK_LABELS[product.stock.state]}
                      </span>{" "}
                      {product.stock.onHand} on hand
                    </p>
                  )}
                  {status === "trashed" ? (
                    <TrashedActions
                      product={product}
                      permissions={permissions}
                      run={products.run}
                      onDone={() => products.reload()}
                    />
                  ) : (
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => onOpen(product.id)}
                      >
                        {canWrite ? "Edit product" : "View product"}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!cursor || products.busy}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!products.data.nextCursor || products.busy}
              onClick={() => setCursor(products.data!.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Trash view: restore (`catalog.trash`) or Owner-only permanent deletion (`catalog.purge`). */
function TrashedActions({
  product,
  permissions,
  run,
  onDone,
}: {
  product: ProductSummary;
  permissions: readonly string[];
  run: ReturnType<typeof useManagementResource>["run"];
  onDone: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const act = async (command: "restore" | "purge") => {
    const body = { version: product.version };
    const path = `/products/${product.id}/${command}`;
    const outcome = await run<unknown>((signal) =>
      command === "restore"
        ? managementRequest(path, productReadinessSchema, "POST", body, signal)
        : managementRequest(path, productPurgeResponseSchema, "POST", body, signal),
    );
    if (outcome.ok) onDone();
  };
  return (
    <div className="form-actions">
      {permissions.includes("catalog.trash") && (
        <button type="button" className="secondary-button" onClick={() => void act("restore")}>
          Restore as draft
        </button>
      )}
      {permissions.includes("catalog.purge") && (
        <>
          <label>
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />{" "}
            I understand this cannot be undone
          </label>
          <button
            type="button"
            className="danger-button"
            disabled={!understood}
            onClick={() => {
              if (window.confirm(`Delete ${product.name} permanently?`)) void act("purge");
            }}
          >
            Delete permanently
          </button>
        </>
      )}
    </div>
  );
}

function ProductEditor({
  id,
  canWrite,
  canSeo,
  permissions,
  onDone,
  onBack,
}: {
  id: string | null;
  canWrite: boolean;
  canSeo: boolean;
  permissions: readonly string[];
  onDone: (id: string) => void;
  onBack: () => void;
}) {
  const product = useManagementResource(
    id ? `/products/${id}` : "/products?limit=1",
    id ? EXISTING_PRODUCT : NEW_PRODUCT,
  );
  const brands = useManagementResource("/brands?limit=100", brandsResponseSchema);
  const categories = useManagementResource("/categories?limit=100", categoriesResponseSchema);
  const row = id ? product.data : null;
  if (id && !row)
    return (
      <section className="management-card">
        <ResourceNotice resource={product} />
        <button type="button" className="secondary-button" onClick={onBack}>
          Back to products
        </button>
      </section>
    );
  return (
    <>
      <ProductForm
        key={row ? `${row.id}-${row.version}` : "new"}
        row={row}
        resource={product}
        canWrite={canWrite}
        canSeo={canSeo}
        brands={brands.data?.items ?? []}
        categories={categories.data?.items ?? []}
        onSaved={(saved) => {
          if (id) product.setData(saved);
          else onDone(saved.id);
        }}
        onBack={onBack}
      />
      {row && (
        <ProductPublishing
          key={`${row.id}-${row.version}`}
          productId={row.id}
          permissions={permissions}
          onChanged={product.reload}
        />
      )}
      {row && <ProductImages productId={row.id} canWrite={canWrite} />}
      {row && (
        <ProductVariants
          productId={row.id}
          productSlug={row.slug}
          canWrite={canWrite}
          onProductChanged={product.reload}
        />
      )}
    </>
  );
}

function ProductForm({
  row,
  resource,
  canWrite,
  canSeo,
  brands,
  categories,
  onSaved,
  onBack,
}: {
  row: ProductResponse | null;
  resource: ReturnType<typeof useManagementResource<ProductResponse | null>>;
  canWrite: boolean;
  canSeo: boolean;
  brands: ReadonlyArray<{ id: string; name: string }>;
  categories: ReadonlyArray<{ id: string; name: string }>;
  onSaved: (product: ProductResponse) => void;
  onBack: () => void;
}) {
  const [type, setType] = useState<"disposable" | "kit">(row?.type ?? "disposable");
  const [name, setName] = useState(row?.name ?? "");
  const [slug, setSlug] = useState(row?.slug ?? "");
  const [touched, setTouched] = useState(Boolean(row));
  const specs = (row?.specs ?? { extra: [] }) as Record<string, unknown> & {
    extra: Array<{ label: string; value: string }>;
  };
  const value = (key: string) => (specs[key] === undefined ? "" : String(specs[key]));
  // A product's current parent stays selectable even if it is no longer in the live lists.
  const withCurrent = (
    list: ReadonlyArray<{ id: string; name: string }>,
    current?: { id: string; name: string },
  ) => (current && !list.some((item) => item.id === current.id) ? [current, ...list] : list);
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>{row ? row.name : "Add product"}</h2>
        <span className="badge">
          {row
            ? `${row.status === "published" ? "Published" : "Draft"} · v${row.version}`
            : "Draft"}
        </span>
      </header>
      <p className="muted">
        Products are saved as drafts. Publishing opens once images and variants are in place. The
        price you enter is the final price the customer pays.
      </p>
      <ResourceNotice resource={resource} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const outcome = await resource.run((signal) =>
            row
              ? managementRequest(
                  `/products/${row.id}`,
                  productResponseSchema,
                  "PATCH",
                  productUpdateCommand(row, data, canSeo),
                  signal,
                )
              : managementRequest(
                  "/products",
                  productResponseSchema,
                  "POST",
                  productCreateCommand(data, canSeo),
                  signal,
                ),
          );
          if (outcome.ok) onSaved(outcome.value);
        }}
      >
        <fieldset disabled={resource.disabled || !canWrite}>
          <div className="form-grid">
            <label>
              <span>Product name *</span>
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
              <span>Slug (/products/…) *</span>
              <input
                name="slug"
                required
                maxLength={150}
                // Changing an existing link makes a redirect: the Owner's (step 101).
                readOnly={Boolean(row) && !canSeo}
                value={slug}
                onChange={(e) => {
                  setTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </label>
            <label>
              <span>Type *</span>
              <select
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value as "disposable" | "kit")}
              >
                <option value="disposable">Disposable</option>
                <option value="kit">Kit</option>
              </select>
            </label>
            <label>
              <span>Brand *</span>
              <select name="brandId" required defaultValue={row?.brand.id ?? ""}>
                <option value="">Choose brand</option>
                {withCurrent(brands, row?.brand).map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Category *</span>
              <select name="categoryId" required defaultValue={row?.category.id ?? ""}>
                <option value="">Choose category</option>
                {withCurrent(categories, row?.category).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            {type === "disposable" && (
              <label>
                <span>Puffs (approx.)</span>
                <input
                  name="puffCount"
                  inputMode="numeric"
                  maxLength={7}
                  defaultValue={row?.puffCount ?? ""}
                />
              </label>
            )}
            <label>
              <span>Price (AED) *</span>
              <input
                name="price"
                required
                inputMode="decimal"
                maxLength={12}
                defaultValue={row ? filsToAed(row.basePriceFils) : ""}
              />
            </label>
            <label>
              <span>Compare-at price (AED, optional)</span>
              <input
                name="compareAt"
                inputMode="decimal"
                maxLength={12}
                defaultValue={row?.compareAtPriceFils ? filsToAed(row.compareAtPriceFils) : ""}
              />
              <small className="muted">Shown as the previous price; must be above the price.</small>
            </label>
            <label className="wide-field">
              <span>Description</span>
              <textarea
                name="description"
                rows={4}
                maxLength={5000}
                defaultValue={row?.description ?? ""}
              />
            </label>
            <label>
              <input type="checkbox" name="isNew" defaultChecked={row?.isNew ?? false} /> Show
              &ldquo;New&rdquo; badge
            </label>
          </div>
          <h3>Specifications</h3>
          <div className="form-grid">
            {type === "disposable" ? (
              <>
                <SpecInput name="liquidMl" label="E-liquid (ml)" value={value("liquidMl")} />
                <SpecInput name="batteryMah" label="Battery (mAh)" value={value("batteryMah")} />
                <SpecInput name="charging" label="Charging" value={value("charging")} />
                <label>
                  <input
                    type="checkbox"
                    name="specs.rechargeable"
                    defaultChecked={specs.rechargeable === true}
                  />{" "}
                  Rechargeable
                </label>
              </>
            ) : (
              <>
                <SpecInput name="batteryMah" label="Battery (mAh)" value={value("batteryMah")} />
                <SpecInput name="maxOutputW" label="Max output (W)" value={value("maxOutputW")} />
                <SpecInput
                  name="podCapacityMl"
                  label="Pod capacity (ml)"
                  value={value("podCapacityMl")}
                />
                <SpecInput name="coilOhm" label="Coil (Ω)" value={value("coilOhm")} />
                <SpecInput name="charging" label="Charging" value={value("charging")} />
                <SpecInput name="display" label="Display" value={value("display")} />
                <SpecInput name="inTheBox" label="In the box" value={value("inTheBox")} />
              </>
            )}
            <label className="wide-field">
              <span>Other specifications (one per line, &ldquo;Label: value&rdquo;)</span>
              <textarea
                name="specs.extra"
                rows={3}
                maxLength={2000}
                defaultValue={formatExtraSpecs(specs.extra ?? [])}
              />
            </label>
          </div>
          {canSeo && (
            <>
              <h3>Search engine listing</h3>
              <div className="form-grid">
                <label>
                  <span>SEO title (optional)</span>
                  <input name="seo.title" maxLength={120} defaultValue={row?.seo?.title ?? ""} />
                </label>
                <label className="wide-field">
                  <span>SEO description (optional)</span>
                  <textarea
                    name="seo.description"
                    rows={2}
                    maxLength={320}
                    defaultValue={row?.seo?.description ?? ""}
                  />
                </label>
              </div>
            </>
          )}
          <div className="form-actions">
            {canWrite && (
              <button className="primary-button" type="submit">
                {row ? "Save changes" : "Save draft"}
              </button>
            )}
            <button type="button" className="secondary-button" onClick={onBack}>
              Back to products
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function SpecInput({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <input name={`specs.${name}`} maxLength={300} defaultValue={value} />
    </label>
  );
}
