import { PermanentEffectError, type ExternalEffectHandler } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import {
  expireMediaUploads,
  finishMediaProcessing,
  loadMediaForProcessing,
  markQuarantinePurged,
  mediaQuarantinePurgeCandidates,
  type Database,
} from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { IMAGE_LIMITS, ImageRejectedError, processImage, type ObjectStorage } from "@ih/platform";
import type { ScheduledJob } from "./scheduler";

/**
 * Media processing consumer (roadmap step 49, ADR 0019). Runs as an external effect: storage
 * reads/writes happen outside any transaction under the effect lease, then one short transaction
 * records `ready` or `rejected` — only if the asset is still `uploaded`, so redelivery is a no-op.
 * Derivative keys are deterministic, so a retried run overwrites the same objects.
 */
export function createMediaConsumer(options: {
  db: Database;
  storage: ObjectStorage;
  log: Logger;
}): ExternalEffectHandler {
  const { db, storage, log } = options;
  return {
    kind: "external",
    consumer: "media_processor",
    maxAttempts: 5,
    async perform(context, signal) {
      const payload = EVENT_CATALOGUE["media.uploaded"].payload.safeParse(context.payload);
      if (!payload.success || context.schemaVersion !== 1)
        throw new PermanentEffectError("INVALID_MEDIA_EVENT");
      const assetId = payload.data.mediaAssetId;
      const asset = await loadMediaForProcessing(db, assetId);
      if (!asset) throw new PermanentEffectError("MEDIA_ASSET_MISSING");
      // Already decided (or never completed): nothing to do.
      if (asset.state !== "uploaded") return { receipt: `skipped:${asset.state}` };
      const system = { actorId: null, requestId: context.effectId };
      const reject = async (error: string) => {
        await finishMediaProcessing(db, system, assetId, { state: "rejected", error });
        log.info({ effectId: context.effectId, assetId, error }, "media rejected");
        return { receipt: `rejected:${error}` };
      };
      const head = await storage.head("quarantine", asset.quarantineKey);
      if (!head) return reject("object_missing");
      // The upload policy outlives completion: refuse bytes that changed after they were checked.
      if (!asset.observedEtag || head.etag !== asset.observedEtag) return reject("object_changed");
      signal.throwIfAborted();
      let original;
      try {
        original = await storage.get("quarantine", asset.quarantineKey, IMAGE_LIMITS.maxBytes);
      } catch (error) {
        if (error instanceof RangeError) return reject("too_large");
        throw error;
      }
      if (!original) return reject("object_missing");
      let processed;
      try {
        processed = await processImage(original.body, asset.declaredType);
      } catch (error) {
        if (error instanceof ImageRejectedError) return reject(error.code);
        throw error;
      }
      signal.throwIfAborted();
      const derivativeKeys: Record<string, string> = {};
      for (const derivative of processed.derivatives) {
        signal.throwIfAborted();
        const key = asset.productId
          ? `products/${asset.productId}/${assetId}/${derivative.name}.webp`
          : `content/${assetId}/${derivative.name}.webp`;
        await storage.put("media", key, derivative.body, derivative.contentType);
        derivativeKeys[derivative.name] = key;
      }
      await finishMediaProcessing(db, system, assetId, {
        state: "ready",
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256,
        derivativeKeys,
      });
      log.info({ effectId: context.effectId, assetId }, "media processed");
      return { receipt: "ready" };
    },
  };
}

/**
 * Hourly durable cleanup: expire authorizations that ran out, then delete private quarantine
 * originals of expired, rejected and (after retention) processed assets. Idempotent per slot:
 * a deleted object is marked purged; deleting an absent object is harmless.
 */
export function createMediaCleanupJob(options: {
  db: Database;
  storage: ObjectStorage;
  log: Logger;
  batch?: number;
}): ScheduledJob {
  const { db, storage, log } = options;
  return {
    name: "media.quarantine_cleanup",
    spec: { kind: "interval", everyMs: 60 * 60_000 },
    catchUp: 1,
    async run() {
      const expired = await expireMediaUploads(db);
      let purged = 0;
      // One failing object must not block the rest: skip it for this run and retry next hour.
      const failed: string[] = [];
      for (;;) {
        const batch = await mediaQuarantinePurgeCandidates(db, options.batch ?? 100, failed);
        if (!batch.length) break;
        for (const item of batch) {
          try {
            await storage.delete("quarantine", item.quarantineKey);
            await markQuarantinePurged(db, item.id);
            purged += 1;
          } catch (error) {
            failed.push(item.id);
            log.warn({ assetId: item.id, ...errorSummary(error) }, "quarantine purge failed");
          }
        }
      }
      log.info({ expired, purged, failed: failed.length }, "media quarantine cleanup");
    },
  };
}
