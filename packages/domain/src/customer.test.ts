import { describe, expect, it } from "vitest";
import {
  InvalidCustomerNameError,
  InvalidPhoneError,
  normalizeCustomerName,
  normalizePhone,
  normalizeTextLine,
} from "./customer";
describe("phone normalization", () => {
  it("maps every way of typing one UAE mobile to the same E.164 identity", () => {
    for (const typed of [
      "0501234567",
      "501234567",
      "+971501234567",
      "971501234567",
      "00971501234567",
      "+971 (0)50 123 4567",
      "+971 050-123-4567",
      " 050.123.4567 ",
      "٠٥٠١٢٣٤٥٦٧",
      "۰۵۰۱۲۳۴۵۶۷",
    ])
      expect(normalizePhone(typed)).toBe("+971501234567");
  });
  it("accepts UAE landlines and numbers of other countries with a country code", () => {
    expect(normalizePhone("04 123 4567")).toBe("+97141234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
  });
  it("refuses instead of guessing", () => {
    for (const typed of [
      "",
      "   ",
      "+",
      "12345",
      "2079460958", // no country code and not a UAE form
      "050123456", // one digit short
      "05012345678", // one digit long
      "+971101234567", // not a UAE mobile or landline prefix
      "800123456", // toll-free
      "+0501234567",
      "+971501234567 ext 4",
      "050-1234567;DROP",
      "+1234567", // shorter than E.164 minimum
      "+1234567890123456", // longer than E.164 maximum
      "++971501234567",
      "5".repeat(41),
    ])
      expect(() => normalizePhone(typed), typed).toThrow(InvalidPhoneError);
    expect(() => normalizePhone(971501234567 as unknown as string)).toThrow(InvalidPhoneError);
  });
});
describe("customer text", () => {
  it("collapses whitespace and bounds the display name", () => {
    expect(normalizeCustomerName("  Synthetic \t Customer \n")).toBe("Synthetic Customer");
    expect(normalizeCustomerName("x".repeat(100))).toHaveLength(100);
    for (const name of [
      "",
      "   ",
      "x".repeat(101),
      "bad\u0000name",
      "bad\u202ename",
      "\u200b\ufeff",
      "zero\u200bwidth",
      "\u200d\u200c",
      "---",
    ])
      expect(() => normalizeCustomerName(name)).toThrow(InvalidCustomerNameError);
  });
  it("turns empty optional lines into null", () => {
    expect(normalizeTextLine(undefined)).toBeNull();
    expect(normalizeTextLine("  ")).toBeNull();
    expect(normalizeTextLine("\u200d \u200c")).toBeNull();
    expect(normalizeTextLine(" Tower  2 ")).toBe("Tower 2");
    expect(normalizeTextLine("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toHaveLength(8);
    expect(() => normalizeTextLine("Tower\u2060 2")).toThrow(RangeError);
    expect(() => normalizeTextLine("a\u0007b")).toThrow(RangeError);
  });
});
