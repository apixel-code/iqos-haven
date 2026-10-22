"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { productReadinessSchema, type ProductReadiness } from "@ih/contracts";
import { managementRequest } from "../lib/management";
import { requirementLabel } from "../lib/publication";
import { Icon } from "./icons";
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
    if (!data) return;
    if (
      confirm &&
      !(await confirmDialog({
        title:
          command === "trash"
            ? "Move to Trash?"
            : command === "unpublish"
              ? "Unpublish this product?"
              : "Publish this product?",
        body: confirm,
        ok:
          command === "trash" ? "Move to Trash" : command === "unpublish" ? "Unpublish" : "Publish",
        danger: command === "trash",
      }))
    )
      return;
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
  const canPublish = permissions.includes("catalog.publish");
  return (
    <>
      <div className="card-h">
        <h2>Publishing</h2>
        {data && (
          <span className={data.status === "published" ? "tag pub" : "tag"}>
            {data.status === "published" ? "Published" : "Draft"}
          </span>
        )}
      </div>
      <div className="card-b">
        <ResourceNotice resource={readiness} compact />
        {data && (
          <fieldset className="plain-fs stack" disabled={readiness.disabled}>
            {data.ready ? (
              <p className="small muted">
                {data.status === "published"
                  ? "Visible on the store. With no stock it shows Out of Stock and stays published."
                  : "Ready to publish. With no stock it shows Out of Stock and stays published."}
              </p>
            ) : (
              <>
                <p className="small muted">Before this product can be published:</p>
                <ul className="checklist">
                  {data.missing.map((requirement) => (
                    <li key={requirement}>
                      <Icon name="x-c" size="sm" />
                      {requirementLabel(requirement)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="row">
              {canPublish && data.status === "draft" && (
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={!data.ready}
                  onClick={() => void act("publish")}
                >
                  <Icon name="globe" />
                  Publish
                </button>
              )}
              {canPublish && data.status === "published" && (
                <button type="button" className="btn btn-s" onClick={() => void act("unpublish")}>
                  <Icon name="eye-off" />
                  Move to draft
                </button>
              )}
              {permissions.includes("catalog.trash") && (
                <button
                  type="button"
                  className="btn btn-ds"
                  onClick={() =>
                    void act(
                      "trash",
                      "Move this product to trash? It is hidden from the store and admin lists. You can restore it from Trash.",
                    )
                  }
                >
                  <Icon name="trash" />
                  Move to trash
                </button>
              )}
            </div>
          </fieldset>
        )}
      </div>
    </>
  );
}
