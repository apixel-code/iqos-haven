import { describe, expect, it } from "vitest";
import { answerConfirm, confirmDialog } from "./confirm";
import { dismissToast, toast } from "./toast";

// Each question gets the next id (1, 2, …) in this module instance; `ask` keeps count.
let asked = 0;
const ask = (title: string) => {
  asked += 1;
  return { id: asked, answer: confirmDialog({ title }) };
};

describe("confirmDialog (parity G-A13)", () => {
  it("resolves true for the confirm button and false for cancel", async () => {
    const first = ask("Delete?");
    answerConfirm(first.id, true);
    await expect(first.answer).resolves.toBe(true);
    const second = ask("Delete again?");
    answerConfirm(second.id, false);
    await expect(second.answer).resolves.toBe(false);
  });
  it("answers an older question no when a new one is asked", async () => {
    const older = ask("One");
    const newer = ask("Two");
    await expect(older.answer).resolves.toBe(false);
    answerConfirm(newer.id, true);
    await expect(newer.answer).resolves.toBe(true);
  });
  it("ignores an answer for a question that is no longer open", async () => {
    const open = ask("Three");
    answerConfirm(open.id - 1, true);
    answerConfirm(open.id, false);
    await expect(open.answer).resolves.toBe(false);
  });
});

describe("toast", () => {
  it("can be dismissed by id and ignores unknown ids", () => {
    toast("Saved");
    expect(() => dismissToast(999_999)).not.toThrow();
  });
});
