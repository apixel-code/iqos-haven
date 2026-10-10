import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import {
  DERIVATIVE_NAMES,
  type GalleryAttachRequest,
  type GalleryImage,
  type GalleryReorderRequest,
  type GalleryUpdateRequest,
} from "@ih/contracts";
import {
  attachGalleryImage,
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  readProductGallery,
  removeGalleryImage,
  reorderGalleryImages,
  updateGalleryImage,
  type Database,
  type GalleryImageRow,
} from "@ih/db";
import type { ObjectStorage } from "@ih/platform";
import { DATABASE, OBJECT_STORAGE } from "../infra/tokens";

/** Admin preview links to sanitized derivatives only; never public, never the original. */
const PREVIEW_SECONDS = 10 * 60;

@Injectable()
export class GalleryService {
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

  /** Signing is local (no network); done after the database work. */
  private async present(rows: GalleryImageRow[]): Promise<GalleryImage[]> {
    return Promise.all(
      rows.map(async (row) => {
        const urls = Object.fromEntries(
          await Promise.all(
            DERIVATIVE_NAMES.map(async (name) => {
              const key = row.derivativeKeys[name];
              // Attach requires every derivative; a gap is corrupt data and fails loudly.
              if (!key) throw new Error("Gallery image without derivative");
              return [
                name,
                await this.storage.presignDownload("media", key, {
                  expiresInSeconds: PREVIEW_SECONDS,
                }),
              ];
            }),
          ),
        ) as GalleryImage["urls"];
        return {
          id: row.id,
          mediaAssetId: row.mediaAssetId,
          isPrimary: row.isPrimary,
          sortOrder: row.sortOrder,
          alt: row.alt,
          width: row.width,
          height: row.height,
          version: row.version,
          urls,
        };
      }),
    );
  }

  /** The snapshot is read after the mutation commits (a separate short transaction). */
  private async view(productId: string, actor: string) {
    const gallery = await readProductGallery(this.db, actor, productId);
    return { productId, images: await this.present(gallery.images), uploads: gallery.uploads };
  }

  read(actor: string, productId: string) {
    return this.execute(() => this.view(productId, actor));
  }
  attach(context: CommandContext, productId: string, input: GalleryAttachRequest) {
    return this.execute(async () => {
      await attachGalleryImage(this.db, context, productId, input);
      return this.view(productId, context.actorId!);
    });
  }
  update(context: CommandContext, productId: string, imageId: string, input: GalleryUpdateRequest) {
    return this.execute(async () => {
      await updateGalleryImage(this.db, context, productId, imageId, input);
      return this.view(productId, context.actorId!);
    });
  }
  reorder(context: CommandContext, productId: string, input: GalleryReorderRequest) {
    return this.execute(async () => {
      await reorderGalleryImages(this.db, context, productId, input);
      return this.view(productId, context.actorId!);
    });
  }
  remove(context: CommandContext, productId: string, imageId: string, version: number) {
    return this.execute(async () => {
      await removeGalleryImage(this.db, context, productId, imageId, { version });
      return this.view(productId, context.actorId!);
    });
  }
}
