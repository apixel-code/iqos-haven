// Generates an Ed25519 age-ticket key pair (ADR 0024). Prints environment lines to stdout:
// the private key for the storefront's secret store only, the public entry for every verifier.
// Nothing is written to disk. Usage: pnpm age:keygen [kid]
import { generateKeyPairSync } from "node:crypto";

const kid = process.argv[2] ?? "age-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) {
  console.error("Key id must match [A-Za-z0-9_-]{1,32}");
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
// Raw 32-byte keys: the tail of the PKCS#8 / SPKI DER encodings (RFC 8410).
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
console.log("# Storefront secret store only:");
console.log(`AGE_TICKET_KEY_ID=${kid}`);
console.log(`AGE_TICKET_PRIVATE_KEY=${seed.toString("base64url")}`);
console.log("# Every verifier (API and storefront); append to the existing list when rotating:");
console.log(`AGE_TICKET_PUBLIC_KEYS=${kid}:${raw.toString("base64url")}`);
