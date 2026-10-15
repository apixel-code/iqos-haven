import { AGE_COOKIE, readAgeCookie } from "@ih/platform/age-ticket";
import {
  AGE_VERIFICATION_REQUIRED,
  storeBrandsResponseSchema,
  storeCategoriesResponseSchema,
  storeDeliveryResponseSchema,
  storeHomeResponseSchema,
  storeInfoResponseSchema,
  storeProductResponseSchema,
  storeProductsResponseSchema,
  storeSearchResponseSchema,
  type StoreBrandsResponse,
  type StoreCategoriesResponse,
  type StoreDeliveryResponse,
  type StoreHomeResponse,
  type StoreInfoResponse,
  type StoreProductResponse,
  type StoreProductsResponse,
  type StoreSearchResponse,
} from "@ih/contracts";
import type { z } from "zod";

/** The API refused the age ticket (expired or revoked since the routing gate saw it). */
export class AgeRequiredError extends Error {
  constructor() {
    super("Age verification required");
  }
}
/** Any other failure of a catalogue read: rate limit, overload, outage, unexpected body. */
export class StoreApiError extends Error {
  constructor(readonly status: number) {
    super(`Store API answered ${status}`);
  }
}

/** What one shopper request contributes to an API call. Nothing else is forwarded. */
export interface ShopperContext {
  readonly cookieHeader: string | null;
  /** Client address set by the gateway; the API limits reads per address. */
  readonly clientIp: string | null;
}

export interface StoreProductsParams {
  brand?: string;
  category?: string;
  type?: "disposable" | "kit";
  sale?: "1";
  sort?: string;
  cursor?: string;
  limit?: number;
}

const TIMEOUT_MS = 5_000;

/**
 * Server-side catalogue client (roadmap step 59, ADR 0028). The storefront keeps no cache of its
 * own: every call is `no-store` and the API (the cache owner) answers it. Only the shopper's age
 * ticket and client address are forwarded: never other cookies, headers or query parameters. The
 * API verifies the ticket again, so this client cannot be used to read the catalogue without one.
 */
export function createStoreApi(options: { baseUrl: string; fetch?: typeof fetch }) {
  const send = options.fetch ?? fetch;

  async function call<S extends z.ZodType>(
    shopper: ShopperContext,
    path: string,
    schema: S,
  ): Promise<z.infer<S> | null> {
    const ticket = readAgeCookie(shopper.cookieHeader ?? undefined);
    // No ticket: do not even ask. The routing gate normally stops this request earlier.
    if (!ticket) throw new AgeRequiredError();
    let response: Response;
    try {
      response = await send(new URL("/v1/store" + path, options.baseUrl), {
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          cookie: `${AGE_COOKIE}=${ticket}`,
          ...(shopper.clientIp ? { "x-ih-client-ip": shopper.clientIp } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new StoreApiError(503);
    }
    if (response.status === 404) return null;
    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      if (body?.error?.code === AGE_VERIFICATION_REQUIRED) throw new AgeRequiredError();
    }
    if (!response.ok) throw new StoreApiError(response.status);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    // A body that does not match the contract is treated as an outage, never rendered.
    if (!parsed.success) throw new StoreApiError(502);
    return parsed.data;
  }

  const required = async <T>(value: Promise<T | null>): Promise<T> => {
    const result = await value;
    if (result === null) throw new StoreApiError(404);
    return result;
  };

  return {
    info: (shopper: ShopperContext): Promise<StoreInfoResponse> =>
      required(call(shopper, "/info", storeInfoResponseSchema)),
    brands: (shopper: ShopperContext): Promise<StoreBrandsResponse> =>
      required(call(shopper, "/brands", storeBrandsResponseSchema)),
    /** Delivery fee, ETA and areas as the Owner set them (step 100: the Help page). */
    delivery: (shopper: ShopperContext): Promise<StoreDeliveryResponse> =>
      required(call(shopper, "/delivery", storeDeliveryResponseSchema)),
    /** The published home sections (step 98): already checked and assembled by the API. */
    home: (shopper: ShopperContext): Promise<StoreHomeResponse> =>
      required(call(shopper, "/content/home", storeHomeResponseSchema)),
    categories: (shopper: ShopperContext): Promise<StoreCategoriesResponse> =>
      required(call(shopper, "/categories", storeCategoriesResponseSchema)),
    products(shopper: ShopperContext, params: StoreProductsParams): Promise<StoreProductsResponse> {
      const query = new URLSearchParams();
      // Only the parameters the API contract knows, in a fixed order.
      for (const key of ["brand", "category", "type", "sale", "sort", "limit", "cursor"] as const) {
        const value = params[key];
        if (value !== undefined) query.set(key, String(value));
      }
      const suffix = query.size ? `?${query}` : "";
      return required(call(shopper, `/products${suffix}`, storeProductsResponseSchema));
    },
    /** `params` come from `searchApiParams`: already reduced to what the contract accepts. */
    search(
      shopper: ShopperContext,
      params: ReadonlyArray<readonly [string, string]>,
    ): Promise<StoreSearchResponse> {
      const query = new URLSearchParams();
      for (const [key, value] of params) query.append(key, value);
      const suffix = query.size ? `?${query}` : "";
      return required(call(shopper, `/search${suffix}`, storeSearchResponseSchema));
    },
    /** Null when the shopper may not see a product under this slug. */
    product: (shopper: ShopperContext, slug: string): Promise<StoreProductResponse | null> =>
      call(shopper, `/products/${encodeURIComponent(slug)}`, storeProductResponseSchema),
  };
}
export type StoreApi = ReturnType<typeof createStoreApi>;
