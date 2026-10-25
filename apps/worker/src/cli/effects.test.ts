import { describe, expect, it } from "vitest";
import { runEffects, type EffectsDeps } from "./effects";

const ID = "0199c4a2-7b1e-7c3a-9f00-1234567890ab";

function deps(argv: string[], overrides: Partial<EffectsDeps> = {}) {
  const output: string[] = [];
  const replayed: Array<[string, string]> = [];
  const base: EffectsDeps = {
    argv,
    list: async () => [
      {
        effectId: ID,
        eventId: "0199c4a2-0000-7c3a-9f00-1234567890ab",
        eventType: "order.created",
        consumer: "email",
        attempts: 5,
        replays: 0,
        lastError: "RETRY_EXHAUSTED:EMAIL_PROVIDER_UNAVAILABLE",
        diedAt: new Date("2026-10-25T10:00:00Z"),
      },
    ],
    replay: async (id, reason) => {
      replayed.push([id, reason]);
    },
    out: (line) => output.push(line),
  };
  return { deps: { ...base, ...overrides }, output, replayed };
}

describe("ops:effects CLI (step 127)", () => {
  it("lists dead effects by ID, consumer and error code", async () => {
    const { deps: d, output } = deps([]);
    expect(await runEffects(d)).toBe(0);
    expect(output[0]).toContain(ID);
    expect(output[0]).toContain("RETRY_EXHAUSTED:EMAIL_PROVIDER_UNAVAILABLE");
  });

  it("replays one effect only with an ID and an incident reason", async () => {
    const ok = deps(["--replay", ID, "--reason", "INC-9 provider key fixed"]);
    expect(await runEffects(ok.deps)).toBe(0);
    expect(ok.replayed).toEqual([[ID, "INC-9 provider key fixed"]]);
    for (const argv of [
      ["--replay", ID],
      ["--replay", "nope", "--reason", "INC-9 fixed it"],
    ]) {
      const bad = deps(argv);
      expect(await runEffects(bad.deps)).toBe(2);
      expect(bad.replayed).toEqual([]);
    }
  });

  it("reports an effect that is no longer dead without changing anything", async () => {
    const { deps: d, output } = deps(["--replay", ID, "--reason", "INC-9 again please"], {
      replay: async () => {
        throw Object.assign(new Error("x"), { code: "EFFECT_NOT_DEAD" });
      },
    });
    expect(await runEffects(d)).toBe(1);
    expect(output.join("\n")).toContain("not dead");
  });
});
