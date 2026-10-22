"use client";
import { useState } from "react";
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
  return (
    <>
      <div className="card-h">
        <h2>Options & variants</h2>
        <span className="tag">{view ? `${view.variants.length} variants` : "Loading"}</span>
      </div>
      {/* The option and variant forms keep their own layout inside the prototype's card (V-A4b). */}
      <div className="card-b">
        <div className="management-card in-drawer">
          <ResourceNotice resource={resource} compact />
          {view && (
            <fieldset disabled={resource.disabled || !canWrite}>
              <form
                data-unsaved="this product's options"
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
                key={`options-${view.productVersion}`}
              >
                <p className="muted">
                  One value per line or comma separated. Which options a product has can only change
                  before its first variant; values can be added later, and removed while unused.
                </p>
                <div className="form-grid">
                  {OPTION_NAMES.map((name) => (
                    <label key={name}>
                      <span>{name[0]!.toUpperCase() + name.slice(1)} values</span>
                      <textarea
                        name={name}
                        rows={3}
                        maxLength={5000}
                        defaultValue={
                          view.options.find((option) => option.name === name)?.values.join("\n") ??
                          ""
                        }
                      />
                    </label>
                  ))}
                </div>
                {canWrite && (
                  <button type="submit" className="secondary-button">
                    Save options
                  </button>
                )}
              </form>
              {canWrite && missing.length > 0 && (
                <div className="form-actions">
                  <button
                    type="button"
                    className="primary-button"
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
                    Add {missing.length} missing{" "}
                    {missing.length === 1 ? "combination" : "combinations"}
                  </button>
                </div>
              )}
              <div className="record-list">
                {view.variants.map((variant) => (
                  <VariantCard
                    key={`${variant.id}-${variant.version}`}
                    variant={variant}
                    canWrite={canWrite}
                    onSave={(body) => request(`/variants/${variant.id}`, "PATCH", body)}
                  />
                ))}
              </div>
              {view.variants.length === 0 && (
                <p className="muted">
                  No variants yet. A product without options needs one variant before it can be
                  sold.
                </p>
              )}
              {canWrite && view.options.length === 0 && view.variants.length === 0 && (
                <button
                  type="button"
                  className="secondary-button"
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
                  Add single variant
                </button>
              )}
            </fieldset>
          )}
        </div>
      </div>
    </>
  );
}

function VariantCard({
  variant,
  canWrite,
  onSave,
}: {
  variant: VariantResponse;
  canWrite: boolean;
  onSave: (body: () => unknown) => Promise<unknown>;
}) {
  const [makeDefault, setMakeDefault] = useState(variant.isDefault);
  return (
    <form
      data-unsaved={`option ${variant.sku}`}
      className="record-card"
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
      <header className="card-heading">
        <strong>{describeAttributes(variant.attributes)}</strong>
        <span className="badge">
          {variant.isDefault ? "Default · " : ""}
          {variant.active ? "Active" : "Inactive"} · {variant.stockOnHand} in stock · v
          {variant.version}
        </span>
      </header>
      <div className="form-grid">
        <label>
          <span>SKU *</span>
          <input name="sku" required maxLength={64} defaultValue={variant.sku} />
        </label>
        <label>
          <span>Price override (AED, optional)</span>
          <input
            name="price"
            inputMode="decimal"
            maxLength={12}
            defaultValue={
              variant.priceOverrideFils === null ? "" : filsToAed(variant.priceOverrideFils)
            }
          />
        </label>
        <label>
          <span>Low-stock alert at</span>
          <input
            name="threshold"
            inputMode="numeric"
            maxLength={7}
            defaultValue={variant.lowStockThreshold}
          />
        </label>
        <label>
          <input type="checkbox" name="active" defaultChecked={variant.active} /> Active
        </label>
        <label>
          <input
            type="checkbox"
            checked={makeDefault}
            disabled={variant.isDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />{" "}
          Default variant
        </label>
      </div>
      {canWrite && (
        <button type="submit" className="secondary-button">
          Save variant
        </button>
      )}
    </form>
  );
}
