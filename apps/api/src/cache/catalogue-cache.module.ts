import { Global, Module } from "@nestjs/common";
import { CatalogueCacheService } from "./catalogue-cache.service";
import { CatalogueInvalidationInterceptor } from "./catalogue-invalidation.interceptor";
import { RevalidateController } from "./revalidate.controller";

/** Catalogue cache owner and its private invalidation route (step 52). */
@Global()
@Module({
  controllers: [RevalidateController],
  providers: [CatalogueCacheService, CatalogueInvalidationInterceptor],
  exports: [CatalogueCacheService, CatalogueInvalidationInterceptor],
})
export class CatalogueCacheModule {}
