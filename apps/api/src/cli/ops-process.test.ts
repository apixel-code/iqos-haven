import { describe, expect, it } from "vitest";
import { libpqEnv } from "./ops-process";

describe("PostgreSQL tools on a server (step 122b)", () => {
  it("passes the migration URL as libpq variables, password decoded and never as an argument", () => {
    expect(libpqEnv("postgres://ih_owner:p%40ss%2Fw0rd@postgres:5433/iqos_haven")).toEqual({
      PGHOST: "postgres",
      PGPORT: "5433",
      PGPASSWORD: "p@ss/w0rd",
    });
    expect(libpqEnv("postgresql://ih_owner:x@db/iqos_haven").PGPORT).toBe("5432");
  });
});
