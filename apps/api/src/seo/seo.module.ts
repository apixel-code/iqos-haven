import { Module } from "@nestjs/common";
import { AdminSeoController, PublicSeoController } from "./admin-seo.controller";

/** SEO policy, overview, issue report (step 113). */
@Module({ controllers: [AdminSeoController, PublicSeoController] })
export class SeoModule {}
