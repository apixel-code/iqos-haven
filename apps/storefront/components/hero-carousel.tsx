"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreHomeResponse } from "@ih/contracts";
import { Icon } from "@/components/icons";
import { openSearchSheet } from "@/components/search-sheet";

type Slide = StoreHomeResponse["heroSlides"][number];

/** The prototype's three slide looks (`s1`…`s3`): colours, shapes and text colour. */
const LOOK = {
  navy: { className: "s1", theme: "dark" },
  lilac: { className: "s2", theme: "light" },
  coral: { className: "s3", theme: "dark" },
} as const;
const AUTO_MS = 5000;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Home hero (prototype `heroBanner`, ADR 0097): one to three slides from published content.
 * Swipe, dots and arrows move between slides; it advances every five seconds, pausing on hover
 * and focus, with its pause button, and not at all with reduced motion (WCAG 2.2.2). One slide
 * shows no controls. Below it, the phone search button and the trust line.
 */
export function HeroCarousel({ slides }: { slides: readonly Slide[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const count = slides.length;
  const go = useCallback(
    (next: number) => {
      const element = track.current;
      if (!element || count < 2) return;
      const target = ((next % count) + count) % count;
      element.scrollTo({
        left: target * element.clientWidth,
        behavior: reducedMotion() ? "instant" : "smooth",
      });
    },
    [count],
  );
  useEffect(() => {
    if (count < 2 || held || stopped || reducedMotion()) return;
    const timer = window.setTimeout(() => go(index + 1), AUTO_MS);
    return () => window.clearTimeout(timer);
  }, [count, held, stopped, index, go]);
  const settle = useRef<number | undefined>(undefined);
  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const element = track.current;
      if (element) setIndex(Math.round(element.scrollLeft / element.clientWidth));
    }, 60);
  };
  const current = slides[Math.min(index, count - 1)];
  const paused = held || stopped;
  return (
    <section className="hero2" aria-label="Featured offers">
      <div className="hb-search">
        <button type="button" className="m-search" onClick={openSearchSheet}>
          <Icon name="search" /> Search vapes, brands, flavours
        </button>
      </div>
      {current && (
        <div className="hb-grid">
          <div
            className={paused ? "hb-main paused" : "hb-main"}
            data-theme={LOOK[current.style].theme}
            role="region"
            aria-roledescription="carousel"
            aria-label="Featured offers"
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
            }}
          >
            <div className="hb-track" ref={track} onScroll={onScroll}>
              {slides.map((slide, at) => {
                const look = LOOK[slide.style];
                const away = at !== index ? -1 : undefined;
                const Title = at === 0 ? "h1" : "h2";
                return (
                  <article
                    key={at}
                    className={`hb-slide ${look.className}`}
                    data-theme={look.theme}
                    aria-roledescription="slide"
                    aria-label={`${at + 1} of ${count}`}
                    aria-hidden={at !== index || undefined}
                  >
                    <i className="hb-shape a" aria-hidden="true" />
                    <i className="hb-shape b" aria-hidden="true" />
                    <div className="hb-copy">
                      {slide.eyebrow && <span className="hb-eyebrow">{slide.eyebrow}</span>}
                      <Title className="hb-title">{slide.title}</Title>
                      {slide.subtitle && <p className="hb-sub">{slide.subtitle}</p>}
                      {(slide.cta || slide.secondaryCta) && (
                        <div className="hb-ctas">
                          {slide.cta && (
                            <Link
                              href={slide.cta.href}
                              prefetch={false}
                              tabIndex={away}
                              className={
                                look.theme === "dark" ? "btn btn-light" : "btn btn-primary"
                              }
                            >
                              {slide.cta.label} <Icon name="arrow-r" />
                            </Link>
                          )}
                          {slide.secondaryCta && (
                            <Link
                              href={slide.secondaryCta.href}
                              prefetch={false}
                              tabIndex={away}
                              className="btn hb-ghost"
                            >
                              {slide.secondaryCta.label}
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                    {slide.image && (
                      <div className="hb-art n1">
                        {/* Signed link to a sanitized content image; the optimizer is not used. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={slide.image.urls.large}
                          alt={slide.image.alt}
                          width={slide.image.width}
                          height={slide.image.height}
                          decoding="async"
                          fetchPriority={at === 0 ? "high" : "auto"}
                        />
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {count > 1 && (
              <div className="hb-ui">
                <div className="hb-dots" role="group" aria-label="Choose slide">
                  {slides.map((_slide, at) => (
                    <button
                      key={at}
                      type="button"
                      className={at === index ? "hb-dot on" : "hb-dot"}
                      aria-label={`Slide ${at + 1}`}
                      aria-current={at === index}
                      onClick={() => go(at)}
                    >
                      <i />
                    </button>
                  ))}
                </div>
                <div className="hb-actions">
                  <button
                    type="button"
                    className="hb-arrow"
                    aria-pressed={stopped}
                    aria-label={stopped ? "Play slides" : "Pause slides"}
                    onClick={() => setStopped((value) => !value)}
                  >
                    <Icon name={stopped ? "play" : "pause"} size="sm" />
                  </button>
                  <div className="hb-arrows">
                    <button
                      type="button"
                      className="hb-arrow"
                      aria-label="Previous slide"
                      onClick={() => go(index - 1)}
                    >
                      <Icon name="chev-l" />
                    </button>
                    <button
                      type="button"
                      className="hb-arrow"
                      aria-label="Next slide"
                      onClick={() => go(index + 1)}
                    >
                      <Icon name="chev-r" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Scrolls sideways on phones, so it takes keyboard focus (WCAG 2.1.1, axe). */}
      <div className="hb-trust" role="region" aria-label="Why shop with us" tabIndex={0}>
        <span>
          <Icon name="truck" />
          Delivery across the UAE
        </span>
        <span>
          <Icon name="cash" />
          Cash on delivery
        </span>
        <span>
          <Icon name="wa" />
          WhatsApp support
        </span>
        <span>
          <Icon name="shield" />
          Genuine brand stock
        </span>
      </div>
    </section>
  );
}
