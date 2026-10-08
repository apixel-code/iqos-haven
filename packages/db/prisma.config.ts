import { defineConfig } from "prisma/config";
import { loadLocalEnvFile } from "@ih/config";

loadLocalEnvFile();
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation/validation need no live DB. The deployment wrapper requires a real migration URL.
  datasource: {
    url: process.env.DATABASE_MIGRATION_URL ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  },
});
