"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A count over an icon (prototype `.count`). When the number changes it bumps once (prototype
 * `bump`, parity G-S10); the count read from storage on load does not, and reduced motion turns it off.
 */
export function CountBadge({ value, data }: { value: number; data?: boolean }) {
  const previous = useRef(value);
  // The count read from device storage right after hydration is not a change the shopper made.
  const ready = useRef(false);
  const [bumps, setBumps] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => (ready.current = true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (ready.current) setBumps((count) => count + 1);
  }, [value]);
  if (value <= 0) return null;
  // A new key restarts the animation on every change.
  return (
    <span key={bumps} className={bumps ? "count bump" : "count"} data-cc={data || undefined}>
      {value}
    </span>
  );
}
