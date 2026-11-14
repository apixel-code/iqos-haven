import { Module } from "@nestjs/common";
import { AdminGuidesController, StoreGuidesController } from "./guides.controller";
import { GuidesService } from "./guides.service";

@Module({ controllers: [AdminGuidesController, StoreGuidesController], providers: [GuidesService] })
export class GuidesModule {}
