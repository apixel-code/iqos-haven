import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { CatalogueImageResponse, MediaUploadRequest } from "@ih/contracts";
import {
  abandonMediaUpload,
  authorizeCatalogueImageUpload,
  authorizeMediaUpload,
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  completeMediaUpload,
  listProductMedia,
  readCatalogueImage,
  readMediaAssetForCompletion,
  UPLOAD_AUTHORIZATION_SECONDS,
  type Database,
} from "@ih/db";
import type { ObjectStorage } from "@ih/platform";
import { DATABASE, OBJECT_STORAGE } from "../infra/tokens";

/** Preview links for the editor; never cached anywhere. */
const PREVIEW_SECONDS = 5 * 60;

/**
 * Upload authorization and completion (step 48). Storage calls happen outside every database
 * transaction: the POST policy is signed after the pending asset commits, and the quarantine
 * object is observed (HEAD) before the completion transaction.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ForbiddenException();
      if (error instanceof CatalogueConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof CatalogueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }

  list(actor: string, productId: string) {
    return this.execute(() => listProductMedia(this.db, actor, productId));
  }

  authorize(context: CommandContext, productId: string, input: MediaUploadRequest) {
    return this.execute(() =>
      this.presign(authorizeMediaUpload(this.db, context, productId, input), input),
    );
  }

  // --- Brand logos and category images (parity G-A7, ADR 0091) ---
  authorizeCatalogueImage(context: CommandContext, input: MediaUploadRequest) {
    return this.execute(() =>
      this.presign(authorizeCatalogueImageUpload(this.db, context, input), input),
    );
  }

  completeCatalogueImage(context: CommandContext, assetId: string) {
    return this.execute(async () => {
      const { key, state } = await readMediaAssetForCompletion(
        this.db,
        context.actorId!,
        assetId,
        "catalogue",
      );
      const observed = state === "pending" ? await this.storage.head("quarantine", key) : null;
      return completeMediaUpload(this.db, context, assetId, observed, "catalogue");
    });
  }

  /** State of one catalogue image, with a short-lived preview link once it is processed. */
  catalogueImage(actorId: string, assetId: string): Promise<CatalogueImageResponse> {
    return this.execute(async () => {
      const row = await readCatalogueImage(this.db, actorId, assetId);
      if (!row) throw new CatalogueNotFoundError();
      const key =
        row.state === "ready" ? (row.derivativeKeys.medium ?? row.derivativeKeys.large) : undefined;
      return {
        id: row.id,
        state: row.state,
        error: row.error,
        url: key
          ? await this.storage.presignDownload("media", key, { expiresInSeconds: PREVIEW_SECONDS })
          : null,
      };
    });
  }

  /** Signs the upload policy after the pending asset has committed (outside any transaction). */
  private presign<A extends { id: string; uploadExpiresAt: string }>(
    authorized: Promise<{ asset: A; key: string }>,
    input: MediaUploadRequest,
  ) {
    return authorized.then(async ({ asset, key }) => {
      // The policy never outlives the database authorization (DB clock decides expiry).
      const remaining = Math.floor((Date.parse(asset.uploadExpiresAt) - Date.now()) / 1000);
      try {
        const post = await this.storage.presignQuarantineUpload(key, {
          expiresInSeconds: Math.max(1, Math.min(UPLOAD_AUTHORIZATION_SECONDS, remaining)),
          maxBytes: input.bytes,
          contentType: input.contentType,
        });
        return { asset, upload: { url: post.url, fields: post.fields } };
      } catch (error) {
        await abandonMediaUpload(this.db, asset.id, "presign_failed");
        throw error;
      }
    });
  }

  complete(context: CommandContext, assetId: string) {
    return this.execute(async () => {
      const { key, state } = await readMediaAssetForCompletion(this.db, context.actorId!, assetId);
      const observed = state === "pending" ? await this.storage.head("quarantine", key) : null;
      return completeMediaUpload(this.db, context, assetId, observed);
    });
  }
}
