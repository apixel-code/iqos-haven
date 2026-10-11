import { Module } from "@nestjs/common";
import { GalleryController } from "./gallery.controller";
import { GalleryService } from "./gallery.service";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  controllers: [MediaController, GalleryController],
  providers: [MediaService, GalleryService],
})
export class MediaModule {}
