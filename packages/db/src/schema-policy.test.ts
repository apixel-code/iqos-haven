import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

describe("schema policy", () => {
  it("never lets Prisma fill timestamps from the application clock", () => {
    // @default(now()) is evaluated by the Prisma client; leases/due_at compare with DB now().
    expect(schema).not.toMatch(/@default\(now\(\)\)/);
  });
});
