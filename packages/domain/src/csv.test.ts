import { describe, expect, it } from "vitest";
import { aedAmount, csvField, csvLine, CsvNumber, dubaiDateTime, percentAmount } from "./csv";

describe("report CSV encoding (step 111)", () => {
  it("defuses text that a spreadsheet would run as a formula", () => {
    for (const attack of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])
      expect(csvField(attack).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("Mango =ice")).toBe("Mango =ice");
    // A phone number is text: its leading + is defused too, so it is never read as a sum.
    expect(csvField("+971501234567")).toBe("'+971501234567");
  });

  it("quotes commas, quotes, line breaks and edge spaces (RFC 4180)", () => {
    expect(csvField('Say "hi", then go')).toBe('"Say ""hi"", then go"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField(null)).toBe("");
    expect(csvLine(["a", 1, null, aedAmount(150)])).toBe("a,1,,1.50\r\n");
  });

  it("writes amounts from integer fils and keeps computed numbers as numbers", () => {
    expect(aedAmount(123456).text).toBe("1234.56");
    expect(aedAmount(5n).text).toBe("0.05");
    expect(aedAmount(0).text).toBe("0.00");
    expect(aedAmount(-250).text).toBe("-2.50");
    expect(csvField(aedAmount(-250))).toBe("-2.50");
    expect(percentAmount(1234)!.text).toBe("12.34");
    expect(percentAmount(5)!.text).toBe("0.05");
    expect(percentAmount(null)).toBeNull();
    expect(() => new CsvNumber("1e5")).toThrow();
    expect(() => csvField(1.5)).toThrow();
  });

  it("formats instants in Dubai time", () => {
    expect(dubaiDateTime(new Date("2026-10-15T20:30:00Z"))).toBe("2026-10-16 00:30");
  });
});
