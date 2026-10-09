import { hash, verify, type Options } from "@node-rs/argon2";

/** @node-rs/argon2 Algorithm.Argon2id (a const enum, unavailable under isolatedModules). */
const ARGON2ID = 2 as NonNullable<Options["algorithm"]>;

/** argon2id parameters; validated floors live in @ih/config passwordHashEnvFields. */
export interface Argon2Params {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/**
 * argon2id password hashing (architecture §11). The PHC string carries its own salt and
 * parameters, so verification works across parameter changes and `needsRehash` tells the login
 * flow when to upgrade a stored hash.
 */
export class Argon2PasswordHasher {
  constructor(private readonly params: Argon2Params) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      algorithm: ARGON2ID,
      memoryCost: this.params.memoryKib,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
      outputLen: 32,
    });
  }

  /** False for a wrong password or a malformed/foreign hash; never throws on bad input. */
  async verify(storedHash: string, password: string): Promise<boolean> {
    // Never spend argon2 work on oversized input (policy max is 128 characters).
    if (!PHC.test(storedHash) || password.length > 512) return false;
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /** True when a stored hash used weaker (or different) parameters than the current ones. */
  needsRehash(storedHash: string): boolean {
    const match = PHC.exec(storedHash);
    if (!match) return true;
    return (
      Number(match[1]) !== this.params.memoryKib ||
      Number(match[2]) !== this.params.timeCost ||
      Number(match[3]) !== this.params.parallelism
    );
  }
}

export function argon2ParamsFromEnv(env: {
  ARGON2_MEMORY_KIB: number;
  ARGON2_TIME_COST: number;
  ARGON2_PARALLELISM: number;
}): Argon2Params {
  return {
    memoryKib: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };
}
