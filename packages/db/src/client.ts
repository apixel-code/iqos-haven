import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createLogger, errorSummary } from "@ih/logger";
import { PrismaClient, Prisma } from "./generated/prisma/client";
export type Database = PrismaClient;
export type Tx = Prisma.TransactionClient;
export type DbExecutor = Database | Tx;
export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  onBackgroundError?: (error: unknown) => void;
}
export function createPool(options: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    statement_timeout: options.statementTimeoutMillis ?? 15000,
    idleTimeoutMillis: 30000,
  });
  const logger = createLogger({ service: options.applicationName });
  pool.on("error", (error: Error) => {
    logger.error(errorSummary(error), "database background connection error");
    options.onBackgroundError?.(error);
  });
  return pool;
}
/** `schema` is for isolated integration-test schemas; runtime uses the connection default. */
export function createDatabase(pool: Pool, options: { schema?: string } = {}): Database {
  return new PrismaClient({
    adapter: new PrismaPg(pool, {
      disposeExternalPool: false,
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    log: [],
  });
}
export async function pingDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
export { Prisma };
