"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useEffect, useState } from "react";
import {
  mediaAssetSchema,
  mediaUploadResponseSchema,
  productGalleryResponseSchema,
  type GalleryImage,
  type ProductGalleryResponse,
} from "@ih/contracts";
import { managementRequest, validate } from "../lib/management";
import { moved, rejectionMessage, uploadForm, uploadRequestFor } from "../lib/media";
import { galleryUpdateRequestSchema } from "@ih/contracts";
import { ResourceNotice, useManagementResource } from "./management-resource";

/**
 * Product images (steps 48–50). Files go straight to private quarantine storage with a
 * short-lived policy; the worker validates and re-encodes them; only processed images can join
 * the gallery. Previews are short-lived signed links to sanitized derivatives.
 */
export function ProductImages({ productId, canWrite }: { productId: string; canWrite: boolean }) {
  const path = `/products/${productId}/images`;
  const gallery = useManagementResource(path, productGalleryResponseSchema);
  const data = gallery.data;
  const [note, setNote] = useState("");
  // Only uploads the worker is handling drive polling; a pending grant just waits for its file.
  const processing = data?.uploads.some((u) => u.state === "uploaded" || u.state === "processing");
  const { busy, setData } = gallery;

  // Poll quietly with its own request: never reload the resource (that would unmount the card)
  // and never while another action runs (that would abort it).
  useEffect(() => {
    if (!processing || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      managementRequest(path, productGalleryResponseSchema, "GET", undefined, controller.signal)
        .then((snapshot) => setData(snapshot))
        .catch(() => undefined);
    }, 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [processing, busy, path, setData, data]);

  /** Every gallery mutation answers with the full snapshot; use it directly. */
  const save = async (work: (signal: AbortSignal) => Promise<ProductGalleryResponse>) => {
    setNote("");
    const outcome = await gallery.run(work);
    if (outcome.ok) setData(outcome.value);
  };

  async function upload(file: File) {
    await save(async (signal) => {
      const grant = await managementRequest(
        `/products/${productId}/media/uploads`,
        mediaUploadResponseSchema,
        "POST",
        uploadRequestFor(file),
        signal,
      );
      // After authorization, a failed transfer is reported but never blocks the card: the
      // snapshot below shows the upload's real state so the user can simply try again.
      try {
        // Straight to private storage; no cookies or credentials are sent there.
        const sent = await fetch(grant.upload.url, {
          method: "POST",
          body: uploadForm(grant.upload.fields, file),
          credentials: "omit",
          signal,
        });
        if (!sent.ok) throw new Error("storage");
        await managementRequest(
          `/media/${grant.asset.id}/complete`,
          mediaAssetSchema,
          "POST",
          {},
          signal,
        );
      } catch {
        if (signal.aborted) throw new Error("aborted");
        setNote("The upload did not complete. Choose the file again.");
      }
      return managementRequest(path, productGalleryResponseSchema, "GET", undefined, signal);
    });
  }

  const images = data?.images ?? [];
  const order = images.map((image) => image.id);
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Images</h2>
        <span className="badge">{images.length}/8</span>
      </header>
      <p className="muted">
        PNG, JPG or WebP, 200–8000 px on each side, up to 8 MB each (square images of at least 1000
        px look best). Images are checked and cleaned before use. The first image is the primary
        image on product cards.
      </p>
      <ResourceNotice resource={gallery} />
      {note && (
        <p role="status" className="muted">
          {note}
        </p>
      )}
      {data && (
        <fieldset disabled={gallery.disabled || !canWrite}>
          {canWrite && (
            <label>
              <span>Add images</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
            </label>
          )}
          {data.uploads.length > 0 && (
            <ul className="record-list">
              {data.uploads.map((item) => (
                <li key={item.id}>
                  {item.state === "uploaded" || item.state === "processing"
                    ? "Checking and processing the image…"
                    : item.state === "pending"
                      ? "Waiting for the file to arrive…"
                      : item.state === "ready"
                        ? "Processed and ready to add."
                        : item.state === "expired"
                          ? "The upload took too long. Choose the file again."
                          : `Not added: ${rejectionMessage(item.error)} Choose the file again.`}{" "}
                  {item.state === "ready" && canWrite && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        void save((signal) =>
                          managementRequest(
                            `/products/${productId}/images`,
                            productGalleryResponseSchema,
                            "POST",
                            { mediaAssetId: item.id },
                            signal,
                          ),
                        )
                      }
                    >
                      Add to gallery
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {images.length === 0 && <p className="muted">No images yet.</p>}
          <div className="record-list">
            {images.map((image) => (
              <ImageCard
                key={`${image.id}-${image.version}`}
                image={image}
                canWrite={canWrite}
                first={order[0] === image.id}
                last={order.at(-1) === image.id}
                onSave={(alt, isPrimary) =>
                  save((signal) =>
                    managementRequest(
                      `/products/${productId}/images/${image.id}`,
                      productGalleryResponseSchema,
                      "PATCH",
                      validate(galleryUpdateRequestSchema, {
                        version: image.version,
                        alt,
                        isPrimary,
                      }),
                      signal,
                    ),
                  )
                }
                onMove={(offset) =>
                  save((signal) =>
                    managementRequest(
                      `/products/${productId}/images/order`,
                      productGalleryResponseSchema,
                      "PUT",
                      { imageIds: moved(order, image.id, offset) },
                      signal,
                    ),
                  )
                }
                onRemove={async () => {
                  if (
                    !(await confirmDialog({
                      title: "Remove this image?",
                      body: "It is taken off the product. To use it again, upload the file again.",
                      ok: "Remove image",
                      danger: true,
                    }))
                  )
                    return;
                  void save((signal) =>
                    managementRequest(
                      `/products/${productId}/images/${image.id}/remove`,
                      productGalleryResponseSchema,
                      "POST",
                      { version: image.version },
                      signal,
                    ),
                  );
                }}
              />
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}

function ImageCard({
  image,
  canWrite,
  first,
  last,
  onSave,
  onMove,
  onRemove,
}: {
  image: GalleryImage;
  canWrite: boolean;
  first: boolean;
  last: boolean;
  onSave: (alt: string, isPrimary: boolean) => Promise<void>;
  onMove: (offset: -1 | 1) => Promise<void>;
  onRemove: () => void;
}) {
  return (
    <form
      data-unsaved="this image's alt text"
      className="record-card"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(String(new FormData(e.currentTarget).get("alt") ?? "").trim(), image.isPrimary);
      }}
    >
      <header className="card-heading">
        {/* Signed preview of the sanitized thumbnail; expires after a few minutes. next/image would
            fetch the private link server-side through its optimizer, which must not happen. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.urls.thumb}
          alt={image.alt || "Product image"}
          width={96}
          height={96}
          style={{ objectFit: "contain" }}
        />
        <span className="badge">
          {image.isPrimary ? "Primary · " : ""}
          {image.width}×{image.height}
        </span>
      </header>
      <label>
        <span>Alt text (describes the image for screen readers)</span>
        <input name="alt" maxLength={500} defaultValue={image.alt} />
      </label>
      {canWrite && (
        <div className="form-actions">
          <button type="submit" className="secondary-button">
            Save alt text
          </button>
          {!image.isPrimary && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void onSave(image.alt, true)}
            >
              Make primary
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={first}
            onClick={() => void onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={last}
            onClick={() => void onMove(1)}
          >
            Move down
          </button>
          <button type="button" className="danger-button" onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </form>
  );
}
