import type { StoreHomeResponse, StoreInfoResponse } from "@ih/contracts";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isIP } from "node:net";
import { cache } from "react";
import { AGE_RECHECK_PATH } from "../age/policy";
import { storefrontEnv } from "../env";
import {
  AgeRequiredError,
  createStoreApi,
  StoreApiError,
  type ShopperContext,
  type StoreApi,
} from "./api";

let api: StoreApi | undefined;

/** The current request's age ticket and client address, for a catalogue read. */
async function shopper(): Promise<ShopperContext> {
  const incoming = await headers();
  const ip = incoming.get("x-ih-client-ip");
  return { cookieHeader: incoming.get("cookie"), clientIp: ip && isIP(ip) ? ip : null };
}

/**
 * Runs a catalogue read for the current request. If the API no longer accepts the ticket the
 * shopper goes back to the age check; other failures reach the route's error boundary.
 */
export async function storeRead<T>(read: (api: StoreApi, shopper: ShopperContext) => Promise<T>) {
  api ??= createStoreApi({ baseUrl: storefrontEnv().API_INTERNAL_URL });
  try {
    return await read(api, await shopper());
  } catch (error) {
    if (error instanceof AgeRequiredError) redirect(AGE_RECHECK_PATH);
    throw error;
  }
}

/**
 * A cursor the API refuses (an old bookmark, or one made for another sort) restarts the list at
 * its first page instead of showing an error.
 */
export async function restartOnStaleCursor<T>(
  read: () => Promise<T>,
  hasCursor: boolean,
  firstPage: string,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (hasCursor && error instanceof StoreApiError && error.status === 400) redirect(firstPage);
    throw error;
  }
}

/**
 * Shell settings for this request (currently the WhatsApp number). Read once per request even
 * when the layout and the page both ask. If it cannot be read the shell simply has no WhatsApp
 * links; an optional extra must never take a page down or send the shopper anywhere.
 */
const NO_SOCIAL = { instagram: null, tiktok: null, facebook: null };
export const storeInfo = cache(async (): Promise<StoreInfoResponse> => {
  api ??= createStoreApi({ baseUrl: storefrontEnv().API_INTERNAL_URL });
  try {
    return await api.info(await shopper());
  } catch (error) {
    // Never redirect from the shell: a page that needs catalogue data decides that itself.
    if (error instanceof StoreApiError || error instanceof AgeRequiredError)
      return { whatsappNumber: null, checkoutOpen: false, social: NO_SOCIAL };
    throw error;
  }
});

/**
 * Brands with products for the footer (ADR 0097). An optional extra like `storeInfo`: if they
 * cannot be read the footer simply lists none.
 */
export const shellBrands = cache(async () => {
  api ??= createStoreApi({ baseUrl: storefrontEnv().API_INTERNAL_URL });
  try {
    const { items } = await api.brands(await shopper());
    return items.filter((brand) => brand.productCount > 0).slice(0, 8);
  } catch (error) {
    if (error instanceof StoreApiError || error instanceof AgeRequiredError) return [];
    throw error;
  }
});

/** What the shop shows when no content is published or it cannot be read: nothing extra. */
export const EMPTY_HOME: StoreHomeResponse = {
  ticker: null,
  heroSlides: [],
  featured: [],
  bestSellers: [],
  brands: [],
  banners: [],
  offers: null,
};
/**
 * The published home content for this request (step 99), read once even when the layout (the
 * promotional bar) and the home page both ask. Managed content is an extra: if it cannot be
 * read the shell shows none of it and the home page falls back to the catalogue sections.
 */
export const storeHome = cache(async (): Promise<StoreHomeResponse> => {
  api ??= createStoreApi({ baseUrl: storefrontEnv().API_INTERNAL_URL });
  try {
    return await api.home(await shopper());
  } catch (error) {
    if (error instanceof StoreApiError || error instanceof AgeRequiredError) return EMPTY_HOME;
    throw error;
  }
});
