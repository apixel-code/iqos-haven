import type { ReactNode } from "react";
import { whatsappHref } from "@/lib/whatsapp";

/**
 * A link that opens WhatsApp with a prepared, editable message. Renders nothing when the Owner
 * has not configured a number. `noreferrer` so the page address is not passed along.
 */
export function WhatsAppLink({
  number,
  message,
  className,
  children,
}: {
  number: string | null;
  message: string;
  className?: string;
  children: ReactNode;
}) {
  const href = whatsappHref(number, message);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        className ??
        "inline-flex h-10 w-fit items-center gap-2 rounded-pill bg-wa px-4 text-sm font-medium text-white hover:bg-wa-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      }
    >
      {children}
    </a>
  );
}
