"use client";
import { productReadinessSchema, type ProductReadiness } from "@ih/contracts";
import { managementRequest } from "../lib/management";
import { requirementLabel } from "../lib/publication";
import { ResourceNotice, useManagementResource } from "./management-resource";

/**
 * Publishing (step 51): the server decides readiness and enforces it; this card only shows what
 * is missing and offers the actions the caller's permissions allow. Zero stock never blocks.
 */
export function ProductPublishing({
  productId,
  permissions,
  onChanged,
}: {
  productId: string;
  permissions: readonly string[];
  onChanged: () => void;
}) {
  const readiness = useManagementResource(
    `/products/${productId}/readiness`,
    productReadinessSchema,
  );
  const data = readiness.data;
  const act = async (command: "publish" | "unpublish" | "trash", confirm?: string) => {
    if (!data || (confirm && !window.confirm(confirm))) return;
    const outcome = await readiness.run((signal) =>
      managementRequest(
        `/products/${productId}/${command}`,
        productReadinessSchema,
        "POST",
        { version: data.version },
        signal,
      ),
    );
    if (outcome.ok) {
      readiness.setData(outcome.value as ProductReadiness);
      onChanged();
    }
  };
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Publishing</h2>
        <span className="badge">
          {data ? (data.status === "published" ? "Published" : "Draft") : "…"}
        </span>
      </header>
      <ResourceNotice resource={readiness} />
      {data && (
        <fieldset disabled={readiness.disabled}>
          {data.ready ? (
            <p className="muted">
              Ready. Published products are visible in the store; with no stock they show Out of
              Stock and stay published.
            </p>
          ) : (
            <>
              <p className="muted">Before this product can be published:</p>
              <ul>
                {data.missing.map((requirement) => (
                  <li key={requirement}>{requirementLabel(requirement)}</li>
                ))}
              </ul>
            </>
          )}
          <div className="form-actions">
            {permissions.includes("catalog.publish") && data.status === "draft" && (
              <button
                type="button"
                className="primary-button"
                disabled={!data.ready}
                onClick={() => void act("publish")}
              >
                Publish
              </button>
            )}
            {permissions.includes("catalog.publish") && data.status === "published" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void act("unpublish")}
              >
                Move to draft
              </button>
            )}
            {permissions.includes("catalog.trash") && (
              <button
                type="button"
                className="danger-button"
                onClick={() =>
                  void act(
                    "trash",
                    "Move this product to trash? It is hidden from the store and admin lists. You can restore it from Trash.",
                  )
                }
              >
                Move to trash
              </button>
            )}
          </div>
        </fieldset>
      )}
    </section>
  );
}
