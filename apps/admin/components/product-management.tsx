"use client";
import { confirmDialog } from "../lib/ui/confirm";
import Link from "next/link";
import { useEffect, useState } from "react";
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
import { money, when } from "../lib/orders";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { PageHead } from "./page-head";
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
  // `?new=1` (the dashboard's "Add product") opens a new draft.
  const [creating, setCreatingState] = useState(() => canWrite && get("new") === "1");
  const setCreating = (on: boolean) => {
    setCreatingState(on);
    if (!on && get("new")) navigate({ new: null });
  };
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
  // The prototype's search as you type (after a pause); Enter is not needed.
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [stock, setStock] = useState<StockFilter>("");
  const [sort, setSort] = useState<ProductSort>("newest");
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = typed.trim().slice(0, 100);
      if (next !== q) {
        setQ(next);
        setCursors([]);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [typed, q]);
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
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const products = useManagementResource(`/products?${params}`, productsResponseSchema);
  const reset = (apply: () => void) => {
    apply();
    setCursors([]);
  };
  const trash = status === "trashed";
  const items = products.data?.items ?? [];
  const chips = [
    categoryId && {
      key: "category",
      label: categories.data?.items.find((item) => item.id === categoryId)?.name ?? "Category",
      clear: () => reset(() => setCategoryId("")),
    },
    brandId && {
      key: "brand",
      label: brands.data?.items.find((item) => item.id === brandId)?.name ?? "Brand",
      clear: () => reset(() => setBrandId("")),
    },
    stock && { key: "stock", label: STOCK_LABELS[stock], clear: () => reset(() => setStock("")) },
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => Boolean(chip));
  const filtered = Boolean(q || brandId || categoryId || stock);
  const clearAll = () =>
    reset(() => {
      setTyped("");
      setQ("");
      setBrandId("");
      setCategoryId("");
      setStock("");
    });
  return (
    <>
      <PageHead
        title="Products"
        sub="Products are drafts until published; publishing opens once images and options are in place."
        actions={
          <>
            <Link className="btn btn-s hide-m" href="/workspace/categories">
              <Icon name="folder" />
              Categories
            </Link>
            <Link className="btn btn-s hide-m" href="/workspace/brands">
              <Icon name="award" />
              Brands
            </Link>
            {canWrite && (
              <button type="button" className="btn btn-p" onClick={() => onOpen("new")}>
                <Icon name="plus" />
                Add product
              </button>
            )}
          </>
        }
      />
      <div className="stack orders-head">
        <div className="tabs" role="tablist" aria-label="Product status">
          {(["all", "published", "draft", "trashed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="tab"
              aria-selected={status === value}
              onClick={() => reset(() => setStatus(value))}
            >
              {value === "trashed" && <Icon name="trash" size="sm" />}
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
        <div className="toolbar">
          <div className="search">
            <Icon name="search" />
            <label className="sr" htmlFor="products-q">
              Search name or SKU
            </label>
            <input
              id="products-q"
              type="search"
              maxLength={100}
              placeholder="Search name or SKU"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <select
            className="fsel"
            aria-label="Category"
            value={categoryId}
            onChange={(e) => reset(() => setCategoryId(e.target.value))}
          >
            <option value="">All categories</option>
            {categories.data?.items.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            className="fsel"
            aria-label="Brand"
            value={brandId}
            onChange={(e) => reset(() => setBrandId(e.target.value))}
          >
            <option value="">All brands</option>
            {brands.data?.items.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
          {canSeeStock && (
            <select
              className="fsel"
              aria-label="Stock"
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
          )}
          <select
            className="fsel"
            aria-label="Sort"
            value={sort}
            onChange={(e) => reset(() => setSort(e.target.value as ProductSort))}
          >
            {(Object.keys(SORT_LABELS) as ProductSort[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </select>
          {chips.map((chip) => (
            <span className="chipf" key={chip.key}>
              {chip.label}
              <button type="button" aria-label={`Clear ${chip.label}`} onClick={chip.clear}>
                <Icon name="x" size="sm" />
              </button>
            </span>
          ))}
        </div>
      </div>
      <ResourceNotice resource={products} compact />
      {trash && items.length > 0 && (
        <div className="note">
          <Icon name="info" />
          <p>
            Products in Trash are hidden from the store. Restore them as drafts, or delete them
            permanently (Owner). Past orders keep their details.
          </p>
        </div>
      )}
      {products.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name={trash ? "trash" : "search"} />
              </div>
              <h3>{trash ? "Trash is empty" : "No matching products"}</h3>
              <p>
                {trash
                  ? "Products you move to Trash appear here, ready to restore."
                  : "Try a different name, SKU or filter."}
              </p>
              {!trash && (filtered || canWrite) && (
                <div className="row">
                  {filtered && (
                    <button type="button" className="btn btn-s" onClick={clearAll}>
                      Clear filters
                    </button>
                  )}
                  {canWrite && (
                    <button type="button" className="btn btn-p" onClick={() => onOpen("new")}>
                      <Icon name="plus" />
                      Add product
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="tbl-wrap only-d">
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th className="num">Price</th>
                      {canSeeStock && <th className="num">Stock</th>}
                      {canSeeStock && <th>Stock status</th>}
                      <th>{trash ? "In Trash" : "Visibility"}</th>
                      <th className="w1">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((product) => (
                      <tr
                        key={product.id}
                        className={trash ? "product-row" : "product-row click"}
                        onClick={trash ? undefined : () => onOpen(product.id)}
                      >
                        <td>
                          <div className="cellp">
                            <Thumb url={product.thumbnailUrl} />
                            <div>
                              <b>{product.name}</b>
                              <small>
                                {product.brand.name} ·{" "}
                                {product.type === "kit" ? "Kit" : "Disposable"}
                                {product.isNew ? " · New" : ""}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td className="small">{product.category.name}</td>
                        <td className="num">{money(product.basePriceFils)}</td>
                        {canSeeStock && (
                          <td className="num">
                            {product.stock ? (
                              <span className="cust">{product.stock.onHand} on hand</span>
                            ) : (
                              "—"
                            )}
                          </td>
                        )}
                        {canSeeStock && (
                          <td>{product.stock && <StockTag state={product.stock.state} />}</td>
                        )}
                        <td>
                          {trash ? (
                            <span className="small muted">
                              {product.trashedAt ? when(product.trashedAt) : "Trashed"}
                            </span>
                          ) : (
                            <span className={product.status === "published" ? "tag pub" : "tag"}>
                              {product.status === "published" ? "Published" : "Draft"}
                            </span>
                          )}
                        </td>
                        <td className="w1" onClick={(event) => event.stopPropagation()}>
                          {trash ? (
                            <TrashedActions
                              product={product}
                              permissions={permissions}
                              run={products.run}
                              onDone={() => products.reload()}
                            />
                          ) : (
                            <button
                              type="button"
                              className="btn btn-s btn-sm"
                              aria-label={`${canWrite ? "Edit product" : "View product"} ${product.name}`}
                              onClick={() => onOpen(product.id)}
                            >
                              <Icon name={canWrite ? "edit" : "eye"} size="sm" />
                              {canWrite ? "Edit" : "View"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ProductPager
                count={items.length}
                page={cursors.length + 1}
                busy={products.busy}
                hasPrevious={cursors.length > 0}
                hasNext={Boolean(products.data.nextCursor)}
                previous={() => setCursors((value) => value.slice(0, -1))}
                next={() => setCursors((value) => [...value, products.data!.nextCursor!])}
              />
            </div>
            {/* Phones: the prototype's product rows in place of the table. */}
            <div className="only-m">
              <div className="mlist">
                {items.map((product) =>
                  trash ? (
                    <div key={product.id} className="mrow product-row">
                      <ProductRowM product={product} trash />
                      <div className="mrow-a">
                        <TrashedActions
                          product={product}
                          permissions={permissions}
                          run={products.run}
                          onDone={() => products.reload()}
                        />
                      </div>
                    </div>
                  ) : (
                    <button
                      key={product.id}
                      type="button"
                      className="mrow product-row"
                      onClick={() => onOpen(product.id)}
                    >
                      <ProductRowM product={product} trash={false} />
                    </button>
                  ),
                )}
              </div>
              <div className="tbl-wrap orders-mpager">
                <ProductPager
                  count={items.length}
                  page={cursors.length + 1}
                  busy={products.busy}
                  hasPrevious={cursors.length > 0}
                  hasNext={Boolean(products.data.nextCursor)}
                  previous={() => setCursors((value) => value.slice(0, -1))}
                  next={() => setCursors((value) => [...value, products.data!.nextCursor!])}
                />
              </div>
            </div>
          </>
        ))}
    </>
  );
}

/** The prototype's phone product row (`prodRowM`): picture, name, price, stock and visibility. */
function ProductRowM({ product, trash }: { product: ProductSummary; trash: boolean }) {
  return (
    <span className="mrow-in">
      <Thumb url={product.thumbnailUrl} large />
      <span className="mrow-b">
        <span className="mrow-t">
          <b>{product.name}</b>
          <span className="amt">{money(product.basePriceFils)}</span>
        </span>
        <span className="meta">
          <span>{product.brand.name}</span>
          {product.stock && (
            <>
              <span aria-hidden="true">·</span>
              <span>{product.stock.onHand} on hand</span>
            </>
          )}
        </span>
        <span className="row">
          {product.stock && <StockTag state={product.stock.state} />}
          {!trash && (
            <span className={product.status === "published" ? "tag pub" : "tag"}>
              {product.status === "published" ? "Published" : "Draft"}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/** A product picture (signed, short-lived thumbnail) or the prototype's empty tile. */
function Thumb({ url, large = false }: { url: string | null; large?: boolean }) {
  return (
    <span className={large ? "thumb lg" : "thumb"} aria-hidden="true">
      {url ? (
        // Signed, short-lived thumbnail from the API; decorative next to the name.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="product-thumb" src={url} alt="" />
      ) : (
        <Icon name="image" />
      )}
    </span>
  );
}

/** The prototype's stock tag (`stockTag`). */
function StockTag({ state }: { state: keyof typeof STOCK_LABELS }) {
  return (
    <span className={`tag ${state === "in_stock" ? "ok" : state === "low" ? "low" : "out"}`}>
      {STOCK_LABELS[state]}
    </span>
  );
}

/** The prototype's table foot; the list pages by position, so it steps back and forward. */
function ProductPager(props: {
  count: number;
  page: number;
  busy: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  previous: () => void;
  next: () => void;
}) {
  return (
    <div className="tbl-f">
      <span>
        {props.count} {props.count === 1 ? "product" : "products"} on this page
      </span>
      <div className="pager">
        <button
          type="button"
          aria-label="Previous page"
          disabled={!props.hasPrevious || props.busy}
          onClick={props.previous}
        >
          <Icon name="cl" size="sm" />
        </button>
        <button type="button" aria-current="page" aria-label={`Page ${props.page}`}>
          {props.page}
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!props.hasNext || props.busy}
          onClick={props.next}
        >
          <Icon name="cr" size="sm" />
        </button>
      </div>
    </div>
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
    <div className="row trash-acts">
      {permissions.includes("catalog.trash") && (
        <button type="button" className="btn btn-s btn-sm" onClick={() => void act("restore")}>
          <Icon name="restore" size="sm" />
          Restore as draft
        </button>
      )}
      {permissions.includes("catalog.purge") && (
        <>
          <label className="check-row small">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            I understand this cannot be undone
          </label>
          <button
            type="button"
            className="btn btn-ds btn-sm"
            disabled={!understood}
            onClick={() => {
              void confirmDialog({
                title: `Delete ${product.name} permanently?`,
                body: "This cannot be undone.",
                ok: "Delete permanently",
                danger: true,
              }).then((ok) => {
                if (ok) void act("purge");
              });
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
        <button data-leave type="button" className="secondary-button" onClick={onBack}>
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
        data-unsaved={row ? row.name : "this new product"}
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
            <button data-leave type="button" className="secondary-button" onClick={onBack}>
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
