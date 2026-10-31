import { extname } from "node:path";
import { assertStorageKey } from "@ih/platform";

/** One entry of a backup set's encrypted media index (written by `pnpm ops:backup`). */
export interface MediaIndexEntry {
  readonly key: string;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

const TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Content type for a restored object; derivatives are WebP (step 26), others by extension. */
export const contentTypeFor = (key: string): string =>
  TYPES[extname(key).toLowerCase()] ?? "application/octet-stream";

/**
 * Index entries that are safe to write back: a valid storage key (the same rule every upload
 * obeys, so nothing climbs out of the bucket), a sealed file inside the set's media folder, and
 * each key at most once.
 */
export function restorableEntries(index: readonly MediaIndexEntry[]): MediaIndexEntry[] {
  const seen = new Set<string>();
  return index.filter((entry) => {
    let validKey = true;
    try {
      assertStorageKey(entry.key);
    } catch {
      validKey = false;
    }
    const ok = validKey && /^media\/[0-9a-f]{64}\.enc$/.test(entry.file) && !seen.has(entry.key);
    seen.add(entry.key);
    return ok;
  });
}
