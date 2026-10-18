"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";

/**
 * Promotional bar (roadmap step 99; prototype `promoBar`). Plain-text messages from published
 * content scroll right to left. It pauses on hover and focus, and with the button (WCAG 2.2.2);
 * with reduced motion it does not move at all and the messages simply wrap.
 */
export function PromoTicker({ messages }: { messages: readonly string[] }) {
  const [paused, setPaused] = useState(false);
  const list = (hidden: boolean) => (
    <ul className="promo-list" aria-hidden={hidden || undefined}>
      {messages.map((message, index) => (
        <li key={index}>{message}</li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Current offers" className={paused ? "promo paused" : "promo"}>
      <div className="promo-viewport">
        <div className="promo-track">
          {list(false)}
          {list(true)}
        </div>
      </div>
      <button
        type="button"
        className="promo-btn"
        aria-pressed={paused}
        aria-label={paused ? "Play offers ticker" : "Pause offers ticker"}
        onClick={() => setPaused((value) => !value)}
      >
        <Icon name={paused ? "play" : "pause"} />
      </button>
    </section>
  );
}
