import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { ProductCreateRequest, ProductsQuery, ProductUpdateRequest } from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  createProduct,
  listProducts,
  ProductCursorError,
  readProduct,
  updateProduct,
  type Database,
} from "@ih/db";
import type { ObjectStorage } from "@ih/platform";
import { DATABASE, OBJECT_STORAGE } from "../infra/tokens";

/** List thumbnails are signed briefly: the admin list is refetched on every visit. */
const THUMBNAIL_SECONDS = 600;

@Injectable()
export class ProductsService {
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
      if (error instanceof ProductCursorError) throw new BadRequestException();
      throw error;
    }
  }
  async list(actor: string, query: ProductsQuery) {
    const page = await this.execute(() => listProducts(this.db, actor, query));
    return {
      nextCursor: page.nextCursor,
      items: await Promise.all(
        page.items.map(async ({ thumbnailKey, ...item }) => ({
          ...item,
          thumbnailUrl: thumbnailKey
            ? await this.storage.presignDownload("media", thumbnailKey, {
                expiresInSeconds: THUMBNAIL_SECONDS,
              })
            : null,
        })),
      ),
    };
  }
  read(actor: string, id: string) {
    return this.execute(() => readProduct(this.db, actor, id));
  }
  create(context: CommandContext, input: ProductCreateRequest) {
    return this.execute(() => createProduct(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: ProductUpdateRequest) {
    return this.execute(() => updateProduct(this.db, context, id, input));
  }
}
