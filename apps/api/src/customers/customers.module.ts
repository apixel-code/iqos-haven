import { Module } from "@nestjs/common";
import { AdminCustomersController, OrderWhatsappController } from "./admin-customers.controller";

/** Admin customer views and order WhatsApp links (step 90). */
@Module({ controllers: [AdminCustomersController, OrderWhatsappController] })
export class CustomersModule {}
