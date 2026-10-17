import { Module } from "@nestjs/common";
import { AdminContentController } from "./admin-content.controller";
import { ContentService } from "./content.service";

/** Storefront content editing (step 97). The public read arrives in step 98. */
@Module({ controllers: [AdminContentController], providers: [ContentService] })
export class ContentModule {}
