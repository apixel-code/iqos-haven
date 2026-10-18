"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { StoreImage } from "@ih/contracts";
import { Icon } from "@/components/icons";

/**
 * Product images (prototype `gal`, parity G-S12): a scroll-snap track that swipes on phones,
 * dots under it on phones and thumbnails from 720px. "Zoom" opens the large image in a modal
 * dialog; there a click (or Enter) toggles 2× magnification at the pointer and the arrow keys
 * step through the images. The prototype's "Demo render" pill is not carried over.
 */
export function Gallery({ images, name }: { images: readonly StoreImage[]; name: string }) {
  const [index, setIndex] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  if (images.length === 0)
    return (
      <div className="gal" aria-label="Product images">
        <div className="gal-track">
          <div aria-hidden="true" className="gal-slide gal-none">
            No image yet
          </div>
        </div>
      </div>
    );

  /** The slide in view follows the scroll position (swipe, thumbnails, keyboard). */
  const onScroll = () => {
    const element = track.current;
    if (!element || element.clientWidth === 0) return;
    const shown = Math.round(element.scrollLeft / element.clientWidth);
    setIndex(Math.min(images.length - 1, Math.max(0, shown)));
  };
  const show = (position: number, smooth = true) => {
    const element = track.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      left: position * element.clientWidth,
      behavior: smooth && !reduced ? "smooth" : "instant",
    });
    setIndex(position);
  };

  return (
    <div className="gal" aria-label="Product images" role="group">
      <div
        ref={track}
        className="gal-track"
        tabIndex={images.length > 1 ? 0 : undefined}
        aria-label={images.length > 1 ? "Image gallery, swipe for more" : undefined}
        onScroll={onScroll}
      >
        {images.map((image, position) => (
          <div key={image.urls.large} className="gal-slide" aria-hidden={position !== index}>
            {/* Signed link to a sanitized derivative; the Next image optimizer is not used. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.urls.large}
              alt={image.alt || (images.length > 1 ? `${name}, image ${position + 1}` : name)}
              width={image.width}
              height={image.height}
              loading={position === 0 ? "eager" : "lazy"}
              draggable={false}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="gal-zoom"
        aria-haspopup="dialog"
        onClick={() => setZoomOpen(true)}
      >
        <Icon name="search" size="sm" />
        Zoom<span className="sr"> image {index + 1}</span>
      </button>
      {images.length > 1 && (
        <>
          <div className="gal-dots" aria-hidden="true">
            {images.map((image, position) => (
              <i key={image.urls.large} className={position === index ? "on" : undefined} />
            ))}
          </div>
          <div className="gal-thumbs">
            {images.map((image, position) => (
              <button
                key={image.urls.thumb}
                type="button"
                aria-label={`Show image ${position + 1}`}
                aria-current={position === index}
                onClick={() => show(position)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.urls.thumb} alt="" width={76} height={76} loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}
      {zoomOpen && (
        <ZoomDialog
          images={images}
          name={name}
          start={index}
          onClose={(last) => {
            setZoomOpen(false);
            // The gallery shows the image the shopper ended on.
            if (last !== index) show(last, false);
          }}
        />
      )}
    </div>
  );
}

/** The large image in a modal dialog, with 2× magnification at the pointer. */
function ZoomDialog({
  images,
  name,
  start,
  onClose,
}: {
  images: readonly StoreImage[];
  name: string;
  start: number;
  onClose: (last: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState("50% 50%");
  const image = images[position]!;
  const many = images.length > 1;
  const last = useRef(start);
  useEffect(() => {
    last.current = position;
  }, [position]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    const closed = () => onClose(last.current);
    element.addEventListener("close", closed);
    return () => element.removeEventListener("close", closed);
    // Opened once per mount; onClose reads the latest position through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (by: number) => {
    setZoomed(false);
    setPosition((current) => (current + by + images.length) % images.length);
  };
  const toggleAt = (event: MouseEvent<HTMLButtonElement>) => {
    if (!zoomed && event.detail > 0) {
      // A pointer click magnifies around the point clicked; the keyboard zooms the centre.
      const box = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * 100;
      const y = ((event.clientY - box.top) / box.height) * 100;
      setOrigin(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
    } else if (!zoomed) setOrigin("50% 50%");
    setZoomed(!zoomed);
  };

  return (
    <dialog
      ref={dialog}
      className="gal-lightbox"
      aria-label={`${name}: image ${position + 1} of ${images.length}`}
      onKeyDown={(event) => {
        if (!many) return;
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog itself, outside the frame) closes it.
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="gal-lb-frame">
        <button
          type="button"
          className="gal-lb-img"
          aria-label={zoomed ? "Zoom out" : "Zoom in"}
          aria-pressed={zoomed}
          onClick={toggleAt}
          onMouseMove={(event) => {
            if (!zoomed) return;
            const box = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * 100;
            const y = ((event.clientY - box.top) / box.height) * 100;
            setOrigin(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.urls.large}
            alt={image.alt || name}
            width={image.width}
            height={image.height}
            draggable={false}
            style={{ transformOrigin: origin }}
            className={zoomed ? "on" : undefined}
          />
        </button>
        <button
          type="button"
          className="ibtn gal-lb-close"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="x" />
        </button>
        {many && (
          <>
            <button
              type="button"
              className="ibtn gal-lb-prev"
              aria-label="Previous image"
              onClick={() => step(-1)}
            >
              <Icon name="chev-l" />
            </button>
            <button
              type="button"
              className="ibtn gal-lb-next"
              aria-label="Next image"
              onClick={() => step(1)}
            >
              <Icon name="chev-r" />
            </button>
            <p className="gal-lb-count" aria-live="polite">
              {position + 1} / {images.length}
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}
