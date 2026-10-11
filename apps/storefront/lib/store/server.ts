import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isIP } from "node:net";
import { AGE_CHECK_PATH } from "../age/policy";
import { storefrontEnv } from "../env";
import { AgeRequiredError, createStoreApi, type ShopperContext, type StoreApi } from "./api";

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
    if (error instanceof AgeRequiredError) redirect(AGE_CHECK_PATH);
    throw error;
  }
}
