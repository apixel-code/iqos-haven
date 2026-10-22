"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useEffect, useId, useState } from "react";
import {
  mediaAssetSchema,
  mediaUploadResponseSchema,
  productGalleryResponseSchema,
  type GalleryImage,
  type ProductGalleryResponse,
} from "@ih/contracts";
import { managementRequest, validate } from "../lib/management";
import { moved, movedTo, rejectionMessage, uploadForm, uploadRequestFor } from "../lib/media";
import { galleryUpdateRequestSchema } from "@ih/contracts";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { Modal } from "./overlays";

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
  const [editing, setEditing] = useState<GalleryImage | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  const altForm = useId();

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
  const reorder = (imageIds: string[]) =>
    save((signal) =>
      managementRequest(
        `/products/${productId}/images/order`,
        productGalleryResponseSchema,
        "PUT",
        { imageIds },
        signal,
      ),
    );
  const update = (image: GalleryImage, alt: string, isPrimary: boolean) =>
    save((signal) =>
      managementRequest(
        `/products/${productId}/images/${image.id}`,
        productGalleryResponseSchema,
        "PATCH",
        validate(galleryUpdateRequestSchema, { version: image.version, alt, isPrimary }),
        signal,
      ),
    );
  const remove = async (image: GalleryImage) => {
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
  };
  const uploadAll = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) await upload(file);
  };
  const locked = gallery.disabled || !canWrite;
  return (
    <>
      <div className="card-h">
        <h2>
          Images <span className="sub">· {images.length}/8</span>
        </h2>
      </div>
      <div className="card-b form">
        <ResourceNotice resource={gallery} compact />
        {note && (
          <p role="status" className="note warn">
            <Icon name="alert" />
            {note}
          </p>
        )}
        {images.length > 0 && (
          <div className="media">
            {images.map((image, index) => (
              <div
                key={`${image.id}-${image.version}`}
                className={`mtile${dragging === image.id ? " dragging" : ""}${over === index && dragging !== image.id ? " over" : ""}`}
                draggable={!locked}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(image.id);
                }}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  setOver(index);
                }}
                onDragLeave={() => setOver((value) => (value === index ? null : value))}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = dragging;
                  setDragging(null);
                  setOver(null);
                  if (id && id !== image.id) void reorder(movedTo(order, id, index));
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
              >
                {/* Signed preview of the sanitized thumbnail; expires after a few minutes.
                    next/image would fetch the private link server-side, which must not happen. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.urls.thumb}
                  alt={image.alt || `Product image ${index + 1}`}
                  width={image.width}
                  height={image.height}
                />
                {image.isPrimary && <span className="prim">Primary</span>}
                {!image.alt && <span className="noalt">No alt text</span>}
                {canWrite && (
                  <>
                    <span className="grip" aria-hidden="true">
                      <Icon name="grip" />
                    </span>
                    <div className="ctl">
                      <button
                        type="button"
                        aria-label={`Move image ${index + 1} left`}
                        disabled={locked || index === 0}
                        onClick={() => void reorder(moved(order, image.id, -1))}
                      >
                        <Icon name="cl" />
                      </button>
                      {!image.isPrimary && (
                        <button
                          type="button"
                          aria-label={`Make image ${index + 1} the primary image`}
                          disabled={locked}
                          onClick={() => void update(image, image.alt, true)}
                        >
                          <Icon name="star" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Alt text of image ${index + 1}`}
                        disabled={locked}
                        onClick={() => setEditing(image)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move image ${index + 1} right`}
                        disabled={locked || index === images.length - 1}
                        onClick={() => void reorder(moved(order, image.id, 1))}
                      >
                        <Icon name="cr" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove image ${index + 1}`}
                        disabled={locked}
                        onClick={() => void remove(image)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {data && data.uploads.length > 0 && (
          <ul className="upload-list">
            {data.uploads.map((item) => (
              <li
                key={item.id}
                className={
                  item.state === "rejected" || item.state === "expired" ? "note err" : "note"
                }
              >
                <Icon
                  name={
                    item.state === "ready"
                      ? "check-c"
                      : item.state === "rejected" || item.state === "expired"
                        ? "alert"
                        : "clock"
                  }
                />
                <p>
                  {item.state === "uploaded" || item.state === "processing"
                    ? "Checking and processing the image…"
                    : item.state === "pending"
                      ? "Waiting for the file to arrive…"
                      : item.state === "ready"
                        ? "Processed and ready to add."
                        : item.state === "expired"
                          ? "The upload took too long. Choose the file again."
                          : `Not added: ${rejectionMessage(item.error)} Choose the file again.`}
                </p>
                {item.state === "ready" && canWrite && (
                  <button
                    type="button"
                    className="btn btn-s btn-sm"
                    disabled={locked}
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
                    <Icon name="plus" size="sm" />
                    Add to gallery
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && data && (
          <label
            className={dropping ? "drop over" : "drop"}
            onDragOver={(event) => {
              if (dragging || locked) return;
              event.preventDefault();
              setDropping(true);
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(event) => {
              if (dragging || locked) return;
              event.preventDefault();
              setDropping(false);
              void uploadAll(event.dataTransfer.files);
            }}
          >
            <span className="ic">
              <Icon name="upload" size="lg" />
            </span>
            <b>Drag images here or browse</b>
            <span className="small muted">
              PNG, JPG or WebP · 200–8000 px a side, square from 1000 px looks best · up to 8 MB
              each · up to 8 images
            </span>
            <input
              type="file"
              className="sr"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={locked}
              onChange={(e) => {
                const files = e.target.files;
                void uploadAll(files).finally(() => {
                  e.target.value = "";
                });
              }}
            />
          </label>
        )}
        {data && (
          <p className="help">
            {images.length === 0 ? "No images yet. " : ""}
            Images are checked and cleaned before use. The primary image shows on product cards;
            drag the tiles or use the arrows to reorder.
          </p>
        )}
      </div>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Alt text"
        sub="Describes the image for people using screen readers."
        foot={
          <>
            <button type="button" className="btn btn-s" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" form={altForm} className="btn btn-p" disabled={locked}>
              Save alt text
            </button>
          </>
        }
      >
        {editing && (
          <form
            id={altForm}
            data-unsaved="this image's alt text"
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const image = editing;
              const alt = String(new FormData(e.currentTarget).get("alt") ?? "").trim();
              setEditing(null);
              void update(image, alt, image.isPrimary);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="alt-preview" src={editing.urls.medium} alt="" />
            <div className="field">
              <label className="label" htmlFor="alt-text">
                Alt text
              </label>
              <input
                id="alt-text"
                className="input"
                name="alt"
                maxLength={500}
                defaultValue={editing.alt}
                data-autofocus=""
                placeholder="e.g. Orbe Halo 7K in Grape Ice, front view"
              />
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
