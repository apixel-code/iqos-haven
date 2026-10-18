"use client";
import { useEffect, useState } from "react";
import {
  catalogueImageResponseSchema,
  IMAGE_TYPES,
  mediaAssetSchema,
  mediaUploadResponseSchema,
  type CatalogueImageResponse,
} from "@ih/contracts";
import { ApiError } from "../lib/auth";
import { managementError, managementRequest } from "../lib/management";
import { rejectionMessage, uploadForm, uploadRequestFor } from "../lib/media";

/**
 * Brand logo or category image (parity G-A7, ADR 0091): upload, wait for processing, preview,
 * remove. The chosen image travels in the form as `imageAssetId` (empty = none) and is saved with
 * the brand or category; a replaced image is released by the server.
 */
export function ParentImage({ initial, label }: { initial: string | null; label: string }) {
  const [assetId, setAssetId] = useState<string | null>(initial);
  const [status, setStatus] = useState<CatalogueImageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Read the chosen image's state; while it processes, ask again shortly.
  useEffect(() => {
    if (!assetId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      managementRequest(`/catalogue-images/${assetId}`, catalogueImageResponseSchema)
        .then((value) => {
          if (stop) return;
          setStatus(value);
          if (
            value.state === "uploaded" ||
            value.state === "processing" ||
            value.state === "pending"
          )
            timer = setTimeout(read, 2000);
        })
        .catch((error) => !stop && setNote(managementError(error)));
    void read();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [assetId]);

  async function upload(file: File) {
    setNote("");
    setBusy(true);
    try {
      const grant = await managementRequest(
        "/catalogue-images/uploads",
        mediaUploadResponseSchema,
        "POST",
        uploadRequestFor(file),
      );
      const sent = await fetch(grant.upload.url, {
        method: "POST",
        body: uploadForm(grant.upload.fields, file),
        credentials: "omit",
      });
      if (!sent.ok) throw new Error("storage");
      await managementRequest(
        `/catalogue-images/${grant.asset.id}/complete`,
        mediaAssetSchema,
        "POST",
        {},
      );
      setStatus(null);
      setAssetId(grant.asset.id);
    } catch (error) {
      setNote(
        error instanceof Error && error.message !== "storage" && !(error instanceof ApiError)
          ? error.message
          : "The upload did not complete. Choose the file again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const current = status?.id === assetId ? status : null;
  const rejected = current?.state === "rejected" || current?.state === "expired";
  return (
    <fieldset className="wide-field parent-image">
      <legend>{label} (optional)</legend>
      {/* Empty clears it on save; the server only accepts a processed catalogue image. */}
      <input type="hidden" name="imageAssetId" value={rejected ? "" : (assetId ?? "")} />
      {assetId && current?.url && (
        // A short-lived signed link to the processed preview.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="parent-image-preview" src={current.url} alt="" />
      )}
      {assetId && current && current.state !== "ready" && (
        <p className="muted small" role="status">
          {rejected
            ? rejectionMessage(current.error)
            : "Processing the image… it can be saved once it is ready."}
        </p>
      )}
      <div className="form-actions">
        <label className="secondary-button">
          {busy ? "Uploading…" : assetId ? "Replace image" : "Upload image"}
          <input
            type="file"
            accept={IMAGE_TYPES.join(",")}
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {assetId && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setAssetId(null);
              setStatus(null);
            }}
          >
            Remove image
          </button>
        )}
      </div>
      {note && <p role="alert">{note}</p>}
    </fieldset>
  );
}
