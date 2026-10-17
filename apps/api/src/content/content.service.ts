import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import {
  CONTENT_SECTION_KEYS,
  CURRENT_CONTENT_SCHEMA,
  type AdminContentSection,
  type ContentImageItem,
  type ContentSectionKey,
  type MediaUploadRequest,
} from "@ih/contracts";
import {
  abandonMediaUpload,
  authorizeContentImageUpload,
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  completeMediaUpload,
  ContentConflictError,
  ContentForbiddenError,
  ContentInvalidError,
  ContentNotFoundError,
  ContentReferenceError,
  listContentImages,
  listContentSections,
  publishContentSection,
  readContentPreview,
  readMediaAssetForCompletion,
  saveContentDraft,
  UPLOAD_AUTHORIZATION_SECONDS,
  type ContentSectionRecord,
  type Database,
} from "@ih/db";
import type { ObjectStorage } from "@ih/platform";
import { ZodError } from "zod";
import { DATABASE, OBJECT_STORAGE } from "../infra/tokens";

const toSection = (row: ContentSectionRecord): AdminContentSection => ({
  key: row.key,
  version: row.version,
  schemaVersion: row.schemaVersion,
  draft: row.draft as Record<string, unknown>,
  draftUpdatedAt: row.draftUpdatedAt,
  published: row.published as Record<string, unknown> | null,
  publishedAt: row.publishedAt,
  unpublishedChanges: row.unpublishedChanges,
});

/** Admin preview links to sanitized derivatives only; never public, never the original. */
const PREVIEW_SECONDS = 10 * 60;

/**
 * Storefront content editing (roadmap step 97, ADR 0065): drafts, a resolved preview, publish,
 * and content images. Storage calls (signing) happen outside every database transaction.
 */
@Injectable()
export class ContentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ContentForbiddenError || error instanceof CatalogueForbiddenError)
        throw new ForbiddenException();
      if (error instanceof ContentNotFoundError || error instanceof CatalogueNotFoundError)
        throw new NotFoundException();
      if (error instanceof ContentConflictError || error instanceof CatalogueConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof ContentReferenceError)
        throw new ConflictException({
          code: "CONTENT_REFERENCES",
          details: error.problems.map((problem) => ({
            path: `${problem.kind}:${problem.id}`,
            message: problem.reason,
          })),
        });
      // A stored draft that no longer fits its schema: only possible outside the API.
      if (error instanceof ContentInvalidError) throw new ConflictException();
      if (error instanceof ZodError)
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          details: error.issues.map((issue) => ({
            path: ["content", ...issue.path].join("."),
            message: "Invalid field",
          })),
        });
      throw error;
    }
  }

  /** All seven sections, in order; a section never saved has version 0 and no draft. */
  sections(actorId: string) {
    return this.execute(async () => {
      const saved = await listContentSections(this.db, actorId);
      const sections: AdminContentSection[] = CONTENT_SECTION_KEYS.map((key) => {
        const row = saved.find((item) => item.key === key);
        return row
          ? toSection(row)
          : {
              key,
              version: 0,
              schemaVersion: CURRENT_CONTENT_SCHEMA[key],
              draft: null,
              draftUpdatedAt: null,
              published: null,
              publishedAt: null,
              unpublishedChanges: false,
            };
      });
      return { sections };
    });
  }

  saveDraft(
    context: CommandContext,
    key: ContentSectionKey,
    expectedVersion: number,
    content: unknown,
  ) {
    return this.execute(async () => {
      return toSection(await saveContentDraft(this.db, context, key, { expectedVersion, content }));
    });
  }

  publish(context: CommandContext, key: ContentSectionKey, expectedVersion: number) {
    return this.execute(async () => {
      // The committed record itself, not a second read another save could have overtaken.
      return toSection(await publishContentSection(this.db, context, key, expectedVersion));
    });
  }

  preview(actorId: string, key: ContentSectionKey) {
    return this.execute(async () => {
      const preview = await readContentPreview(this.db, actorId, key);
      return {
        ...preview,
        images: await Promise.all(
          preview.images.map(async (image) => ({
            id: image.id,
            ready: image.ready,
            url: await this.url(image.ready ? image.derivativeKeys : {}),
          })),
        ),
      };
    });
  }

  images(actorId: string) {
    return this.execute(async () => {
      const rows = await listContentImages(this.db, actorId);
      const items: ContentImageItem[] = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          state: row.state as ContentImageItem["state"],
          width: row.width,
          height: row.height,
          error: row.error,
          url: await this.url(row.state === "ready" ? row.derivativeKeys : {}),
          createdAt: row.createdAt.toISOString(),
        })),
      );
      return { items };
    });
  }

  authorizeImage(context: CommandContext, input: MediaUploadRequest) {
    return this.execute(async () => {
      const { asset, key } = await authorizeContentImageUpload(this.db, context, input);
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

  completeImage(context: CommandContext, assetId: string) {
    return this.execute(async () => {
      const { key, state } = await readMediaAssetForCompletion(
        this.db,
        context.actorId!,
        assetId,
        "content",
      );
      const observed = state === "pending" ? await this.storage.head("quarantine", key) : null;
      return completeMediaUpload(this.db, context, assetId, observed, "content");
    });
  }

  /** A signed link to the medium derivative, or null while there is none. */
  private async url(keys: Record<string, string>) {
    const key = keys.medium ?? keys.large;
    return key
      ? this.storage.presignDownload("media", key, { expiresInSeconds: PREVIEW_SECONDS })
      : null;
  }
}
