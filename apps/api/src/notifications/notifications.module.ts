import { Module } from "@nestjs/common";
import { AdminEventsController } from "./admin-events.controller";
import { NotificationsController } from "./notifications.controller";

/** The staff inbox and its event stream (step 91). */
@Module({ controllers: [NotificationsController, AdminEventsController] })
export class NotificationsModule {}
