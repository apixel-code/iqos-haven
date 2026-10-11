import { Module } from "@nestjs/common";
import { StoreCatalogController } from "./store-catalog.controller";
import { StoreCatalogService } from "./store-catalog.service";

/** Shopper-facing API surface (`/v1/store/*`); every route is behind the age ticket. */
@Module({ controllers: [StoreCatalogController], providers: [StoreCatalogService] })
export class StoreModule {}
