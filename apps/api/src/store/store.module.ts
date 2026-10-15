import { Module } from "@nestjs/common";
import { StoreCatalogController } from "./store-catalog.controller";
import { StoreCatalogService } from "./store-catalog.service";
import { StoreSearchController } from "./store-search.controller";
import { CartQuoteController } from "./cart-quote.controller";
import { CartQuoteService } from "./cart-quote.service";
import { StoreReviewsController } from "./store-reviews.controller";
import { StoreContentController } from "./store-content.controller";

/** Shopper-facing API surface (`/v1/store/*`); every route is behind the age ticket. */
@Module({
  controllers: [
    StoreSearchController,
    StoreCatalogController,
    CartQuoteController,
    StoreReviewsController,
    StoreContentController,
  ],
  providers: [StoreCatalogService, CartQuoteService],
  exports: [CartQuoteService],
})
export class StoreModule {}
