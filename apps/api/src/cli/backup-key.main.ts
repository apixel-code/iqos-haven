import { randomBytes } from "node:crypto";

/**
 * `pnpm ops:backup-key` (step 126): prints a new BACKUP_ENCRYPTION_KEY. Store it in the secret
 * store, apart from the backups; a backup cannot be restored without the key it was made with.
 */
process.stdout.write(`BACKUP_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}\n`);
