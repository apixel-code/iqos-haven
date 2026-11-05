import { publicBusinessSchema, type PublicBusiness } from "@ih/contracts";
import { storefrontEnv } from "./env";

/**
 * The Owner's public business details (ADR 0106): legal name and trade licence number, read from
 * the API's public answer for the shop footer and the terms. Optional: a slow, failed or
 * unexpected answer shows none rather than taking a page down. Held per server process for a
 * minute. Server code only.
 */
const NONE: PublicBusiness = { legalName: null, tradeLicence: null };
const HOLD_MS = 60_000;
let held: { business: PublicBusiness; until: number } | undefined;

export async function readBusiness(now = Date.now()): Promise<PublicBusiness> {
  if (held && held.until > now) return held.business;
  let business = NONE;
  try {
    const response = await fetch(new URL("/v1/public/business", storefrontEnv().API_INTERNAL_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const parsed = publicBusinessSchema.safeParse(await response.json());
      if (parsed.success) business = parsed.data;
    }
  } catch {
    business = NONE;
  }
  held = { business, until: now + HOLD_MS };
  return business;
}

/** Tests only. */
export function forgetBusiness(): void {
  held = undefined;
}

/** "Legal name · Trade licence no. X", with whichever parts are set; null when neither is. */
export function businessLine({ legalName, tradeLicence }: PublicBusiness): string | null {
  const parts = [legalName, tradeLicence && `Trade licence no. ${tradeLicence}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
