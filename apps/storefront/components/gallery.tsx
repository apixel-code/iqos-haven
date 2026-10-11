"use client";

import { useState } from "react";
import type { StoreImage } from "@ih/contracts";

/** Product images: one large image and a thumbnail per image (prototype gallery, no zoom). */
export function Gallery({ images, name }: { images: readonly StoreImage[]; name: string }) {
  const [index, setIndex] = useState(0);
  const current = images[index] ?? images[0];
  if (!current)
    return (
      <div
        aria-hidden="true"
        className="flex aspect-square items-center justify-center rounded-lg bg-surface-2 text-sm text-ink-3"
      >
        No image yet
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-lg bg-surface-2">
        {/* Signed link to a sanitized derivative; the Next image optimizer is not used. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.urls.large}
          alt={current.alt || name}
          width={current.width}
          height={current.height}
          className="size-full object-contain"
        />
      </div>
      {images.length > 1 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((image, position) => (
            <li key={image.urls.thumb}>
              <button
                type="button"
                aria-label={`Show image ${position + 1}`}
                aria-current={position === index ? "true" : undefined}
                onClick={() => setIndex(position)}
                className={`size-[76px] overflow-hidden rounded-sm border-2 bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  position === index ? "border-ink" : "border-transparent"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.urls.thumb}
                  alt=""
                  width={76}
                  height={76}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
