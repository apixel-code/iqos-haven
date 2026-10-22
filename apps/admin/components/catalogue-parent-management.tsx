"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { toast } from "../lib/ui/toast";
import Link from "next/link";
import { useId, useState } from "react";
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
import { Icon, type IconName } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";
import { ParentImage, ParentThumb } from "./parent-image";

type Tab = "live" | "trashed";
type Parent = BrandResponse | CategoryResponse;
type Page = { items: Parent[]; nextCursor: string | null };

interface KindConfig {
  readonly path: "/brands" | "/categories";
  readonly title: string;
  readonly noun: string;
  readonly urlPrefix: string;
  readonly sub: string;
  readonly empty: string;
  readonly icon: IconName;
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
    sub: "Brand pages and the Shop by Brand section use these.",
    empty: "Add a brand to group products and create a brand page.",
    icon: "award",
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
    sub: "Shown in the store menu and filters, in display order.",
    empty: "Create a category to group products in the store.",
    icon: "folder",
    description: false,
    imageLabel: "Image",
    page: categoriesResponseSchema as ResponseContract<Page>,
    row: categoryResponseSchema as ResponseContract<Parent>,
    create: categoryCreateCommand,
    update: (row, data, seo) => categoryUpdateCommand(row as CategoryResponse, data, seo),
  },
};

/**
 * Brands (step 42) and categories (step 43) in the prototype's layout (`VIEWS.brands`,
 * `VIEWS.categories`, ADR 0097 V-A6): a category list and a brand card grid, with a drawer to
 * create or edit one. Server permissions decide every action; buttons only mirror them. A brand
 * logo or category image is uploaded in the drawer (parity G-A7, ADR 0091), and the Owner can
 * delete a trashed one that no product uses.
 */
