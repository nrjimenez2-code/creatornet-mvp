/**
 * What a file SAYS it is, versus what it actually is.
 *
 * Uploads go straight from the browser to R2 on a presigned URL, so the bytes
 * never pass through this app. Until now the only format check was the
 * Content-Type the uploader chose. sharp sniffs the real format, not the
 * header, so a HEIC or AVIF sent as "image/jpeg" lands under
 * media.creatornet.net/thumbnails — precisely the remotePatterns entry
 * /_next/image fetches and decodes.
 *
 * The trap these tests exist for: MP4 and HEIC/AVIF are BOTH ISO-BMFF. All of
 * them carry "ftyp" at offset 4 and differ only in the brand at offset 8. Any
 * check that stops at "ftyp" happily accepts a HEIC as a video, and a naive
 * image check accepts it as a JPEG.
 */

import {
  sniffMediaKind,
  bytesAllowedForFolder,
  isAllowedUpload,
  IMAGE_TYPES,
  SNIFF_BYTES,
} from "@/lib/uploadPolicy";

const bytes = (...v: number[]) => new Uint8Array(v);
const str = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

/** An ISO-BMFF header: 4-byte box size, "ftyp", then the 4-byte brand. */
const ftyp = (brand: string) =>
  new Uint8Array([0, 0, 0, 0x20, ...str("ftyp"), ...str(brand), 0, 0, 0, 0]);

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 0, 0, 0);
const GIF = new Uint8Array([...str("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([...str("RIFF"), 0x1a, 0, 0, 0, ...str("WEBP"), 0, 0, 0, 0]);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0x1f, 0, 0, 0, 0);

describe("sniffMediaKind identifies real formats", () => {
  it.each([
    ["jpeg", JPEG], ["png", PNG], ["gif", GIF], ["webp", WEBP], ["webm", WEBM],
    ["mp4", ftyp("isom")], ["mp4", ftyp("mp42")], ["quicktime", ftyp("qt  ")], ["3gpp", ftyp("3gp4")],
    ["heif", ftyp("heic")], ["heif", ftyp("mif1")], ["avif", ftyp("avif")],
  ])("recognises %s", (kind, b) => {
    expect(sniffMediaKind(b as Uint8Array)).toBe(kind);
  });

  it("tells HEIC and AVIF apart from MP4 even though all three are ISO-BMFF", () => {
    // Identical for the first 8 bytes. Only the brand differs.
    expect(ftyp("heic").slice(0, 8)).toEqual(ftyp("isom").slice(0, 8));
    expect(sniffMediaKind(ftyp("heic"))).toBe("heif");
    expect(sniffMediaKind(ftyp("avif"))).toBe("avif");
    expect(sniffMediaKind(ftyp("isom"))).toBe("mp4");
  });

  it("returns null rather than guessing on unknown or truncated input", () => {
    expect(sniffMediaKind(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull();
    expect(sniffMediaKind(bytes(0xff))).toBeNull();
    expect(sniffMediaKind(new Uint8Array())).toBeNull();
    expect(sniffMediaKind(ftyp("zzzz"))).toBeNull(); // ftyp, unknown brand
  });
});

describe("bytesAllowedForFolder — the actual attack", () => {
  it("REJECTS a HEIC or AVIF uploaded as a thumbnail", () => {
    // This is the file that would reach /_next/image and be decoded by libheif.
    expect(bytesAllowedForFolder("thumbnails", ftyp("heic"))).toBe(false);
    expect(bytesAllowedForFolder("thumbnails", ftyp("avif"))).toBe(false);
    expect(bytesAllowedForFolder("thumbnails", ftyp("mif1"))).toBe(false);
  });

  it("accepts what the composer really produces", () => {
    // canvas.toBlob(..., "image/jpeg") and the accept="image/jpeg,image/png" picker.
    expect(bytesAllowedForFolder("thumbnails", JPEG)).toBe(true);
    expect(bytesAllowedForFolder("thumbnails", PNG)).toBe(true);
    expect(bytesAllowedForFolder("videos", ftyp("isom"))).toBe(true);
    expect(bytesAllowedForFolder("videos", ftyp("qt  "))).toBe(true);
    expect(bytesAllowedForFolder("videos", WEBM)).toBe(true);
  });

  it("rejects a file that belongs in the other folder", () => {
    expect(bytesAllowedForFolder("thumbnails", ftyp("isom"))).toBe(false); // video as thumbnail
    expect(bytesAllowedForFolder("videos", JPEG)).toBe(false);             // image as video
  });

  it("fails OPEN on formats it does not recognise", () => {
    // Deliberate: the threat is a positively-identified HEIC/AVIF. Rejecting
    // everything unrecognised would break unusual-but-legitimate containers
    // for no security gain.
    expect(bytesAllowedForFolder("videos", bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBe(true);
    expect(bytesAllowedForFolder("thumbnails", new Uint8Array())).toBe(true);
  });

  it("reads far enough to classify an ISO-BMFF file", () => {
    // The brand sits at offset 8-11, so anything under 12 cannot discriminate.
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(12);
    expect(bytesAllowedForFolder("thumbnails", ftyp("heic").slice(0, SNIFF_BYTES))).toBe(false);
  });
});

describe("the declared-type allowlist no longer offers libheif formats", () => {
  it("drops image/heic and image/heif", () => {
    expect(IMAGE_TYPES.has("image/heic")).toBe(false);
    expect(IMAGE_TYPES.has("image/heif")).toBe(false);
    expect(isAllowedUpload("thumbnails", "image/heic")).toBe(false);
    expect(isAllowedUpload("thumbnails", "image/heif")).toBe(false);
  });

  it("still allows exactly what the UI promises: JPG, PNG, WebP", () => {
    expect(isAllowedUpload("thumbnails", "image/jpeg")).toBe(true);
    expect(isAllowedUpload("thumbnails", "image/png")).toBe(true);
    expect(isAllowedUpload("thumbnails", "image/webp")).toBe(true);
  });
});
