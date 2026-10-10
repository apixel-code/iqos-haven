import { Module } from "@nestjs/common";
import { BrandsController } from "./brands.controller";
import { BrandsService } from "./brands.service";
import { CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";

@Module({
  controllers: [BrandsController, CategoriesController],
  providers: [BrandsService, CategoriesService],
})
export class CatalogueModule {}
