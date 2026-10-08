import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const folder = mkdtempSync(join(tmpdir(), "ih-minio-"));
try {
  const fake = join(folder, "mc");
  const run = () =>
    spawnSync("/bin/sh", ["infra/minio/init-buckets.sh"], {
      env: {
        ...process.env,
        PATH: folder + ":" + process.env.PATH,
        MINIO_ROOT_USER: "fixture",
        MINIO_ROOT_PASSWORD: "fixture",
        MINIO_INIT_RETRIES: "1",
      },
      encoding: "utf8",
    });
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = "mb" ] && exit 42\nexit 0\n', { mode: 0o700 });
  assert.equal(run().status, 42, "Bucket failure must propagate");
  writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  assert.equal(run().status, 1, "Startup retry budget must terminate");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(run().status, 0);
  process.stdout.write("3 MinIO startup/error-propagation checks passed.\n");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
