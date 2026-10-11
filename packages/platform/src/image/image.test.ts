import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  IMAGE_LIMITS,
  ImageRejectedError,
  processImage,
  sniffImageType,
  type ImageRejection,
} from "./image";

const base = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } });
const rejects = async (promise: Promise<unknown>, code: ImageRejection) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ImageRejectedError);
  expect((error as ImageRejectedError).code).toBe(code);
};

describe("untrusted image processing", () => {
  it("sniffs JPEG, PNG and WebP signatures only", async () => {
    expect(sniffImageType(await base(10, 10).jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffImageType(await base(10, 10).png().toBuffer())).toBe("image/png");
    expect(sniffImageType(await base(10, 10).webp().toBuffer())).toBe("image/webp");
    expect(sniffImageType(await base(10, 10).gif().toBuffer())).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it("re-encodes to metadata-free WebP derivatives without enlarging", async () => {
    const source = await base(1200, 900)
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "Private camera owner" } } })
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const result = await processImage(source, "image/jpeg");
    expect([result.width, result.height]).toEqual([1200, 900]);
    expect(result.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(result.derivatives.map((d) => [d.name, d.width, d.height])).toEqual([
      ["large", 1200, 900],
      ["medium", 800, 600],
      ["thumb", 320, 240],
    ]);
    for (const derivative of result.derivatives) {
      const meta = await sharp(derivative.body).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(derivative.body.includes(Buffer.from("Private camera owner"))).toBe(false);
    }
  });

  it("applies EXIF orientation to dimensions and derivatives", async () => {
    const source = await base(1000, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await processImage(source, "image/jpeg");
    expect([result.width, result.height]).toEqual([400, 1000]);
    expect(result.derivatives[1]).toMatchObject({ width: 320, height: 800 });
  });

  it("never trusts the declared type", async () => {
    const png = await base(400, 400).png().toBuffer();
    await rejects(processImage(png, "image/jpeg"), "type_mismatch");
    await rejects(processImage(Buffer.from("<svg/>"), "image/png"), "unsupported_format");
    await rejects(
      processImage(await base(400, 400).gif().toBuffer(), "image/png"),
      "unsupported_format",
    );
  });

  it("rejects truncated or corrupt images", async () => {
    const jpeg = await base(800, 800).jpeg().toBuffer();
    await rejects(processImage(jpeg.subarray(0, 200), "image/jpeg"), "decode_failed");
    const broken = Buffer.from(jpeg);
    broken.fill(0x41, 50, 400);
    await rejects(processImage(broken, "image/jpeg"), "decode_failed");
  });

  it("rejects animated images", async () => {
    const frames = await Promise.all([
      base(300, 300).png().toBuffer(),
      sharp({ create: { width: 300, height: 300, channels: 3, background: "#0000ff" } })
        .png()
        .toBuffer(),
    ]);
    const animated = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    await rejects(processImage(animated, "image/webp"), "animated");
  });

  it("rejects animated PNG (APNG) even though its first frame decodes", async () => {
    const png = await base(300, 300).png().toBuffer();
    // Insert an acTL chunk (2 frames, loop forever) right after IHDR (8 + 25 bytes).
    const data = Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]);
    const typeAndData = Buffer.concat([Buffer.from("acTL"), data]);
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeAndData.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(typeAndData), 8 + data.length);
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    await rejects(processImage(apng, "image/png"), "animated");
    expect((await processImage(png, "image/png")).width).toBe(300);
  });

  it("bounds sides, pixels and bytes (decompression bombs never decode)", async () => {
    await rejects(processImage(await base(150, 600).png().toBuffer(), "image/png"), "dimensions");
    const limits = { ...IMAGE_LIMITS, maxPixels: 1_000_000 };
    // A small, highly compressible file that would expand to 4 megapixels.
    const bomb = await base(2000, 2000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.byteLength).toBeLessThan(100_000);
    const error = await processImage(bomb, "image/png", limits).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageRejectedError);
    expect(["too_many_pixels", "decode_failed"]).toContain((error as ImageRejectedError).code);
    await rejects(
      processImage(await base(400, 400).png().toBuffer(), "image/png", {
        ...IMAGE_LIMITS,
        maxBytes: 10,
      }),
      "too_large",
    );
  });
});
