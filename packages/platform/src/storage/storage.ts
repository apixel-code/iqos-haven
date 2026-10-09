import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Private object storage (architecture §11 Media upload, reports). All buckets are private:
 * objects are reached only with service credentials or short-lived presigned URLs.
 */
export type BucketPurpose = "quarantine" | "media" | "reports";

export interface StorageConfig {
  readonly endpoint?: string | undefined;
  readonly region: string;
  readonly accessKeyId?: string | undefined;
  readonly secretAccessKey?: string | undefined;
  readonly forcePathStyle: boolean;
  readonly buckets: Readonly<Record<BucketPurpose, string>>;
}

/** Presigned links never outlive this (architecture: report downloads ≤ 15 minutes). */
export const MAX_PRESIGN_SECONDS = 15 * 60;
/** Launch upload limit: eight MB per source image (architecture §11). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,511}$/;
/** Source image types accepted for upload (bytes are still verified by the media consumer). */
export const UPLOAD_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const UPLOAD_PREFIX = "uploads/";

export class StorageKeyError extends Error {
  readonly code = "INVALID_STORAGE_KEY";
}

/**
 * Keys are generated server-side, e.g. `uploads/<assetId>/original`. Client filenames never
 * become keys. Rejects traversal, empty segments and anything outside a small charset.
 */
export function assertStorageKey(key: string): string {
  if (
    !KEY_PATTERN.test(key) ||
    key.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new StorageKeyError("Invalid storage key");
  return key;
}

function ttl(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS)
    throw new RangeError(`Presign lifetime must be 1–${MAX_PRESIGN_SECONDS} seconds`);
  return seconds;
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
  readonly size: number;
}

export interface PresignedUpload {
  readonly url: string;
  readonly fields: Record<string, string>;
  readonly key: string;
  readonly expiresAt: Date;
}

export class ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  private bucket(purpose: BucketPurpose): string {
    return this.config.buckets[purpose];
  }

  async put(
    purpose: BucketPurpose,
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(purpose),
        Key: assertStorageKey(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Reads a whole object, counting bytes as they stream so an object larger than `maxBytes`
   * (or with no declared length) can never be buffered beyond the limit.
   */
  async get(
    purpose: BucketPurpose,
    key: string,
    maxBytes = MAX_UPLOAD_BYTES,
  ): Promise<StoredObject | null> {
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket(purpose), Key: assertStorageKey(key) }),
      );
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) return null;
      throw error;
    }
    const stream = result.Body?.transformToWebStream();
    if (!stream) return { body: new Uint8Array(), contentType: result.ContentType, size: 0 };
    if ((result.ContentLength ?? 0) > maxBytes) {
      await stream.cancel().catch(() => undefined);
      throw new RangeError("Stored object exceeds the read limit");
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("Stored object exceeds the read limit");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body, contentType: result.ContentType, size };
  }

  async head(
    purpose: BucketPurpose,
    key: string,
  ): Promise<{ size: number; contentType: string | undefined } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket(purpose), Key: assertStorageKey(key) }),
      );
      return { size: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (error instanceof NotFound || error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async delete(purpose: BucketPurpose, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket(purpose), Key: assertStorageKey(key) }),
    );
  }

  /**
   * Short-lived download link for an authorized requester (e.g. a report the caller may still
   * access). Permission must be re-checked before calling this, at download time.
   */
  async presignDownload(
    purpose: Exclude<BucketPurpose, "quarantine">,
    key: string,
    options: { expiresInSeconds: number; downloadName?: string },
  ): Promise<string> {
    const name = options.downloadName?.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket(purpose),
        Key: assertStorageKey(key),
        ...(name ? { ResponseContentDisposition: `attachment; filename="${name}"` } : {}),
      }),
      { expiresIn: ttl(options.expiresInSeconds) },
    );
  }

  /**
   * Browser upload straight into the private quarantine bucket. A POST policy (not a PUT
   * content-type) pins the exact key and enforces the size range server-side. Bytes are still
   * validated by the media consumer before anything is published.
   */
  async presignQuarantineUpload(
    key: string,
    options: { expiresInSeconds: number; maxBytes?: number; contentType: string },
  ): Promise<PresignedUpload> {
    const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_BYTES)
      throw new RangeError("Upload size limit out of range");
    const seconds = ttl(options.expiresInSeconds);
    const safeKey = assertStorageKey(key);
    if (!safeKey.startsWith(UPLOAD_PREFIX))
      throw new StorageKeyError("Uploads live under uploads/");
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(options.contentType))
      throw new RangeError("Unsupported upload content type");
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucket("quarantine"),
      Key: safeKey,
      Expires: seconds,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$key", safeKey],
        ["eq", "$Content-Type", options.contentType],
      ],
      Fields: { "Content-Type": options.contentType },
    });
    return {
      url: post.url,
      fields: post.fields,
      key: safeKey,
      expiresAt: new Date(Date.now() + seconds * 1000),
    };
  }

  destroy(): void {
    this.client.destroy();
  }
}

/** Builds the storage config from validated env (api/worker schemas in @ih/config). */
export function storageConfigFromEnv(env: {
  S3_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_ACCESS_KEY?: string | undefined;
  S3_SECRET_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE: boolean;
  S3_BUCKET_QUARANTINE: string;
  S3_BUCKET_MEDIA: string;
  S3_BUCKET_REPORTS: string;
}): StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    buckets: {
      quarantine: env.S3_BUCKET_QUARANTINE,
      media: env.S3_BUCKET_MEDIA,
      reports: env.S3_BUCKET_REPORTS,
    },
  };
}
