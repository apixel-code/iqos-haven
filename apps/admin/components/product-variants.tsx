"use client";
import { useId, useState } from "react";
import {
  OPTION_NAMES,
  productVariantsResponseSchema,
  type ProductVariantsResponse,
  type VariantResponse,
} from "@ih/contracts";
import { aedToFils, filsToAed, managementRequest, validate } from "../lib/management";
import {
  describeAttributes,
  missingCombinations,
  parseOptionValues,
  suggestSku,
} from "../lib/variants";
import { variantCreateRequestSchema, variantUpdateRequestSchema } from "@ih/contracts";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";

/**
 * Options and variants of one product (step 45). Every response is the full snapshot, so the
 * screen always shows one consistent version. Stock is read-only here; adjustments come with
 * the stock ledger (steps 46–47).
 */
export function ProductVariants({
  productId,
  productSlug,
  canWrite,
  onProductChanged,
}: {
  productId: string;
  productSlug: string;
  canWrite: boolean;
  /** Options are product data: saving them bumps the product version, so the editor reloads. */
  onProductChanged: () => void;
}) {
  const resource = useManagementResource(
    `/products/${productId}/variants`,
    productVariantsResponseSchema,
  );
  const view = resource.data;
  const save = async (work: (signal: AbortSignal) => Promise<ProductVariantsResponse>) => {
    const outcome = await resource.run(work);
    if (!outcome.ok) return null;
    resource.setData(outcome.value);
    return outcome.value;
  };
  /** The body is built inside the run so form validation errors are reported, not thrown. */
  const request = (path: string, method: "POST" | "PUT" | "PATCH", body: () => unknown) =>
    save((signal) =>
      managementRequest(
        `/products/${productId}${path}`,
        productVariantsResponseSchema,
        method,
        body(),
        signal,
      ),
    );
  const missing = view ? missingCombinations(view) : [];
  const locked = resource.disabled || !canWrite;
  return (
    <>
      <div className="card-h">
        <h2>Options & variants</h2>
        <span className="tag">{view ? `${view.variants.length} variants` : "Loading"}</span>
      </div>
      <div className="card-b form">
        <ResourceNotice resource={resource} compact />
        {view && (
          <>
            <form
              data-unsaved="this product's options"
              className="form"
              key={`options-${view.productVersion}`}
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const options = OPTION_NAMES.flatMap((name) => {
                  const values = parseOptionValues(String(data.get(name) ?? ""));
                  return values.length ? [{ name, values }] : [];
                });
                void request("/options", "PUT", () => ({
                  productVersion: view.productVersion,
                  options,
                })).then((ok) => {
                  // Only a real change bumps the product version and needs the editor reloaded.
                  if (ok && ok.productVersion !== view.productVersion) onProductChanged();
                });
              }}
            >
              <fieldset className="plain-fs form" disabled={locked}>
                <div className="fgrid c2">
                  {OPTION_NAMES.map((name) => (
                    <div className="field" key={name}>
                      <label className="label" htmlFor={`opt-${name}`}>
                        <span>
                          {name[0]!.toUpperCase() + name.slice(1)} values{" "}
                          <span className="opt">Optional</span>
                        </span>
                      </label>
                      <textarea
                        id={`opt-${name}`}
                        className="textarea"
                        name={name}
                        rows={3}
                        maxLength={5000}
                        defaultValue={
                          view.options.find((option) => option.name === name)?.values.join("\n") ??
                          ""
                        }
                      />
                    </div>
                  ))}
                </div>
                <p className="help">
                  One value per line or comma separated. Which options a product has can only change
                  before its first variant; values can be added later, and removed while unused.
                </p>
                {canWrite && (
                  <div className="row">
                    <button type="submit" className="btn btn-s">
                      Save options
                    </button>
                    {missing.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-p"
                        onClick={async () => {
                          const offset = view.variants.length;
                          for (const [index, attributes] of missing.entries()) {
                            const ok = await request("/variants", "POST", () => ({
                              sku: suggestSku(productSlug, attributes, offset + index),
                              attributes,
                              priceOverrideFils: null,
                              lowStockThreshold: 0,
                              active: true,
                            }));
                            if (!ok) break;
                          }
                        }}
                      >
                        <Icon name="plus" />
                        Add {missing.length} missing{" "}
                        {missing.length === 1 ? "combination" : "combinations"}
                      </button>
                    )}
                    {view.options.length === 0 && view.variants.length === 0 && (
                      <button
                        type="button"
                        className="btn btn-p"
                        onClick={() =>
                          void request("/variants", "POST", () =>
                            validate(variantCreateRequestSchema, {
                              sku: suggestSku(productSlug, {}),
                              attributes: {},
                              priceOverrideFils: null,
                              lowStockThreshold: 0,
                              active: true,
                            }),
                          )
                        }
                      >
                        <Icon name="plus" />
                        Add single variant
                      </button>
                    )}
                  </div>
                )}
              </fieldset>
            </form>
            {view.variants.length === 0 ? (
              <p className="small muted">
                No variants yet. A product without options needs one variant before it can be sold.
              </p>
            ) : (
              <div className="vlist">
                {view.variants.map((variant) => (
                  <VariantRow
                    key={`${variant.id}-${variant.version}`}
                    variant={variant}
                    canWrite={canWrite}
                    locked={locked}
                    onSave={(body) => request(`/variants/${variant.id}`, "PATCH", body)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** One variant: its name, stock and default state, then its own fields. Stock changes in Inventory. */
function VariantRow({
  variant,
  canWrite,
  locked,
  onSave,
}: {
  variant: VariantResponse;
  canWrite: boolean;
  locked: boolean;
  onSave: (body: () => unknown) => Promise<unknown>;
}) {
  const id = useId();
  const [makeDefault, setMakeDefault] = useState(variant.isDefault);
  const name = describeAttributes(variant.attributes);
  return (
    <form
      className="variant-row"
      data-version={variant.version}
      data-unsaved={`option ${variant.sku}`}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const price = String(data.get("price") ?? "").trim();
        void onSave(() =>
          validate(variantUpdateRequestSchema, {
            version: variant.version,
            sku: String(data.get("sku") ?? ""),
            priceOverrideFils: price ? aedToFils(price) : null,
            lowStockThreshold: Number(String(data.get("threshold") ?? "").trim() || "0"),
            active: data.get("active") === "on",
            isDefault: makeDefault,
          }),
        );
      }}
    >
      <div className="vr-h">
        <b>{name}</b>
        <span className="row">
          {variant.isDefault && <span className="tag pub default-tag">Default</span>}
          {!variant.active && <span className="tag">Inactive</span>}
          <span className={variant.stockOnHand > 0 ? "tag ok" : "tag out"}>
            {variant.stockOnHand} in stock
          </span>
        </span>
      </div>
      <fieldset className="plain-fs vr-f" disabled={locked}>
        <div className="field">
          <label className="label" htmlFor={`${id}-sku`}>
            SKU
          </label>
          <input
            id={`${id}-sku`}
            className="input mono"
            name="sku"
            required
            maxLength={64}
            defaultValue={variant.sku}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-price`}>
            <span>
              Price <span className="opt">Override</span>
            </span>
          </label>
          <div className="affix">
            <span>AED</span>
            <input
              id={`${id}-price`}
              className="input"
              name="price"
              inputMode="decimal"
              maxLength={12}
              placeholder="Product price"
              defaultValue={
                variant.priceOverrideFils === null ? "" : filsToAed(variant.priceOverrideFils)
              }
            />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-alert`}>
            Low-stock alert at
          </label>
          <input
            id={`${id}-alert`}
            className="input"
            name="threshold"
            inputMode="numeric"
            maxLength={7}
            defaultValue={variant.lowStockThreshold}
          />
        </div>
        <div className="vr-a">
          <label className="check-row">
            <input type="checkbox" name="active" defaultChecked={variant.active} />
            Active
          </label>
          {!variant.isDefault && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              Make default
            </label>
          )}
          {canWrite && (
            <button type="submit" className="btn btn-s btn-sm" aria-label={`Save variant ${name}`}>
              Save
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
