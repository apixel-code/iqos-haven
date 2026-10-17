import { Module } from "@nestjs/common";
import { CatalogueImagesController } from "./catalogue-images.controller";
import { GalleryController } from "./gallery.controller";
import { GalleryService } from "./gallery.service";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  controllers: [MediaController, GalleryController, CatalogueImagesController],
  providers: [MediaService, GalleryService],
})
export class MediaModule {}
