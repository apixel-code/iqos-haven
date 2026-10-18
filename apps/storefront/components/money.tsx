import { displayAmount } from "@/lib/store/listing";

/**
 * The UAE dirham sign as the prototype draws it (`DH`, ADR 0097): a small inline SVG, with
 * "AED" for screen readers and copy-paste. Emails, CSV files and other plain text keep "AED".
 */
export function Dirham() {
  return (
    <span className="dh">
      <svg viewBox="0 0 24 20" aria-hidden="true">
        <path d="M7 2.5v15M7 2.5h3.6c5.4 0 9 3.3 9 7.5s-3.6 7.5-9 7.5H7M2.5 8.4h19M2.5 11.6h19" />
      </svg>
      <span className="sr">AED </span>
    </span>
  );
}

/** A price from integer fils, with the dirham sign. */
export function Money({ fils, className }: { fils: number; className?: string }) {
  return (
    <span className={className}>
      <Dirham />
      {displayAmount(fils)}
    </span>
  );
}
