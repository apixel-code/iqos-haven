import { Module } from "@nestjs/common";
import { BrandsController } from "./brands.controller";
import { BrandsService } from "./brands.service";
import { CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";
import { PublicationController } from "./publication.controller";
import { PublicationService } from "./publication.service";
import { VariantsController } from "./variants.controller";
import { VariantsService } from "./variants.service";

@Module({
  controllers: [
    BrandsController,
    CategoriesController,
    ProductsController,
    VariantsController,
    PublicationController,
  ],
  providers: [
    BrandsService,
    CategoriesService,
    ProductsService,
    VariantsService,
    PublicationService,
  ],
})
export class CatalogueModule {}
