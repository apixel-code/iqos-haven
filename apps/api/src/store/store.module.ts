import { Module } from "@nestjs/common";
import { StoreCatalogController } from "./store-catalog.controller";
import { StoreCatalogService } from "./store-catalog.service";
import { StoreSearchController } from "./store-search.controller";

/** Shopper-facing API surface (`/v1/store/*`); every route is behind the age ticket. */
@Module({
  controllers: [StoreSearchController, StoreCatalogController],
  providers: [StoreCatalogService],
})
export class StoreModule {}
