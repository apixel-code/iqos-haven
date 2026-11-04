import { Module } from "@nestjs/common";
import { PublicBusinessController } from "./public-business.controller";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
@Module({
  controllers: [SettingsController, PublicBusinessController],
  providers: [SettingsService],
})
export class SettingsModule {}
