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
import { Icon, type IconName } from "./icons";

/**
 * Brand logo or category image (parity G-A7, ADR 0091): upload, wait for processing, preview,
 * remove. The chosen image travels in the form as `imageAssetId` (empty = none) and is saved with
 * the brand or category; a replaced image is released by the server.
 */
export function ParentImage({
  initial,
  label,
  hint = "Optional",
}: {
  initial: string | null;
  label: string;
  hint?: string;
}) {
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
  const picker = (text: string, drop: boolean) => (
    <label className={drop ? "drop drop-sm" : "btn btn-s btn-sm"}>
      <Icon name="upload" size={drop ? undefined : "sm"} />
      <span className={drop ? "small" : undefined}>{busy ? "Uploading…" : text}</span>
      <input
        type="file"
        accept={IMAGE_TYPES.join(",")}
        className="sr"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </label>
  );
  return (
    <div className="field parent-image">
      <span className="label">
        <span>
          {label} <span className="opt">{hint}</span>
        </span>
      </span>
      {/* Empty clears it on save; the server only accepts a processed catalogue image. */}
      <input type="hidden" name="imageAssetId" value={rejected ? "" : (assetId ?? "")} />
      {assetId ? (
        <div className="row parent-image-row">
          {current?.url ? (
            // A short-lived signed link to the processed preview.
            // eslint-disable-next-line @next/next/no-img-element
            <img className="parent-image-preview" src={current.url} alt="" />
          ) : (
            <span className="parent-image-wait" aria-hidden="true" />
          )}
          <div className="row">
            {picker("Replace image", false)}
            <button
              type="button"
              className="btn btn-s btn-sm"
              disabled={busy}
              onClick={() => {
                setAssetId(null);
                setStatus(null);
              }}
            >
              Remove image
            </button>
          </div>
        </div>
      ) : (
        picker("Upload image", true)
      )}
      {assetId && current && current.state !== "ready" && (
        <p className="help" role="status">
          {rejected
            ? rejectionMessage(current.error)
            : "Processing the image… it can be saved once it is ready."}
        </p>
      )}
      {note && (
        <p className="errm" role="alert">
          <Icon name="alert" />
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * A brand logo or category image in a list (V-A6): the signed preview of its processed image,
 * or the prototype's plain tile with an icon.
 */
export function ParentThumb({
  assetId,
  icon,
  className,
}: {
  assetId: string | null;
  icon: IconName;
  className: string;
}) {
  const [shown, setShown] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let stop = false;
    managementRequest(`/catalogue-images/${assetId}`, catalogueImageResponseSchema)
      .then((value) => !stop && setShown({ id: assetId, url: value.url ?? null }))
      .catch(() => !stop && setShown({ id: assetId, url: null }));
    return () => {
      stop = true;
    };
  }, [assetId]);
  const url = assetId && shown?.id === assetId ? shown.url : null;
  return (
    <span className={className} aria-hidden="true">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : (
        <Icon name={icon} />
      )}
    </span>
  );
}