export function CatalogueParentManagement({
  kind,
  permissions,
}: {
  kind: "brand" | "category";
  permissions: readonly string[];
}) {
  const config = KINDS[kind];
  const Noun = config.noun[0]!.toUpperCase() + config.noun.slice(1);
  const canWrite = permissions.includes("catalog.write");
  const canTrash = permissions.includes("catalog.trash");
  const canPurge = permissions.includes("catalog.purge");
  const canSeo = permissions.includes("seo.write");
  const [tab, setTab] = useState<Tab>("live");
  const [cursors, setCursors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Parent | "new" | null>(null);
  const cursor = cursors.at(-1);
  const resource = useManagementResource(
    `${config.path}?status=${tab}&limit=50` +
      (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    config.page,
  );
  const items = (resource.data?.items ?? []).filter((row) =>
    row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const trash = tab === "trashed";

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
    setCursors([]);
  }
  /** The prototype's "Show in store" switch: the same update, with only `active` changed. */
  async function setActive(row: Parent, active: boolean) {
    const data = new FormData();
    data.set("name", row.name);
    data.set("slug", row.slug);
    if ("description" in row) data.set("description", row.description);
    data.set("sortOrder", String(row.sortOrder));
    if (active) data.set("active", "on");
    const outcome = await resource.run((signal) =>
      managementRequest(
        `${config.path}/${row.id}`,
        config.row,
        "PATCH",
        // SEO and the image are left out, so they stay as they are.
        config.update(row, data, false),
        signal,
      ),
    );
    if (outcome.ok) {
      replace(outcome.value);
      toast(`${row.name} ${active ? "is shown in the store" : "is hidden from the store"}`);
    }
  }
  async function moveToTrash(row: Parent) {
    if (row.publishedProductCount > 0) {
      toast(
        `${plural(row.publishedProductCount, "published product")} use ${row.name}. Move or unpublish them before moving the ${config.noun} to trash.`,
        { kind: "err" },
      );
      return;
    }
    if (
      !(await confirmDialog({
        title: `Move ${row.name} to Trash?`,
        body: `The ${config.noun} page will be hidden. You can restore it from Trash.`,
        ok: "Move to Trash",
        danger: true,
      }))
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
      !(await confirmDialog({
        title: `Delete ${row.name} permanently?`,
        body: "Its old links stop redirecting. This cannot be undone.",
        ok: "Delete permanently",
        danger: true,
      }))
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

  const trashActions = (row: Parent) =>
    canTrash && (
      <>
        <button
          type="button"
          className="btn btn-s btn-sm"
          disabled={resource.disabled}
          onClick={() => void restore(row)}
        >
          <Icon name="restore" size="sm" />
          Restore
        </button>
        {canPurge && (
          <button
            type="button"
            className="btn btn-ds btn-sm"
            disabled={resource.disabled}
            onClick={() => void purge(row)}
          >
            Delete permanently
          </button>
        )}
      </>
    );
  const liveActions = (row: Parent) => (
    <>
      <button
        type="button"
        className="ibtn"
        aria-label={`${canWrite ? "Edit" : "View"} ${row.name}`}
        onClick={() => setEditing(row)}
      >
        <Icon name={canWrite ? "edit" : "eye"} />
      </button>
      {canTrash && (
        <button
          type="button"
          className="ibtn"
          aria-label={`Move ${row.name} to trash`}
          disabled={resource.disabled}
          onClick={() => void moveToTrash(row)}
        >
          <Icon name="trash" />
        </button>
      )}
    </>
  );
  const activeSwitch = (row: Parent, text: string) => (
    <label className="switch">
      <input
        type="checkbox"
        checked={row.active}
        disabled={resource.disabled || !canWrite}
        aria-label={`Show ${row.name} in the store`}
        onChange={(event) => void setActive(row, event.target.checked)}
      />
      <span className="small">{text}</span>
    </label>
  );
  const image = (row: Parent) => ("logoAssetId" in row ? row.logoAssetId : row.imageAssetId);

  return (
    <>
      <Link className="backlink" href="/workspace/products">
        <Icon name="arr-l" size="sm" />
        Products
      </Link>
      <PageHead
        title={config.title}
        sub={config.sub}
        actions={
          canWrite && (
            <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
              <Icon name="plus" />
              New {config.noun}
            </button>
          )
        }
      />
      <div className="stack orders-head">
        <div className="tabs" role="tablist" aria-label={`${config.title} lists`}>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={!trash}
            onClick={() => show("live")}
          >
            {config.title}
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={trash}
            onClick={() => show("trashed")}
          >
            <Icon name="trash" size="sm" />
            Trash
          </button>
        </div>
        <div className="toolbar">
          <div className="search">
            <Icon name="search" />
            <label className="sr" htmlFor={`${kind}-q`}>
              Search {config.title.toLowerCase()} on this page
            </label>
            <input
              id={`${kind}-q`}
              type="search"
              placeholder={`Search ${config.title.toLowerCase()}`}
              value={search}
              maxLength={150}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>
      <ResourceNotice resource={resource} compact />
      {resource.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name={trash ? "trash" : config.icon} />
              </div>
              <h3>{trash ? "Trash is empty" : `No ${config.title.toLowerCase()} found`}</h3>
              <p>
                {trash
                  ? `Deleted ${config.title.toLowerCase()} can be restored from here.`
                  : search
                    ? "Try a different name."
                    : config.empty}
              </p>
            </div>
          </div>
        ) : kind === "category" ? (
          <div className="tbl-wrap">
            <div className="list">
              {items.map((row) => (
                <div className="li parent-row" key={`${row.id}-${row.version}`}>
                  <ParentThumb assetId={image(row)} icon="folder" className="thumb parent-thumb" />
                  <div className="li-b">
                    <b>{row.name}</b>
                    <small>
                      <span className="mono">
                        {config.urlPrefix}
                        {row.slug}
                      </span>{" "}
                      · {plural(row.publishedProductCount, "published product")}
                      {trash ? "" : ` · order ${row.sortOrder}`}
                    </small>
                  </div>
                  {trash ? (
                    <div className="row">{trashActions(row)}</div>
                  ) : (
                    <>
                      <span className="hide-m">
                        {activeSwitch(row, row.active ? "Active" : "Inactive")}
                      </span>
                      {liveActions(row)}
                    </>
                  )}
                </div>
              ))}
            </div>
            <Pager
              count={items.length}
              page={cursors.length + 1}
              busy={resource.busy}
              hasPrevious={cursors.length > 0}
              hasNext={Boolean(resource.data.nextCursor)}
              previous={() => setCursors((value) => value.slice(0, -1))}
              next={() => setCursors((value) => [...value, resource.data!.nextCursor!])}
              noun={config.noun}
            />
          </div>
        ) : (
          <>
            <div className="grid g3">
              {items.map((row) => (
                <div className="card parent-row brand-card" key={`${row.id}-${row.version}`}>
                  <ParentThumb assetId={image(row)} icon="award" className="brand-logo" />
                  <div className="card-b brand-card-b">
                    <div className="row between">
                      <b className="brand-name">{row.name}</b>
                      {row.active ? (
                        <span className="tag ok">Active</span>
                      ) : (
                        <span className="tag">Inactive</span>
                      )}
                    </div>
                    {"description" in row && row.description && (
                      <p className="small muted clamp2">{row.description}</p>
                    )}
                    <div className="row between brand-meta">
                      <span className="small">
                        {plural(row.publishedProductCount, "published product")}
                      </span>
                      <span className="mono xs muted">
                        {config.urlPrefix}
                        {row.slug}
                      </span>
                    </div>
                  </div>
                  <div className="card-f between">
                    {trash ? (
                      trashActions(row)
                    ) : (
                      <>
                        {activeSwitch(row, "Show in store")}
                        <span className="row tight">{liveActions(row)}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="tbl-wrap">
              <Pager
                count={items.length}
                page={cursors.length + 1}
                busy={resource.busy}
                hasPrevious={cursors.length > 0}
                hasNext={Boolean(resource.data.nextCursor)}
                previous={() => setCursors((value) => value.slice(0, -1))}
                next={() => setCursors((value) => [...value, resource.data!.nextCursor!])}
                noun={config.noun}
              />
            </div>
          </>
        ))}
      {!trash && kind === "category" && (
        <p className="help help-i">
          <Icon name="info" size="sm" /> Inactive categories are hidden from the store menu but keep
          their products.
        </p>
      )}
      {editing && (
        <ParentDrawer
          key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
          config={config}
          noun={Noun}
          row={editing === "new" ? null : editing}
          resource={resource}
          canWrite={canWrite}
          canSeo={canSeo}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            toast(created ? `${saved.name} created` : `${saved.name} saved`);
            if (created) {
              setCursors([]);
              resource.reload();
            } else replace(saved);
          }}
        />
      )}
    </>
  );
}

function Pager(props: {
  count: number;
  page: number;
  busy: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  previous: () => void;
  next: () => void;
  noun: string;
}) {
  return (
    <div className="tbl-f">
      <span>
        {props.count}{" "}
        {props.count === 1
          ? props.noun
          : props.noun === "category"
            ? "categories"
            : `${props.noun}s`}{" "}
        on this page
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

/** The prototype's drawer to create or edit a brand or category (`beBody`, `ceBody`). */
function ParentDrawer({
  config,
  noun,
  row,
  resource,
  canWrite,
  canSeo,
  onClose,
  onSaved,
}: {
  config: KindConfig;
  noun: string;
  row: Parent | null;
  resource: ReturnType<typeof useManagementResource<Page>>;
  canWrite: boolean;
  canSeo: boolean;
  onClose: () => void;
  onSaved: (saved: Parent, created: boolean) => void;
}) {
  const form = useId();
  const [name, setName] = useState(row?.name ?? "");
  const [slug, setSlug] = useState(row?.slug ?? "");
  const [touched, setTouched] = useState(Boolean(row));
  const slugLocked = Boolean(row) && !canSeo;
  const locked = resource.disabled || !canWrite;
  return (
    <Drawer
      open
      onClose={onClose}
      title={row ? `${canWrite ? "Edit" : "View"} ${config.noun}` : `New ${config.noun}`}
      sub={row ? `${plural(row.publishedProductCount, "published product")} linked` : undefined}
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={onClose}>
            Cancel
          </button>
          {canWrite && (
            <button type="submit" form={form} className="btn btn-p" disabled={locked}>
              {row ? "Save changes" : `Create ${config.noun}`}
            </button>
          )}
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved={row ? row.name : `this new ${config.noun}`}
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const outcome = await resource.run((signal) =>
            row
              ? managementRequest(
                  `${config.path}/${row.id}`,
                  config.row,
                  "PATCH",
                  config.update(row, data, canSeo),
                  signal,
                )
              : managementRequest(
                  config.path,
                  config.row,
                  "POST",
                  config.create(data, canSeo),
                  signal,
                ),
          );
          if (outcome.ok) onSaved(outcome.value, !row);
        }}
      >
        <ResourceNotice resource={resource} compact />
        <fieldset className="plain-fs form" disabled={locked}>
          {config.noun === "brand" && (
            <ParentImage
              initial={row && "logoAssetId" in row ? row.logoAssetId : null}
              label={config.imageLabel}
              hint="Optional · a transparent PNG works best"
            />
          )}
          <div className="field">
            <label className="label" htmlFor={`${form}-name`}>
              <span>
                {noun} name{" "}
                <span className="req" aria-hidden="true">
                  *
                </span>
              </span>
            </label>
            <input
              id={`${form}-name`}
              className="input"
              name="name"
              required
              maxLength={150}
              data-autofocus=""
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!touched) setSlug(slugify(e.target.value));
              }}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${form}-slug`}>
              <span>
                Slug{" "}
                <span className="req" aria-hidden="true">
                  *
                </span>
              </span>
            </label>
            <div className="affix">
              <span>{config.urlPrefix}</span>
              <input
                id={`${form}-slug`}
                className="input mono"
                name="slug"
                required
                maxLength={150}
                readOnly={slugLocked}
                value={slug}
                onChange={(e) => {
                  setTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </div>
            <p className="help">
              {slugLocked
                ? "Only the Owner can change a link once it exists (the old link becomes a redirect)."
                : "Lowercase letters, numbers and single hyphens. Renaming keeps the old link working."}
            </p>
          </div>
          {config.description && (
            <div className="field">
              <label className="label" htmlFor={`${form}-desc`}>
                <span>
                  Description <span className="opt">Optional</span>
                </span>
              </label>
              <textarea
                id={`${form}-desc`}
                className="textarea"
                name="description"
                rows={3}
                maxLength={10_000}
                defaultValue={row && "description" in row ? row.description : ""}
              />
            </div>
          )}
          {config.noun === "category" && (
            <ParentImage
              initial={row && "imageAssetId" in row ? row.imageAssetId : null}
              label={config.imageLabel}
              hint="Optional, used on category tiles"
            />
          )}
          <div className="field">
            <label className="label" htmlFor={`${form}-order`}>
              Display order
            </label>
            <input
              id={`${form}-order`}
              className="input"
              name="sortOrder"
              inputMode="numeric"
              maxLength={6}
              defaultValue={row?.sortOrder ?? 0}
            />
            <p className="help">Lower numbers appear first.</p>
          </div>
          <label className="switch">
            <input type="checkbox" name="active" defaultChecked={row?.active ?? true} />
            Active (shown in store)
          </label>
          {canSeo && (
            <>
              <div className="field">
                <label className="label" htmlFor={`${form}-st`}>
                  <span>
                    SEO title <span className="opt">Optional</span>
                  </span>
                </label>
                <input
                  id={`${form}-st`}
                  className="input"
                  name="seo.title"
                  maxLength={120}
                  defaultValue={row?.seo?.title ?? ""}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor={`${form}-sd`}>
                  <span>
                    SEO description <span className="opt">Optional</span>
                  </span>
                </label>
                <textarea
                  id={`${form}-sd`}
                  className="textarea"
                  name="seo.description"
                  rows={2}
                  maxLength={320}
                  defaultValue={row?.seo?.description ?? ""}
                />
              </div>
            </>
          )}
        </fieldset>
      </form>
    </Drawer>
  );
}
