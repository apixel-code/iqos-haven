import type { Metadata } from "next";
import { ReviewView } from "@/components/review-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Review your order · ${SITE.name}`,
  // The link's token is in the fragment, which never travels; nothing else may either.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Review page (roadmap step 94, ADR 0062). The server renders only the frame: the products to
 * review are read in the browser with the link's token, posted in the request body. Behind the
 * routing gate like every shop page; the age question keeps the link's fragment.
 */
export default function ReviewPage() {
  return <ReviewView />;
}
