"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/icons";
import { toast } from "@/lib/ui/toast";

/** The prototype's "Copy" button (`copyText`): copies the text and confirms with a toast. */
export function CopyButton({
  text,
  className = "btn btn-outline",
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const copied = () => toast({ title: "Copied", sub: text });
        const failed = () => toast({ title: "Select and copy", sub: text });
        try {
          navigator.clipboard.writeText(text).then(copied, failed);
        } catch {
          failed();
        }
      }}
    >
      <Icon name="copy" size="sm" />
      {children}
    </button>
  );
}
